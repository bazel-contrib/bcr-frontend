package remoteexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type poolTimeline struct {
	Cursor     string            `json:"cursor"`
	Snapshot   bool              `json:"snapshot,omitempty"`
	Pool       json.RawMessage   `json:"pool,omitempty"`
	Workers    []json.RawMessage `json:"workers,omitempty"`
	Operations []json.RawMessage `json:"operations,omitempty"`
	Events     []json.RawMessage `json:"events,omitempty"`
}

func timelineRows[T proto.Message](ctx context.Context, tx *sql.Tx, dst *[]json.RawMessage, newMessage func() T, query string, args ...any) error {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		item := newMessage()
		if err := decode(rows, item); err != nil {
			return err
		}
		data, err := protojson.Marshal(item)
		if err != nil {
			return err
		}
		*dst = append(*dst, data)
	}
	return rows.Err()
}

func readTimelineSnapshot(ctx context.Context, tx *sql.Tx, pool string, latest uint64) (poolTimeline, error) {
	snapshot := poolTimeline{Cursor: strconv.FormatUint(latest, 10), Snapshot: true}
	info, err := getPool(ctx, tx, pool)
	if err != nil {
		return snapshot, err
	}
	snapshot.Pool, err = protojson.Marshal(info)
	if err != nil {
		return snapshot, err
	}
	if err := timelineRows(ctx, tx, &snapshot.Workers, func() *pb.Worker { return new(pb.Worker) },
		"SELECT data FROM workers WHERE pool = ? AND deadline > 0 ORDER BY id LIMIT 128", pool); err != nil {
		return snapshot, err
	}
	for _, state := range []pb.OperationState{queued, leased, running} {
		if err := timelineRows(ctx, tx, &snapshot.Operations, func() *pb.ExecutionOperation { return new(pb.ExecutionOperation) },
			"SELECT data FROM operations WHERE pool = ? AND state = ? ORDER BY enqueued, name LIMIT 128", pool, state); err != nil {
			return snapshot, err
		}
	}
	err = timelineRows(ctx, tx, &snapshot.Operations, func() *pb.ExecutionOperation { return new(pb.ExecutionOperation) },
		"SELECT data FROM operations WHERE pool = ? AND state = ? ORDER BY enqueued DESC, name LIMIT 32", pool, completed)
	return snapshot, err
}

func (s *Scheduler) readTimeline(ctx context.Context, pool string, after *uint64) (poolTimeline, error) {
	var result poolTimeline
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		latest, err := activitySequence(ctx, tx)
		if err != nil {
			return err
		}
		var oldest uint64
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MIN(sequence), 0) FROM activity").Scan(&oldest); err != nil {
			return err
		}
		if after == nil || *after > latest || (oldest > 0 && *after < oldest-1) {
			result, err = readTimelineSnapshot(ctx, tx, pool, latest)
			return err
		}
		events, err := readEvents(ctx, tx, pool, "", *after)
		if err != nil {
			return err
		}
		// Skip unrelated pool events. If this page filled up, continue at its last event.
		if len(events) == activityBatchSize {
			latest = events[len(events)-1].Sequence
		}
		result.Cursor = strconv.FormatUint(latest, 10)
		for _, event := range events {
			data, err := protojson.Marshal(event)
			if err != nil {
				return err
			}
			result.Events = append(result.Events, data)
		}
		return nil
	})
	return result, err
}

func (s *Scheduler) serveTimeline(w http.ResponseWriter, r *http.Request) {
	pool := r.PathValue("pool")
	if !validID.MatchString(pool) {
		writeError(w, status.Error(codes.InvalidArgument, "invalid pool ID"))
		return
	}
	var after *uint64
	if r.URL.Query().Has("after") {
		cursor, err := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		if err != nil {
			writeError(w, status.Error(codes.InvalidArgument, "invalid execution activity cursor"))
			return
		}
		after = &cursor
	}
	ctx := r.Context()
	result, err := s.readTimeline(ctx, pool, after)
	if err != nil {
		writeError(w, err)
		return
	}
	// A short long poll works over both direct HTTP and the Iroh viewer's
	// bounded request/reply transport. Unreturned events remain replayable.
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for !result.Snapshot && len(result.Events) == 0 {
		if pause(wait, pollInterval) != nil {
			break
		}
		cursor, _ := strconv.ParseUint(result.Cursor, 10, 64)
		next, err := s.readTimeline(wait, pool, &cursor)
		if errors.Is(wait.Err(), context.DeadlineExceeded) {
			break
		}
		if err != nil {
			writeError(w, err)
			return
		}
		result = next
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
