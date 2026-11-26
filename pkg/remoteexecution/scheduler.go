// Package remoteexecution schedules REAPI actions and records worker activity.
package remoteexecution

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	_ "modernc.org/sqlite"
)

const (
	heartbeatInterval = 5 * time.Second
	leaseDuration     = 30 * time.Second
	offerDuration     = 10 * time.Second
	pollInterval      = 250 * time.Millisecond
	longPoll          = 15 * time.Second
	maxAttempts       = 3
	activityRetention = 100000
	defaultTimeout    = 10 * time.Minute
	maxTimeout        = time.Hour
)

var validID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

type PoolConfig struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Instance       string            `json:"instance,omitempty"`
	Platform       map[string]string `json:"platform"`
	IrohGatewayID  string            `json:"iroh_gateway_id,omitempty"`
	RevokedWorkers []string          `json:"revoked_workers,omitempty"`
}

type WorkerConfig struct {
	Pool  string `json:"pool"`
	Token string `json:"token"`
}

type Config struct {
	ClientToken string                  `json:"client_token"`
	ViewerToken string                  `json:"viewer_token"`
	AdminToken  string                  `json:"admin_token,omitempty"`
	Pools       []PoolConfig            `json:"pools"`
	Workers     map[string]WorkerConfig `json:"workers"`
}

func LoadConfig(path string) (Config, error) {
	var config Config
	file, err := os.Open(path)
	if err != nil {
		return config, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, err
	}
	return config, config.validate()
}

func (c Config) validate() error {
	tokens := map[string]bool{}
	addToken := func(token string) bool {
		if len(token) < 24 || len(token) > 256 || tokens[token] ||
			strings.IndexFunc(token, func(r rune) bool { return r < 0x21 || r > 0x7e }) >= 0 {
			return false
		}
		tokens[token] = true
		return true
	}
	if !addToken(c.ClientToken) || !addToken(c.ViewerToken) {
		return errors.New("client_token and viewer_token must be distinct tokens of 24–256 bytes")
	}
	if c.AdminToken != "" && !addToken(c.AdminToken) {
		return errors.New("admin_token must be a distinct token of 24–256 bytes")
	}
	pools := map[string]bool{}
	for _, pool := range c.Pools {
		if pools[pool.ID] {
			return fmt.Errorf("invalid or duplicate pool ID %q", pool.ID)
		}
		if err := pool.validate(); err != nil {
			return err
		}
		pools[pool.ID] = true
	}
	if len(pools) == 0 && c.AdminToken == "" {
		return errors.New("at least one execution pool is required")
	}
	for id, worker := range c.Workers {
		if !validID.MatchString(id) || !pools[worker.Pool] || !addToken(worker.Token) {
			return fmt.Errorf("invalid worker ID, pool, or credential for %q", id)
		}
	}
	return nil
}

func (pool PoolConfig) validate() error {
	if !validID.MatchString(pool.ID) || len(pool.Name) > 256 {
		return fmt.Errorf("invalid pool ID or name for %q", pool.ID)
	}
	if !validInstanceName(pool.Instance) {
		return fmt.Errorf("invalid instance name for pool %q", pool.ID)
	}
	for key, value := range pool.Platform {
		if key == "" || value == "" {
			return fmt.Errorf("empty platform property in pool %q", pool.ID)
		}
	}
	if pool.IrohGatewayID != "" && !validIrohID.MatchString(pool.IrohGatewayID) {
		return fmt.Errorf("invalid Iroh gateway ID for pool %q", pool.ID)
	}
	for _, id := range pool.RevokedWorkers {
		if peer, ok := strings.CutPrefix(id, irohWorkerPrefix); !ok || !validIrohID.MatchString(peer) {
			return fmt.Errorf("invalid revoked Iroh worker ID %q in pool %q", id, pool.ID)
		}
	}
	return nil
}

const schema = `
CREATE TABLE IF NOT EXISTS pools (
	id TEXT PRIMARY KEY, data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
	id TEXT PRIMARY KEY, pool TEXT NOT NULL REFERENCES pools(id), data BLOB NOT NULL,
	session TEXT NOT NULL UNIQUE, registration TEXT NOT NULL, deadline INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workers_pool ON workers(pool, id);
CREATE TABLE IF NOT EXISTS operations (
	name TEXT PRIMARY KEY, pool TEXT NOT NULL REFERENCES pools(id), instance TEXT NOT NULL, state INTEGER NOT NULL,
	enqueued INTEGER NOT NULL, data BLOB NOT NULL, timeout_ns INTEGER NOT NULL,
	cacheable INTEGER NOT NULL, response BLOB
);
CREATE INDEX IF NOT EXISTS operations_queue ON operations(pool, state, enqueued, name);
CREATE TABLE IF NOT EXISTS leases (
	id TEXT PRIMARY KEY, operation TEXT NOT NULL REFERENCES operations(name),
	session TEXT NOT NULL, worker TEXT NOT NULL REFERENCES workers(id),
	request_id TEXT NOT NULL, deadline INTEGER NOT NULL, state INTEGER NOT NULL,
	attempt INTEGER NOT NULL, data BLOB NOT NULL, completion BLOB,
	UNIQUE(session, request_id), UNIQUE(operation, attempt)
);
CREATE INDEX IF NOT EXISTS leases_session ON leases(session, state);
CREATE INDEX IF NOT EXISTS leases_worker ON leases(worker, attempt);
CREATE INDEX IF NOT EXISTS leases_expiry ON leases(state, deadline);
CREATE TABLE IF NOT EXISTS activity (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT, pool TEXT NOT NULL, worker TEXT NOT NULL,
	data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_pool ON activity(pool, sequence);
CREATE INDEX IF NOT EXISTS activity_worker ON activity(pool, worker, sequence);
`

type Scheduler struct {
	pb.UnimplementedWorkerServiceServer
	pb.UnimplementedExecutionObserverServiceServer
	re.UnimplementedExecutionServer
	remotecache.Backend

	config    Config
	db        *sql.DB
	lock      *os.File
	startedAt time.Time
	sweep     atomic.Pointer[sweepStatus]
}

func Open(path string, config Config, cache remotecache.Backend) (*Scheduler, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("lock execution database: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		lock.Close()
		return nil, err
	}
	file.Close()
	dsn := (&url.URL{Scheme: "file", Path: path}).String()
	db, err := sql.Open("sqlite", dsn+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)")
	if err != nil {
		lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Scheduler{config: config, Backend: cache, db: db, lock: lock, startedAt: time.Now()}
	if err := s.initialize(context.Background()); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Scheduler) Close() error {
	return errors.Join(s.db.Close(), s.lock.Close())
}

func (s *Scheduler) initialize(ctx context.Context) error {
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var version int
		if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
			return err
		}
		if version > 3 {
			return fmt.Errorf("unsupported execution database version %d", version)
		}
		if version == 0 {
			if _, err := tx.ExecContext(ctx, schema); err != nil {
				return err
			}
		}
		if version < 2 {
			if _, err := tx.ExecContext(ctx, `CREATE TABLE pool_settings (
				id TEXT PRIMARY KEY REFERENCES pools(id), data BLOB NOT NULL, legacy_order INTEGER
			); PRAGMA user_version = 2;`); err != nil {
				return err
			}
		}
		if version < 3 {
			if _, err := tx.ExecContext(ctx, instanceSchema); err != nil {
				return err
			}
		}
		if len(s.config.Pools) > 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM pool_settings WHERE legacy_order IS NOT NULL"); err != nil {
				return err
			}
		} else if _, err := tx.ExecContext(ctx, "UPDATE pool_settings SET legacy_order = NULL WHERE legacy_order IS NOT NULL"); err != nil {
			return err
		}
		for position, pool := range s.config.Pools {
			if err := ensureInstance(ctx, tx, pool.Instance); err != nil {
				return err
			}
			if err := savePoolSettings(ctx, tx, pool); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE pool_settings SET legacy_order = ? WHERE id = ?", position, pool.ID); err != nil {
				return err
			}
		}
		if version == 1 && len(s.config.Pools) == 0 {
			history, err := priorPoolSettings(ctx, tx)
			if err != nil {
				return err
			}
			for _, pool := range history {
				if err := ensureInstance(ctx, tx, pool.Instance); err != nil {
					return err
				}
				if err := savePoolSettings(ctx, tx, pool); err != nil {
					return err
				}
			}
		}
		var missingPool string
		err := tx.QueryRowContext(ctx, `SELECT pool FROM operations WHERE state != ? AND
			pool NOT IN (SELECT id FROM pool_settings) LIMIT 1`, completed).Scan(&missingPool)
		if err == nil {
			return fmt.Errorf("pool %q has unfinished operations and must remain configured", missingPool)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE workers SET deadline = 0 WHERE deadline != -1"); err != nil {
			return err
		}
		return expire(ctx, tx, time.Now())
	})
}

func platformProto(properties map[string]string) *re.Platform {
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	slices.Sort(names)
	p := &re.Platform{}
	for _, name := range names {
		p.Properties = append(p.Properties, &re.Platform_Property{Name: name, Value: properties[name]})
	}
	return p
}

func (s *Scheduler) transaction(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func decode(row interface{ Scan(...any) error }, message proto.Message) error {
	var data []byte
	if err := row.Scan(&data); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return status.Error(codes.NotFound, "record not found")
		}
		return err
	}
	return proto.Unmarshal(data, message)
}

func save(ctx context.Context, tx *sql.Tx, message proto.Message, query string, args ...any) error {
	data, err := proto.Marshal(message)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, query, append([]any{data}, args...)...)
	return err
}

func event(ctx context.Context, tx *sql.Tx, record *pb.ActivityEvent) error {
	record.ObservedAt = timestamppb.Now()
	return save(ctx, tx, record, "INSERT INTO activity(data, pool, worker) VALUES (?, ?, ?)", record.PoolId, record.WorkerId)
}

func operationEvent(ctx context.Context, tx *sql.Tx, operation *pb.ExecutionOperation, worker string) error {
	return event(ctx, tx, &pb.ActivityEvent{PoolId: operation.PoolId, WorkerId: worker, Update: &pb.ActivityEvent_Operation{Operation: operation}})
}

func workerEvent(ctx context.Context, tx *sql.Tx, worker *pb.Worker) error {
	return event(ctx, tx, &pb.ActivityEvent{PoolId: worker.PoolId, WorkerId: worker.WorkerId, Update: &pb.ActivityEvent_Worker{Worker: worker}})
}

func attemptEvent(ctx context.Context, tx *sql.Tx, attempt *pb.ExecutionAttempt) error {
	return event(ctx, tx, &pb.ActivityEvent{PoolId: attempt.PoolId, WorkerId: attempt.WorkerId, Update: &pb.ActivityEvent_Attempt{Attempt: attempt}})
}

func poolEvent(ctx context.Context, tx *sql.Tx, poolID string) error {
	pool, err := getPool(ctx, tx, poolID)
	if err != nil {
		return err
	}
	return event(ctx, tx, &pb.ActivityEvent{PoolId: poolID, Update: &pb.ActivityEvent_Pool{Pool: pool}})
}

func pause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return status.FromContextError(ctx.Err()).Err()
	case <-timer.C:
		return nil
	}
}

func tokenMatches(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func timestamp(unixNanos int64) *timestamppb.Timestamp {
	return timestamppb.New(time.Unix(0, unixNanos))
}
