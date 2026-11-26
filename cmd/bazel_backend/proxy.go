package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"

	lro "cloud.google.com/go/longrunning/autogen/longrunningpb"
	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"
)

type executionProxy struct {
	re.UnimplementedExecutionServer
	lro.UnimplementedOperationsServer
	execution      re.ExecutionClient
	operations     lro.OperationsClient
	forwardHeaders bool
}

func (p *executionProxy) context(ctx context.Context) context.Context {
	return remotecache.ProxyContext(ctx, p.forwardHeaders)
}

func (p *executionProxy) Execute(req *re.ExecuteRequest, stream re.Execution_ExecuteServer) error {
	upstream, err := p.execution.Execute(p.context(stream.Context()), req)
	if err != nil {
		return err
	}
	return forwardResponses(upstream, stream)
}

func (p *executionProxy) WaitExecution(req *re.WaitExecutionRequest, stream re.Execution_WaitExecutionServer) error {
	upstream, err := p.execution.WaitExecution(p.context(stream.Context()), req)
	if err != nil {
		return err
	}
	return forwardResponses(upstream, stream)
}

func (p *executionProxy) GetOperation(ctx context.Context, req *lro.GetOperationRequest) (*lro.Operation, error) {
	return p.operations.GetOperation(p.context(ctx), req)
}

func (p *executionProxy) ListOperations(ctx context.Context, req *lro.ListOperationsRequest) (*lro.ListOperationsResponse, error) {
	return p.operations.ListOperations(p.context(ctx), req)
}

func (p *executionProxy) WaitOperation(ctx context.Context, req *lro.WaitOperationRequest) (*lro.Operation, error) {
	return p.operations.WaitOperation(p.context(ctx), req)
}

func (p *executionProxy) CancelOperation(ctx context.Context, req *lro.CancelOperationRequest) (*emptypb.Empty, error) {
	return p.operations.CancelOperation(p.context(ctx), req)
}

func (p *executionProxy) DeleteOperation(ctx context.Context, req *lro.DeleteOperationRequest) (*emptypb.Empty, error) {
	return p.operations.DeleteOperation(p.context(ctx), req)
}

func forwardResponses[T any](upstream grpc.ServerStreamingClient[T], downstream grpc.ServerStreamingServer[T]) error {
	defer func() { downstream.SetTrailer(upstream.Trailer()) }()
	header, err := upstream.Header()
	if err != nil {
		return err
	}
	if len(header) > 0 {
		if err := downstream.SendHeader(header); err != nil {
			return err
		}
	}
	for {
		message, err := upstream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if err := downstream.Send(message); err != nil {
			return err
		}
	}
}

func (options *executionOptions) startProxy(store *invocation.Store, logger *log.Logger, serveErrors chan<- error) (*grpc.Server, *remotecache.Monitor, func(), error) {
	conn, err := dialBackend(options.backend)
	if err != nil {
		return nil, nil, nil, err
	}
	listener, err := net.Listen("tcp", options.grpcListen)
	if err != nil {
		conn.Close()
		return nil, nil, nil, err
	}
	closeProxy := func() {
		listener.Close()
		conn.Close()
	}
	if !listener.Addr().(*net.TCPAddr).IP.IsLoopback() {
		closeProxy()
		return nil, nil, nil, errors.New("terminate TLS at a local proxy and bind the execution listener to loopback")
	}
	forward := trustedBackendLink(options.backend)
	backend := remotecache.NewExecutionProxy(conn, forward)
	monitor := remotecache.NewMonitor(backend)
	server := remotecache.NewServer(backend, store.ObserveRemoteCache, logger, grpc.StatsHandler(monitor))
	proxy := &executionProxy{execution: re.NewExecutionClient(conn), operations: lro.NewOperationsClient(conn), forwardHeaders: forward}
	re.RegisterExecutionServer(server, proxy)
	lro.RegisterOperationsServer(server, proxy)
	go func() { serveErrors <- server.Serve(listener) }()
	logger.Printf("remote execution enabled on %s (proxy)", listener.Addr())
	return server, monitor, closeProxy, nil
}

func executionHTTPProxy(address string) (http.Handler, error) {
	upstream, err := url.Parse(address)
	if err != nil || upstream.Hostname() == "" || upstream.User != nil ||
		(upstream.Scheme != "https" && upstream.Scheme != "http") ||
		(upstream.Path != "" && upstream.Path != "/") || upstream.ForceQuery || upstream.RawQuery != "" || upstream.Fragment != "" ||
		!trustedBackendLink(address) {
		return nil, errors.New("--remote_execution_http_backend requires an HTTPS or loopback HTTP origin")
	}
	return &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(upstream)
			// The edge applies its own browser origin policy.
			request.Out.Header.Del("Origin")
		},
	}, nil
}
