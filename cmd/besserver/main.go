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
	"google.golang.org/grpc/keepalive"
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
	publishers := make(map[string]func())
	defer func() {
		for _, release := range publishers {
			release()
		}
	}()
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
			id := event.StreamId.GetInvocationId()
			if id != "" && event.StreamId.GetComponent() == buildpb.StreamId_TOOL && publishers[id] == nil {
				publishers[id] = s.store.BeginPublish(id)
			}
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
	incompleteAfter := flag.Duration("incomplete_after", 5*time.Minute, "grace period before an abandoned invocation is marked incomplete")
	cacheListen := flag.String("cache_listen", "", "optional address for the plaintext instrumented remote cache")
	cacheDir := flag.String("cache_dir", "", "file-backed remote cache directory")
	cacheMaxBytes := flag.Int64("cache_max_bytes", 0, "local cache disk budget in bytes (0 disables eviction)")
	archiveAfter := flag.Duration("archive_after", 0, "archive completed runs after this age (for example 720h)")
	archiveCache := flag.String("archive_cache", "", "non-evicting archive cache URL (grpc:// or grpcs://)")
	archiveInstance := flag.String("archive_instance", "", "dedicated REAPI CAS instance for archived events")
	cacheUpstream := flag.String("cache_upstream", "", "upstream remote cache URL (grpc:// or grpcs://)")
	flag.Parse()
	if *incompleteAfter <= 0 {
		return errors.New("--incomplete_after must be positive")
	}
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %v", flag.Args())
	}
	if *journal != "" && *database != "" {
		return errors.New("--journal and --sqlite are mutually exclusive")
	}
	if (*cacheListen != "") != (*cacheDir != "" || *cacheUpstream != "") || (*cacheDir != "" && *cacheUpstream != "") {
		return errors.New("--cache_listen requires exactly one of --cache_dir or --cache_upstream")
	}
	if *cacheMaxBytes < 0 || (*cacheMaxBytes > 0 && *cacheDir == "") {
		return errors.New("--cache_max_bytes must be nonnegative and requires --cache_dir when set")
	}
	if *cacheListen != "" && *journal != "" {
		return errors.New("instrumented remote cache requires SQLite storage")
	}
	if *archiveAfter < 0 || (*archiveAfter > 0 && *archiveCache == "") ||
		((*archiveCache == "") != (*archiveInstance == "")) || (*archiveCache != "" && *journal != "") {
		return errors.New("archival requires SQLite, --archive_cache and --archive_instance; use --archive_after to enable offloading")
	}
	var archive invocation.BlobArchive
	if *archiveCache != "" {
		conn, err := dialCache(*archiveCache)
		if err != nil {
			return fmt.Errorf("archive cache: %w", err)
		}
		defer conn.Close()
		archive, err = remotecache.NewBlobArchive(conn, *archiveInstance)
		if err != nil {
			return err
		}
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
		storage, err = invocation.OpenSQLiteWithArchive(path, archive)
		if err == nil {
			store = invocation.NewStore(storage)
		}
	}
	if err != nil {
		return err
	}
	defer store.Close()
	if _, err := store.ExpireIncomplete(context.Background(), time.Now(), *incompleteAfter); err != nil {
		return fmt.Errorf("expire abandoned invocations at startup: %w", err)
	}
	httpListener, err := net.Listen("tcp", *httpListen)
	if err != nil {
		return err
	}
	defer httpListener.Close()
	logger := log.New(os.Stderr, "besserver: ", log.LstdFlags)
	server := grpc.NewServer(grpc.KeepaliveParams(keepalive.ServerParameters{
		Time: time.Minute, Timeout: 20 * time.Second,
	}))
	buildpb.RegisterPublishBuildEventServer(server, &publishServer{logger: logger, store: store})
	invocationpb.RegisterInvocationServiceServer(server, store)
	httpServer := &http.Server{Handler: store.Handler(*origin), ReadHeaderTimeout: 10 * time.Second}
	serveErrors := make(chan error, 3)
	var cacheServer *grpc.Server
	if *cacheListen != "" {
		backend, cleanup, err := cacheBackend(*cacheDir, *cacheUpstream, *cacheMaxBytes)
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
		if *cacheMaxBytes > 0 {
			logger.Printf("remote cache disk budget: %d bytes (LRU)", *cacheMaxBytes)
		}
		logger.Printf("remote cache listening on %s (Bazel --remote_cache=grpc://%s)", cacheListener.Addr(), cacheListener.Addr())
	}
	go func() { serveErrors <- server.Serve(listener) }()
	go func() { serveErrors <- httpServer.Serve(httpListener) }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *archiveAfter > 0 {
		done := make(chan struct{})
		archiveCtx, cancel := context.WithCancel(ctx)
		defer func() {
			cancel()
			<-done
		}()
		go func() {
			defer close(done)
			archiveRuns(archiveCtx, store, *archiveAfter, logger)
		}()
	}
	logger.Printf("BES listening on %s (Bazel --bes_backend=grpc://%s)", listener.Addr(), listener.Addr())
	logger.Printf("invocation API listening on http://%s", httpListener.Addr())
	var serveErr error
	sweep := time.NewTicker(min(30*time.Second, max(time.Millisecond, *incompleteAfter/2)))
	defer sweep.Stop()
serving:
	for {
		select {
		case <-ctx.Done():
			break serving
		case serveErr = <-serveErrors:
			break serving
		case <-sweep.C:
			if _, err := store.ExpireIncomplete(ctx, time.Now(), *incompleteAfter); err != nil && ctx.Err() == nil {
				logger.Printf("expire abandoned invocations: %v", err)
			}
		}
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

func archiveRuns(ctx context.Context, store *invocation.Store, age time.Duration, logger *log.Logger) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for ctx.Err() == nil {
		writeCtx, cancel := context.WithTimeout(ctx, time.Minute)
		archived, err := store.ArchiveBefore(writeCtx, time.Now().Add(-age))
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Printf("archive build events: %v", err)
		}
		if archived && err == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func cacheBackend(dir, upstream string, maxBytes int64) (remotecache.Backend, func(), error) {
	if maxBytes > 0 {
		backend, err := remotecache.NewBoundedFileCache(dir, maxBytes)
		if err != nil {
			return nil, nil, err
		}
		return backend, func() { backend.Close() }, nil
	}
	if dir != "" {
		backend, err := remotecache.NewFileCache(dir)
		return backend, func() {}, err
	}
	conn, err := dialCache(upstream)
	if err != nil {
		return nil, nil, err
	}
	return remotecache.NewProxy(conn), func() { conn.Close() }, nil
}

func dialCache(upstream string) (*grpc.ClientConn, error) {
	endpoint, err := url.Parse(upstream)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil ||
		(endpoint.Path != "" && endpoint.Path != "/") || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("expected grpc://host[:port] or grpcs://host[:port]")
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
		return nil, errors.New("cache scheme must be grpc or grpcs")
	}
	target := net.JoinHostPort(endpoint.Hostname(), port)
	return grpc.NewClient(target, grpc.WithTransportCredentials(transport),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(remotecache.MaxMessageBytes),
			grpc.MaxCallSendMsgSize(remotecache.MaxMessageBytes)))
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
