package invocation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	_ "modernc.org/sqlite"
)

const sqliteSchema = `
CREATE TABLE events (
    cursor INTEGER PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    build_id TEXT NOT NULL,
    component INTEGER NOT NULL,
    lifecycle INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    payload BLOB NOT NULL,
    UNIQUE (invocation_id, build_id, component, lifecycle, sequence)
);
CREATE INDEX events_replay ON events(invocation_id, cursor);

CREATE TABLE invocations (
    id TEXT PRIMARY KEY,
    created_us INTEGER NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    command TEXT NOT NULL,
    state INTEGER NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    summary BLOB NOT NULL
);
CREATE INDEX invocations_created ON invocations(created_us DESC, id);
CREATE INDEX invocations_repo_created ON invocations(repo, created_us DESC);

CREATE TABLE tool_streams (
    invocation_id TEXT NOT NULL,
    build_id TEXT NOT NULL,
    terminal_sequence INTEGER NOT NULL DEFAULT 0,
    missing_through_terminal INTEGER,
    PRIMARY KEY (invocation_id, build_id)
);

CREATE TABLE test_attempts (
    cursor INTEGER PRIMARY KEY REFERENCES events(cursor),
    invocation_id TEXT NOT NULL,
    label TEXT NOT NULL,
    configuration TEXT NOT NULL,
    run INTEGER NOT NULL,
    shard INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    status INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    cached_locally INTEGER NOT NULL,
    cached_remotely INTEGER NOT NULL
);
CREATE INDEX test_attempts_label ON test_attempts(label, invocation_id);
CREATE INDEX test_attempts_invocation ON test_attempts(invocation_id);

CREATE TABLE test_summaries (
    cursor INTEGER PRIMARY KEY REFERENCES events(cursor),
    invocation_id TEXT NOT NULL,
    label TEXT NOT NULL,
    configuration TEXT NOT NULL,
    status INTEGER NOT NULL
);
CREATE INDEX test_summaries_label ON test_summaries(label, invocation_id);

CREATE TABLE build_metrics (
    cursor INTEGER PRIMARY KEY REFERENCES events(cursor),
    invocation_id TEXT NOT NULL,
    wall_ms INTEGER,
    cpu_ms INTEGER,
    analysis_ms INTEGER,
    execution_ms INTEGER,
    critical_path_ms INTEGER,
    actions_executed INTEGER
);
CREATE INDEX build_metrics_invocation ON build_metrics(invocation_id);
PRAGMA user_version = 1;
`

const sqliteCacheSchema = `
CREATE TABLE remote_cache_metrics (
    invocation_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    result TEXT NOT NULL,
    count INTEGER NOT NULL,
    transferred_bytes INTEGER NOT NULL,
    observed_us INTEGER NOT NULL,
    PRIMARY KEY (invocation_id, operation, result)
);
PRAGMA user_version = 2;
`

type sqliteStorage struct {
	db   *sql.DB
	lock *os.File
}

// OpenSQLite opens a local database. One service owns live notifications for
// the database, while other processes can query it using SQLite readers.
func OpenSQLite(path string) (Storage, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// Resolve existing links so aliases share the same service lock and WAL.
	path, err = filepath.EvalSymlinks(absolute)
	if errors.Is(err, os.ErrNotExist) {
		if _, statErr := os.Lstat(absolute); !errors.Is(statErr, os.ErrNotExist) {
			return nil, err
		}
		dir, dirErr := filepath.EvalSymlinks(filepath.Dir(absolute))
		if dirErr != nil {
			return nil, dirErr
		}
		path = filepath.Join(dir, filepath.Base(absolute))
	} else if err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("lock invocation database: %w", err)
	}
	// Establish private permissions before SQLite creates the database or its WAL.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		lock.Close()
		return nil, err
	}
	dsn := (&url.URL{Scheme: "file", Path: path}).String()
	db, err := sql.Open("sqlite", dsn+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)")
	if err != nil {
		lock.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	storage := &sqliteStorage{db: db, lock: lock}
	if err := storage.initialize(context.Background()); err != nil {
		storage.Close()
		return nil, err
	}
	return storage, nil
}

func (s *sqliteStorage) initialize(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	switch version {
	case 0:
		if _, err := tx.ExecContext(ctx, sqliteSchema); err != nil {
			return err
		}
		fallthrough
	case 1:
		if _, err := tx.ExecContext(ctx, sqliteCacheSchema); err != nil {
			return err
		}
		if version == 1 {
			if err := backfillBazelCacheHits(ctx, tx); err != nil {
				return err
			}
		}
	case 2:
	default:
		return fmt.Errorf("unsupported invocation database schema version %d", version)
	}
	return tx.Commit()
}

func backfillBazelCacheHits(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT m.invocation_id, e.payload FROM build_metrics m
		JOIN events e ON e.cursor = m.cursor ORDER BY m.cursor`)
	if err != nil {
		return err
	}
	defer rows.Close()
	counts := make(map[string]*int64)
	for rows.Next() {
		var id string
		var data []byte
		if err := rows.Scan(&id, &data); err != nil {
			return err
		}
		var event pb.InvocationEvent
		if err := proto.Unmarshal(data, &event); err != nil {
			return err
		}
		if count := bazelRemoteCacheHits(decodeBEP(event.GetOrderedEvent())); count != nil {
			counts[id] = count
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for id, count := range counts {
		inv, err := scanInvocation(tx.QueryRowContext(ctx, "SELECT summary FROM invocations WHERE id = ?", id))
		if err != nil {
			return err
		}
		inv.BazelRemoteCacheHits = count
		data, err := proto.Marshal(inv)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE invocations SET summary = ? WHERE id = ?", data, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *sqliteStorage) observeRemoteCache(ctx context.Context, id string, metrics []*pb.RemoteCacheMetric) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UnixMicro()
	for _, metric := range metrics {
		_, err := tx.ExecContext(ctx, `INSERT INTO remote_cache_metrics
			(invocation_id, operation, result, count, transferred_bytes, observed_us) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (invocation_id, operation, result) DO UPDATE SET
			count = count + excluded.count, transferred_bytes = transferred_bytes + excluded.transferred_bytes,
			observed_us = max(observed_us, excluded.observed_us)`, id, metric.Operation, metric.Result,
			metric.Count, metric.TransferredBytes, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *sqliteStorage) readRemoteCache(ctx context.Context, inv *pb.Invocation) error {
	rows, err := s.db.QueryContext(ctx, `SELECT operation, result, count, transferred_bytes, observed_us
		FROM remote_cache_metrics WHERE invocation_id = ? ORDER BY operation, result`, inv.InvocationId)
	if err != nil {
		return err
	}
	defer rows.Close()
	var stats pb.RemoteCacheStats
	var latest int64
	for rows.Next() {
		metric := new(pb.RemoteCacheMetric)
		var observed int64
		if err := rows.Scan(&metric.Operation, &metric.Result, &metric.Count, &metric.TransferredBytes, &observed); err != nil {
			return err
		}
		stats.Metrics = append(stats.Metrics, metric)
		latest = max(latest, observed)
	}
	if len(stats.Metrics) > 0 {
		stats.ObservedAt = timestamppb.New(time.UnixMicro(latest))
		inv.RemoteCache = &stats
	}
	return rows.Err()
}

func (s *sqliteStorage) Close() error {
	dbErr := s.db.Close()
	return errors.Join(dbErr, s.lock.Close())
}

func (s *sqliteStorage) Append(ctx context.Context, ordered *buildpb.OrderedBuildEvent, lifecycle bool) (bool, error) {
	if err := validateOrderedEvent(ordered, lifecycle); err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	id := ordered.StreamId
	key := []any{id.InvocationId, id.BuildId, id.Component, lifecycle, ordered.SequenceNumber}
	var prior []byte
	err = tx.QueryRowContext(ctx, `SELECT payload FROM events WHERE invocation_id = ?
		AND build_id = ? AND component = ? AND lifecycle = ? AND sequence = ?`, key...).Scan(&prior)
	switch {
	case err == nil:
		var existing pb.InvocationEvent
		if err := proto.Unmarshal(prior, &existing); err != nil {
			return false, err
		}
		if proto.Equal(existing.OrderedEvent, ordered) {
			return false, nil
		}
		return false, status.Error(codes.AlreadyExists, "stream sequence already contains a different event")
	case !errors.Is(err, sql.ErrNoRows):
		return false, err
	}

	// The cursor is stored in the row key and restored on replay.
	event := &pb.InvocationEvent{OrderedEvent: ordered, Lifecycle: lifecycle, ReceivedAt: timestamppb.Now()}
	data, err := proto.Marshal(event)
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO events
		(invocation_id, build_id, component, lifecycle, sequence, payload)
		VALUES (?, ?, ?, ?, ?, ?)`, append(key, data)...)
	if err != nil {
		return false, err
	}
	cursor, err := result.LastInsertId()
	if err != nil {
		return false, err
	}
	if id.InvocationId != "" {
		bep := decodeBEP(ordered)
		if err := updateSQLiteSummary(ctx, tx, event, bep); err != nil {
			return false, err
		}
		if err := projectSQLiteFacts(ctx, tx, cursor, id.InvocationId, bep); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func updateSQLiteSummary(ctx context.Context, tx *sql.Tx, event *pb.InvocationEvent, bep *beppb.BuildEvent) error {
	ordered := event.OrderedEvent
	id := ordered.StreamId
	inv, err := scanInvocation(tx.QueryRowContext(ctx, "SELECT summary FROM invocations WHERE id = ?", id.InvocationId))
	switch {
	case errors.Is(err, sql.ErrNoRows):
		inv = &pb.Invocation{
			InvocationId: id.InvocationId, BuildId: id.BuildId, CreatedAt: event.ReceivedAt,
			State: pb.InvocationState_INVOCATION_STATE_IN_PROGRESS,
		}
	case err != nil:
		return err
	}
	inv.UpdatedAt, inv.LastEventAt = event.ReceivedAt, event.ReceivedAt
	if !event.Lifecycle && id.Component == buildpb.StreamId_TOOL {
		if err := updateSQLiteStream(ctx, tx, inv, ordered, bep.GetLastMessage()); err != nil {
			return err
		}
	}
	applySummary(inv, bep)
	var exitCode, duration any
	if inv.Result != nil && inv.Result.ExitCode != nil {
		exitCode = inv.Result.GetExitCode()
	}
	if inv.StartedAt != nil && inv.FinishedAt != nil {
		duration = inv.FinishedAt.AsTime().Sub(inv.StartedAt.AsTime()).Milliseconds()
	}
	summary, err := proto.Marshal(inv)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO invocations
		(id, created_us, repo, branch, commit_sha, command, state, exit_code, duration_ms, summary)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, branch=excluded.branch,
		commit_sha=excluded.commit_sha, command=excluded.command, state=excluded.state,
		exit_code=excluded.exit_code, duration_ms=excluded.duration_ms, summary=excluded.summary`,
		inv.InvocationId, inv.CreatedAt.AsTime().UnixMicro(), inv.SourceControl.GetRepositoryUrl(),
		inv.SourceControl.GetBranch(), inv.SourceControl.GetCommitSha(), inv.Command,
		inv.State, exitCode, duration, summary)
	return err
}

func updateSQLiteStream(ctx context.Context, tx *sql.Tx, inv *pb.Invocation, ordered *buildpb.OrderedBuildEvent, lastBEP bool) error {
	id := ordered.StreamId
	if _, err := tx.ExecContext(ctx, `INSERT INTO tool_streams (invocation_id, build_id)
  VALUES (?, ?) ON CONFLICT DO NOTHING`, id.InvocationId, id.BuildId); err != nil {
		return err
	}
	if lastBEP || ordered.Event.GetComponentStreamFinished() != nil {
		// Positive sequence numbers and the unique stream key let us count the
		// missing entries once, then decrement for each new event within the range.
		if _, err := tx.ExecContext(ctx, `UPDATE tool_streams SET terminal_sequence = ?,
   missing_through_terminal = ? - (SELECT count(*) FROM events WHERE invocation_id = ?
   AND build_id = ? AND component = ? AND lifecycle = 0 AND sequence <= ?)
   WHERE invocation_id = ? AND build_id = ?`, ordered.SequenceNumber, ordered.SequenceNumber,
			id.InvocationId, id.BuildId, id.Component, ordered.SequenceNumber, id.InvocationId, id.BuildId); err != nil {
			return err
		}
	} else if _, err := tx.ExecContext(ctx, `UPDATE tool_streams
  SET missing_through_terminal = missing_through_terminal - 1
  WHERE invocation_id = ? AND build_id = ? AND terminal_sequence >= ?`,
		id.InvocationId, id.BuildId, ordered.SequenceNumber); err != nil {
		return err
	}
	var incomplete bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM tool_streams WHERE invocation_id = ? AND (missing_through_terminal IS NULL OR missing_through_terminal > 0)
	)`, id.InvocationId).Scan(&incomplete); err != nil {
		return err
	}
	inv.State = pb.InvocationState_INVOCATION_STATE_IN_PROGRESS
	if !incomplete {
		inv.State = pb.InvocationState_INVOCATION_STATE_COMPLETE
	}
	return nil
}

func projectSQLiteFacts(ctx context.Context, tx *sql.Tx, cursor int64, invocationID string, bep *beppb.BuildEvent) error {
	switch {
	case bep.GetTestResult() != nil && bep.GetId().GetTestResult() != nil:
		id, result := bep.GetId().GetTestResult(), bep.GetTestResult()
		duration := result.GetTestAttemptDurationMillis()
		if value := result.GetTestAttemptDuration(); value != nil {
			duration = value.AsDuration().Milliseconds()
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO test_attempts
			(cursor, invocation_id, label, configuration, run, shard, attempt, status, duration_ms, cached_locally, cached_remotely)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, cursor, invocationID, id.Label, id.Configuration.GetId(),
			id.Run, id.Shard, id.Attempt, result.Status, duration, result.CachedLocally, result.GetExecutionInfo().GetCachedRemotely())
		return err
	case bep.GetTestSummary() != nil && bep.GetId().GetTestSummary() != nil:
		id := bep.GetId().GetTestSummary()
		_, err := tx.ExecContext(ctx, `INSERT INTO test_summaries (cursor, invocation_id, label, configuration, status)
			VALUES (?, ?, ?, ?, ?)`, cursor, invocationID, id.Label, id.Configuration.GetId(), bep.GetTestSummary().OverallStatus)
		return err
	case bep.GetBuildMetrics() != nil:
		var wall, cpu, analysis, execution, criticalPath, actions any
		metrics := bep.GetBuildMetrics()
		if timing := metrics.TimingMetrics; timing != nil {
			wall, cpu, analysis, execution = timing.WallTimeInMs, timing.CpuTimeInMs, timing.AnalysisPhaseTimeInMs, timing.ExecutionPhaseTimeInMs
			if value := timing.CriticalPathTime; value != nil {
				criticalPath = value.AsDuration().Milliseconds()
			}
		}
		if summary := metrics.ActionSummary; summary != nil {
			actions = summary.ActionsExecuted
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO build_metrics
			(cursor, invocation_id, wall_ms, cpu_ms, analysis_ms, execution_ms, critical_path_ms, actions_executed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, cursor, invocationID, wall, cpu, analysis, execution, criticalPath, actions)
		return err
	}
	return nil
}

func scanInvocation(row interface{ Scan(...any) error }) (*pb.Invocation, error) {
	var data []byte
	if err := row.Scan(&data); err != nil {
		return nil, err
	}
	inv := new(pb.Invocation)
	return inv, proto.Unmarshal(data, inv)
}

func (s *sqliteStorage) Get(ctx context.Context, id string) (*pb.Invocation, error) {
	inv, err := scanInvocation(s.db.QueryRowContext(ctx, "SELECT summary FROM invocations WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, status.Error(codes.NotFound, "invocation not found")
	}
	if err != nil {
		return nil, err
	}
	return inv, s.readRemoteCache(ctx, inv)
}

func (s *sqliteStorage) List(ctx context.Context) ([]*pb.Invocation, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT summary FROM invocations ORDER BY created_us DESC, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var invocations []*pb.Invocation
	for rows.Next() {
		inv, err := scanInvocation(rows)
		if err != nil {
			return nil, err
		}
		invocations = append(invocations, inv)
	}
	return invocations, rows.Err()
}

func (s *sqliteStorage) Replay(ctx context.Context, id string, after uint64, limit int) ([]*pb.InvocationEvent, uint64, error) {
	if limit <= 0 {
		return nil, after, status.Error(codes.InvalidArgument, "replay limit must be positive")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, after, err
	}
	defer tx.Rollback()
	var highWater uint64
	if err := tx.QueryRowContext(ctx, "SELECT coalesce(max(cursor), 0) FROM events").Scan(&highWater); err != nil {
		return nil, after, err
	}
	if after > highWater {
		return nil, after, status.Error(codes.OutOfRange, "cursor exceeds event store")
	}
	rows, err := tx.QueryContext(ctx, `SELECT cursor, payload FROM events
		WHERE invocation_id = ? AND cursor > ? ORDER BY cursor LIMIT ?`, id, after, limit)
	if err != nil {
		return nil, after, err
	}
	defer rows.Close()
	var events []*pb.InvocationEvent
	for rows.Next() {
		var cursor uint64
		var data []byte
		if err := rows.Scan(&cursor, &data); err != nil {
			return nil, after, err
		}
		event := new(pb.InvocationEvent)
		if err := proto.Unmarshal(data, event); err != nil {
			return nil, after, err
		}
		event.Cursor = cursor
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, after, err
	}
	if len(events) == limit {
		highWater = events[len(events)-1].Cursor
	}
	return events, highWater, nil
}
