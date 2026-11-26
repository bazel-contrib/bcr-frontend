package remotecache

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestMonitorReportsLiveCacheTraffic(t *testing.T) {
	cache, err := NewBoundedFileCache(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cache.Close() })
	monitor := NewMonitor(cache)
	conn := connectCache(t, NewServer(cache, nil, nil, grpc.StatsHandler(monitor)))
	streams := bs.NewByteStreamClient(conn)
	cas := re.NewContentAddressableStorageClient(conn)
	actions := re.NewActionCacheClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	handler := monitor.Handler("https://registry.example")
	snapshot := func() cacheStatus {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/remote-cache/status", nil)
		request.Header.Set("Origin", "https://registry.example")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || response.Header().Get("Access-Control-Allow-Origin") != "https://registry.example" {
			t.Fatalf("status response: %d %v", response.Code, response.Header())
		}
		var sample cacheStatus
		if err := json.Unmarshal(response.Body.Bytes(), &sample); err != nil {
			t.Fatal(err)
		}
		return sample
	}
	wait := func(condition func(cacheStatus) bool) cacheStatus {
		t.Helper()
		for {
			sample := snapshot()
			if condition(sample) {
				return sample
			}
			select {
			case <-ctx.Done():
				t.Fatalf("last snapshot: %+v", sample)
			case <-time.After(5 * time.Millisecond):
			}
		}
	}

	data := []byte("remote cache content")
	digest := &re.Digest{Hash: fmt.Sprintf("%x", sha256.Sum256(data)), SizeBytes: int64(len(data))}
	resource := fmt.Sprintf("blobs/%s/%d", digest.Hash, digest.SizeBytes)
	upload, err := streams.Write(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := upload.Send(&bs.WriteRequest{ResourceName: "ci/linux/uploads/live/" + resource, Data: data[:6]}); err != nil {
		t.Fatal(err)
	}
	wait(func(s cacheStatus) bool {
		return s.ActiveUploads == 1 && s.Connections == 1 && s.UploadedBytes == 6 &&
			len(s.Instances) == 1 && s.Instances[0].Name == "ci/linux" && s.Instances[0].ActiveUploads == 1
	})
	if err := upload.Send(&bs.WriteRequest{WriteOffset: 6, Data: data[6:], FinishWrite: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := upload.CloseAndRecv(); err != nil {
		t.Fatal(err)
	}

	read, err := streams.Read(ctx, &bs.ReadRequest{ResourceName: "ci/linux/" + resource})
	if err != nil {
		t.Fatal(err)
	}
	if err := pipeResponses(read.Recv, func(*bs.ReadResponse) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := cas.BatchUpdateBlobs(ctx, &re.BatchUpdateBlobsRequest{
		InstanceName: "ci/macos",
		Requests:     []*re.BatchUpdateBlobsRequest_Request{{Digest: digest, Data: data}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := cas.BatchReadBlobs(ctx, &re.BatchReadBlobsRequest{InstanceName: "ci/macos", Digests: []*re.Digest{digest}}); err != nil {
		t.Fatal(err)
	}
	get := &re.GetActionResultRequest{ActionDigest: digest}
	if _, err := actions.GetActionResult(ctx, get); status.Code(err) != codes.NotFound {
		t.Fatalf("action miss: %v", err)
	}
	if _, err := actions.UpdateActionResult(ctx, &re.UpdateActionResultRequest{
		ActionDigest: digest, ActionResult: &re.ActionResult{},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := actions.GetActionResult(ctx, get); err != nil {
		t.Fatal(err)
	}
	traffic := int64(2 * len(data))
	sample := wait(func(s cacheStatus) bool {
		return s.UploadedBytes == traffic && s.DownloadedBytes == traffic &&
			s.ActiveUploads == 0 && s.ActiveDownloads == 0 && s.ActionHits == 1 && s.ActionMisses == 1 &&
			len(s.Instances) == 3 && s.Instances[0].ActionHits == 1 &&
			s.Instances[1].ActiveUploads == 0 && s.Instances[1].ActiveDownloads == 0 &&
			s.Instances[2].ActiveUploads == 0 && s.Instances[2].ActiveDownloads == 0
	})
	if sample.Storage.Mode != "bounded" || sample.Storage.UsedBytes <= 0 || sample.Storage.LimitBytes != 1<<20 || sample.Storage.ReservedBytes != 0 {
		t.Fatalf("storage: %+v", sample.Storage)
	}
	if len(sample.Instances) != 3 || sample.Instances[0].Name != "" ||
		sample.Instances[0].ActionHits != 1 || sample.Instances[0].ActionMisses != 1 {
		t.Fatalf("default instance: %+v", sample.Instances)
	}
	for i, name := range []string{"ci/linux", "ci/macos"} {
		got := sample.Instances[i+1]
		if got.Name != name || got.UploadedBytes != int64(len(data)) || got.DownloadedBytes != int64(len(data)) ||
			got.ActiveUploads != 0 || got.ActiveDownloads != 0 || got.ActionHits != 0 {
			t.Fatalf("per-instance traffic for %q: %+v", name, got)
		}
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	wait(func(s cacheStatus) bool { return s.Connections == 0 })

	request := httptest.NewRequest(http.MethodGet, "/api/remote-cache/status", nil)
	request.Header.Set("Origin", "https://other.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status from unrelated origin: %d", response.Code)
	}
}
