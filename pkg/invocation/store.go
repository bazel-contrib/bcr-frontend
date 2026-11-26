// Package invocation stores BES events and serves invocation summaries and replay.
package invocation

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"sort"
	"sync"
	"syscall"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	beppb "github.com/bazel-contrib/bcr-frontend/proto/buildeventstream"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

var validGroupName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

func invocationGroupName(bep *beppb.BuildEvent) string {
	name := bep.GetBuildMetadata().GetMetadata()["igroup"]
	if validGroupName.MatchString(name) {
		return name
	}
	return ""
}

type streamProgress struct {
	contiguous int64
	pending    map[int64]bool
	terminal   int64
}

// journalStorage indexes the legacy append-only journal in memory.
type journalStorage struct {
	mu        sync.Mutex
	file      *os.File
	writeErr  error
	events    []*pb.InvocationEvent
	summaries map[string]*pb.Invocation
	streams   map[string]map[string]*streamProgress
	keys      map[string]*pb.InvocationEvent
}

func openJournal(path string) (*journalStorage, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*journalStorage, error) { f.Close(); return nil, err }
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fail(fmt.Errorf("lock invocation journal: %w", err))
	}
	s := &journalStorage{
		file:      f,
		summaries: make(map[string]*pb.Invocation),
		streams:   make(map[string]map[string]*streamProgress),
		keys:      make(map[string]*pb.InvocationEvent),
	}
	reader := bufio.NewReader(f)
	var offset int64
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			// Discard a partial final record left by an interrupted append.
			if err := f.Truncate(offset); err != nil {
				return fail(err)
			}
			break
		}
		if err != nil {
			return fail(err)
		}
		data, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(line)))
		if err != nil {
			return fail(fmt.Errorf("journal offset %d: %w", offset, err))
		}
		event := new(pb.InvocationEvent)
		if err := proto.Unmarshal(data, event); err != nil {
			return fail(err)
		}
		if event.Cursor != uint64(len(s.events)+1) || validateOrderedEvent(event.OrderedEvent, event.Lifecycle) != nil {
			return fail(fmt.Errorf("invalid journal record at offset %d", offset))
		}
		s.index(event)
		offset += int64(len(line))
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		return fail(err)
	}
	return s, nil
}

func (s *journalStorage) Close() error { return s.file.Close() }

func eventKey(event *pb.InvocationEvent) string {
	id := event.OrderedEvent.StreamId
	return fmt.Sprintf("%t/%q/%q/%d/%d", event.Lifecycle, id.BuildId, id.InvocationId, id.Component, event.OrderedEvent.SequenceNumber)
}

func validateOrderedEvent(ordered *buildpb.OrderedBuildEvent, lifecycle bool) error {
	if ordered == nil || ordered.StreamId == nil || ordered.Event == nil || ordered.SequenceNumber <= 0 {
		return status.Error(codes.InvalidArgument, "event requires stream_id, payload and positive sequence_number")
	}
	if !lifecycle && ordered.StreamId.InvocationId == "" {
		return status.Error(codes.InvalidArgument, "tool event requires invocation_id")
	}
	return nil
}

func (s *journalStorage) Append(ctx context.Context, ordered *buildpb.OrderedBuildEvent, lifecycle bool) (bool, error) {
	if err := validateOrderedEvent(ordered, lifecycle); err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if s.writeErr != nil {
		return false, s.writeErr
	}
	event := &pb.InvocationEvent{
		Cursor:       uint64(len(s.events) + 1),
		ReceivedAt:   timestamppb.Now(),
		Lifecycle:    lifecycle,
		OrderedEvent: proto.Clone(ordered).(*buildpb.OrderedBuildEvent),
	}
	if old := s.keys[eventKey(event)]; old != nil {
		if proto.Equal(old.OrderedEvent, ordered) {
			return false, nil
		}
		return false, status.Error(codes.AlreadyExists, "stream sequence already contains a different event")
	}
	data, err := proto.Marshal(event)
	if err != nil {
		return false, status.Error(codes.Internal, err.Error())
	}
	offset, err := s.file.Seek(0, io.SeekEnd)
	if err != nil {
		return false, status.Error(codes.Internal, err.Error())
	}
	line := []byte(base64.StdEncoding.EncodeToString(data) + "\n")
	if _, err = s.file.Write(line); err == nil {
		err = s.file.Sync()
	}
	if err != nil {
		// Roll back a partial append so a retry cannot follow a corrupt record.
		if truncateErr := s.file.Truncate(offset); truncateErr != nil {
			s.writeErr = status.Errorf(codes.Internal, "journal requires recovery after a failed append: write: %v, rollback: %v", err, truncateErr)
			return false, s.writeErr
		}
		return false, status.Error(codes.Internal, err.Error())
	}
	s.index(event)
	return true, nil
}

func (s *journalStorage) index(event *pb.InvocationEvent) {
	s.events = append(s.events, event)
	s.keys[eventKey(event)] = event
	id := event.OrderedEvent.StreamId
	// Build-enqueued and build-finished lifecycle events may be build-scoped.
	if id.InvocationId == "" {
		return
	}
	inv := s.summaries[id.InvocationId]
	if inv == nil {
		inv = &pb.Invocation{InvocationId: id.InvocationId, BuildId: id.BuildId, CreatedAt: event.ReceivedAt, State: pb.InvocationState_INVOCATION_STATE_IN_PROGRESS}
		s.summaries[id.InvocationId] = inv
	}
	inv.UpdatedAt, inv.LastEventAt = event.ReceivedAt, event.ReceivedAt
	s.trackStreams(inv, event)
	applySummary(inv, decodeBEP(event.OrderedEvent))
	finalizeAttempt(inv, event)
}

func finalizeAttempt(inv *pb.Invocation, event *pb.InvocationEvent) {
	if inv.State == pb.InvocationState_INVOCATION_STATE_IN_PROGRESS &&
		event.OrderedEvent.GetEvent().GetInvocationAttemptFinished() != nil {
		inv.State = pb.InvocationState_INVOCATION_STATE_INCOMPLETE
	}
}

func (s *journalStorage) ExpireIncomplete(ctx context.Context, now, cutoff time.Time, protected func(string) bool) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	count := 0
	for id, inv := range s.summaries {
		if inv.State == pb.InvocationState_INVOCATION_STATE_IN_PROGRESS &&
			!inv.GetLastEventAt().AsTime().After(cutoff) && !protected(id) {
			inv.State = pb.InvocationState_INVOCATION_STATE_INCOMPLETE
			inv.UpdatedAt = timestamppb.New(now)
			count++
		}
	}
	return count, nil
}

func decodeBEP(ordered *buildpb.OrderedBuildEvent) *beppb.BuildEvent {
	payload := ordered.Event.GetBazelEvent()
	if payload == nil {
		return nil
	}
	bep := new(beppb.BuildEvent)
	if err := payload.UnmarshalTo(bep); err != nil {
		return nil
	}
	return bep
}

// A populated runner breakdown accounts for zero hits when that runner is absent.
// The older proto3 scalar can only establish a positive count.
func bazelRemoteCacheHits(bep *beppb.BuildEvent) *int64 {
	actions := bep.GetBuildMetrics().GetActionSummary()
	var count int64
	if runners := actions.GetRunnerCount(); len(runners) > 0 {
		for _, runner := range runners {
			if runner.GetName() == "remote cache hit" {
				count += int64(runner.GetCount())
			}
		}
		return &count
	}
	if count = actions.GetRemoteCacheHits(); count > 0 {
		return &count
	}
	return nil
}

func applySummary(inv *pb.Invocation, bep *beppb.BuildEvent) {
	inv.TargetPatterns = appendTargetPatterns(inv.TargetPatterns, bep)
	if count := bazelRemoteCacheHits(bep); count != nil {
		inv.BazelRemoteCacheHits = count
	}
	if started := bep.GetStarted(); started != nil {
		inv.Command, inv.BazelVersion = started.Command, started.BuildToolVersion
		inv.WorkspaceDirectory, inv.WorkingDirectory = started.WorkspaceDirectory, started.WorkingDirectory
		inv.StartedAt = started.StartTime
	}
	if finished := bep.GetFinished(); finished != nil {
		inv.FinishedAt = finished.FinishTime
		if code := finished.ExitCode; code != nil {
			inv.Result = &pb.InvocationResult{ExitCode: proto.Int32(code.Code), ExitCodeName: code.Name}
		}
	}
	if ws := bep.GetWorkspaceStatus(); ws != nil {
		for _, item := range ws.Item {
			switch item.Key {
			case "BUILD_USER":
				inv.BuildUser = item.Value
			case "BUILD_HOST":
				inv.Host = item.Value
			}
		}
	}
	if metadata := bep.GetBuildMetadata(); metadata != nil {
		inv.SourceControl = &pb.SourceControl{
			RepositoryUrl: metadata.Metadata["REPO_URL"],
			CommitSha:     metadata.Metadata["COMMIT_SHA"],
			Branch:        metadata.Metadata["BRANCH_NAME"],
		}
		inv.Role = metadata.Metadata["ROLE"]
	}
	if inv.InvocationGroup == "" {
		inv.InvocationGroup = invocationGroupName(bep)
	}
}

func appendTargetPatterns(patterns []string, bep *beppb.BuildEvent) []string {
	add := func(id *beppb.BuildEventId) {
		pattern := id.GetPattern()
		if pattern == nil {
			pattern = id.GetPatternSkipped()
		}
		for _, value := range pattern.GetPattern() {
			if !slices.Contains(patterns, value) {
				patterns = append(patterns, value)
			}
		}
	}
	add(bep.GetId())
	if bep.GetStarted() != nil {
		for _, child := range bep.GetChildren() {
			add(child)
		}
	}
	return patterns
}

// Track only tool streams, since lifecycle publishers may finish independently.
func (s *journalStorage) trackStreams(inv *pb.Invocation, event *pb.InvocationEvent) {
	ordered := event.OrderedEvent
	if event.Lifecycle || ordered.StreamId.Component != buildpb.StreamId_TOOL {
		return
	}
	streams := s.streams[inv.InvocationId]
	if streams == nil {
		streams = make(map[string]*streamProgress)
		s.streams[inv.InvocationId] = streams
	}
	key := ordered.StreamId.BuildId
	progress := streams[key]
	if progress == nil {
		progress = &streamProgress{pending: make(map[int64]bool)}
		streams[key] = progress
	}
	progress.pending[ordered.SequenceNumber] = true
	for progress.pending[progress.contiguous+1] {
		progress.contiguous++
		delete(progress.pending, progress.contiguous)
	}
	if ended := ordered.Event.GetComponentStreamFinished(); ended.GetType() == buildpb.BuildEvent_BuildComponentStreamFinished_EXPIRED {
		progress.terminal = 0
		inv.State = pb.InvocationState_INVOCATION_STATE_INCOMPLETE
	} else if ended != nil {
		progress.terminal = ordered.SequenceNumber
	}
	if payload := ordered.Event.GetBazelEvent(); payload != nil {
		bep := new(beppb.BuildEvent)
		if payload.UnmarshalTo(bep) == nil && bep.LastMessage {
			progress.terminal = ordered.SequenceNumber
		}
	}
	for _, stream := range streams {
		if stream.terminal == 0 || stream.contiguous < stream.terminal {
			if inv.State != pb.InvocationState_INVOCATION_STATE_INCOMPLETE {
				inv.State = pb.InvocationState_INVOCATION_STATE_IN_PROGRESS
			}
			return
		}
	}
	inv.State = pb.InvocationState_INVOCATION_STATE_COMPLETE
}

func (s *journalStorage) List(_ context.Context) ([]*pb.Invocation, error) {
	return s.list("")
}

func (s *journalStorage) ListByGroup(_ context.Context, group string) ([]*pb.Invocation, error) {
	return s.list(group)
}

func (s *journalStorage) ListPage(ctx context.Context, group string, limit int, cursor pageCursor) (*pb.ListInvocationsResponse, error) {
	runs, err := s.ListByGroup(ctx, group)
	if err != nil {
		return nil, err
	}
	var active *pb.Invocation
	var page []*pb.Invocation
	for _, run := range runs {
		if group != "" && cursor.ID == "" && active == nil && run.State == pb.InvocationState_INVOCATION_STATE_IN_PROGRESS {
			active = run
		}
		created := run.GetCreatedAt().AsTime().UnixMicro()
		if len(page) <= limit && (cursor.ID == "" || created < cursor.CreatedUS ||
			(created == cursor.CreatedUS && run.GetInvocationId() > cursor.ID)) {
			page = append(page, run)
		}
	}
	return pageResponse(group, limit, page, active), nil
}

func (s *journalStorage) list(group string) ([]*pb.Invocation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []*pb.Invocation
	for _, inv := range s.summaries {
		if group == "" || inv.InvocationGroup == group {
			result = append(result, proto.Clone(inv).(*pb.Invocation))
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.AsTime().UnixMicro() == result[j].CreatedAt.AsTime().UnixMicro() {
			return result[i].InvocationId < result[j].InvocationId
		}
		return result[i].CreatedAt.AsTime().After(result[j].CreatedAt.AsTime())
	})
	return result, nil
}

func (s *journalStorage) ListGroups(_ context.Context) ([]*pb.InvocationGroup, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	byName := make(map[string]*pb.InvocationGroup)
	var groups []*pb.InvocationGroup
	for _, inv := range s.summaries {
		name := inv.GetInvocationGroup()
		if name == "" {
			continue
		}
		group := byName[name]
		if group == nil {
			group = &pb.InvocationGroup{Name: name, InvocationCount: proto.Int64(0)}
			byName[name] = group
			groups = append(groups, group)
		}
		*group.InvocationCount += 1
		if created := inv.GetCreatedAt(); created != nil {
			if group.LatestInvocationAt == nil || created.AsTime().After(group.LatestInvocationAt.AsTime()) {
				group.LatestInvocationAt = proto.Clone(created).(*timestamppb.Timestamp)
			}
		}
	}
	sort.Slice(groups, func(i, j int) bool {
		a, b := groups[i].LatestInvocationAt.AsTime(), groups[j].LatestInvocationAt.AsTime()
		if a.Equal(b) {
			return groups[i].Name < groups[j].Name
		}
		return a.After(b)
	})
	return groups, nil
}

func (s *journalStorage) Get(_ context.Context, id string) (*pb.Invocation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	inv := s.summaries[id]
	if inv == nil {
		return nil, status.Error(codes.NotFound, "invocation not found")
	}
	return proto.Clone(inv).(*pb.Invocation), nil
}

func (s *journalStorage) Replay(_ context.Context, id string, cursor uint64, limit int) ([]*pb.InvocationEvent, uint64, error) {
	if limit <= 0 {
		return nil, cursor, status.Error(codes.InvalidArgument, "replay limit must be positive")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cursor > uint64(len(s.events)) {
		return nil, cursor, status.Error(codes.OutOfRange, "cursor exceeds journal")
	}
	var events []*pb.InvocationEvent
	for cursor < uint64(len(s.events)) && len(events) < limit {
		event := s.events[cursor]
		cursor++
		if event.OrderedEvent.StreamId.InvocationId == id {
			events = append(events, proto.Clone(event).(*pb.InvocationEvent))
		}
	}
	return events, cursor, nil
}
