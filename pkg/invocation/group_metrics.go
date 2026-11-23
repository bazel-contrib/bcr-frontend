package invocation

import (
	"context"
	"database/sql"
	"slices"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/protobuf/proto"
)

func summarizeGroup(invocations []*pb.Invocation) *pb.InvocationGroupMetrics {
	metrics := &pb.InvocationGroupMetrics{InvocationCount: int64(len(invocations)), Cache: &pb.GroupCacheMetrics{}}
	var durations []int64
	var totalDuration float64
	var bazelHits int64
	var hasBazelHits bool
	for _, invocation := range invocations {
		if invocation.BazelRemoteCacheHits != nil {
			bazelHits += invocation.GetBazelRemoteCacheHits()
			hasBazelHits = true
		}
		switch invocation.GetState() {
		case pb.InvocationState_INVOCATION_STATE_IN_PROGRESS:
			metrics.RunningCount++
		case pb.InvocationState_INVOCATION_STATE_COMPLETE:
			build := &pb.GroupBuildSample{
				InvocationId: invocation.GetInvocationId(),
				StartedAt:    invocation.GetStartedAt(),
				Status:       invocation.GetResult().GetExitCodeName(),
			}
			if build.StartedAt == nil {
				build.StartedAt = invocation.GetCreatedAt()
			}
			if build.Status == "" {
				build.Status = "UNKNOWN"
			}
			if result := invocation.GetResult(); result != nil && result.ExitCode != nil {
				if result.GetExitCode() == 0 {
					metrics.SucceededCount++
					if build.Status == "UNKNOWN" {
						build.Status = "SUCCESS"
					}
				} else {
					metrics.FailedCount++
					if build.Status == "UNKNOWN" {
						build.Status = "FAILED"
					}
				}
			}
			if invocation.StartedAt != nil && invocation.FinishedAt != nil {
				duration := invocation.FinishedAt.AsTime().Sub(invocation.StartedAt.AsTime())
				if duration >= 0 {
					millis := duration.Milliseconds()
					build.DurationMs = proto.Int64(millis)
					durations = append(durations, millis)
					totalDuration += float64(millis)
				}
			}
			metrics.Builds = append(metrics.Builds, build)
		}
	}
	if hasBazelHits {
		metrics.Cache.BazelRemoteCacheHits = proto.Int64(bazelHits)
	}
	if count := len(durations); count > 0 {
		slices.Sort(durations)
		metrics.TimingSampleCount = int64(count)
		metrics.AverageDurationMs = proto.Float64(totalDuration / float64(count))
		metrics.MedianDurationMs = proto.Float64((float64(durations[(count-1)/2]) + float64(durations[count/2])) / 2)
		metrics.P95DurationMs = proto.Int64(durations[(95*count-1)/100])
	}
	return metrics
}

func (s *journalStorage) GroupMetrics(ctx context.Context, name string) (*pb.InvocationGroupMetrics, error) {
	invocations, err := s.ListByGroup(ctx, name)
	if err != nil {
		return nil, err
	}
	return summarizeGroup(invocations), nil
}

func (s *sqliteStorage) GroupMetrics(ctx context.Context, name string) (*pb.InvocationGroupMetrics, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	invocations, err := listSQLiteInvocations(ctx, tx, sqliteInvocationsByGroup, name)
	if err != nil {
		return nil, err
	}
	metrics := summarizeGroup(invocations)
	if err := readGroupBuildSamples(ctx, tx, name, metrics.Builds); err != nil {
		return nil, err
	}
	cache := metrics.Cache
	err = tx.QueryRowContext(ctx, `SELECT
		coalesce(sum(CASE WHEN m.result = 'hit' THEN m.count END), 0),
		coalesce(sum(CASE WHEN m.result = 'miss' THEN m.count END), 0),
		coalesce(sum(CASE WHEN m.result = 'error' THEN m.count END), 0),
		count(DISTINCT m.invocation_id)
	FROM invocations i JOIN remote_cache_metrics m ON m.invocation_id = i.id
	WHERE i.invocation_group = ? AND m.operation = 'ac_lookup'`, name).Scan(
		&cache.ActionCacheHits, &cache.ActionCacheMisses, &cache.ActionCacheErrors, &cache.ActionCacheInvocationCount)
	if err != nil {
		return nil, err
	}
	metrics.Tests, err = groupTestMetrics(ctx, tx, name)
	if err != nil {
		return nil, err
	}
	return metrics, tx.Commit()
}

func readGroupBuildSamples(ctx context.Context, tx *sql.Tx, name string, builds []*pb.GroupBuildSample) error {
	byID := make(map[string]*pb.GroupBuildSample, len(builds))
	for _, build := range builds {
		byID[build.InvocationId] = build
	}
	rows, err := tx.QueryContext(ctx, `SELECT i.id, m.wall_ms, m.cpu_ms, m.execution_ms, m.critical_path_ms,
		m.actions_executed, m.actions_total, m.targets_configured, m.output_bytes
	FROM invocations i JOIN build_metrics m ON m.cursor = (
		SELECT max(cursor) FROM build_metrics WHERE invocation_id = i.id
	)
	WHERE i.invocation_group = ? AND i.state = ?`, name, pb.InvocationState_INVOCATION_STATE_COMPLETE)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var wall, cpu, execution, path, executed, total, configured, output *int64
		if err := rows.Scan(&id, &wall, &cpu, &execution, &path, &executed, &total, &configured, &output); err != nil {
			return err
		}
		build := byID[id]
		if build.DurationMs == nil {
			build.DurationMs = wall
		}
		build.CpuMs, build.ExecutionMs, build.CriticalPathMs = cpu, execution, path
		build.ActionsExecuted, build.ActionsTotal, build.TargetsConfigured, build.OutputBytes = executed, total, configured, output
	}
	return rows.Err()
}

func groupTestMetrics(ctx context.Context, tx *sql.Tx, name string) (*pb.GroupTestMetrics, error) {
	rows, err := tx.QueryContext(ctx, `WITH latest AS (
		SELECT max(t.cursor) AS cursor
		FROM invocations i JOIN test_summaries t ON t.invocation_id = i.id
		WHERE i.invocation_group = ?
		GROUP BY t.invocation_id, t.label, t.configuration
	)
	SELECT t.label, count(*), sum(t.status = ?) AS flaky_count, sum(t.status IN (?, ?))
	FROM latest JOIN test_summaries t USING (cursor)
	GROUP BY t.label ORDER BY flaky_count DESC, t.label`, name, beppb.TestStatus_FLAKY, beppb.TestStatus_FAILED, beppb.TestStatus_TIMEOUT)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	stats := new(pb.GroupTestMetrics)
	for rows.Next() {
		target := new(pb.GroupFlakyTarget)
		var failures int64
		if err := rows.Scan(&target.Label, &target.SummaryCount, &target.FlakyCount, &failures); err != nil {
			return nil, err
		}
		stats.SummaryCount += target.SummaryCount
		stats.FlakyCount += target.FlakyCount
		stats.FailedOrTimedOutCount += failures
		if target.FlakyCount > 0 && len(stats.FlakyTargets) < 10 {
			stats.FlakyTargets = append(stats.FlakyTargets, target)
		}
	}
	return stats, rows.Err()
}
