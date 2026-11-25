package invocation

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"time"

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
	days := req.GetWindowDays()
	if days == 0 {
		days = 30
	}
	if days < 1 || days > 90 {
		return nil, status.Error(codes.InvalidArgument, "window_days must be between 1 and 90")
	}
	metrics, err := s.storage.GroupMetrics(ctx, name, time.Now().UTC().AddDate(0, 0, -int(days)))
	return metrics, storageError(err)
}

type pageCursor struct {
	CreatedUS int64
	ID        string
	Group     string
}

func pageResponse(group string, limit int, rows []*pb.Invocation, active *pb.Invocation) *pb.ListInvocationsResponse {
	result := &pb.ListInvocationsResponse{Invocations: rows, ActiveInvocation: active}
	if len(rows) > limit {
		result.Invocations = rows[:limit]
		last := rows[limit-1]
		token, _ := json.Marshal(pageCursor{last.GetCreatedAt().AsTime().UnixMicro(), last.GetInvocationId(), group})
		result.NextPageToken = base64.RawURLEncoding.EncodeToString(token)
	}
	return result
}

func (s *Store) ListInvocations(ctx context.Context, req *pb.ListInvocationsRequest) (*pb.ListInvocationsResponse, error) {
	group := req.GetInvocationGroup()
	if group != "" && !validGroupName.MatchString(group) {
		return nil, status.Error(codes.InvalidArgument, "invalid invocation group name")
	}
	limit := int(req.GetPageSize())
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 200 {
		return nil, status.Error(codes.InvalidArgument, "page_size must be between 1 and 200")
	}
	var cursor pageCursor
	if token := req.GetPageToken(); token != "" {
		if len(token) > 4096 {
			return nil, status.Error(codes.InvalidArgument, "invalid page token")
		}
		data, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Group != group || cursor.ID == "" || cursor.CreatedUS <= 0 {
			return nil, status.Error(codes.InvalidArgument, "invalid page token")
		}
	}
	result, err := s.storage.ListPage(ctx, group, limit, cursor)
	return result, storageError(err)
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
