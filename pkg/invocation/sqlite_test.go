package invocation

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"testing"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Discard projections added after schema version 5 when testing older migrations.
const dropBuildMetricCounts = `
	DROP INDEX invocations_group_active;
	DROP INDEX test_summaries_invocation;
	DROP INDEX events_hot;
	DROP INDEX invocations_archive_due;
	ALTER TABLE invocations DROP COLUMN updated_us;
	ALTER TABLE events DROP COLUMN ordered_hash;
	ALTER TABLE events DROP COLUMN archive_cursor;
	DROP TABLE event_archives;
	ALTER TABLE build_metrics DROP COLUMN actions_total;
	ALTER TABLE build_metrics DROP COLUMN targets_configured;
	ALTER TABLE build_metrics DROP COLUMN output_bytes;
`

func TestSQLiteBackfillsExitCodeName(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "invocations.sqlite")
	storage, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if storage != nil {
			storage.Close()
		}
	}()
	event := testEvent(t, 1)
	payload, err := anypb.New(&beppb.BuildEvent{Payload: &beppb.BuildEvent_Finished{
		Finished: &beppb.BuildFinished{
			ExitCode: &beppb.BuildFinished_ExitCode{Code: 3, Name: "TESTS_FAILED"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
	if _, err := storage.Append(ctx, event, false); err != nil {
		t.Fatal(err)
	}
	checkResult := func() {
		t.Helper()
		db := storage.(*sqliteStorage).db
		var code int32
		var name string
		if err := db.QueryRowContext(ctx, "SELECT exit_code, exit_code_name FROM invocations WHERE id = 'invocation'").Scan(&code, &name); err != nil {
			t.Fatal(err)
		}
		if code != 3 || name != "TESTS_FAILED" {
			t.Fatalf("exit result = (%d, %q), want (3, TESTS_FAILED)", code, name)
		}
	}
	checkResult()
	db := storage.(*sqliteStorage).db
	if _, err := db.ExecContext(ctx, dropBuildMetricCounts+`ALTER TABLE invocations DROP COLUMN exit_code_name; PRAGMA user_version = 4`); err != nil {
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	storage, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	checkResult()
}

func TestSQLiteKeepsIncompleteStateAndBuildResultAfterRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "events.sqlite")
	storage, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(storage)
	event := testEvent(t, 1)
	finish := timestamppb.Now()
	payload, err := anypb.New(&beppb.BuildEvent{Payload: &beppb.BuildEvent_Finished{
		Finished: &beppb.BuildFinished{
			FinishTime: finish,
			ExitCode:   &beppb.BuildFinished_ExitCode{Name: "SUCCESS"},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
	if err := store.Append(event, false); err != nil {
		t.Fatal(err)
	}
	if count, err := store.ExpireIncomplete(ctx, time.Now().Add(time.Hour), time.Minute); err != nil || count != 1 {
		t.Fatalf("expire count %d: %v", count, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	storage, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	inv, err := storage.Get(ctx, event.StreamId.InvocationId)
	if err != nil || inv.GetState() != pb.InvocationState_INVOCATION_STATE_INCOMPLETE ||
		inv.GetResult().GetExitCodeName() != "SUCCESS" || !proto.Equal(inv.GetFinishedAt(), finish) {
		t.Fatalf("stored invocation: %v, %v", inv, err)
	}
}

func TestSQLiteDurableEventsAndFacts(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "events ?#.sqlite")
	storage, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	// Check the projections through SQLite itself as an analytics client would.
	db := storage.(*sqliteStorage).db
	defer func() { storage.Close() }()
	appendEvent := func(event *buildpb.OrderedBuildEvent) {
		t.Helper()
		if inserted, err := storage.Append(ctx, event, false); !inserted || err != nil {
			t.Fatalf("append: inserted=%v, err=%v", inserted, err)
		}
	}
	withBEP := func(sequence int64, bep *beppb.BuildEvent) *buildpb.OrderedBuildEvent {
		t.Helper()
		event := testEvent(t, sequence)
		payload, err := anypb.New(bep)
		if err != nil {
			t.Fatal(err)
		}
		event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
		return event
	}

	appendEvent(testEvent(t, 1))
	other := testEvent(t, 1)
	other.StreamId.InvocationId = "other"
	appendEvent(other)
	attempt := withBEP(2, &beppb.BuildEvent{
		Id: &beppb.BuildEventId{Id: &beppb.BuildEventId_TestResult{TestResult: &beppb.BuildEventId_TestResultId{
			Label: "//example:test", Run: 1, Shard: 2, Attempt: 3,
		}}},
		Payload: &beppb.BuildEvent_TestResult{TestResult: &beppb.TestResult{
			Status: beppb.TestStatus_FLAKY, TestAttemptDurationMillis: 27,
		}},
	})
	appendEvent(attempt)
	metrics := withBEP(3, &beppb.BuildEvent{Payload: &beppb.BuildEvent_BuildMetrics{
		BuildMetrics: &beppb.BuildMetrics{TimingMetrics: &beppb.BuildMetrics_TimingMetrics{WallTimeInMs: 123}},
	}})
	// Force a projection failure and check that the raw event rolls back too.
	if _, err := db.ExecContext(ctx, `CREATE TEMP TRIGGER reject_metrics BEFORE INSERT ON build_metrics
		BEGIN SELECT RAISE(ABORT, 'test rollback'); END`); err != nil {
		t.Fatal(err)
	}
	if inserted, err := storage.Append(ctx, metrics, false); inserted || err == nil {
		t.Fatalf("projection failure: inserted=%v, err=%v", inserted, err)
	}
	if _, err := db.ExecContext(ctx, "DROP TRIGGER reject_metrics"); err != nil {
		t.Fatal(err)
	}
	appendEvent(metrics)
	if _, err := OpenSQLite(path); err == nil {
		t.Fatal("second service opened the same database")
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	storage = reopened
	db = storage.(*sqliteStorage).db
	inv, err := storage.Get(ctx, "invocation")
	if err != nil || inv.GetCommand() != "test" {
		t.Fatalf("stored summary: %v, %v", inv, err)
	}
	if inserted, err := storage.Append(ctx, attempt, false); inserted || err != nil {
		t.Fatalf("identical retry: inserted=%v, err=%v", inserted, err)
	}
	if _, err := storage.Append(ctx, testEvent(t, 2), false); status.Code(err) != codes.AlreadyExists {
		t.Fatalf("conflicting retry: %v", err)
	}
	events, next, err := storage.Replay(ctx, "invocation", 1, 1)
	if err != nil || len(events) != 1 || next != 3 || !proto.Equal(events[0].OrderedEvent, attempt) {
		t.Fatalf("filtered replay: %v, next=%d, err=%v", events, next, err)
	}
	events, next, err = storage.Replay(ctx, "invocation", next, 10)
	if err != nil || len(events) != 1 || next != 4 || !proto.Equal(events[0].OrderedEvent, metrics) {
		t.Fatalf("resumed replay: %v, next=%d, err=%v", events, next, err)
	}
	var count, duration, wall int
	if err := db.QueryRowContext(ctx, `SELECT count(*), sum(duration_ms) FROM test_attempts
		WHERE label = '//example:test' AND shard = 2 AND attempt = 3 AND status = ?`,
		beppb.TestStatus_FLAKY).Scan(&count, &duration); err != nil || count != 1 || duration != 27 {
		t.Fatalf("attempt projection: count=%d, duration=%d, err=%v", count, duration, err)
	}
	if err := db.QueryRowContext(ctx, "SELECT wall_ms FROM build_metrics WHERE invocation_id = 'invocation'").Scan(&wall); err != nil || wall != 123 {
		t.Fatalf("metrics projection: wall=%d, err=%v", wall, err)
	}
}

func TestInvocationGroupMetrics(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "metrics.sqlite")
	storage, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { storage.Close() }()
	store := NewStore(storage)
	sequences := make(map[string]int64)
	appendEvent := func(id string, bep *beppb.BuildEvent) {
		t.Helper()
		sequences[id]++
		event := testEvent(t, sequences[id])
		event.StreamId.InvocationId = id
		payload, err := anypb.New(bep)
		if err != nil {
			t.Fatal(err)
		}
		event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
		if err := store.Append(event, false); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Unix(1000, 0)
	begin := func(id, group string) {
		appendEvent(id, &beppb.BuildEvent{Payload: &beppb.BuildEvent_Started{Started: &beppb.BuildStarted{
			StartTime: timestamppb.New(start),
		}}})
		appendEvent(id, &beppb.BuildEvent{Payload: &beppb.BuildEvent_BuildMetadata{BuildMetadata: &beppb.BuildMetadata{
			Metadata: map[string]string{"igroup": group},
		}}})
	}
	finish := func(id string, duration time.Duration, code int32) {
		appendEvent(id, &beppb.BuildEvent{LastMessage: true, Payload: &beppb.BuildEvent_Finished{
			Finished: &beppb.BuildFinished{
				FinishTime: timestamppb.New(start.Add(duration)),
				ExitCode:   &beppb.BuildFinished_ExitCode{Code: code, Name: map[int32]string{1: "BUILD_FAILURE"}[code]},
			},
		}})
	}
	testSummary := func(id, label string, status beppb.TestStatus) {
		appendEvent(id, &beppb.BuildEvent{
			Id: &beppb.BuildEventId{Id: &beppb.BuildEventId_TestSummary{
				TestSummary: &beppb.BuildEventId_TestSummaryId{Label: label},
			}},
			Payload: &beppb.BuildEvent_TestSummary{TestSummary: &beppb.TestSummary{OverallStatus: status}},
		})
	}
	for _, id := range []string{"fast", "slow", "running"} {
		begin(id, "release")
	}
	begin("other", "continuous")
	testSummary("fast", "//:test", beppb.TestStatus_PASSED)
	testSummary("fast", "//:test", beppb.TestStatus_FLAKY)
	testSummary("slow", "//:test", beppb.TestStatus_TIMEOUT)
	testSummary("other", "//:unrelated", beppb.TestStatus_FLAKY)
	appendEvent("fast", &beppb.BuildEvent{Payload: &beppb.BuildEvent_BuildMetrics{BuildMetrics: &beppb.BuildMetrics{
		ActionSummary:     &beppb.BuildMetrics_ActionSummary{RemoteCacheHits: 2},
		BuildGraphMetrics: &beppb.BuildMetrics_BuildGraphMetrics{ActionCount: 12},
		TargetMetrics:     &beppb.BuildMetrics_TargetMetrics{TargetsConfigured: 7},
		ArtifactMetrics: &beppb.BuildMetrics_ArtifactMetrics{
			OutputArtifactsSeen: &beppb.BuildMetrics_ArtifactMetrics_FilesMetric{SizeInBytes: 12345},
		},
		TimingMetrics: &beppb.BuildMetrics_TimingMetrics{
			WallTimeInMs: 999, CpuTimeInMs: 600, ExecutionPhaseTimeInMs: 700,
			CriticalPathTime: durationpb.New(500 * time.Millisecond),
		},
	}}})
	finish("fast", time.Second, 0)
	finish("slow", 3*time.Second, 1)
	finish("other", 10*time.Second, 0)
	observe := func(id string, hits, misses, errors int64) {
		t.Helper()
		if err := store.ObserveRemoteCache(ctx, id, []*pb.RemoteCacheMetric{
			{Operation: "ac_lookup", Result: "hit", Count: hits},
			{Operation: "ac_lookup", Result: "miss", Count: misses},
			{Operation: "ac_lookup", Result: "error", Count: errors},
			{Operation: "cas_read", Result: "hit", Count: 999},
		}); err != nil {
			t.Fatal(err)
		}
	}
	observe("fast", 2, 2, 1)
	observe("slow", 7, 1, 0)
	observe("other", 100, 0, 0)
	metrics, err := store.GetInvocationGroupMetrics(ctx, &pb.GetInvocationGroupMetricsRequest{InvocationGroup: "release"})
	if err != nil {
		t.Fatal(err)
	}
	if metrics.InvocationCount != 3 || metrics.RunningCount != 1 || metrics.SucceededCount != 1 || metrics.FailedCount != 1 ||
		metrics.TimingSampleCount != 2 || metrics.GetAverageDurationMs() != 2000 || metrics.GetMedianDurationMs() != 2000 ||
		metrics.GetP95DurationMs() != 3000 {
		t.Fatalf("build metrics: %v", metrics)
	}
	cache := metrics.GetCache()
	if cache.ActionCacheHits != 9 || cache.ActionCacheMisses != 3 || cache.ActionCacheErrors != 1 ||
		cache.ActionCacheInvocationCount != 2 || cache.GetBazelRemoteCacheHits() != 2 {
		t.Fatalf("cache metrics: %v", cache)
	}
	tests := metrics.GetTests()
	if tests.SummaryCount != 2 || tests.FlakyCount != 1 || tests.FailedOrTimedOutCount != 1 ||
		len(tests.FlakyTargets) != 1 || tests.FlakyTargets[0].Label != "//:test" || tests.FlakyTargets[0].SummaryCount != 2 {
		t.Fatalf("test metrics: %v", tests)
	}
	empty, err := store.GetInvocationGroupMetrics(ctx, &pb.GetInvocationGroupMetricsRequest{InvocationGroup: "empty"})
	if err != nil || empty.GetInvocationCount() != 0 || empty.AverageDurationMs != nil || empty.GetCache().BazelRemoteCacheHits != nil {
		t.Fatalf("empty group metrics: %v, %v", empty, err)
	}
	checkBuilds := func(builds []*pb.GroupBuildSample) {
		t.Helper()
		if len(builds) != 2 {
			t.Fatalf("got %d build samples, want 2", len(builds))
		}
		for _, build := range builds {
			switch build.InvocationId {
			case "fast":
				if build.Status != "SUCCESS" || !build.StartedAt.AsTime().Equal(start) || build.GetDurationMs() != 1000 ||
					build.GetActionsTotal() != 12 || build.GetTargetsConfigured() != 7 || build.GetOutputBytes() != 12345 ||
					build.ActionsExecuted == nil || build.GetActionsExecuted() != 0 || build.GetCpuMs() != 600 ||
					build.GetExecutionMs() != 700 || build.GetCriticalPathMs() != 500 {
					t.Fatalf("fast metrics: %v", build)
				}
			case "slow":
				if build.Status != "BUILD_FAILURE" || build.GetDurationMs() != 3000 ||
					build.ActionsExecuted != nil || build.OutputBytes != nil {
					t.Fatalf("slow metrics: %v", build)
				}
			default:
				t.Fatalf("unexpected build sample: %v", build)
			}
		}
	}
	checkBuilds(metrics.Builds)
	if _, err := storage.(*sqliteStorage).db.ExecContext(ctx, dropBuildMetricCounts+`PRAGMA user_version = 5`); err != nil {
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	storage, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	metrics, err = NewStore(storage).GetInvocationGroupMetrics(ctx, &pb.GetInvocationGroupMetricsRequest{InvocationGroup: "release"})
	if err != nil {
		t.Fatal(err)
	}
	checkBuilds(metrics.Builds)
}

func TestSQLiteMigratesBazelCacheHitsAndRetainsRemoteTelemetry(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "events.sqlite")
	storage, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	event := testEvent(t, 1)
	payload, err := anypb.New(&beppb.BuildEvent{Payload: &beppb.BuildEvent_BuildMetrics{
		BuildMetrics: &beppb.BuildMetrics{ActionSummary: &beppb.BuildMetrics_ActionSummary{
			RunnerCount: []*beppb.BuildMetrics_ActionSummary_RunnerCount{
				{Name: "local", Count: 3}, {Name: "remote cache hit", Count: 2},
			},
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
	if _, err := storage.Append(ctx, event, false); err != nil {
		t.Fatal(err)
	}
	inv, err := storage.Get(ctx, "invocation")
	if err != nil || inv.GetBazelRemoteCacheHits() != 2 {
		t.Fatalf("initial summary: %v, %v", inv, err)
	}
	inv.BazelRemoteCacheHits = nil
	data, err := proto.Marshal(inv)
	if err != nil {
		t.Fatal(err)
	}
	db := storage.(*sqliteStorage).db
	if _, err := db.ExecContext(ctx, "UPDATE invocations SET summary = ?", data); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, dropBuildMetricCounts+`DROP TABLE remote_cache_metrics;
		DROP INDEX invocations_group_created;
		ALTER TABLE invocations DROP COLUMN invocation_group;
		ALTER TABLE invocations DROP COLUMN exit_code_name;
		DROP TABLE invocation_groups;
		PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}

	storage, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	inv, err = storage.Get(ctx, "invocation")
	if err != nil || inv.GetBazelRemoteCacheHits() != 2 || inv.RemoteCache != nil {
		t.Fatalf("migrated summary: %v, %v", inv, err)
	}
	store := NewStore(storage)
	for range 2 {
		if err := store.ObserveRemoteCache(ctx, "invocation", []*pb.RemoteCacheMetric{
			{Operation: "cas_read", Result: "hit", Count: 1, TransferredBytes: 20},
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	storage, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	inv, err = storage.Get(ctx, "invocation")
	metrics := inv.GetRemoteCache().GetMetrics()
	if err != nil || len(metrics) != 1 || metrics[0].Count != 2 || metrics[0].TransferredBytes != 40 {
		t.Fatalf("retained cache telemetry: %v, %v", metrics, err)
	}
}

func TestSQLiteInvocationGroups(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "events.sqlite")
	storage, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { storage.Close() }()
	store := NewStore(storage)
	appendGroup := func(id, name string, sequence int64) {
		t.Helper()
		event := testEvent(t, sequence)
		event.StreamId.InvocationId = id
		payload, err := anypb.New(&beppb.BuildEvent{Payload: &beppb.BuildEvent_BuildMetadata{
			BuildMetadata: &beppb.BuildMetadata{Metadata: map[string]string{"igroup": name}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
		if err := store.Append(event, false); err != nil {
			t.Fatal(err)
		}
	}
	appendGroup("first", "release", 1)
	appendGroup("second", "release", 1)
	appendGroup("third", "z-continuous", 1)
	appendGroup("fourth", "../invalid", 1)
	appendGroup("first", "changed", 2)
	pattern := &beppb.BuildEventId{Id: &beppb.BuildEventId_Pattern{
		Pattern: &beppb.BuildEventId_PatternExpandedId{Pattern: []string{"//:one", "//:two"}},
	}}
	started := &beppb.BuildEvent{
		Children: []*beppb.BuildEventId{pattern},
		Payload:  &beppb.BuildEvent_Started{Started: &beppb.BuildStarted{Command: "build"}},
	}
	for i, bep := range []*beppb.BuildEvent{started, {Id: pattern}} {
		event := testEvent(t, int64(i+3))
		event.StreamId.InvocationId = "first"
		payload, err := anypb.New(bep)
		if err != nil {
			t.Fatal(err)
		}
		event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}
		if err := store.Append(event, false); err != nil {
			t.Fatal(err)
		}
	}

	checkGroups := func() {
		t.Helper()
		groups, err := store.ListInvocationGroups(ctx, &pb.ListInvocationGroupsRequest{})
		if err != nil || len(groups.GetGroups()) != 2 || groups.Groups[0].Name != "z-continuous" || groups.Groups[1].Name != "release" {
			t.Fatalf("list groups: %v, %v", groups, err)
		}
		if groups.Groups[0].GetInvocationCount() != 1 || groups.Groups[1].GetInvocationCount() != 2 {
			t.Fatalf("group counts: %v", groups)
		}
		third, err := storage.Get(ctx, "third")
		if err != nil || groups.Groups[0].GetLatestInvocationAt() == nil ||
			groups.Groups[0].GetLatestInvocationAt().AsTime().UnixMicro() != third.GetCreatedAt().AsTime().UnixMicro() {
			t.Fatalf("latest z-continuous invocation: groups=%v, invocation=%v, error=%v", groups, third, err)
		}
		release, err := store.ListInvocations(ctx, &pb.ListInvocationsRequest{InvocationGroup: "release"})
		if err != nil || len(release.GetInvocations()) != 2 || release.Invocations[0].InvocationId != "second" ||
			release.Invocations[1].InvocationId != "first" || release.Invocations[1].InvocationGroup != "release" {
			t.Fatalf("release membership: %v, %v", release, err)
		}
		if groups.Groups[1].GetLatestInvocationAt() == nil ||
			groups.Groups[1].GetLatestInvocationAt().AsTime().UnixMicro() != release.Invocations[0].GetCreatedAt().AsTime().UnixMicro() {
			t.Fatalf("latest release invocation: groups=%v, invocations=%v", groups, release)
		}
		first := release.Invocations[1]
		if first.Command != "build" || !slices.Equal(first.TargetPatterns, []string{"//:one", "//:two"}) {
			t.Fatalf("release command: %v", first)
		}
	}
	checkGroups()

	handler := store.Handler("http://localhost:8080")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/invocations?group=release", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("HTTP group filter: %d %s", recorder.Code, recorder.Body)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/invocations?group=../invalid", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid HTTP group filter: %d", recorder.Code)
	}

	// Reopen a version-two database without the group and target projections.
	db := storage.(*sqliteStorage).db
	summary, err := storage.Get(ctx, "first")
	if err != nil {
		t.Fatal(err)
	}
	summary.TargetPatterns = nil
	data, err := proto.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE invocations SET summary = ? WHERE id = 'first'", data); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, dropBuildMetricCounts+`DROP INDEX invocations_group_created;
		ALTER TABLE invocations DROP COLUMN invocation_group;
		ALTER TABLE invocations DROP COLUMN exit_code_name;
		DROP TABLE invocation_groups;
		PRAGMA user_version = 2`); err != nil {
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	storage, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	store = NewStore(storage)
	checkGroups()
}
