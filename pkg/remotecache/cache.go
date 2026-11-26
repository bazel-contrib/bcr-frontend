// Package remotecache serves and measures a Bazel gRPC remote cache.
package remotecache

import (
	"context"
	"io"
	"log"
	"strings"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const requestMetadataKey = "build.bazel.remote.execution.v2.requestmetadata-bin"

// MaxMessageBytes accommodates the REAPI batch size and its protobuf envelope.
const MaxMessageBytes = 16 << 20

type Backend interface {
	re.ActionCacheServer
	re.ContentAddressableStorageServer
	re.CapabilitiesServer
	bs.ByteStreamServer
}

type Observer func(context.Context, string, []*pb.RemoteCacheMetric) error

func NewServer(backend Backend, observe Observer, logger *log.Logger, options ...grpc.ServerOption) *grpc.Server {
	m := instrumentation{observe: observe, logger: logger}
	server := grpc.NewServer(append([]grpc.ServerOption{
		grpc.MaxRecvMsgSize(MaxMessageBytes), grpc.MaxSendMsgSize(MaxMessageBytes),
		grpc.UnaryInterceptor(m.unary), grpc.StreamInterceptor(m.stream),
	}, options...)...)
	re.RegisterActionCacheServer(server, backend)
	re.RegisterContentAddressableStorageServer(server, backend)
	re.RegisterCapabilitiesServer(server, backend)
	bs.RegisterByteStreamServer(server, backend)
	return server
}

type instrumentation struct {
	observe Observer
	logger  *log.Logger
}

func (m instrumentation) record(ctx context.Context, metrics ...*pb.RemoteCacheMetric) {
	if m.observe == nil || len(metrics) == 0 {
		return
	}
	id := RequestInvocationID(ctx)
	if id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if err := m.observe(ctx, id, metrics); err != nil && m.logger != nil {
		m.logger.Printf("record remote cache metrics: %v", err)
	}
}

// RequestInvocationID extracts the Bazel invocation ID from REAPI metadata.
func RequestInvocationID(ctx context.Context) string {
	incoming, _ := metadata.FromIncomingContext(ctx)
	values := incoming.Get(requestMetadataKey)
	if len(values) != 1 {
		return ""
	}
	var request re.RequestMetadata
	if err := proto.Unmarshal([]byte(values[0]), &request); err != nil {
		return ""
	}
	id := request.GetToolInvocationId()
	if id == "" || len(id) > 128 {
		return ""
	}
	return id
}

func outcome(err error, success string) string {
	switch status.Code(err) {
	case codes.OK:
		return success
	case codes.NotFound:
		if success == "hit" {
			return "miss"
		}
	}
	return "error"
}

func metric(operation, result string, count, bytes int64) *pb.RemoteCacheMetric {
	return &pb.RemoteCacheMetric{Operation: operation, Result: result, Count: count, TransferredBytes: bytes}
}

func (m instrumentation) unary(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	response, err := handler(ctx, req)
	switch request := req.(type) {
	case *re.GetActionResultRequest:
		m.record(ctx, metric("ac_lookup", outcome(err, "hit"), 1, 0))
	case *re.UpdateActionResultRequest:
		m.record(ctx, metric("ac_write", outcome(err, "ok"), 1, 0))
	case *re.FindMissingBlobsRequest:
		if err != nil {
			m.record(ctx, metric("cas_presence", "error", int64(max(1, len(request.BlobDigests))), 0))
			break
		}
		type digestKey struct {
			hash string
			size int64
		}
		missing := make(map[digestKey]struct{})
		for _, digest := range response.(*re.FindMissingBlobsResponse).MissingBlobDigests {
			missing[digestKey{digest.GetHash(), digest.GetSizeBytes()}] = struct{}{}
		}
		var misses int64
		for _, digest := range request.BlobDigests {
			if _, absent := missing[digestKey{digest.GetHash(), digest.GetSizeBytes()}]; absent {
				misses++
			}
		}
		m.record(ctx, metric("cas_presence", "hit", int64(len(request.BlobDigests))-misses, 0),
			metric("cas_presence", "miss", misses, 0))
	case *re.BatchReadBlobsRequest:
		if err != nil {
			m.record(ctx, metric("cas_read", "error", int64(max(1, len(request.Digests))), 0))
			break
		}
		var hits, misses, failures, bytes int64
		for _, item := range response.(*re.BatchReadBlobsResponse).Responses {
			switch codes.Code(item.GetStatus().GetCode()) {
			case codes.OK:
				hits++
				bytes += int64(len(item.Data))
			case codes.NotFound:
				misses++
			default:
				failures++
			}
		}
		m.record(ctx, metric("cas_read", "hit", hits, bytes), metric("cas_read", "miss", misses, 0),
			metric("cas_read", "error", failures, 0))
	case *re.BatchUpdateBlobsRequest:
		var transferred int64
		for _, item := range request.Requests {
			transferred += int64(len(item.Data))
		}
		if err != nil {
			m.record(ctx, metric("cas_write", "error", int64(max(1, len(request.Requests))), transferred))
			break
		}
		var ok, failures int64
		for _, item := range response.(*re.BatchUpdateBlobsResponse).Responses {
			if codes.Code(item.GetStatus().GetCode()) == codes.OK {
				ok++
			} else {
				failures++
			}
		}
		// Count frontend traffic once even if the backend rejects some blobs.
		m.record(ctx, metric("cas_write", "ok", ok, 0), metric("cas_write", "error", failures, 0),
			metric("cas_write", "transfer", 0, transferred))
	}
	return response, err
}

type observedStream struct {
	grpc.ServerStream
	received, sent int64
}

func (s *observedStream) RecvMsg(message any) error {
	err := s.ServerStream.RecvMsg(message)
	if request, ok := message.(*bs.WriteRequest); err == nil && ok {
		s.received += int64(len(request.Data))
	}
	return err
}

func (s *observedStream) SendMsg(message any) error {
	err := s.ServerStream.SendMsg(message)
	if response, ok := message.(*bs.ReadResponse); err == nil && ok {
		s.sent += int64(len(response.Data))
	}
	return err
}

func (m instrumentation) stream(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
	switch info.FullMethod {
	case "/google.bytestream.ByteStream/Read", "/google.bytestream.ByteStream/Write":
		wrapped := &observedStream{ServerStream: stream}
		err := handler(srv, wrapped)
		if strings.HasSuffix(info.FullMethod, "/Read") {
			m.record(stream.Context(), metric("cas_read", outcome(err, "hit"), 1, wrapped.sent))
		} else {
			m.record(stream.Context(), metric("cas_write", outcome(err, "ok"), 1, wrapped.received))
		}
		return err
	default:
		return handler(srv, stream)
	}
}

func pipeResponses[T any](recv func() (*T, error), send func(*T) error) error {
	for {
		message, err := recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := send(message); err != nil {
			return err
		}
	}
}
