package invocation

import (
	"context"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Store) ListInvocations(ctx context.Context, _ *pb.ListInvocationsRequest) (*pb.ListInvocationsResponse, error) {
	invocations, err := s.storage.List(ctx)
	if err != nil {
		return nil, storageError(err)
	}
	return &pb.ListInvocationsResponse{Invocations: invocations}, nil
}

func (s *Store) GetInvocation(ctx context.Context, req *pb.GetInvocationRequest) (*pb.Invocation, error) {
	inv, err := s.storage.Get(ctx, req.GetInvocationId())
	return inv, storageError(err)
}

func (s *Store) WatchInvocation(req *pb.WatchInvocationRequest, stream grpc.ServerStreamingServer[pb.InvocationEvent]) error {
	if req.GetInvocationId() == "" {
		return status.Error(codes.InvalidArgument, "invocation_id is required")
	}
	cursor := req.AfterCursor
	for {
		events, next, changed, err := s.batch(stream.Context(), req.InvocationId, cursor)
		if err != nil {
			return err
		}
		for _, event := range events {
			if err := stream.Send(event); err != nil {
				return err
			}
		}
		if next != cursor {
			cursor = next
			continue
		}
		select {
		case <-stream.Context().Done():
			return status.FromContextError(stream.Context().Err()).Err()
		case <-changed:
		}
	}
}
