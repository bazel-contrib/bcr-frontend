package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"strings"
	"testing"
	"time"

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
	listener := bufconn.Listen(1024 * 1024)
	var logs bytes.Buffer
	server := grpc.NewServer()
	buildpb.RegisterPublishBuildEventServer(server, &publishServer{logger: log.New(&logs, "", 0)})
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
	// Both RPCs finished, so the server has completed its log writes.
	if text := logs.String(); !strings.Contains(text, "lifecycle") || strings.Count(text, "build ") != 3 || !strings.Contains(text, "lastMessage") {
		t.Fatalf("missing decoded events in logs: %s", text)
	}
	if _, err := client.PublishLifecycleEvent(ctx, &buildpb.PublishLifecycleEventRequest{}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing event: got %v, want InvalidArgument", err)
	}
}
