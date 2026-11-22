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

	ac           re.ActionCacheClient
	cas          re.ContentAddressableStorageClient
	capabilities re.CapabilitiesClient
	blobs        bs.ByteStreamClient
}

func NewProxy(conn grpc.ClientConnInterface) Backend {
	return &proxy{
		ac: re.NewActionCacheClient(conn), cas: re.NewContentAddressableStorageClient(conn),
		capabilities: re.NewCapabilitiesClient(conn), blobs: bs.NewByteStreamClient(conn),
	}
}

func upstreamContext(ctx context.Context) context.Context {
	incoming, _ := metadata.FromIncomingContext(ctx)
	// gRPC supplies these hop-specific values on the new connection.
	for key := range incoming {
		if strings.HasPrefix(key, "grpc-") || strings.HasPrefix(key, ":") ||
			key == "content-type" || key == "user-agent" || key == "te" {
			delete(incoming, key)
		}
	}
	return metadata.NewOutgoingContext(ctx, incoming)
}

func (p *proxy) GetActionResult(ctx context.Context, req *re.GetActionResultRequest) (*re.ActionResult, error) {
	return p.ac.GetActionResult(upstreamContext(ctx), req)
}

func (p *proxy) UpdateActionResult(ctx context.Context, req *re.UpdateActionResultRequest) (*re.ActionResult, error) {
	return p.ac.UpdateActionResult(upstreamContext(ctx), req)
}

func (p *proxy) FindMissingBlobs(ctx context.Context, req *re.FindMissingBlobsRequest) (*re.FindMissingBlobsResponse, error) {
	return p.cas.FindMissingBlobs(upstreamContext(ctx), req)
}

func (p *proxy) BatchReadBlobs(ctx context.Context, req *re.BatchReadBlobsRequest) (*re.BatchReadBlobsResponse, error) {
	return p.cas.BatchReadBlobs(upstreamContext(ctx), req)
}

func (p *proxy) BatchUpdateBlobs(ctx context.Context, req *re.BatchUpdateBlobsRequest) (*re.BatchUpdateBlobsResponse, error) {
	return p.cas.BatchUpdateBlobs(upstreamContext(ctx), req)
}

func (p *proxy) SplitBlob(ctx context.Context, req *re.SplitBlobRequest) (*re.SplitBlobResponse, error) {
	return p.cas.SplitBlob(upstreamContext(ctx), req)
}

func (p *proxy) SpliceBlob(ctx context.Context, req *re.SpliceBlobRequest) (*re.SpliceBlobResponse, error) {
	return p.cas.SpliceBlob(upstreamContext(ctx), req)
}

func (p *proxy) QueryWriteStatus(ctx context.Context, req *bs.QueryWriteStatusRequest) (*bs.QueryWriteStatusResponse, error) {
	return p.blobs.QueryWriteStatus(upstreamContext(ctx), req)
}

func (p *proxy) GetCapabilities(ctx context.Context, req *re.GetCapabilitiesRequest) (*re.ServerCapabilities, error) {
	response, err := p.capabilities.GetCapabilities(upstreamContext(ctx), req)
	if err != nil {
		return nil, err
	}
	response.ExecutionCapabilities = nil
	return response, nil
}

func (p *proxy) GetTree(req *re.GetTreeRequest, downstream re.ContentAddressableStorage_GetTreeServer) error {
	upstream, err := p.cas.GetTree(upstreamContext(downstream.Context()), req)
	if err != nil {
		return err
	}
	return pipeResponses(upstream.Recv, downstream.Send)
}

func (p *proxy) Read(req *bs.ReadRequest, downstream bs.ByteStream_ReadServer) error {
	upstream, err := p.blobs.Read(upstreamContext(downstream.Context()), req)
	if err != nil {
		return err
	}
	return pipeResponses(upstream.Recv, downstream.Send)
}

func (p *proxy) Write(downstream bs.ByteStream_WriteServer) error {
	upstream, err := p.blobs.Write(upstreamContext(downstream.Context()))
	if err != nil {
		return err
	}
	for {
		req, err := downstream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if err := upstream.Send(req); err == io.EOF {
			break // The final status is available via CloseAndRecv.
		} else if err != nil {
			return err
		}
		if req.GetFinishWrite() {
			break
		}
	}
	response, err := upstream.CloseAndRecv()
	if err != nil {
		return err
	}
	return downstream.SendAndClose(response)
}
