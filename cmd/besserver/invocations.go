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
	"syscall"
	"time"

	invocationpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/invocation"
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
	var origins []string
	flag.Func("frontend_origin", "allowed BCR frontend origin (repeatable; defaults to http://localhost:8080)", func(origin string) error {
		origins = append(origins, origin)
		return nil
	})
	journal := flag.String("journal", "", "use a legacy event journal at this path")
	database := flag.String("sqlite", "", "path to the SQLite event database (default invocations.sqlite)")
	incompleteAfter := flag.Duration("incomplete_after", 5*time.Minute, "grace period before an abandoned invocation is marked incomplete")
	cache := registerCacheFlags()
	flag.Parse()
	if len(origins) == 0 {
		origins = []string{"http://localhost:8080"}
	}
	if *incompleteAfter <= 0 {
		return errors.New("--incomplete_after must be positive")
	}
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %v", flag.Args())
	}
	if *journal != "" && *database != "" {
		return errors.New("--journal and --sqlite are mutually exclusive")
	}
	if err := cache.validate(*journal != ""); err != nil {
		return err
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
	logger := log.New(os.Stderr, "besserver: ", log.LstdFlags)
	server := grpc.NewServer(grpc.KeepaliveParams(keepalive.ServerParameters{
		Time: time.Minute, Timeout: 20 * time.Second,
	}))
	buildpb.RegisterPublishBuildEventServer(server, &publishServer{logger: logger, store: store})
	invocationpb.RegisterInvocationServiceServer(server, store)
	httpServer := &http.Server{Handler: store.Handler(origins...), ReadHeaderTimeout: 10 * time.Second}
	serveErrors := make(chan error, 3)
	cacheServer, closeCache, err := cache.start(store, logger, serveErrors)
	if err != nil {
		return err
	}
	defer closeCache()
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
