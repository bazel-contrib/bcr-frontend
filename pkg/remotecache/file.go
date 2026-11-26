package remotecache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	"github.com/bazelbuild/remote-apis/build/bazel/semver"
	bs "google.golang.org/genproto/googleapis/bytestream"
	rpc "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const (
	maxBatchBytes = 4 << 20
	blobChunkSize = 256 << 10
	uploadIdle    = 30 * time.Second
	emptySHA256   = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

type fileCache struct {
	re.UnimplementedActionCacheServer
	re.UnimplementedContentAddressableStorageServer
	re.UnimplementedCapabilitiesServer
	bs.UnimplementedByteStreamServer

	root   string
	budget *diskBudget
}

// NewFileCache stores SHA-256 blobs and action results in separate on-disk namespaces.
func NewFileCache(root string) (Backend, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	return &fileCache{root: root}, nil
}

// CheckReady checks that the cache's root directory can be opened.
func (f *fileCache) CheckReady(context.Context) error {
	dir, err := os.Open(f.root)
	if err != nil {
		return err
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("cache root is not a directory")
	}
	return nil
}

func (f *fileCache) GetCapabilities(context.Context, *re.GetCapabilitiesRequest) (*re.ServerCapabilities, error) {
	return &re.ServerCapabilities{
		CacheCapabilities: &re.CacheCapabilities{
			DigestFunctions:               []re.DigestFunction_Value{re.DigestFunction_SHA256},
			ActionCacheUpdateCapabilities: &re.ActionCacheUpdateCapabilities{UpdateEnabled: true},
			MaxBatchTotalSizeBytes:        maxBatchBytes,
		},
		LowApiVersion:  &semver.SemVer{Major: 2},
		HighApiVersion: &semver.SemVer{Major: 2, Minor: 3},
	}, nil
}

func checkFunction(function re.DigestFunction_Value) error {
	if function != re.DigestFunction_UNKNOWN && function != re.DigestFunction_SHA256 {
		return status.Error(codes.InvalidArgument, "file cache supports SHA-256")
	}
	return nil
}

func checkDigest(digest *re.Digest) error {
	hash := digest.GetHash()
	if len(hash) != 64 || strings.ToLower(hash) != hash || digest.GetSizeBytes() < 0 {
		return status.Error(codes.InvalidArgument, "invalid SHA-256 digest")
	}
	if _, err := hex.DecodeString(hash); err != nil {
		return status.Error(codes.InvalidArgument, "invalid SHA-256 digest")
	}
	if (digest.SizeBytes == 0) != (hash == emptySHA256) {
		return status.Error(codes.InvalidArgument, "invalid empty blob digest")
	}
	return nil
}

func (f *fileCache) path(instance, kind string, digest *re.Digest) string {
	namespace := sha256.Sum256([]byte(instance))
	return filepath.Join(f.root, hex.EncodeToString(namespace[:]), kind, digest.Hash[:2],
		digest.Hash+"-"+strconv.FormatInt(digest.SizeBytes, 10))
}

func fileError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return status.Error(codes.NotFound, "cache entry not found")
	}
	return status.Error(codes.Internal, "cache disk operation failed")
}

func (f *fileCache) newTemp(path string) (*os.File, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fileError(err)
	}
	file, err := os.CreateTemp(dir, ".upload-*")
	return file, fileError(err)
}

func (f *fileCache) publishFile(file *os.File, path string, size int64) error {
	if err := file.Sync(); err != nil {
		return fileError(err)
	}
	if err := file.Close(); err != nil {
		return fileError(err)
	}
	if f.budget == nil {
		return fileError(os.Rename(file.Name(), path))
	}
	b := f.budget
	b.mu.Lock()
	defer b.mu.Unlock()
	old := b.entries[path]
	if old != nil && old.Value.(*diskEntry).pins > 0 {
		return status.Error(codes.ResourceExhausted, "cache entry is being read")
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return fileError(err)
	}
	if old != nil {
		b.forget(old)
	}
	now := time.Now()
	_ = os.Chtimes(path, now, now)
	b.add(&diskEntry{path: path, size: size})
	b.reserved -= size
	return nil
}

type cacheUpload struct {
	cache *fileCache
	file  *os.File
	path  string
	cost  int64
}

func (f *fileCache) startUpload(path string, size int64) (*cacheUpload, error) {
	upload := &cacheUpload{cache: f, path: path}
	if f.budget != nil {
		upload.cost = f.budget.cost(size)
		if err := f.budget.reserve(upload.cost); err != nil {
			return nil, err
		}
	}
	file, err := f.newTemp(path)
	if err != nil {
		upload.release()
		return nil, err
	}
	upload.file = file
	return upload, nil
}

func (u *cacheUpload) release() {
	if u.file != nil {
		u.file.Close()
		os.Remove(u.file.Name())
	}
	if u.cost != 0 {
		b := u.cache.budget
		b.mu.Lock()
		b.reserved -= u.cost
		b.mu.Unlock()
	}
}

func (u *cacheUpload) publish() error {
	if err := u.cache.publishFile(u.file, u.path, u.cost); err != nil {
		return err
	}
	u.cost = 0
	return nil
}

func (f *fileCache) writeFile(path string, data []byte) error {
	upload, err := f.startUpload(path, int64(len(data)))
	if err != nil {
		return err
	}
	defer upload.release()
	if _, err := upload.file.Write(data); err != nil {
		return fileError(err)
	}
	return upload.publish()
}

func (f *fileCache) open(path string) (*os.File, func(), error) {
	b := f.budget
	var entry *diskEntry
	if b != nil {
		b.mu.Lock()
		defer b.mu.Unlock()
		elem := b.entries[path]
		if elem == nil {
			return nil, nil, fileError(os.ErrNotExist)
		}
		entry = elem.Value.(*diskEntry)
		b.touch(elem)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, fileError(err)
	}
	if entry != nil {
		entry.pins++
	}
	return file, func() {
		file.Close()
		if entry != nil {
			b.mu.Lock()
			entry.pins--
			b.mu.Unlock()
		}
	}, nil
}

func (f *fileCache) readFile(path string) ([]byte, error) {
	file, closeFile, err := f.open(path)
	if err != nil {
		return nil, err
	}
	defer closeFile()
	data, err := io.ReadAll(file)
	return data, fileError(err)
}

func (f *fileCache) hasBlob(instance string, digest *re.Digest) error {
	if err := checkDigest(digest); err != nil {
		return err
	}
	if digest.SizeBytes == 0 {
		return nil
	}
	path := f.path(instance, "cas", digest)
	if f.budget != nil {
		b := f.budget
		b.mu.Lock()
		defer b.mu.Unlock()
		elem := b.entries[path]
		if elem == nil {
			return fileError(os.ErrNotExist)
		}
		b.touch(elem)
	}
	info, err := os.Stat(path)
	if err != nil {
		return fileError(err)
	}
	if info.Size() != digest.SizeBytes {
		return status.Error(codes.DataLoss, "blob length does not match its digest")
	}
	return nil
}

func (f *fileCache) readBlob(instance string, digest *re.Digest) ([]byte, error) {
	if err := f.hasBlob(instance, digest); err != nil || digest.SizeBytes == 0 {
		return nil, err
	}
	return f.readFile(f.path(instance, "cas", digest))
}

func (f *fileCache) GetActionResult(ctx context.Context, req *re.GetActionResultRequest) (*re.ActionResult, error) {
	if err := checkFunction(req.DigestFunction); err != nil {
		return nil, err
	}
	if err := checkDigest(req.ActionDigest); err != nil {
		return nil, err
	}
	data, err := f.readFile(f.path(req.InstanceName, "ac", req.ActionDigest))
	if err != nil {
		return nil, err
	}
	result := new(re.ActionResult)
	if err := proto.Unmarshal(data, result); err != nil {
		return nil, status.Error(codes.DataLoss, "invalid cached action result")
	}
	for _, output := range result.OutputFiles {
		if err := f.hasBlob(req.InstanceName, output.GetDigest()); err != nil {
			return nil, err
		}
	}
	for _, dir := range result.OutputDirectories {
		if err := f.checkOutputDirectory(ctx, req.InstanceName, dir); err != nil {
			return nil, err
		}
	}
	for _, digest := range []*re.Digest{result.StdoutDigest, result.StderrDigest} {
		if digest != nil {
			if err := f.hasBlob(req.InstanceName, digest); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

// The tree blob can survive eviction of the files it describes.
func (f *fileCache) checkOutputDirectory(ctx context.Context, instance string, output *re.OutputDirectory) error {
	checkFiles := func(directory *re.Directory) error {
		if err := ctx.Err(); err != nil {
			return status.FromContextError(err).Err()
		}
		for _, file := range directory.GetFiles() {
			if err := f.hasBlob(instance, file.GetDigest()); err != nil {
				return err
			}
		}
		return nil
	}
	if digest := output.GetTreeDigest(); digest != nil {
		data, err := f.readOutputDirectoryBlob(instance, digest)
		if err != nil {
			return err
		}
		tree := new(re.Tree)
		if err := proto.Unmarshal(data, tree); err != nil {
			return status.Error(codes.DataLoss, "invalid CAS output tree")
		}
		if err := checkFiles(tree.GetRoot()); err != nil {
			return err
		}
		for _, child := range tree.GetChildren() {
			if err := checkFiles(child); err != nil {
				return err
			}
		}
	}
	root := output.GetRootDirectoryDigest()
	if root == nil {
		return nil
	}
	pending := []*re.Digest{root}
	seen := make(map[string]bool)
	for len(pending) > 0 {
		digest := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		key := digest.GetHash() + "/" + strconv.FormatInt(digest.GetSizeBytes(), 10)
		if seen[key] {
			continue
		}
		seen[key] = true
		data, err := f.readOutputDirectoryBlob(instance, digest)
		if err != nil {
			return err
		}
		directory := new(re.Directory)
		if err := proto.Unmarshal(data, directory); err != nil {
			return status.Error(codes.DataLoss, "invalid CAS output directory")
		}
		if err := checkFiles(directory); err != nil {
			return err
		}
		for _, child := range directory.GetDirectories() {
			pending = append(pending, child.GetDigest())
		}
	}
	return nil
}

// Directory metadata is decoded in memory, unlike ByteStream payloads.
func (f *fileCache) readOutputDirectoryBlob(instance string, digest *re.Digest) ([]byte, error) {
	if digest.GetSizeBytes() > MaxMessageBytes {
		return nil, status.Error(codes.NotFound, "cached output directory metadata exceeds the decoding limit")
	}
	return f.readBlob(instance, digest)
}

func (f *fileCache) UpdateActionResult(_ context.Context, req *re.UpdateActionResultRequest) (*re.ActionResult, error) {
	if err := checkFunction(req.DigestFunction); err != nil {
		return nil, err
	}
	if err := checkDigest(req.ActionDigest); err != nil {
		return nil, err
	}
	if req.ActionResult == nil {
		return nil, status.Error(codes.InvalidArgument, "missing action result")
	}
	data, err := proto.Marshal(req.ActionResult)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid action result")
	}
	if err := f.writeFile(f.path(req.InstanceName, "ac", req.ActionDigest), data); err != nil {
		return nil, err
	}
	return req.ActionResult, nil
}

func (f *fileCache) FindMissingBlobs(_ context.Context, req *re.FindMissingBlobsRequest) (*re.FindMissingBlobsResponse, error) {
	if err := checkFunction(req.DigestFunction); err != nil {
		return nil, err
	}
	response := new(re.FindMissingBlobsResponse)
	for _, digest := range req.BlobDigests {
		err := f.hasBlob(req.InstanceName, digest)
		if status.Code(err) == codes.NotFound {
			response.MissingBlobDigests = append(response.MissingBlobDigests, digest)
		} else if err != nil {
			return nil, err
		}
	}
	return response, nil
}

func (f *fileCache) BatchReadBlobs(_ context.Context, req *re.BatchReadBlobsRequest) (*re.BatchReadBlobsResponse, error) {
	if err := checkFunction(req.DigestFunction); err != nil {
		return nil, err
	}
	var total int64
	response := new(re.BatchReadBlobsResponse)
	for _, digest := range req.Digests {
		size := digest.GetSizeBytes()
		if size > maxBatchBytes-total {
			return nil, status.Error(codes.InvalidArgument, "batch exceeds cache size limit")
		}
		total += max(0, size)
		data, err := f.readBlob(req.InstanceName, digest)
		response.Responses = append(response.Responses, &re.BatchReadBlobsResponse_Response{
			Digest: digest, Data: data, Status: rpcStatus(err),
		})
	}
	return response, nil
}

func rpcStatus(err error) *rpc.Status {
	if err == nil {
		return &rpc.Status{}
	}
	return status.Convert(err).Proto()
}

func (f *fileCache) BatchUpdateBlobs(_ context.Context, req *re.BatchUpdateBlobsRequest) (*re.BatchUpdateBlobsResponse, error) {
	if err := checkFunction(req.DigestFunction); err != nil {
		return nil, err
	}
	var total int
	for _, blob := range req.Requests {
		total += len(blob.GetData())
		if total > maxBatchBytes {
			return nil, status.Error(codes.InvalidArgument, "batch exceeds cache size limit")
		}
	}
	response := new(re.BatchUpdateBlobsResponse)
	for _, blob := range req.Requests {
		err := f.writeBlob(req.InstanceName, blob)
		response.Responses = append(response.Responses, &re.BatchUpdateBlobsResponse_Response{
			Digest: blob.GetDigest(), Status: rpcStatus(err),
		})
	}
	return response, nil
}

func (f *fileCache) writeBlob(instance string, blob *re.BatchUpdateBlobsRequest_Request) error {
	digest := blob.GetDigest()
	if err := checkDigest(digest); err != nil {
		return err
	}
	if blob.Compressor != re.Compressor_IDENTITY {
		return status.Error(codes.InvalidArgument, "file cache supports uncompressed blobs")
	}
	hash := sha256.Sum256(blob.Data)
	if int64(len(blob.Data)) != digest.SizeBytes || hex.EncodeToString(hash[:]) != digest.Hash {
		return status.Error(codes.InvalidArgument, "blob data does not match its digest")
	}
	if digest.SizeBytes == 0 {
		return nil
	}
	if f.budget != nil {
		err := f.hasBlob(instance, digest)
		if status.Code(err) != codes.NotFound {
			return err
		}
	}
	return f.writeFile(f.path(instance, "cas", digest), blob.Data)
}

func (f *fileCache) GetTree(req *re.GetTreeRequest, stream re.ContentAddressableStorage_GetTreeServer) error {
	if err := checkFunction(req.DigestFunction); err != nil {
		return err
	}
	if err := checkDigest(req.RootDigest); err != nil {
		return err
	}
	var offset int
	if req.PageToken != "" {
		var err error
		offset, err = strconv.Atoi(req.PageToken)
		if err != nil || offset < 0 {
			return status.Error(codes.InvalidArgument, "invalid tree page token")
		}
	}
	limit := min(128, int(req.PageSize))
	if limit <= 0 {
		limit = 128
	}
	response := new(re.GetTreeResponse)
	queue := []*re.Digest{req.RootDigest}
	visited := make(map[string]bool)
	var position, bytes int
	for len(queue) > 0 {
		if err := stream.Context().Err(); err != nil {
			return status.FromContextError(err).Err()
		}
		digest := queue[0]
		queue = queue[1:]
		if err := checkDigest(digest); err != nil {
			return err
		}
		key := digest.GetHash() + "/" + strconv.FormatInt(digest.SizeBytes, 10)
		if visited[key] {
			continue
		}
		visited[key] = true
		if len(response.Directories) >= limit ||
			(len(response.Directories) > 0 && digest.SizeBytes > int64(maxBatchBytes-bytes)) {
			response.NextPageToken = strconv.Itoa(position)
			break
		}
		if digest.SizeBytes > maxBatchBytes {
			return status.Error(codes.ResourceExhausted, "directory exceeds tree response limit")
		}
		data, err := f.readBlob(req.InstanceName, digest)
		if err != nil {
			if status.Code(err) == codes.NotFound && position > 0 {
				continue // REAPI permits omitting missing descendants.
			}
			return err
		}
		directory := new(re.Directory)
		if err := proto.Unmarshal(data, directory); err != nil {
			return status.Error(codes.DataLoss, "invalid CAS directory")
		}
		for _, child := range directory.Directories {
			queue = append(queue, child.GetDigest())
		}
		if position >= offset {
			response.Directories = append(response.Directories, directory)
			bytes += len(data) + 8
		}
		position++
	}
	return stream.Send(response)
}

func blobResource(name string, upload bool) (string, *re.Digest, error) {
	parts := strings.Split(name, "/")
	blob := len(parts) - 3
	if blob < 0 || parts[blob] != "blobs" {
		return "", nil, status.Error(codes.InvalidArgument, "expected an uncompressed ByteStream blob resource")
	}
	prefix := blob
	if upload {
		prefix -= 2
		if prefix < 0 || parts[prefix] != "uploads" || parts[prefix+1] == "" {
			return "", nil, status.Error(codes.InvalidArgument, "expected a ByteStream upload resource")
		}
	}
	size, err := strconv.ParseInt(parts[blob+2], 10, 64)
	if err != nil {
		return "", nil, status.Error(codes.InvalidArgument, "invalid blob size")
	}
	digest := &re.Digest{Hash: parts[blob+1], SizeBytes: size}
	return strings.Join(parts[:prefix], "/"), digest, checkDigest(digest)
}

func (f *fileCache) Read(req *bs.ReadRequest, stream bs.ByteStream_ReadServer) error {
	instance, digest, err := blobResource(req.ResourceName, false)
	if err != nil {
		return err
	}
	if req.ReadOffset < 0 || req.ReadLimit < 0 || req.ReadOffset > digest.SizeBytes {
		return status.Error(codes.OutOfRange, "invalid blob read range")
	}
	if digest.SizeBytes == 0 {
		return nil
	}
	file, closeFile, err := f.open(f.path(instance, "cas", digest))
	if err != nil {
		return err
	}
	defer closeFile()
	remaining := digest.SizeBytes - req.ReadOffset
	if req.ReadLimit > 0 {
		remaining = min(remaining, req.ReadLimit)
	}
	reader := io.NewSectionReader(file, req.ReadOffset, remaining)
	buffer := make([]byte, blobChunkSize)
	for remaining > 0 {
		n, err := io.ReadFull(reader, buffer[:min(int64(len(buffer)), remaining)])
		if err != nil {
			return status.Error(codes.DataLoss, "incomplete cached blob")
		}
		if err := stream.Send(&bs.ReadResponse{Data: buffer[:n]}); err != nil {
			return err
		}
		remaining -= int64(n)
	}
	return nil
}

func (f *fileCache) QueryWriteStatus(_ context.Context, req *bs.QueryWriteStatusRequest) (*bs.QueryWriteStatusResponse, error) {
	instance, digest, err := blobResource(req.ResourceName, true)
	if err != nil {
		return nil, err
	}
	if err := f.hasBlob(instance, digest); err != nil {
		return nil, err
	}
	return &bs.QueryWriteStatusResponse{CommittedSize: digest.SizeBytes, Complete: true}, nil
}

func (f *fileCache) Write(stream bs.ByteStream_WriteServer) error {
	return f.writeUpload(stream, uploadIdle)
}

func (f *fileCache) writeUpload(stream bs.ByteStream_WriteServer, idle time.Duration) error {
	req, err := stream.Recv()
	if err == io.EOF {
		return status.Error(codes.InvalidArgument, "missing ByteStream upload")
	}
	if err != nil {
		return err
	}
	name := req.ResourceName
	instance, digest, err := blobResource(name, true)
	if err != nil {
		return err
	}
	if err := f.hasBlob(instance, digest); err == nil {
		return stream.SendAndClose(&bs.WriteResponse{CommittedSize: digest.SizeBytes})
	} else if status.Code(err) != codes.NotFound {
		return err
	}
	path := f.path(instance, "cas", digest)
	upload, err := f.startUpload(path, digest.SizeBytes)
	if err != nil {
		return err
	}
	defer upload.release()
	hash := sha256.New()
	writer := io.MultiWriter(upload.file, hash)
	var offset int64
	deadline := time.Now().Add(idle)
	for {
		if req.ResourceName != "" && req.ResourceName != name {
			return status.Error(codes.InvalidArgument, "upload resource changed")
		}
		if req.WriteOffset != offset || int64(len(req.Data)) > digest.SizeBytes-offset {
			return status.Error(codes.OutOfRange, "invalid upload offset or size")
		}
		n, err := writer.Write(req.Data)
		if err != nil {
			return fileError(err)
		}
		offset += int64(n)
		if n != 0 {
			deadline = time.Now().Add(idle)
		}
		if req.FinishWrite {
			break
		}
		req, err = receiveUploadChunk(stream, time.Until(deadline))
		if err == io.EOF {
			return status.Error(codes.InvalidArgument, "upload ended before finish_write")
		}
		if err != nil {
			return err
		}
	}
	if offset != digest.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != digest.Hash {
		return status.Error(codes.InvalidArgument, "uploaded data does not match its digest")
	}
	if err := upload.publish(); err != nil {
		return err
	}
	return stream.SendAndClose(&bs.WriteResponse{CommittedSize: offset})
}

func receiveUploadChunk(stream bs.ByteStream_WriteServer, remaining time.Duration) (*bs.WriteRequest, error) {
	type received struct {
		request *bs.WriteRequest
		err     error
	}
	result := make(chan received, 1)
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	go func() {
		request, err := stream.Recv()
		result <- received{request, err}
	}()
	select {
	case message := <-result:
		return message.request, message.err
	case <-timer.C:
		// Returning from the RPC also cancels the pending receive.
		return nil, status.Error(codes.DeadlineExceeded, "cache upload stopped making progress")
	case <-stream.Context().Done():
		return nil, status.FromContextError(stream.Context().Err()).Err()
	}
}
