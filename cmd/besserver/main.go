package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	// Register Bazel's event payload so protojson can expand Any messages.
	_ "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
)

type publishServer struct {
	buildpb.UnimplementedPublishBuildEventServer
	logger *log.Logger
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
	listen := flag.String("listen", "localhost:1985", "address for the plaintext build event gRPC service")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected positional arguments: %v", flag.Args())
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	defer listener.Close()

	logger := log.New(os.Stderr, "besserver: ", log.LstdFlags)
	server := grpc.NewServer()
	buildpb.RegisterPublishBuildEventServer(server, &publishServer{logger: logger})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			timer := time.AfterFunc(5*time.Second, server.Stop)
			defer timer.Stop()
			server.GracefulStop()
		case <-done:
		}
	}()
	logger.Printf("listening on %s (Bazel --bes_backend=grpc://%s)", listener.Addr(), listener.Addr())
	return server.Serve(listener)
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
