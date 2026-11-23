package invocation

import (
	"context"
	"errors"
	"sync"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Storage persists accepted BES events and the invocation summaries derived from them.
// Calls may be concurrent. A successful append commits both before returning.
// Identical retries return false and conflicting retries return AlreadyExists.
type Storage interface {
	Append(context.Context, *buildpb.OrderedBuildEvent, bool) (inserted bool, err error)
	Get(context.Context, string) (*pb.Invocation, error)
	List(context.Context) ([]*pb.Invocation, error)
	ListByGroup(context.Context, string) ([]*pb.Invocation, error)
	ListGroups(context.Context) ([]*pb.InvocationGroup, error)
	GroupMetrics(context.Context, string) (*pb.InvocationGroupMetrics, error)
	// Replay returns at most limit events in arrival order after the cursor.
	// The returned cursor is the last event read, or the replay snapshot's
	// high-water mark when the requested invocation has no more events.
	Replay(ctx context.Context, invocationID string, after uint64, limit int) ([]*pb.InvocationEvent, uint64, error)
	Close() error
}

// Store serves invocation reads and subscriptions over one storage backend.
type Store struct {
	pb.UnimplementedInvocationServiceServer
	storage Storage
	mu      sync.Mutex
	changed chan struct{}
}

func NewStore(storage Storage) *Store {
	return &Store{storage: storage, changed: make(chan struct{})}
}

// Open opens a legacy journal.
func Open(path string) (*Store, error) {
	storage, err := openJournal(path)
	if err != nil {
		return nil, err
	}
	return NewStore(storage), nil
}

// ObserveRemoteCache persists a request's aggregate observations together.
func (s *Store) ObserveRemoteCache(ctx context.Context, id string, metrics []*pb.RemoteCacheMetric) error {
	storage, ok := s.storage.(*sqliteStorage)
	if !ok {
		return errors.New("remote cache observations require SQLite storage")
	}
	return storage.observeRemoteCache(ctx, id, metrics)
}

func (s *Store) Close() error { return s.storage.Close() }

func (s *Store) Append(event *buildpb.OrderedBuildEvent, lifecycle bool) error {
	return s.AppendContext(context.Background(), event, lifecycle)
}

func (s *Store) AppendContext(ctx context.Context, event *buildpb.OrderedBuildEvent, lifecycle bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	inserted, err := s.storage.Append(ctx, event, lifecycle)
	if err != nil {
		return storageError(err)
	}
	if inserted {
		close(s.changed)
		s.changed = make(chan struct{})
	}
	return nil
}

// Capture the replay page and notification channel under the append lock.
func (s *Store) batch(ctx context.Context, id string, cursor uint64) ([]*pb.InvocationEvent, uint64, <-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	events, next, err := s.storage.Replay(ctx, id, cursor, 256)
	return events, next, s.changed, storageError(err)
}

func storageError(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := status.FromError(err); ok {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return status.FromContextError(err).Err()
	}
	return status.Error(codes.Internal, err.Error())
}
