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
	frontend := connectCache(t, NewServer(NewProxy(upstream, false), frontendObserver, nil))
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

type earlyWriteCache struct{ Backend }

func (cache earlyWriteCache) Write(stream bs.ByteStream_WriteServer) error {
	if values := metadata.ValueFromIncomingContext(stream.Context(), "authorization"); len(values) != 0 {
		return status.Error(codes.PermissionDenied, "plaintext upstream received credentials")
	}
	if _, err := stream.Recv(); err != nil {
		return err
	}
	return stream.SendAndClose(&bs.WriteResponse{CommittedSize: 42})
}

func TestProxyReturnsEarlyUploadResult(t *testing.T) {
	file, err := NewFileCache(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	upstream := connectCache(t, NewServer(earlyWriteCache{file}, nil, nil))
	frontend := connectCache(t, NewServer(NewProxy(upstream, false), nil, nil))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "test-credential")
	stream, err := bs.NewByteStreamClient(frontend).Write(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&bs.WriteRequest{ResourceName: "already-stored", Data: []byte("chunk")}); err != nil {
		t.Fatal(err)
	}
	// The server's response must arrive while the client still has its send side open.
	response := new(bs.WriteResponse)
	if err := stream.RecvMsg(response); err != nil || response.GetCommittedSize() != 42 {
		t.Fatalf("response = %v, error = %v", response, err)
	}
}

type shortIdleCache struct{ *fileCache }

func (cache shortIdleCache) Write(stream bs.ByteStream_WriteServer) error {
	return cache.writeUpload(stream, 100*time.Millisecond)
}

func TestStalledUploadReleasesCapacity(t *testing.T) {
	cache, limit := boundedCache(t, 1)
	defer cache.Close()
	client := bs.NewByteStreamClient(connectCache(t, NewServer(shortIdleCache{cache}, nil, nil)))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	content := make([]byte, limit)
	resource := fmt.Sprintf("uploads/test/blobs/%x/%d", sha256.Sum256(content), len(content))
	stream, err := client.Write(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&bs.WriteRequest{ResourceName: resource, Data: content[:1]}); err != nil {
		t.Fatal(err)
	}
	if err := stream.RecvMsg(new(bs.WriteResponse)); status.Code(err) != codes.DeadlineExceeded {
		t.Fatalf("stalled upload: %v", err)
	}
	stream, err = client.Write(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&bs.WriteRequest{ResourceName: resource, Data: content, FinishWrite: true}); err != nil {
		t.Fatal(err)
	}
	response, err := stream.CloseAndRecv()
	if err != nil || response.GetCommittedSize() != limit {
		t.Fatalf("replacement upload: %v, %v", response, err)
	}
}

func TestArchiveByteStreamRoundTrip(t *testing.T) {
	cache, err := NewFileCache(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conn := connectCache(t, NewServer(cache, nil, nil))
	archive, err := NewBlobArchive(conn, "archives/build-events")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blob := make([]byte, 3<<20)
	digest := fmt.Sprintf("%x", sha256.Sum256(blob))
	for range 2 {
		if err := archive.Put(ctx, digest, blob); err != nil {
			t.Fatal(err)
		}
	}
	read, err := archive.Get(ctx, digest, int64(len(blob)))
	if err != nil || sha256.Sum256(read) != sha256.Sum256(blob) {
		t.Fatalf("archive read: %d bytes, %v", len(read), err)
	}
}
