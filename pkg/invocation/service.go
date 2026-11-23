package invocation

import (
	"context"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Store) ListInvocationGroups(ctx context.Context, _ *pb.ListInvocationGroupsRequest) (*pb.ListInvocationGroupsResponse, error) {
	groups, err := s.storage.ListGroups(ctx)
	if err != nil {
		return nil, storageError(err)
	}
	return &pb.ListInvocationGroupsResponse{Groups: groups}, nil
}

func (s *Store) GetInvocationGroupMetrics(ctx context.Context, req *pb.GetInvocationGroupMetricsRequest) (*pb.InvocationGroupMetrics, error) {
	name := req.GetInvocationGroup()
	if !validGroupName.MatchString(name) {
		return nil, status.Error(codes.InvalidArgument, "invalid invocation group name")
	}
	metrics, err := s.storage.GroupMetrics(ctx, name)
	return metrics, storageError(err)
}

func (s *Store) ListInvocations(ctx context.Context, req *pb.ListInvocationsRequest) (*pb.ListInvocationsResponse, error) {
	var invocations []*pb.Invocation
	var err error
	if group := req.GetInvocationGroup(); group != "" {
		if !validGroupName.MatchString(group) {
			return nil, status.Error(codes.InvalidArgument, "invalid invocation group name")
		}
		invocations, err = s.storage.ListByGroup(ctx, group)
	} else {
		invocations, err = s.storage.List(ctx)
	}
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
