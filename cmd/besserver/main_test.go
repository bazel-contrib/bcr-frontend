package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	invocationpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

func TestPublish(t *testing.T) {
	storage, err := invocation.OpenSQLite(filepath.Join(t.TempDir(), "events.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	store := invocation.NewStore(storage)
	defer store.Close()
	listener := bufconn.Listen(1024 * 1024)
	var logs bytes.Buffer
	server := grpc.NewServer()
	buildpb.RegisterPublishBuildEventServer(server, &publishServer{logger: log.New(&logs, "", 0), store: store})
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := grpc.NewClient("passthrough:///bes",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client := buildpb.NewPublishBuildEventClient(conn)
	id := &buildpb.StreamId{BuildId: "build", InvocationId: "invocation", Component: buildpb.StreamId_TOOL}
	payload, err := anypb.New(&beppb.BuildEvent{LastMessage: true})
	if err != nil {
		t.Fatal(err)
	}
	event := &buildpb.OrderedBuildEvent{StreamId: id, SequenceNumber: 1,
		Event: &buildpb.BuildEvent{Event: &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}}}
	if _, err := client.PublishLifecycleEvent(ctx, &buildpb.PublishLifecycleEventRequest{BuildEvent: event}); err != nil {
		t.Fatal(err)
	}
	stream, err := client.PublishBuildToolEventStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for sequence := int64(1); sequence <= 3; sequence++ {
		event.SequenceNumber = sequence
		if err := stream.Send(&buildpb.PublishBuildToolEventStreamRequest{OrderedBuildEvent: event}); err != nil {
			t.Fatal(err)
		}
		ack, err := stream.Recv()
		if err != nil {
			t.Fatal(err)
		}
		if ack.SequenceNumber != sequence || !proto.Equal(ack.StreamId, id) {
			t.Fatalf("unexpected acknowledgement: %v", ack)
		}
	}
	if err := stream.CloseSend(); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Recv(); err != io.EOF {
		t.Fatalf("stream close: got %v, want EOF", err)
	}
	inv, err := store.GetInvocation(ctx, &invocationpb.GetInvocationRequest{InvocationId: "invocation"})
	if err != nil || inv.GetState() != invocationpb.InvocationState_INVOCATION_STATE_COMPLETE {
		t.Fatalf("published invocation missing from service: %v %v", inv, err)
	}
	// Both RPCs finished, so the server has completed its log writes.
	if text := logs.String(); !strings.Contains(text, "lifecycle") || strings.Count(text, "build ") != 3 || !strings.Contains(text, "lastMessage") {
		t.Fatalf("missing decoded events in logs: %s", text)
	}
	if _, err := client.PublishLifecycleEvent(ctx, &buildpb.PublishLifecycleEventRequest{}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing event: got %v, want InvalidArgument", err)
	}
}

func TestArchiveReplayFromRemoteCache(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cache, err := remotecache.NewFileCache(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cacheServer := remotecache.NewServer(cache, nil, nil)
	go cacheServer.Serve(listener)
	defer cacheServer.Stop()
	conn, err := dialCache("grpc://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	archive, err := remotecache.NewBlobArchive(conn, "build-events")
	if err != nil {
		t.Fatal(err)
	}
	storage, err := invocation.OpenSQLiteWithArchive(filepath.Join(t.TempDir(), "events.sqlite"), archive)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()

	payload, err := anypb.New(&beppb.BuildEvent{LastMessage: true})
	if err != nil {
		t.Fatal(err)
	}
	event := &buildpb.OrderedBuildEvent{
		StreamId:       &buildpb.StreamId{InvocationId: "completed", BuildId: "build", Component: buildpb.StreamId_TOOL},
		SequenceNumber: 1,
		Event:          &buildpb.BuildEvent{Event: &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}},
	}
	store := invocation.NewStore(storage)
	if err := store.AppendContext(ctx, event, false); err != nil {
		t.Fatal(err)
	}
	if archived, err := store.ArchiveBefore(ctx, time.Now().Add(time.Second)); err != nil || !archived {
		t.Fatalf("archive: %v, %v", archived, err)
	}
	replayed, _, err := storage.Replay(ctx, "completed", 0, 256)
	if err != nil || len(replayed) != 1 || !proto.Equal(replayed[0].GetOrderedEvent(), event) {
		t.Fatalf("replay: %v, %v", replayed, err)
	}
	cacheServer.Stop()
	if _, next, err := storage.Replay(ctx, "completed", 0, 256); status.Code(err) != codes.Unavailable || next != 0 {
		t.Fatalf("archive offline: cursor %d, err %v", next, err)
	}
}
