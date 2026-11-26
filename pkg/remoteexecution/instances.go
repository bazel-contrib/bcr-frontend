package remoteexecution

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const instanceSchema = `
CREATE TABLE execution_instances (
	name TEXT PRIMARY KEY NOT NULL,
	display_name TEXT NOT NULL
);
INSERT INTO execution_instances(name, display_name)
	SELECT DISTINCT coalesce(json_extract(data, '$.instance'), ''), '' FROM pool_settings;
ALTER TABLE pool_settings RENAME TO pool_settings_v2;
CREATE TABLE pool_settings (
	id TEXT PRIMARY KEY REFERENCES pools(id),
	data BLOB NOT NULL,
	legacy_order INTEGER,
	instance_name TEXT NOT NULL REFERENCES execution_instances(name)
);
INSERT INTO pool_settings(rowid, id, data, legacy_order, instance_name)
	SELECT rowid, id, CAST(json_remove(data, '$.instance') AS BLOB), legacy_order,
		coalesce(json_extract(data, '$.instance'), '') FROM pool_settings_v2 ORDER BY rowid;
DROP TABLE pool_settings_v2;
CREATE INDEX pool_settings_instance ON pool_settings(instance_name);
PRAGMA user_version = 3;`

type Instance struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
}

type instanceSummary struct {
	Instance
	schedulerWork
	Pools []schedulerPool `json:"pools"`
}

func validInstanceName(name string) bool {
	if name == "" {
		return true
	}
	for segment := range strings.SplitSeq(name, "/") {
		switch segment {
		case "blobs", "uploads":
			return false
		}
		if !validID.MatchString(segment) {
			return false
		}
	}
	return true
}

func ensureInstance(ctx context.Context, tx *sql.Tx, name string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO execution_instances VALUES (?, '') ON CONFLICT(name) DO NOTHING", name)
	return err
}

func readInstance(ctx context.Context, db queryer, name string) (Instance, error) {
	result := Instance{Name: name}
	err := db.QueryRowContext(ctx, "SELECT display_name FROM execution_instances WHERE name = ?", name).Scan(&result.DisplayName)
	if errors.Is(err, sql.ErrNoRows) {
		return result, status.Error(codes.NotFound, "execution instance not found")
	}
	return result, err
}

func listInstances(ctx context.Context, db queryer) ([]Instance, error) {
	rows, err := db.QueryContext(ctx, "SELECT name, display_name FROM execution_instances ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Instance{}
	for rows.Next() {
		var instance Instance
		if err := rows.Scan(&instance.Name, &instance.DisplayName); err != nil {
			return nil, err
		}
		result = append(result, instance)
	}
	return result, rows.Err()
}

func (s *Scheduler) saveInstance(ctx context.Context, instance Instance) error {
	if !validInstanceName(instance.Name) || len(instance.DisplayName) > 256 {
		return status.Error(codes.InvalidArgument, "invalid execution instance name or display name")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO execution_instances VALUES (?, ?)
		ON CONFLICT(name) DO UPDATE SET display_name = excluded.display_name`, instance.Name, instance.DisplayName)
	return err
}

func (s *Scheduler) listInstanceSummaries(ctx context.Context) ([]instanceSummary, error) {
	result := []instanceSummary{}
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		instances, err := listInstances(ctx, tx)
		if err != nil {
			return err
		}
		settings, err := listPoolSettings(ctx, tx)
		if err != nil {
			return err
		}
		byInstance := make(map[string]int, len(instances))
		for _, instance := range instances {
			byInstance[instance.Name] = len(result)
			result = append(result, instanceSummary{Instance: instance, Pools: []schedulerPool{}})
		}
		for _, pool := range settings {
			info, err := readPoolWork(ctx, tx, pool.ID)
			if err != nil {
				return err
			}
			summary := &result[byInstance[pool.Instance]]
			summary.Pools = append(summary.Pools, info)
			summary.schedulerWork.add(info.schedulerWork)
		}
		return nil
	})
	return result, err
}
