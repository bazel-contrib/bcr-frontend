package invocation

import (
	"bytes"
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

const sqliteGroupSchema = `
CREATE TABLE invocation_groups (name TEXT PRIMARY KEY NOT NULL);
ALTER TABLE invocations ADD COLUMN invocation_group TEXT REFERENCES invocation_groups(name);
CREATE INDEX invocations_group_created ON invocations(invocation_group, created_us DESC, id);
PRAGMA user_version = 3;
`

const sqliteArchiveSchema = `
CREATE TABLE event_archives (
    cursor INTEGER PRIMARY KEY REFERENCES events(cursor),
    digest TEXT NOT NULL,
    size INTEGER NOT NULL
);
ALTER TABLE events ADD COLUMN archive_cursor INTEGER REFERENCES event_archives(cursor);
ALTER TABLE events ADD COLUMN ordered_hash BLOB;
ALTER TABLE invocations ADD COLUMN updated_us INTEGER NOT NULL DEFAULT 0;
CREATE INDEX invocations_archive_due ON invocations(state, updated_us, id);
CREATE INDEX events_hot ON events(invocation_id, cursor) WHERE archive_cursor IS NULL;
CREATE INDEX invocations_group_active ON invocations(invocation_group, state, created_us DESC, id);
CREATE INDEX test_summaries_invocation ON test_summaries(invocation_id, label, configuration, cursor);
PRAGMA user_version = 7;
`

type sqliteStorage struct {
	archive BlobArchive
	db      *sql.DB
	lock    *os.File
}

// OpenSQLite opens a local database. One service owns live notifications for
// the database, while other processes can query it using SQLite readers.
func OpenSQLite(path string) (Storage, error) {
	return OpenSQLiteWithArchive(path, nil)
}

func OpenSQLiteWithArchive(path string, archive BlobArchive) (Storage, error) {
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
	storage := &sqliteStorage{db: db, lock: lock, archive: archive}
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
		fallthrough
	case 2:
		if _, err := tx.ExecContext(ctx, sqliteGroupSchema); err != nil {
			return err
		}
		fallthrough
	case 3:
		if version != 0 {
			if err := backfillInvocationSummaries(ctx, tx, version < 3); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "PRAGMA user_version = 4"); err != nil {
			return err
		}
		fallthrough
	case 4:
		if _, err := tx.ExecContext(ctx, "ALTER TABLE invocations ADD COLUMN exit_code_name TEXT"); err != nil {
			return err
		}
		if err := backfillExitCodeNames(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "PRAGMA user_version = 5"); err != nil {
			return err
		}
		fallthrough
	case 5:
		if _, err := tx.ExecContext(ctx, `ALTER TABLE build_metrics ADD COLUMN actions_total INTEGER;
			ALTER TABLE build_metrics ADD COLUMN targets_configured INTEGER;
			ALTER TABLE build_metrics ADD COLUMN output_bytes INTEGER;
			PRAGMA user_version = 6`); err != nil {
			return err
		}
		if err := backfillBuildMetrics(ctx, tx); err != nil {
			return err
		}
		fallthrough
	case 6:
		if _, err := tx.ExecContext(ctx, sqliteArchiveSchema); err != nil {
			return err
		}
		if err := backfillArchiveTimestamps(ctx, tx); err != nil {
			return err
		}
	case 7:
	default:
		return fmt.Errorf("unsupported invocation database schema version %d", version)
	}
	return tx.Commit()
}

func backfillArchiveTimestamps(ctx context.Context, tx *sql.Tx) error {
	runs, err := listSQLiteInvocations(ctx, tx, "SELECT summary FROM invocations")
	if err != nil {
		return err
	}
	for _, run := range runs {
		if _, err := tx.ExecContext(ctx, "UPDATE invocations SET updated_us = ? WHERE id = ?",
			run.GetUpdatedAt().AsTime().UnixMicro(), run.GetInvocationId()); err != nil {
			return err
		}
	}
	return nil
}

func buildMetricCounts(metrics *beppb.BuildMetrics) (actionsTotal, targetsConfigured, outputBytes *int64) {
	// Bazel can omit the action count when analysis was fully cached.
	if total := metrics.GetBuildGraphMetrics().GetActionCount(); total > 0 {
		actionsTotal = proto.Int64(int64(total))
	}
	if targets := metrics.GetTargetMetrics(); targets != nil {
		targetsConfigured = proto.Int64(targets.GetTargetsConfigured())
	}
	if outputs := metrics.GetArtifactMetrics().GetOutputArtifactsSeen(); outputs != nil {
		outputBytes = proto.Int64(outputs.GetSizeInBytes())
	}
	return
}

func backfillBuildMetrics(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT m.cursor, e.payload FROM build_metrics m JOIN events e USING (cursor)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type projection struct {
		cursor                        int64
		actionsTotal, targets, output *int64
	}
	var builds []projection
	for rows.Next() {
		var entry projection
		var data []byte
		if err := rows.Scan(&entry.cursor, &data); err != nil {
			return err
		}
		var event pb.InvocationEvent
		if err := proto.Unmarshal(data, &event); err != nil {
			return err
		}
		entry.actionsTotal, entry.targets, entry.output = buildMetricCounts(decodeBEP(event.GetOrderedEvent()).GetBuildMetrics())
		builds = append(builds, entry)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, entry := range builds {
		if _, err := tx.ExecContext(ctx, `UPDATE build_metrics SET actions_total = ?, targets_configured = ?,
			output_bytes = ? WHERE cursor = ?`, entry.actionsTotal, entry.targets, entry.output, entry.cursor); err != nil {
			return err
		}
	}
	return nil
}

func backfillExitCodeNames(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT summary FROM invocations WHERE exit_code IS NOT NULL")
	if err != nil {
		return err
	}
	defer rows.Close()
	names := make(map[string]string)
	for rows.Next() {
		inv, err := scanInvocation(rows)
		if err != nil {
			return err
		}
		if name := inv.GetResult().GetExitCodeName(); name != "" {
			names[inv.GetInvocationId()] = name
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for id, name := range names {
		if _, err := tx.ExecContext(ctx, "UPDATE invocations SET exit_code_name = ? WHERE id = ?", name, id); err != nil {
			return err
		}
	}
	return nil
}

func backfillInvocationSummaries(ctx context.Context, tx *sql.Tx, backfillGroups bool) error {
	rows, err := tx.QueryContext(ctx, `SELECT invocation_id, payload FROM events
		WHERE invocation_id != '' ORDER BY cursor`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type projection struct {
		group   string
		targets []string
	}
	projections := make(map[string]projection)
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
		bep := decodeBEP(event.GetOrderedEvent())
		current := projections[id]
		if backfillGroups && current.group == "" {
			current.group = invocationGroupName(bep)
		}
		current.targets = appendTargetPatterns(current.targets, bep)
		if current.group != "" || len(current.targets) > 0 {
			projections[id] = current
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for id, projection := range projections {
		inv, err := scanInvocation(tx.QueryRowContext(ctx, "SELECT summary FROM invocations WHERE id = ?", id))
		if err != nil {
			return err
		}
		if projection.group != "" {
			inv.InvocationGroup = projection.group
			if err := ensureInvocationGroup(ctx, tx, projection.group); err != nil {
				return err
			}
		}
		if len(projection.targets) > 0 {
			inv.TargetPatterns = projection.targets
		}
		data, err := proto.Marshal(inv)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE invocations SET invocation_group = NULLIF(?, ''), summary = ? WHERE id = ?", inv.InvocationGroup, data, id); err != nil {
			return err
		}
	}
	return nil
}

func ensureInvocationGroup(ctx context.Context, tx *sql.Tx, name string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO invocation_groups (name) VALUES (?) ON CONFLICT DO NOTHING", name)
	return err
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
	var prior, hash []byte
	err = tx.QueryRowContext(ctx, `SELECT payload, ordered_hash FROM events WHERE invocation_id = ?
		AND build_id = ? AND component = ? AND lifecycle = ? AND sequence = ?`, key...).Scan(&prior, &hash)
	switch {
	case err == nil:
		if hash != nil {
			retry, err := orderedDigest(ordered)
			if err != nil {
				return false, err
			}
			if bytes.Equal(hash, retry) {
				return false, nil
			}
		} else {
			var existing pb.InvocationEvent
			if err := proto.Unmarshal(prior, &existing); err != nil {
				return false, err
			}
			if proto.Equal(existing.OrderedEvent, ordered) {
				return false, nil
			}
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
	previousGroup := inv.InvocationGroup
	applySummary(inv, bep)
	finalizeAttempt(inv, event)
	if inv.InvocationGroup != previousGroup {
		if err := ensureInvocationGroup(ctx, tx, inv.InvocationGroup); err != nil {
			return err
		}
	}
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
		(id, created_us, updated_us, repo, branch, commit_sha, command, state, exit_code, exit_code_name, duration_ms, summary, invocation_group)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), ?, ?, NULLIF(?, ''))
		ON CONFLICT(id) DO UPDATE SET updated_us=excluded.updated_us, repo=excluded.repo, branch=excluded.branch,
		commit_sha=excluded.commit_sha, command=excluded.command, state=excluded.state,
		exit_code=excluded.exit_code, exit_code_name=excluded.exit_code_name,
		duration_ms=excluded.duration_ms, summary=excluded.summary,
		invocation_group=excluded.invocation_group`,
		inv.InvocationId, inv.CreatedAt.AsTime().UnixMicro(), inv.UpdatedAt.AsTime().UnixMicro(), inv.SourceControl.GetRepositoryUrl(),
		inv.SourceControl.GetBranch(), inv.SourceControl.GetCommitSha(), inv.Command,
		inv.State, exitCode, inv.GetResult().GetExitCodeName(), duration, summary, inv.InvocationGroup)
	return err
}

func updateSQLiteStream(ctx context.Context, tx *sql.Tx, inv *pb.Invocation, ordered *buildpb.OrderedBuildEvent, lastBEP bool) error {
	id := ordered.StreamId
	if _, err := tx.ExecContext(ctx, `INSERT INTO tool_streams (invocation_id, build_id)
  VALUES (?, ?) ON CONFLICT DO NOTHING`, id.InvocationId, id.BuildId); err != nil {
		return err
	}
	ended := ordered.Event.GetComponentStreamFinished()
	if ended.GetType() == buildpb.BuildEvent_BuildComponentStreamFinished_EXPIRED {
		if _, err := tx.ExecContext(ctx, `UPDATE tool_streams SET terminal_sequence = 0, missing_through_terminal = NULL
			WHERE invocation_id = ? AND build_id = ?`, id.InvocationId, id.BuildId); err != nil {
			return err
		}
		inv.State = pb.InvocationState_INVOCATION_STATE_INCOMPLETE
	} else if lastBEP || ended != nil {
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
	if !incomplete {
		inv.State = pb.InvocationState_INVOCATION_STATE_COMPLETE
	} else if inv.State != pb.InvocationState_INVOCATION_STATE_INCOMPLETE {
		inv.State = pb.InvocationState_INVOCATION_STATE_IN_PROGRESS
	}
	return nil
}

func (s *sqliteStorage) ExpireIncomplete(ctx context.Context, now, cutoff time.Time, protected func(string) bool) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	runs, err := listSQLiteInvocations(ctx, tx, `SELECT summary FROM invocations
		WHERE state = ? AND updated_us <= ?`, pb.InvocationState_INVOCATION_STATE_IN_PROGRESS, cutoff.UnixMicro())
	if err != nil {
		return 0, err
	}
	count := 0
	for _, run := range runs {
		if protected(run.InvocationId) || run.GetLastEventAt().AsTime().After(cutoff) {
			continue
		}
		run.State = pb.InvocationState_INVOCATION_STATE_INCOMPLETE
		run.UpdatedAt = timestamppb.New(now)
		summary, err := proto.Marshal(run)
		if err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invocations SET state = ?, updated_us = ?, summary = ? WHERE id = ?`,
			run.State, now.UnixMicro(), summary, run.InvocationId); err != nil {
			return 0, err
		}
		count++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return count, nil
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
		actionsTotal, targetsConfigured, outputBytes := buildMetricCounts(metrics)
		_, err := tx.ExecContext(ctx, `INSERT INTO build_metrics
			(cursor, invocation_id, wall_ms, cpu_ms, analysis_ms, execution_ms, critical_path_ms, actions_executed,
			 actions_total, targets_configured, output_bytes)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, cursor, invocationID, wall, cpu, analysis, execution,
			criticalPath, actions, actionsTotal, targetsConfigured, outputBytes)
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
	return listSQLiteInvocations(ctx, s.db, "SELECT summary FROM invocations ORDER BY created_us DESC, id")
}

const sqliteInvocationsByGroup = "SELECT summary FROM invocations WHERE invocation_group = ? ORDER BY created_us DESC, id"

func (s *sqliteStorage) ListByGroup(ctx context.Context, group string) ([]*pb.Invocation, error) {
	return listSQLiteInvocations(ctx, s.db, sqliteInvocationsByGroup, group)
}

func (s *sqliteStorage) ListPage(ctx context.Context, group string, limit int, cursor pageCursor) (*pb.ListInvocationsResponse, error) {
	query := "SELECT summary FROM invocations WHERE 1=1"
	var args []any
	if group != "" {
		query += " AND invocation_group = ?"
		args = append(args, group)
	}
	if cursor.ID != "" {
		query += " AND created_us <= ? AND (created_us < ? OR id > ?)"
		args = append(args, cursor.CreatedUS, cursor.CreatedUS, cursor.ID)
	}
	rows, err := listSQLiteInvocations(ctx, s.db, query+" ORDER BY created_us DESC, id LIMIT ?", append(args, limit+1)...)
	if err != nil {
		return nil, err
	}
	var active *pb.Invocation
	if group != "" && cursor.ID == "" {
		active, err = scanInvocation(s.db.QueryRowContext(ctx, `SELECT summary FROM invocations WHERE invocation_group = ?
			AND state = ? ORDER BY created_us DESC, id LIMIT 1`, group, pb.InvocationState_INVOCATION_STATE_IN_PROGRESS))
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	return pageResponse(group, limit, rows, active), nil
}

func listSQLiteInvocations(ctx context.Context, reader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, args ...any) ([]*pb.Invocation, error) {
	rows, err := reader.QueryContext(ctx, query, args...)
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

func (s *sqliteStorage) ListGroups(ctx context.Context) ([]*pb.InvocationGroup, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT g.name, count(i.invocation_group), max(i.created_us) AS latest
		FROM invocation_groups g LEFT JOIN invocations i ON i.invocation_group = g.name
		GROUP BY g.name ORDER BY latest DESC, g.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var groups []*pb.InvocationGroup
	for rows.Next() {
		group := new(pb.InvocationGroup)
		var count int64
		var latest sql.NullInt64
		if err := rows.Scan(&group.Name, &count, &latest); err != nil {
			return nil, err
		}
		group.InvocationCount = proto.Int64(count)
		if latest.Valid {
			group.LatestInvocationAt = timestamppb.New(time.UnixMicro(latest.Int64))
		}
		groups = append(groups, group)
	}
	return groups, rows.Err()
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
	rows, err := tx.QueryContext(ctx, `SELECT e.cursor, e.payload, a.digest, a.size FROM events e
		LEFT JOIN event_archives a ON a.cursor = e.archive_cursor
		WHERE e.invocation_id = ? AND e.cursor > ? ORDER BY e.cursor LIMIT ?`, id, after, limit)
	if err != nil {
		return nil, after, err
	}
	defer rows.Close()
	var events []*pb.InvocationEvent
	for rows.Next() {
		var cursor uint64
		var data []byte
		var digest sql.NullString
		var size sql.NullInt64
		if err := rows.Scan(&cursor, &data, &digest, &size); err != nil {
			return nil, after, err
		}
		if digest.Valid {
			if len(events) > 0 {
				break // Return the hot prefix first.
			}
			if err := rows.Close(); err != nil {
				return nil, after, err
			}
			if err := tx.Commit(); err != nil {
				return nil, after, err
			}
			events, err := s.replayArchive(ctx, digest.String, size.Int64, after, limit)
			if err != nil {
				return nil, after, err
			}
			if len(events) == 0 || events[0].GetCursor() != cursor {
				return nil, after, status.Error(codes.DataLoss, "archive is missing the expected replay cursor")
			}
			return events, events[len(events)-1].GetCursor(), nil
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
	if len(events) > 0 {
		highWater = events[len(events)-1].GetCursor()
	}
	return events, highWater, nil
}
