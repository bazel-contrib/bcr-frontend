package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	invocationpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	"github.com/bazel-contrib/bcr-frontend/pkg/remoteexecution"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	// Register Bazel's event payload so protojson can expand Any messages.
	_ "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
)

type publishServer struct {
	buildpb.UnimplementedPublishBuildEventServer
	logger         *log.Logger
	store          *invocation.Store
	upstream       buildpb.PublishBuildEventClient
	forwardHeaders bool
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
	if s.upstream != nil {
		return s.upstream.PublishLifecycleEvent(remotecache.ProxyContext(ctx, s.forwardHeaders), req)
	}
	return &emptypb.Empty{}, nil
}

func (s *publishServer) PublishBuildToolEventStream(stream buildpb.PublishBuildEvent_PublishBuildToolEventStreamServer) error {
	if s.upstream == nil {
		return s.receiveBuildEvents(stream, func(req *buildpb.PublishBuildToolEventStreamRequest) error {
			event := req.GetOrderedBuildEvent()
			return stream.Send(&buildpb.PublishBuildToolEventStreamResponse{StreamId: event.StreamId, SequenceNumber: event.SequenceNumber})
		})
	}
	ctx, cancel := context.WithCancel(remotecache.ProxyContext(stream.Context(), s.forwardHeaders))
	defer cancel()
	upstream, err := s.upstream.PublishBuildToolEventStream(ctx)
	if err != nil {
		return err
	}
	inputError := make(chan error, 1)
	go func() {
		err := s.receiveBuildEvents(stream, upstream.Send)
		if err != nil && err != io.EOF {
			inputError <- err
			cancel()
			return
		}
		// Upstream reports its final status on the response stream.
		_ = upstream.CloseSend()
	}()
	err = forwardResponses(upstream, stream)
	select {
	case inputErr := <-inputError:
		return inputErr
	default:
		return err
	}
}

func (s *publishServer) receiveBuildEvents(stream buildpb.PublishBuildEvent_PublishBuildToolEventStreamServer, handle func(*buildpb.PublishBuildToolEventStreamRequest) error) error {
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
		if err := handle(req); err != nil {
			return err
		}
	}
}

func run() error {
	listen := flag.String("bes_backend_grpc_listen", "localhost:1973", "address for the plaintext build event gRPC service")
	besBackend := flag.String("bes_backend", "", "upstream Build Event Service gRPC URL (grpc:// or grpcs://)")
	httpListen := flag.String("http_listen", "localhost:1974", "address for the shared HTTP and SSE APIs")
	var origins []string
	flag.Func("http_allow_origin", "allowed BCR frontend origin (repeatable; defaults to http://localhost:8080)", func(origin string) error {
		if strings.Contains(origin, ",") {
			return errors.New("set --http_allow_origin once per origin")
		}
		origins = append(origins, origin)
		return nil
	})
	journal := flag.String("bes_backend_journal", "", "use a legacy event journal at this path")
	database := flag.String("bes_backend_sqlite", "", "path to the SQLite event database (default invocations.sqlite)")
	incompleteAfter := flag.Duration("bes_backend_incomplete_after", 5*time.Minute, "grace period before an abandoned invocation is marked incomplete")
	cache := registerCacheFlags()
	execution := registerExecutionFlags()
	flag.Parse()
	if len(origins) == 0 {
		origins = []string{"http://localhost:8080"}
	}
	if *incompleteAfter <= 0 {
		return errors.New("--bes_backend_incomplete_after must be positive")
	}
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %v", flag.Args())
	}
	if *journal != "" && *database != "" {
		return errors.New("--bes_backend_journal and --bes_backend_sqlite are mutually exclusive")
	}
	if err := cache.validate(*journal != ""); err != nil {
		return err
	}
	if execution.grpcListen != "" && *journal != "" {
		return errors.New("--remote_execution_grpc_listen requires SQLite build event storage")
	}
	var httpProxy http.Handler
	if execution.httpBackend != "" {
		if execution.enabled() {
			return errors.New("--remote_execution_http_backend cannot be used with a local scheduler")
		}
		var err error
		httpProxy, err = executionHTTPProxy(execution.httpBackend)
		if err != nil {
			return err
		}
	}
	archive, closeArchive, err := cache.openArchive()
	if err != nil {
		return err
	}
	defer closeArchive()
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
	logger := log.New(os.Stderr, "bazel_backend: ", log.LstdFlags)
	server := grpc.NewServer(grpc.KeepaliveParams(keepalive.ServerParameters{
		Time: time.Minute, Timeout: 20 * time.Second,
	}))
	publisher := &publishServer{logger: logger, store: store}
	if *besBackend != "" {
		conn, err := dialBackend(*besBackend)
		if err != nil {
			return fmt.Errorf("--bes_backend: %w", err)
		}
		defer conn.Close()
		publisher.upstream = buildpb.NewPublishBuildEventClient(conn)
		publisher.forwardHeaders = trustedBackendLink(*besBackend)
	}
	buildpb.RegisterPublishBuildEventServer(server, publisher)
	invocationpb.RegisterInvocationServiceServer(server, store)
	serveErrors := make(chan error, 5)
	dedicatedCache, err := execution.dedicatedCache(cache)
	if err != nil {
		return err
	}
	sharedExecution := execution
	if dedicatedCache != nil || execution.backend != "" {
		sharedExecution = new(executionOptions)
	}
	cacheServer, scheduler, cacheMonitor, closeCache, err := cache.start(store, sharedExecution, logger, serveErrors)
	if err != nil {
		return err
	}
	defer closeCache()
	grpcServers := []*grpc.Server{server}
	if cacheServer != nil {
		grpcServers = append(grpcServers, cacheServer)
	}
	if dedicatedCache != nil {
		executionServer, dedicatedScheduler, executionCacheMonitor, closeExecution, err := dedicatedCache.start(store, execution, logger, serveErrors)
		if err != nil {
			return err
		}
		defer closeExecution()
		scheduler = dedicatedScheduler
		if cacheMonitor == nil {
			cacheMonitor = executionCacheMonitor
		}
		grpcServers = append(grpcServers, executionServer)
	}
	if execution.backend != "" {
		executionServer, executionMonitor, closeExecution, err := execution.startProxy(store, logger, serveErrors)
		if err != nil {
			return fmt.Errorf("--remote_execution_backend: %w", err)
		}
		defer closeExecution()
		if cacheMonitor == nil {
			cacheMonitor = executionMonitor
		}
		grpcServers = append(grpcServers, executionServer)
	}
	mux := http.NewServeMux()
	mux.Handle("/", store.Handler(origins...))
	if cacheMonitor != nil {
		mux.Handle("/api/remote-cache/", cacheMonitor.Handler(origins...))
	}
	var executionHandler func(...string) http.Handler
	if scheduler != nil {
		executionHandler = scheduler.Handler
	} else if httpProxy != nil {
		executionHandler = func(origins ...string) http.Handler { return remoteexecution.HTTPAccess(httpProxy, origins...) }
	}
	if executionHandler != nil {
		mux.Handle(remoteexecution.HTTPPrefix, executionHandler(origins...))
	}
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	var workerServer *http.Server
	if execution.workerListen != "" {
		if executionHandler == nil {
			return errors.New("--remote_execution_http_listen requires a scheduler or --remote_execution_http_backend")
		}
		workerListener, err := net.Listen("tcp", execution.workerListen)
		if err != nil {
			return err
		}
		defer workerListener.Close()
		if !workerListener.Addr().(*net.TCPAddr).IP.IsLoopback() {
			return errors.New("the Iroh worker gateway backend must bind to loopback")
		}
		workerMux := http.NewServeMux()
		workerMux.Handle(remoteexecution.HTTPPrefix+"worker/", executionHandler())
		workerServer = &http.Server{Handler: workerMux, ReadHeaderTimeout: 10 * time.Second}
		defer workerServer.Close()
		logger.Printf("Iroh worker gateway backend listening on %s", workerListener.Addr())
		go func() { serveErrors <- workerServer.Serve(workerListener) }()
	}
	go func() { serveErrors <- server.Serve(listener) }()
	go func() { serveErrors <- httpServer.Serve(httpListener) }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if cache.archiveAfter > 0 {
		done := make(chan struct{})
		archiveCtx, cancel := context.WithCancel(ctx)
		defer func() {
			cancel()
			<-done
		}()
		go func() {
			defer close(done)
			archiveRuns(archiveCtx, store, cache.archiveAfter, logger)
		}()
	}
	logger.Printf("BES listening on %s (Bazel --bes_backend=grpc://%s)", listener.Addr(), listener.Addr())
	logger.Printf("invocation API listening on http://%s", httpListener.Addr())
	var serveErr error
	sweep := time.NewTicker(min(30*time.Second, max(time.Millisecond, *incompleteAfter/2)))
	defer sweep.Stop()
	var executionSweep <-chan time.Time
	if scheduler != nil {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		executionSweep = ticker.C
	}
serving:
	for {
		select {
		case <-ctx.Done():
			break serving
		case serveErr = <-serveErrors:
			break serving
		case <-executionSweep:
			if err := scheduler.Sweep(ctx); err != nil && ctx.Err() == nil {
				logger.Printf("expire remote execution leases: %v", err)
			}
		case <-sweep.C:
			if _, err := store.ExpireIncomplete(ctx, time.Now(), *incompleteAfter); err != nil && ctx.Err() == nil {
				logger.Printf("expire abandoned invocations: %v", err)
			}
		}
	}
	// Close browser subscriptions before waiting for the gRPC streams to drain.
	httpServer.Close()
	if workerServer != nil {
		workerServer.Close()
	}
	timer := time.AfterFunc(5*time.Second, func() {
		for _, grpcServer := range grpcServers {
			grpcServer.Stop()
		}
	})
	defer timer.Stop()
	for _, grpcServer := range grpcServers {
		grpcServer.GracefulStop()
	}
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
