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
	emptySHA256   = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

type fileCache struct {
	re.UnimplementedActionCacheServer
	re.UnimplementedContentAddressableStorageServer
	re.UnimplementedCapabilitiesServer
	bs.UnimplementedByteStreamServer

	root string
}

// NewFileCache stores SHA-256 blobs and action results in separate on-disk namespaces.
func NewFileCache(root string) (Backend, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	return &fileCache{root: root}, nil
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

func publishFile(file *os.File, path string) error {
	if err := file.Sync(); err != nil {
		return fileError(err)
	}
	if err := file.Close(); err != nil {
		return fileError(err)
	}
	return fileError(os.Rename(file.Name(), path))
}

func (f *fileCache) writeFile(path string, data []byte) error {
	file, err := f.newTemp(path)
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		return fileError(err)
	}
	return publishFile(file, path)
}

func (f *fileCache) hasBlob(instance string, digest *re.Digest) error {
	if err := checkDigest(digest); err != nil {
		return err
	}
	if digest.SizeBytes == 0 {
		return nil
	}
	info, err := os.Stat(f.path(instance, "cas", digest))
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
	data, err := os.ReadFile(f.path(instance, "cas", digest))
	return data, fileError(err)
}

func (f *fileCache) GetActionResult(_ context.Context, req *re.GetActionResultRequest) (*re.ActionResult, error) {
	if err := checkFunction(req.DigestFunction); err != nil {
		return nil, err
	}
	if err := checkDigest(req.ActionDigest); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(f.path(req.InstanceName, "ac", req.ActionDigest))
	if err != nil {
		return nil, fileError(err)
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
		for _, digest := range []*re.Digest{dir.GetTreeDigest(), dir.GetRootDirectoryDigest()} {
			if digest != nil {
				if err := f.hasBlob(req.InstanceName, digest); err != nil {
					return nil, err
				}
			}
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
	file, err := os.Open(f.path(instance, "cas", digest))
	if err != nil {
		return fileError(err)
	}
	defer file.Close()
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
	file, err := f.newTemp(path)
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	hash := sha256.New()
	writer := io.MultiWriter(file, hash)
	var offset int64
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
		if req.FinishWrite {
			break
		}
		req, err = stream.Recv()
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
	if err := publishFile(file, path); err != nil {
		return err
	}
	return stream.SendAndClose(&bs.WriteResponse{CommittedSize: offset})
}
