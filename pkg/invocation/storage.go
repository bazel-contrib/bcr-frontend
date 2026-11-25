package invocation

import (
	"context"
	"errors"
	"sync"
	"time"

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
	ListPage(context.Context, string, int, pageCursor) (*pb.ListInvocationsResponse, error)
	GroupMetrics(context.Context, string, time.Time) (*pb.InvocationGroupMetrics, error)
	ExpireIncomplete(ctx context.Context, now, cutoff time.Time, protected func(string) bool) (int, error)
	// Replay returns at most limit events in arrival order after the cursor.
	// The returned cursor is the last event read, or the replay snapshot's
	// high-water mark when the requested invocation has no more events.
	Replay(ctx context.Context, invocationID string, after uint64, limit int) ([]*pb.InvocationEvent, uint64, error)
	Close() error
}

// Store serves invocation reads and subscriptions over one storage backend.
type Store struct {
	pb.UnimplementedInvocationServiceServer
	storage    Storage
	mu         sync.Mutex
	changed    chan struct{}
	publishers map[string]int
	detached   map[string]time.Time
}

func NewStore(storage Storage) *Store {
	return &Store{
		storage: storage, changed: make(chan struct{}),
		publishers: make(map[string]int), detached: make(map[string]time.Time),
	}
}

// BeginPublish protects a live tool stream from idle expiry. The caller releases
// it when the RPC closes, leaving a grace period for the client's retries.
func (s *Store) BeginPublish(id string) func() {
	s.mu.Lock()
	s.publishers[id]++
	delete(s.detached, id)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.publishers[id]--
		if s.publishers[id] == 0 {
			delete(s.publishers, id)
			s.detached[id] = time.Now()
		}
	}
}

// ExpireIncomplete finalizes detached invocations without a complete tool
// stream. The recorded finish and exit status remain independent of collection.
func (s *Store) ExpireIncomplete(ctx context.Context, now time.Time, grace time.Duration) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := now.Add(-grace)
	for id, detached := range s.detached {
		if !detached.After(cutoff) {
			delete(s.detached, id)
		}
	}
	count, err := s.storage.ExpireIncomplete(ctx, now, cutoff, func(id string) bool {
		return s.publishers[id] > 0 || !s.detached[id].IsZero()
	})
	if count > 0 {
		close(s.changed)
		s.changed = make(chan struct{})
	}
	return count, storageError(err)
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

// Capture the notification channel before reading so a concurrent append cannot be missed.
func (s *Store) batch(ctx context.Context, id string, cursor uint64) ([]*pb.InvocationEvent, uint64, <-chan struct{}, error) {
	s.mu.Lock()
	changed := s.changed
	s.mu.Unlock()
	events, next, err := s.storage.Replay(ctx, id, cursor, 256)
	return events, next, changed, storageError(err)
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
