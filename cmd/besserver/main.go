package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	invocationpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	// Register Bazel's event payload so protojson can expand Any messages.
	_ "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
)

type publishServer struct {
	buildpb.UnimplementedPublishBuildEventServer
	logger *log.Logger
	store  *invocation.Store
}

func (s *publishServer) logEvent(kind string, message proto.Message) {
	data, err := protojson.Marshal(message)
	if err != nil {
		// Preserve events containing Any types that this server doesn't know.
		s.logger.Printf("%s %s", kind, prototext.Format(message))
		return
	}
	s.logger.Printf("%s %s", kind, data)
}

func validateEvent(event *buildpb.OrderedBuildEvent) error {
	if event == nil || event.StreamId == nil || event.Event == nil {
		return status.Error(codes.InvalidArgument, "ordered_build_event requires stream_id and event")
	}
	if event.SequenceNumber <= 0 {
		return status.Error(codes.InvalidArgument, "sequence_number must be positive")
	}
	return nil
}

func (s *publishServer) PublishLifecycleEvent(ctx context.Context, req *buildpb.PublishLifecycleEventRequest) (*emptypb.Empty, error) {
	if err := validateEvent(req.GetBuildEvent()); err != nil {
		return nil, err
	}
	if s.store != nil {
		if err := s.store.AppendContext(ctx, req.BuildEvent, true); err != nil {
			return nil, err
		}
	}
	s.logEvent("lifecycle", req)
	return &emptypb.Empty{}, nil
}

func (s *publishServer) PublishBuildToolEventStream(stream buildpb.PublishBuildEvent_PublishBuildToolEventStreamServer) error {
	for {
		req, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		event := req.GetOrderedBuildEvent()
		if err := validateEvent(event); err != nil {
			return err
		}
		if s.store != nil {
			if err := s.store.AppendContext(stream.Context(), event, false); err != nil {
				return err
			}
		}
		s.logEvent("build", req)
		if err := stream.Send(&buildpb.PublishBuildToolEventStreamResponse{
			StreamId:       event.StreamId,
			SequenceNumber: event.SequenceNumber,
		}); err != nil {
			return err
		}
	}
}

func run() error {
	listen := flag.String("listen", "localhost:1973", "address for the plaintext build event gRPC service")
	httpListen := flag.String("http_listen", "localhost:1974", "address for invocation HTTP and SSE APIs")
	origin := flag.String("frontend_origin", "http://localhost:8080", "allowed BCR frontend origin")
	journal := flag.String("journal", "", "use a legacy event journal at this path")
	database := flag.String("sqlite", "", "path to the SQLite event database (default invocations.sqlite)")
	cacheListen := flag.String("cache_listen", "", "optional address for the plaintext instrumented remote cache")
	cacheDir := flag.String("cache_dir", "", "file-backed remote cache directory")
	cacheUpstream := flag.String("cache_upstream", "", "upstream remote cache URL (grpc:// or grpcs://)")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %v", flag.Args())
	}
	if *journal != "" && *database != "" {
		return errors.New("--journal and --sqlite are mutually exclusive")
	}
	if (*cacheListen != "") != (*cacheDir != "" || *cacheUpstream != "") || (*cacheDir != "" && *cacheUpstream != "") {
		return errors.New("--cache_listen requires exactly one of --cache_dir or --cache_upstream")
	}
	if *cacheListen != "" && *journal != "" {
		return errors.New("instrumented remote cache requires SQLite storage")
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer listener.Close()

	var store *invocation.Store
	if *journal != "" {
		store, err = invocation.Open(*journal)
	} else {
		path := *database
		if path == "" {
			path = "invocations.sqlite"
		}
		var storage invocation.Storage
		storage, err = invocation.OpenSQLite(path)
		if err == nil {
			store = invocation.NewStore(storage)
		}
	}
	if err != nil {
		return err
	}
	defer store.Close()
	httpListener, err := net.Listen("tcp", *httpListen)
	if err != nil {
		return err
	}
	defer httpListener.Close()
	logger := log.New(os.Stderr, "besserver: ", log.LstdFlags)
	server := grpc.NewServer()
	buildpb.RegisterPublishBuildEventServer(server, &publishServer{logger: logger, store: store})
	invocationpb.RegisterInvocationServiceServer(server, store)
	httpServer := &http.Server{Handler: store.Handler(*origin), ReadHeaderTimeout: 10 * time.Second}
	serveErrors := make(chan error, 3)
	var cacheServer *grpc.Server
	if *cacheListen != "" {
		backend, cleanup, err := cacheBackend(*cacheDir, *cacheUpstream)
		if err != nil {
			return err
		}
		defer cleanup()
		cacheListener, err := net.Listen("tcp", *cacheListen)
		if err != nil {
			return err
		}
		defer cacheListener.Close()
		cacheServer = remotecache.NewServer(backend, store.ObserveRemoteCache, logger)
		go func() { serveErrors <- cacheServer.Serve(cacheListener) }()
		logger.Printf("remote cache listening on %s (Bazel --remote_cache=grpc://%s)", cacheListener.Addr(), cacheListener.Addr())
	}
	go func() { serveErrors <- server.Serve(listener) }()
	go func() { serveErrors <- httpServer.Serve(httpListener) }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Printf("BES listening on %s (Bazel --bes_backend=grpc://%s)", listener.Addr(), listener.Addr())
	logger.Printf("invocation API listening on http://%s", httpListener.Addr())
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-serveErrors:
	}
	// Close browser subscriptions before waiting for the gRPC streams to drain.
	httpServer.Close()
	timer := time.AfterFunc(5*time.Second, func() {
		server.Stop()
		if cacheServer != nil {
			cacheServer.Stop()
		}
	})
	defer timer.Stop()
	if cacheServer != nil {
		cacheServer.GracefulStop()
	}
	server.GracefulStop()
	if errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	return serveErr
}

func cacheBackend(dir, upstream string) (remotecache.Backend, func(), error) {
	if dir != "" {
		backend, err := remotecache.NewFileCache(dir)
		return backend, func() {}, err
	}
	endpoint, err := url.Parse(upstream)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, nil, errors.New("invalid --cache_upstream, expected grpc://host[:port] or grpcs://host[:port]")
	}
	var transport credentials.TransportCredentials
	port := endpoint.Port()
	switch endpoint.Scheme {
	case "grpc":
		transport = insecure.NewCredentials()
		if port == "" {
			port = "80"
		}
	case "grpcs":
		transport = credentials.NewTLS(&tls.Config{ServerName: endpoint.Hostname(), MinVersion: tls.VersionTLS12})
		if port == "" {
			port = "443"
		}
	default:
		return nil, nil, errors.New("upstream cache scheme must be grpc or grpcs")
	}
	target := net.JoinHostPort(endpoint.Hostname(), port)
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(transport),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(remotecache.MaxMessageBytes),
			grpc.MaxCallSendMsgSize(remotecache.MaxMessageBytes)))
	if err != nil {
		return nil, nil, err
	}
	return remotecache.NewProxy(conn), func() { conn.Close() }, nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
