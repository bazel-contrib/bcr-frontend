package remotecache

import (
	"context"
	"io"
	"strings"

	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

type proxy struct {
	re.UnimplementedActionCacheServer
	re.UnimplementedContentAddressableStorageServer
	re.UnimplementedCapabilitiesServer
	bs.UnimplementedByteStreamServer

	ac             re.ActionCacheClient
	cas            re.ContentAddressableStorageClient
	capabilities   re.CapabilitiesClient
	blobs          bs.ByteStreamClient
	forwardHeaders bool
	execution      bool
}

func NewProxy(conn grpc.ClientConnInterface, forwardHeaders bool) Backend {
	return newProxy(conn, forwardHeaders, false)
}

// NewExecutionProxy also forwards the upstream's remote execution capabilities.
func NewExecutionProxy(conn grpc.ClientConnInterface, forwardHeaders bool) Backend {
	return newProxy(conn, forwardHeaders, true)
}

func newProxy(conn grpc.ClientConnInterface, forwardHeaders, execution bool) Backend {
	return &proxy{
		ac: re.NewActionCacheClient(conn), cas: re.NewContentAddressableStorageClient(conn),
		capabilities: re.NewCapabilitiesClient(conn), blobs: bs.NewByteStreamClient(conn),
		forwardHeaders: forwardHeaders,
		execution:      execution,
	}
}

func (p *proxy) upstreamContext(ctx context.Context) context.Context {
	return ProxyContext(ctx, p.forwardHeaders)
}

// ProxyContext forwards Bazel request metadata and, on trusted links, caller metadata.
func ProxyContext(ctx context.Context, forwardHeaders bool) context.Context {
	incoming, _ := metadata.FromIncomingContext(ctx)
	// gRPC supplies these hop-specific values on the new connection.
	for key := range incoming {
		if (!forwardHeaders && key != requestMetadataKey) || strings.HasPrefix(key, "grpc-") || strings.HasPrefix(key, ":") ||
			key == "content-type" || key == "user-agent" || key == "te" {
			delete(incoming, key)
		}
	}
	return metadata.NewOutgoingContext(ctx, incoming)
}

func (p *proxy) GetActionResult(ctx context.Context, req *re.GetActionResultRequest) (*re.ActionResult, error) {
	return p.ac.GetActionResult(p.upstreamContext(ctx), req)
}

func (p *proxy) UpdateActionResult(ctx context.Context, req *re.UpdateActionResultRequest) (*re.ActionResult, error) {
	return p.ac.UpdateActionResult(p.upstreamContext(ctx), req)
}

func (p *proxy) FindMissingBlobs(ctx context.Context, req *re.FindMissingBlobsRequest) (*re.FindMissingBlobsResponse, error) {
	return p.cas.FindMissingBlobs(p.upstreamContext(ctx), req)
}

func (p *proxy) BatchReadBlobs(ctx context.Context, req *re.BatchReadBlobsRequest) (*re.BatchReadBlobsResponse, error) {
	return p.cas.BatchReadBlobs(p.upstreamContext(ctx), req)
}

func (p *proxy) BatchUpdateBlobs(ctx context.Context, req *re.BatchUpdateBlobsRequest) (*re.BatchUpdateBlobsResponse, error) {
	return p.cas.BatchUpdateBlobs(p.upstreamContext(ctx), req)
}

func (p *proxy) SplitBlob(ctx context.Context, req *re.SplitBlobRequest) (*re.SplitBlobResponse, error) {
	return p.cas.SplitBlob(p.upstreamContext(ctx), req)
}

func (p *proxy) SpliceBlob(ctx context.Context, req *re.SpliceBlobRequest) (*re.SpliceBlobResponse, error) {
	return p.cas.SpliceBlob(p.upstreamContext(ctx), req)
}

func (p *proxy) QueryWriteStatus(ctx context.Context, req *bs.QueryWriteStatusRequest) (*bs.QueryWriteStatusResponse, error) {
	return p.blobs.QueryWriteStatus(p.upstreamContext(ctx), req)
}

func (p *proxy) GetCapabilities(ctx context.Context, req *re.GetCapabilitiesRequest) (*re.ServerCapabilities, error) {
	response, err := p.capabilities.GetCapabilities(p.upstreamContext(ctx), req)
	if err != nil {
		return nil, err
	}
	if !p.execution {
		response.ExecutionCapabilities = nil
	}
	if caps := response.GetCacheCapabilities(); caps != nil && (caps.MaxBatchTotalSizeBytes == 0 || caps.MaxBatchTotalSizeBytes > maxBatchBytes) {
		caps.MaxBatchTotalSizeBytes = maxBatchBytes
	}
	return response, nil
}

func (p *proxy) GetTree(req *re.GetTreeRequest, downstream re.ContentAddressableStorage_GetTreeServer) error {
	upstream, err := p.cas.GetTree(p.upstreamContext(downstream.Context()), req)
	if err != nil {
		return err
	}
	return pipeResponses(upstream.Recv, downstream.Send)
}

func (p *proxy) Read(req *bs.ReadRequest, downstream bs.ByteStream_ReadServer) error {
	upstream, err := p.blobs.Read(p.upstreamContext(downstream.Context()), req)
	if err != nil {
		return err
	}
	return pipeResponses(upstream.Recv, downstream.Send)
}

func (p *proxy) Write(downstream bs.ByteStream_WriteServer) error {
	ctx, cancel := context.WithCancel(p.upstreamContext(downstream.Context()))
	defer cancel()
	upstream, err := p.blobs.Write(ctx)
	if err != nil {
		return err
	}
	// A cache may return success as soon as it recognizes a stored blob.
	// Read that response even when the client has paused sending chunks.
	pumpError := make(chan error, 1)
	go func() {
		for {
			req, err := downstream.Recv()
			if err == io.EOF {
				_ = upstream.CloseSend()
				return
			}
			if err == nil {
				err = upstream.Send(req)
				if err == io.EOF {
					return // RecvMsg provides the upstream status.
				}
			}
			if err != nil {
				pumpError <- err
				cancel()
				return
			}
			if req.GetFinishWrite() {
				_ = upstream.CloseSend()
				return
			}
		}
	}()
	response := new(bs.WriteResponse)
	if err := upstream.RecvMsg(response); err != nil {
		select {
		case err := <-pumpError:
			return err
		default:
			return err
		}
	}
	return downstream.SendAndClose(response)
}
