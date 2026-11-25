package invocation

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type testArchive struct {
	blobs map[string][]byte
	err   error
}

func (a *testArchive) Put(_ context.Context, digest string, data []byte) error {
	if a.err != nil {
		return a.err
	}
	a.blobs[digest] = bytes.Clone(data)
	return nil
}

func (a *testArchive) Get(_ context.Context, digest string, _ int64) ([]byte, error) {
	value, ok := a.blobs[digest]
	if !ok {
		return nil, errors.New("blob unavailable")
	}
	return value, nil
}

func appendSummaryEvent(t *testing.T, storage Storage, id string, sequence int64, bep *beppb.BuildEvent) *buildpb.OrderedBuildEvent {
	t.Helper()
	event := testEvent(t, sequence)
	event.StreamId.InvocationId = id
	message, err := anypb.New(bep)
	if err != nil {
		t.Fatal(err)
	}
	event.Event.Event = &buildpb.BuildEvent_BazelEvent{BazelEvent: message}
	if inserted, err := storage.Append(context.Background(), event, false); !inserted || err != nil {
		t.Fatalf("append: %v, %v", inserted, err)
	}
	return event
}

func TestArchiveAndReplayAfterRestart(t *testing.T) {
	ctx := context.Background()
	archive := &testArchive{blobs: map[string][]byte{}, err: errors.New("cache offline")}
	path := filepath.Join(t.TempDir(), "archive.sqlite")
	storage, err := OpenSQLiteWithArchive(path, archive)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if storage != nil {
			storage.Close()
		}
	}()
	metrics := appendSummaryEvent(t, storage, "cold", 1, &beppb.BuildEvent{
		Payload: &beppb.BuildEvent_BuildMetrics{BuildMetrics: &beppb.BuildMetrics{
			TimingMetrics: &beppb.BuildMetrics_TimingMetrics{WallTimeInMs: 123},
		}},
	})
	appendSummaryEvent(t, storage, "hot", 1, &beppb.BuildEvent{})
	finish := appendSummaryEvent(t, storage, "cold", 2, &beppb.BuildEvent{
		LastMessage: true,
		Payload: &beppb.BuildEvent_Finished{Finished: &beppb.BuildFinished{
			ExitCode: &beppb.BuildFinished_ExitCode{Name: "SUCCESS"},
		}},
	})
	cutoff := time.Now().Add(time.Minute)
	store := NewStore(storage)
	if ok, err := store.ArchiveBefore(ctx, cutoff); ok || err == nil {
		t.Fatalf("failed archive: %v, %v", ok, err)
	}
	before, _, err := storage.Replay(ctx, "cold", 0, 10)
	if err != nil || len(before) != 2 {
		t.Fatalf("hot replay after failed upload: %v, %v", before, err)
	}
	archive.err = nil
	if ok, err := store.ArchiveBefore(ctx, cutoff); !ok || err != nil {
		t.Fatalf("archive: %v, %v", ok, err)
	}
	if ok, err := store.ArchiveBefore(ctx, cutoff); ok || err != nil {
		t.Fatalf("should leave running invocation hot: %v, %v", ok, err)
	}
	db := storage.(*sqliteStorage).db
	var archived, wall int
	if err := db.QueryRow("SELECT count(*) FROM events WHERE length(payload)=0 AND archive_cursor IS NOT NULL").Scan(&archived); err != nil || archived != 2 {
		t.Fatalf("archived event rows: %v, %v", archived, err)
	}
	if err := db.QueryRow("SELECT wall_ms FROM build_metrics").Scan(&wall); err != nil || wall != 123 {
		t.Fatalf("archived build metric: %v, %v", wall, err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	storage, err = OpenSQLiteWithArchive(path, archive)
	if err != nil {
		t.Fatal(err)
	}
	first, cursor, err := storage.Replay(ctx, "cold", 0, 1)
	if err != nil || len(first) != 1 || !proto.Equal(first[0], before[0]) || !proto.Equal(first[0].GetOrderedEvent(), metrics) {
		t.Fatalf("first archived event: %v, %v", first, err)
	}
	second, cursor, err := storage.Replay(ctx, "cold", cursor, 10)
	if err != nil || len(second) != 1 || !proto.Equal(second[0], before[1]) || cursor != before[1].GetCursor() {
		t.Fatalf("resumed archived event: %v, %v", second, err)
	}
	if inserted, err := storage.Append(ctx, finish, false); inserted || err != nil {
		t.Fatalf("deduplicate archived retry: %v, %v", inserted, err)
	}
	conflict := proto.Clone(finish).(*buildpb.OrderedBuildEvent)
	conflict.Event.Event = metrics.Event.Event
	if inserted, err := storage.Append(ctx, conflict, false); inserted || status.Code(err) != codes.AlreadyExists {
		t.Fatalf("reject conflicting retry: %v, %v", inserted, err)
	}
	for digest := range archive.blobs {
		delete(archive.blobs, digest)
	}
	if _, next, err := storage.Replay(ctx, "cold", 0, 10); next != 0 || status.Code(err) != codes.Unavailable {
		t.Fatalf("remote outage must preserve the requested cursor: %d, %v", next, err)
	}
}

func TestInvocationPagesAndMetricWindow(t *testing.T) {
	ctx := context.Background()
	storage, err := OpenSQLite(filepath.Join(t.TempDir(), "pages.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	for _, id := range []string{"old", "recent", "running"} {
		appendSummaryEvent(t, storage, id, 1, &beppb.BuildEvent{
			Payload: &beppb.BuildEvent_BuildMetadata{BuildMetadata: &beppb.BuildMetadata{
				Metadata: map[string]string{"igroup": "release"},
			}},
		})
	}
	old, err := storage.Get(ctx, "old")
	if err != nil {
		t.Fatal(err)
	}
	old.CreatedAt = timestamppb.New(time.Now().AddDate(0, 0, -15))
	raw, err := proto.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.(*sqliteStorage).db.Exec("UPDATE invocations SET summary = ?, created_us = ? WHERE id = 'old'",
		raw, old.CreatedAt.AsTime().UnixMicro()); err != nil {
		t.Fatal(err)
	}
	store := NewStore(storage)
	req := &pb.ListInvocationsRequest{InvocationGroup: "release", PageSize: 1}
	for _, want := range []string{"running", "recent", "old"} {
		page, err := store.ListInvocations(ctx, req)
		if err != nil || len(page.GetInvocations()) != 1 || page.Invocations[0].GetInvocationId() != want {
			t.Fatalf("page for %s: %v, %v", want, page, err)
		}
		req.PageToken = page.GetNextPageToken()
		if (want == "old") != (req.PageToken == "") {
			t.Fatalf("unexpected next token after %s", want)
		}
	}
	for days, want := range map[int32]int64{7: 2, 30: 3} {
		metrics, err := store.GetInvocationGroupMetrics(ctx, &pb.GetInvocationGroupMetricsRequest{InvocationGroup: "release", WindowDays: days})
		if err != nil || metrics.GetInvocationCount() != want {
			t.Fatalf("window for %d days: %v, %v", days, metrics, err)
		}
	}
}
