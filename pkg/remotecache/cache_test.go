package remotecache

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
)

func connectCache(t *testing.T, server *grpc.Server) *grpc.ClientConn {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient("passthrough:///cache", grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestProxyFileCacheAndMetrics(t *testing.T) {
	file, err := NewFileCache(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	type key struct{ operation, result string }
	measure := func() (Observer, map[key]int64) {
		counts := make(map[key]int64)
		var mu sync.Mutex
		return func(_ context.Context, id string, metrics []*pb.RemoteCacheMetric) error {
			mu.Lock()
			defer mu.Unlock()
			if id != "test-invocation" {
				t.Errorf("observation invocation = %q", id)
			}
			for _, metric := range metrics {
				counts[key{metric.Operation, metric.Result}] += metric.Count
			}
			return nil
		}, counts
	}
	upstreamObserver, upstreamCounts := measure()
	frontendObserver, frontendCounts := measure()
	upstream := connectCache(t, NewServer(file, upstreamObserver, nil))
	frontend := connectCache(t, NewServer(NewProxy(upstream), frontendObserver, nil))
	client := bs.NewByteStreamClient(frontend)
	meta, err := proto.Marshal(&re.RequestMetadata{ToolInvocationId: "test-invocation"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(metadata.AppendToOutgoingContext(context.Background(), requestMetadataKey, string(meta)), 10*time.Second)
	defer cancel()
	data := []byte("cache content")
	digest := fmt.Sprintf("%x/%d", sha256.Sum256(data), len(data))
	write := func(body []byte) error {
		stream, err := client.Write(ctx)
		if err != nil {
			return err
		}
		if err := stream.Send(&bs.WriteRequest{
			ResourceName: "team/cache/uploads/test/blobs/" + digest, Data: body, FinishWrite: true,
		}); err != nil {
			return err
		}
		_, err = stream.CloseAndRecv()
		return err
	}
	if err := write([]byte("wrong content")); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid upload: %v", err)
	}
	if err := write(data); err != nil {
		t.Fatalf("valid upload: %v", err)
	}
	stream, err := client.Read(ctx, &bs.ReadRequest{ResourceName: "team/cache/blobs/" + digest, ReadOffset: 6})
	if err != nil {
		t.Fatal(err)
	}
	var downloaded []byte
	if err := pipeResponses(stream.Recv, func(piece *bs.ReadResponse) error {
		downloaded = append(downloaded, piece.Data...)
		return nil
	}); err != nil || string(downloaded) != "content" {
		t.Fatalf("downloaded %q: %v", downloaded, err)
	}
	stream, err = client.Read(ctx, &bs.ReadRequest{ResourceName: "other/blobs/" + digest})
	if err == nil {
		_, err = stream.Recv()
	}
	if err == io.EOF || status.Code(err) != codes.NotFound {
		t.Fatalf("other instance download: %v", err)
	}
	// Both layers independently see the same metadata forwarded by the proxy.
	for _, counts := range []map[key]int64{frontendCounts, upstreamCounts} {
		for _, expected := range []key{
			{"cas_write", "ok"}, {"cas_write", "error"}, {"cas_read", "hit"}, {"cas_read", "miss"},
		} {
			if counts[expected] != 1 {
				t.Fatalf("%v: got metrics %v", expected, counts)
			}
		}
	}
}
