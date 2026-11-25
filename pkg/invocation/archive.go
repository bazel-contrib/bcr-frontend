package invocation

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	buildpb "github.com/bazel-contrib/bcr-frontend/proto/build"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"
)

// BlobArchive stores and reads immutable blobs addressed by their SHA-256 digest.
type BlobArchive interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string, int64) ([]byte, error)
}

const (
	archiveChunkBytes  = 8 << 20
	archiveChunkEvents = 256
)

// ArchiveBefore offloads one chunk of a completed run last updated before cutoff.
// An upload can be retried safely. The remote copy is verified before the local
// payloads are cleared. SQLite retains replay cursors, facts and deduplication keys.
func (s *Store) ArchiveBefore(ctx context.Context, cutoff time.Time) (bool, error) {
	storage, ok := s.storage.(*sqliteStorage)
	if !ok || storage.archive == nil {
		return false, errors.New("event archival requires SQLite and a blob archive")
	}
	return storage.archiveBefore(ctx, cutoff)
}

func archiveDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func orderedDigest(event *buildpb.OrderedBuildEvent) ([]byte, error) {
	data, err := (proto.MarshalOptions{Deterministic: true}).Marshal(event)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	return sum[:], nil
}

func (s *sqliteStorage) archiveBefore(ctx context.Context, cutoff time.Time) (bool, error) {
	var id string
	var updated int64
	err := s.db.QueryRowContext(ctx, `SELECT i.id, i.updated_us FROM invocations i
		WHERE i.state = ? AND i.updated_us < ? AND EXISTS (
			SELECT 1 FROM events e WHERE e.invocation_id = i.id AND e.archive_cursor IS NULL)
		ORDER BY i.updated_us, i.id LIMIT 1`, pb.InvocationState_INVOCATION_STATE_COMPLETE, cutoff.UnixMicro()).Scan(&id, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	events, err := s.readArchiveCandidates(ctx, id)
	if err != nil || len(events) == 0 {
		return false, err
	}
	var content bytes.Buffer
	zip := gzip.NewWriter(&content)
	fingerprints := make([][]byte, 0, len(events))
	for _, event := range events {
		fingerprint, err := orderedDigest(event.GetOrderedEvent())
		if err != nil {
			return false, err
		}
		fingerprints = append(fingerprints, fingerprint)
		if _, err := protodelim.MarshalTo(zip, event); err != nil {
			return false, err
		}
	}
	if err := zip.Close(); err != nil {
		return false, err
	}
	digest := archiveDigest(content.Bytes())
	size := int64(content.Len())
	if err := s.archive.Put(ctx, digest, content.Bytes()); err != nil {
		return false, err
	}
	if _, err := s.readArchiveBlob(ctx, digest, size); err != nil {
		return false, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var eligible bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM invocations
		WHERE id = ? AND state = ? AND updated_us = ?)`, id, pb.InvocationState_INVOCATION_STATE_COMPLETE, updated).Scan(&eligible); err != nil {
		return false, err
	}
	if !eligible {
		return false, nil
	}
	first := events[0].GetCursor()
	result, err := tx.ExecContext(ctx, `INSERT INTO event_archives (cursor, digest, size)
		VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, first, digest, size)
	if err != nil {
		return false, err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		return false, err
	}
	for i, event := range events {
		result, err := tx.ExecContext(ctx, `UPDATE events SET payload = X'', archive_cursor = ?, ordered_hash = ?
			WHERE cursor = ? AND archive_cursor IS NULL`, first, fingerprints[i], event.GetCursor())
		if err != nil {
			return false, err
		}
		if n, err := result.RowsAffected(); err != nil || n != 1 {
			return false, err
		}
	}
	return true, tx.Commit()
}

func (s *sqliteStorage) readArchiveCandidates(ctx context.Context, id string) ([]*pb.InvocationEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT cursor, payload FROM events
		WHERE invocation_id = ? AND archive_cursor IS NULL ORDER BY cursor LIMIT ?`, id, archiveChunkEvents)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []*pb.InvocationEvent
	var size int
	for rows.Next() {
		var cursor uint64
		var data []byte
		if err := rows.Scan(&cursor, &data); err != nil {
			return nil, err
		}
		if len(events) > 0 && size+len(data) > archiveChunkBytes {
			break
		}
		event := new(pb.InvocationEvent)
		if err := proto.Unmarshal(data, event); err != nil {
			return nil, err
		}
		event.Cursor = cursor
		events = append(events, event)
		size += len(data)
	}
	return events, rows.Err()
}

func (s *sqliteStorage) readArchiveBlob(ctx context.Context, digest string, size int64) ([]byte, error) {
	if s.archive == nil {
		return nil, status.Error(codes.Unavailable, "event archive is not configured")
	}
	blob, err := s.archive.Get(ctx, digest, size)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "read archived build events: %v", err)
	}
	if int64(len(blob)) != size || archiveDigest(blob) != digest {
		return nil, status.Error(codes.DataLoss, "archived event blob failed digest verification")
	}
	return blob, nil
}

func (s *sqliteStorage) replayArchive(ctx context.Context, digest string, size int64, after uint64, limit int) ([]*pb.InvocationEvent, error) {
	blob, err := s.readArchiveBlob(ctx, digest, size)
	if err != nil {
		return nil, err
	}
	zip, err := gzip.NewReader(bytes.NewReader(blob))
	if err != nil {
		return nil, err
	}
	defer zip.Close()
	reader := bytes.NewBuffer(nil)
	// Build event RPCs limit individual messages. The extra space covers the cursor and envelope.
	if _, err := io.Copy(reader, io.LimitReader(zip, archiveChunkBytes+64*archiveChunkEvents+1)); err != nil {
		return nil, err
	}
	if reader.Len() > archiveChunkBytes+64*archiveChunkEvents {
		return nil, errors.New("archived event chunk exceeds replay limit")
	}
	var events []*pb.InvocationEvent
	for reader.Len() > 0 && len(events) < limit {
		event := new(pb.InvocationEvent)
		if err := (protodelim.UnmarshalOptions{MaxSize: archiveChunkBytes}).UnmarshalFrom(reader, event); err != nil {
			return nil, fmt.Errorf("decode archived event: %w", err)
		}
		if event.GetCursor() > after {
			events = append(events, event)
		}
	}
	return events, nil
}
