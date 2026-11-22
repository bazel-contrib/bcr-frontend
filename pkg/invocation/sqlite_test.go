package invocation

import (
	"context"
	"path/filepath"
	"testing"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

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
	if _, err := db.ExecContext(ctx, "DROP TABLE remote_cache_metrics; PRAGMA user_version = 1"); err != nil {
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
