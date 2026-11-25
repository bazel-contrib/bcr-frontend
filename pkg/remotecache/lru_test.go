package remotecache

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"testing"

	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

func boundedCache(t *testing.T, blocks int64) (*fileCache, int64) {
	t.Helper()
	root := t.TempDir()
	probe, err := NewBoundedFileCache(root, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	limit := blocks * probe.budget.block
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	cache, err := NewBoundedFileCache(root, limit)
	if err != nil {
		t.Fatal(err)
	}
	return cache, limit
}

func putCacheBlob(t *testing.T, f *fileCache, instance string, data []byte) *re.Digest {
	t.Helper()
	digest := &re.Digest{Hash: fmt.Sprintf("%x", sha256.Sum256(data)), SizeBytes: int64(len(data))}
	if err := f.writeBlob(instance, &re.BatchUpdateBlobsRequest_Request{Digest: digest, Data: data}); err != nil {
		t.Fatal(err)
	}
	return digest
}

func TestLRUEvictsToLowWatermarkAfterRestart(t *testing.T) {
	cache, limit := boundedCache(t, 12)
	var entries []*re.Digest
	for i := 0; i < 12; i++ {
		entries = append(entries, putCacheBlob(t, cache, "first", []byte{byte(i)}))
	}
	if _, err := cache.readBlob("first", entries[0]); err != nil {
		t.Fatal(err)
	}
	root := cache.root
	abandoned := cache.path("first", "cas", entries[0])
	temp, err := cache.newTemp(abandoned)
	if err != nil {
		t.Fatal(err)
	}
	temp.Close()
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}
	cache, err = NewBoundedFileCache(root, limit)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	if _, err := os.Stat(temp.Name()); !os.IsNotExist(err) {
		t.Fatalf("abandoned upload: %v", err)
	}
	putCacheBlob(t, cache, "second", []byte("cross-instance"))
	for i, digest := range entries {
		want := codes.OK
		if i >= 1 && i <= 3 {
			want = codes.NotFound
		}
		if err := cache.hasBlob("first", digest); status.Code(err) != want {
			t.Fatalf("entry %d: got %v, want %v", i, err, want)
		}
	}
	if cache.budget.used != 10*cache.budget.block {
		t.Fatalf("post-eviction bytes = %d", cache.budget.used)
	}
}

func TestLRUReservationsAndPinnedReaders(t *testing.T) {
	cache, limit := boundedCache(t, 2)
	defer cache.Close()
	digest := putCacheBlob(t, cache, "", []byte("held"))
	path := cache.path("", "cas", digest)
	_, closeReader, err := cache.open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer closeReader()
	upload, err := cache.startUpload(path, limit/2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := upload.file.Write([]byte("partial")); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.startUpload(path, 1); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("overcommitted capacity: %v", err)
	}
	upload.release()
	if _, err := os.Stat(upload.file.Name()); !os.IsNotExist(err) {
		t.Fatalf("cancelled upload: %v", err)
	}
	if _, err := cache.startUpload(path, limit+1); status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("oversized upload: %v", err)
	}
	if err := cache.hasBlob("", digest); err != nil {
		t.Fatalf("open reader's entry was evicted: %v", err)
	}
	putCacheBlob(t, cache, "", []byte("fits after cancellation"))
}

func TestEvictedDirectoryFileMakesActionCacheMiss(t *testing.T) {
	cache, _ := boundedCache(t, 4)
	defer cache.Close()
	ctx := context.Background()
	output := putCacheBlob(t, cache, "", []byte("output"))
	filler := putCacheBlob(t, cache, "", []byte("other"))
	treeData, err := proto.Marshal(&re.Tree{Root: &re.Directory{Files: []*re.FileNode{{Name: "file", Digest: output}}}})
	if err != nil {
		t.Fatal(err)
	}
	tree := putCacheBlob(t, cache, "", treeData)
	action := &re.Digest{Hash: fmt.Sprintf("%x", sha256.Sum256([]byte("action"))), SizeBytes: 6}
	if _, err := cache.UpdateActionResult(ctx, &re.UpdateActionResultRequest{
		ActionDigest: action,
		ActionResult: &re.ActionResult{OutputDirectories: []*re.OutputDirectory{{TreeDigest: tree}}},
	}); err != nil {
		t.Fatal(err)
	}
	req := &re.GetActionResultRequest{ActionDigest: action}
	if _, err := cache.GetActionResult(ctx, req); err != nil {
		t.Fatalf("complete action: %v", err)
	}
	if err := cache.hasBlob("", filler); err != nil {
		t.Fatal(err)
	}
	if err := cache.hasBlob("", tree); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.readFile(cache.path("", "ac", action)); err != nil {
		t.Fatal(err)
	}
	putCacheBlob(t, cache, "", []byte("trigger eviction"))
	if err := cache.hasBlob("", tree); err != nil {
		t.Fatalf("tree should outlive its output file: %v", err)
	}
	if _, err := cache.GetActionResult(ctx, req); status.Code(err) != codes.NotFound {
		t.Fatalf("incomplete action: %v", err)
	}
}
