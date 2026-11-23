package invocation

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
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

func testEvent(t *testing.T, sequence int64) *buildpb.OrderedBuildEvent {
	t.Helper()
	payload, err := anypb.New(&beppb.BuildEvent{Payload: &beppb.BuildEvent_Started{Started: &beppb.BuildStarted{Command: "test"}}})
	if err != nil {
		t.Fatal(err)
	}
	return &buildpb.OrderedBuildEvent{StreamId: &buildpb.StreamId{BuildId: "build", InvocationId: "invocation", Component: buildpb.StreamId_TOOL},
		SequenceNumber: sequence, Event: &buildpb.BuildEvent{Event: &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}}}
}

func TestJournalRecoveryAndRetries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	event := testEvent(t, 1)
	if err := store.Append(event, false); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(event, false); err != nil {
		t.Fatal(err)
	}
	conflict := proto.Clone(event).(*buildpb.OrderedBuildEvent)
	conflict.Event = &buildpb.BuildEvent{}
	if err := store.Append(conflict, false); status.Code(err) != codes.AlreadyExists {
		t.Fatalf("conflict: %v", err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("second writer acquired journal")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("partial"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	store, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if events, _, _, err := store.batch(context.Background(), "invocation", 0); err != nil || len(events) != 1 {
		t.Fatalf("replay count = %d, err = %v", len(events), err)
	}
	inv, err := store.GetInvocation(context.Background(), &pb.GetInvocationRequest{InvocationId: "invocation"})
	if err != nil || inv.Command != "test" {
		t.Fatalf("summary recovery: %v %v", inv, err)
	}
	if err := store.Append(testEvent(t, 2), false); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.batch(context.Background(), "invocation", 999); status.Code(err) != codes.OutOfRange {
		t.Fatal(err)
	}
}

func checkWatchReplayThenLive(t *testing.T, store *Store) {
	if err := store.Append(testEvent(t, 1), false); err != nil {
		t.Fatal(err)
	}
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	pb.RegisterInvocationServiceServer(server, store)
	go server.Serve(listener)
	defer server.Stop()
	conn, err := grpc.NewClient("passthrough:///invocations", grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := pb.NewInvocationServiceClient(conn)
	list, err := client.ListInvocations(ctx, &pb.ListInvocationsRequest{})
	if err != nil || len(list.GetInvocations()) != 1 {
		t.Fatalf("list: %v %v", list, err)
	}
	stream, err := client.WatchInvocation(ctx, &pb.WatchInvocationRequest{InvocationId: "invocation"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := stream.Recv()
	if err != nil || first.GetCursor() != 1 {
		t.Fatalf("replay: %v %v", first, err)
	}
	if err := store.Append(testEvent(t, 2), false); err != nil {
		t.Fatal(err)
	}
	next, err := stream.Recv()
	if err != nil || next.GetCursor() != 2 {
		t.Fatalf("live: %v %v", next, err)
	}
	resumed, err := client.WatchInvocation(ctx, &pb.WatchInvocationRequest{InvocationId: "invocation", AfterCursor: 1})
	if err != nil {
		t.Fatal(err)
	}
	next, err = resumed.Recv()
	if err != nil || next.GetCursor() != 2 {
		t.Fatalf("resume: %v %v", next, err)
	}
}

func checkBrowserReplayAndLive(t *testing.T, store *Store) {
	if err := store.Append(testEvent(t, 1), false); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(store.Handler("http://localhost:8080"))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/invocations/invocation/events", nil)
	req.Header.Set("Origin", "http://localhost:8080")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Access-Control-Allow-Origin") != "http://localhost:8080" {
		t.Fatal("missing CORS header")
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func(wantID string) int64 {
		t.Helper()
		var id, kind, payload string
		var received int64
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(line, "id: ") {
				id = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
			}
			if strings.HasPrefix(line, "event: ") {
				kind = strings.TrimSpace(strings.TrimPrefix(line, "event: "))
			}
			if strings.HasPrefix(line, "data: ") {
				payload = strings.TrimSpace(strings.TrimPrefix(line, "data: "))
			}
			if line == "\n" && payload != "" {
				if kind == "bep-time" {
					fields := strings.Fields(payload)
					if len(fields) != 3 || fields[0] != wantID || id != "" {
						t.Fatalf("timing frame changed cursor or had invalid payload: %q %q", id, payload)
					}
					var parseErr error
					received, parseErr = strconv.ParseInt(fields[1], 10, 64)
					sent, sentErr := strconv.ParseInt(fields[2], 10, 64)
					if parseErr != nil || sentErr != nil || received <= 0 || sent < received {
						t.Fatalf("invalid event timing: %q", payload)
					}
					kind, payload = "", ""
					continue
				}
				break
			}
		}
		if id != wantID || kind != "bep" || received == 0 {
			t.Fatalf("BEP frame: cursor %s, kind %s, received %d, want cursor %s", id, kind, received, wantID)
		}
		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			t.Fatal(err)
		}
		bep := new(beppb.BuildEvent)
		if err := proto.Unmarshal(data, bep); err != nil || bep.GetStarted().GetCommand() != "test" {
			t.Fatalf("browser payload: %v %v", bep, err)
		}
		return received
	}
	readEvent("1")
	if err := store.Append(testEvent(t, 2), false); err != nil {
		t.Fatal(err)
	}
	receipt := readEvent("2")
	response.Body.Close()
	req, _ = http.NewRequestWithContext(ctx, "GET", server.URL+"/api/invocations/invocation/events", nil)
	req.Header.Set("Last-Event-ID", "1")
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader = bufio.NewReader(response.Body)
	if replayed := readEvent("2"); replayed != receipt {
		t.Fatalf("replay receipt changed: got %d, want %d", replayed, receipt)
	}
	req, _ = http.NewRequestWithContext(ctx, "GET", server.URL+"/api/invocations", nil)
	req.Header.Set("Origin", "https://unrelated.example")
	denied, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, denied.Body)
	denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("origin check: %d", denied.StatusCode)
	}
}

func checkCompletionWaitsForMissingSequence(t *testing.T, store *Store) {
	last := testEvent(t, 2)
	payload, err := anypb.New(&beppb.BuildEvent{LastMessage: true})
	if err != nil {
		t.Fatal(err)
	}
	last.Event = &buildpb.BuildEvent{Event: &buildpb.BuildEvent_BazelEvent{BazelEvent: payload}}
	if err := store.Append(last, false); err != nil {
		t.Fatal(err)
	}
	inv, _ := store.GetInvocation(context.Background(), &pb.GetInvocationRequest{InvocationId: "invocation"})
	if inv.State != pb.InvocationState_INVOCATION_STATE_IN_PROGRESS {
		t.Fatal(inv.State)
	}
	if err := store.Append(testEvent(t, 1), false); err != nil {
		t.Fatal(err)
	}
	inv, _ = store.GetInvocation(context.Background(), &pb.GetInvocationRequest{InvocationId: "invocation"})
	if inv.State != pb.InvocationState_INVOCATION_STATE_COMPLETE {
		t.Fatal(inv.State)
	}
}

func checkBuildScopedLifecycle(t *testing.T, store *Store) {
	event := testEvent(t, 1)
	event.StreamId.InvocationId = ""
	event.StreamId.Component = buildpb.StreamId_CONTROLLER
	if err := store.Append(event, true); err != nil {
		t.Fatal(err)
	}
	result, err := store.ListInvocations(context.Background(), &pb.ListInvocationsRequest{})
	if err != nil || len(result.GetInvocations()) != 0 {
		t.Fatalf("build-scoped event created an invocation: %v %v", result, err)
	}
	if err := store.Append(event, false); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("tool event missing invocation ID: %v", err)
	}
}

func TestStorageService(t *testing.T) {
	backends := []struct {
		name string
		open func(string) (*Store, error)
	}{
		{"journal", Open},
		{"sqlite", func(path string) (*Store, error) {
			storage, err := OpenSQLite(path)
			if err != nil {
				return nil, err
			}
			return NewStore(storage), nil
		}},
	}
	checks := []struct {
		name string
		run  func(*testing.T, *Store)
	}{
		{"grpc_replay_live", checkWatchReplayThenLive},
		{"browser_replay_live", checkBrowserReplayAndLive},
		{"completion_waits_for_gap", checkCompletionWaitsForMissingSequence},
		{"build_scoped_lifecycle", checkBuildScopedLifecycle},
	}
	for _, backend := range backends {
		for _, check := range checks {
			t.Run(backend.name+"/"+check.name, func(t *testing.T) {
				store, err := backend.open(filepath.Join(t.TempDir(), "events"))
				if err != nil {
					t.Fatal(err)
				}
				defer store.Close()
				check.run(t, store)
			})
		}
	}
}
