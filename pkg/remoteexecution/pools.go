package remoteexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func savePoolSettings(ctx context.Context, tx *sql.Tx, pool PoolConfig) error {
	stored := pool
	stored.Instance = ""
	settings, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	if err := save(ctx, tx, &pb.Pool{
		PoolId: pool.ID, DisplayName: pool.Name, InstanceName: pool.Instance,
		Platform: platformProto(pool.Platform),
	}, "INSERT INTO pools(data,id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", pool.ID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO pool_settings(id,data,instance_name) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET data = excluded.data, instance_name = excluded.instance_name`, pool.ID, settings, pool.Instance)
	return err
}

func readPoolSettings(ctx context.Context, db queryer, id string) (PoolConfig, error) {
	var pool PoolConfig
	var data []byte
	var instance string
	err := db.QueryRowContext(ctx, "SELECT data, instance_name FROM pool_settings WHERE id = ?", id).Scan(&data, &instance)
	if errors.Is(err, sql.ErrNoRows) {
		return pool, status.Error(codes.NotFound, "execution pool not found")
	}
	if err != nil {
		return pool, err
	}
	err = json.Unmarshal(data, &pool)
	pool.Instance = instance
	return pool, err
}

func listPoolSettings(ctx context.Context, db queryer) ([]PoolConfig, error) {
	return queryPoolSettings(ctx, db, "")
}

func queryPoolSettings(ctx context.Context, db queryer, condition string, args ...any) ([]PoolConfig, error) {
	rows, err := db.QueryContext(ctx, "SELECT data, instance_name FROM pool_settings "+condition+" ORDER BY legacy_order NULLS LAST, rowid", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pools := []PoolConfig{}
	for rows.Next() {
		var data []byte
		var instance string
		var pool PoolConfig
		if err := rows.Scan(&data, &instance); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &pool); err != nil {
			return nil, err
		}
		pool.Instance = instance
		pools = append(pools, pool)
	}
	return pools, rows.Err()
}

func priorPoolSettings(ctx context.Context, db queryer) ([]PoolConfig, error) {
	rows, err := db.QueryContext(ctx, "SELECT data FROM pools WHERE id NOT IN (SELECT id FROM pool_settings) ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pools []PoolConfig
	for rows.Next() {
		pool := new(pb.Pool)
		if err := decode(rows, pool); err != nil {
			return nil, err
		}
		settings := PoolConfig{ID: pool.PoolId, Name: pool.DisplayName, Instance: pool.InstanceName, Platform: map[string]string{}}
		for _, property := range pool.Platform.GetProperties() {
			settings.Platform[property.Name] = property.Value
		}
		pools = append(pools, settings)
	}
	return pools, rows.Err()
}

func (s *Scheduler) updatePool(ctx context.Context, settings PoolConfig) error {
	if err := settings.validate(); err != nil {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	if slices.ContainsFunc(s.config.Pools, func(pool PoolConfig) bool { return pool.ID == settings.ID }) {
		return status.Error(codes.FailedPrecondition, "this pool is managed by the scheduler configuration file")
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		if _, err := readInstance(ctx, tx, settings.Instance); err != nil {
			if status.Code(err) == codes.NotFound {
				return status.Error(codes.FailedPrecondition, "create the execution instance before assigning a pool")
			}
			return err
		}
		now := time.Now()
		old, err := readPoolSettings(ctx, tx, settings.ID)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		if err == nil && (old.Instance != settings.Instance || !maps.Equal(old.Platform, settings.Platform) || old.IrohGatewayID != settings.IrohGatewayID) {
			var busy bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM operations WHERE pool = ? AND state != ?)
				OR EXISTS(SELECT 1 FROM workers WHERE pool = ? AND deadline > ?)`, settings.ID, completed, settings.ID, now.UnixNano()).Scan(&busy); err != nil {
				return err
			}
			if busy {
				return status.Error(codes.FailedPrecondition, "stop pool workers and finish pending actions before changing routing or gateway settings")
			}
		}
		for _, worker := range settings.RevokedWorkers {
			if _, err := tx.ExecContext(ctx, "UPDATE workers SET deadline = 0 WHERE pool = ? AND id = ? AND deadline > 0", settings.ID, worker); err != nil {
				return err
			}
		}
		if err := expire(ctx, tx, now); err != nil {
			return err
		}
		if err := savePoolSettings(ctx, tx, settings); err != nil {
			return err
		}
		return poolEvent(ctx, tx, settings.ID)
	})
}
