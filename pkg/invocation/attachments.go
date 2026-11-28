package invocation

import (
	"crypto/subtle"
	"database/sql"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
)

const maxAttachmentBytes = 64 << 20

var attachmentID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Attachments may arrive before the first BEP event, so their IDs deliberately
// have no foreign key into invocations.
const sqliteAttachmentSchema = `
CREATE TABLE IF NOT EXISTS invocation_attachments (
  invocation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL,
  payload BLOB,
  PRIMARY KEY (invocation_id, kind)
);
PRAGMA user_version = 8;`

func (s *Store) serveAttachment(w http.ResponseWriter, r *http.Request) {
	id, kind := r.PathValue("id"), r.PathValue("kind")
	switch kind {
	case "capture", "action-map", "execution-log", "profile", "bep":
	default:
		http.NotFound(w, r)
		return
	}
	if !attachmentID.MatchString(id) {
		http.Error(w, "invalid invocation UUID", http.StatusBadRequest)
		return
	}
	storage, ok := s.storage.(*sqliteStorage)
	if !ok {
		http.Error(w, "attachments require SQLite", http.StatusServiceUnavailable)
		return
	}
	ctx := r.Context()
	if r.Method == http.MethodPut {
		token := os.Getenv("BCR_INVOKE_TOKEN")
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		authorized := net.ParseIP(ip).IsLoopback()
		if token != "" {
			authorized = subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) == 1
		}
		if !authorized || r.Header.Get("Origin") != "" {
			http.Error(w, "attachment upload denied", http.StatusForbidden)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAttachmentBytes))
		if err != nil || len(data) == 0 {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				http.Error(w, "attachment exceeds 64 MiB", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, "could not read attachment", http.StatusBadRequest)
			}
			return
		}
		digest := archiveDigest(data)
		payload := data
		if storage.archive != nil {
			if err := storage.archive.Put(ctx, digest, data); err != nil {
				http.Error(w, "attachment archive write failed", http.StatusBadGateway)
				return
			}
			payload = nil
		}
		// Identical retries succeed. A different file must use a different UUID.
		var registered string
		err = storage.db.QueryRowContext(ctx, `INSERT INTO invocation_attachments
			(invocation_id, kind, digest, size, payload) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(invocation_id, kind) DO UPDATE SET digest = digest
			RETURNING digest`, id, kind, digest, len(data), payload).Scan(&registered)
		if err != nil {
			http.Error(w, "attachment registration failed", http.StatusInternalServerError)
			return
		}
		if registered != digest {
			http.Error(w, "a different attachment is already registered", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var digest string
	var size int64
	var data []byte
	err := storage.db.QueryRowContext(ctx, `SELECT digest, size, payload FROM invocation_attachments
		WHERE invocation_id = ? AND kind = ?`, id, kind).Scan(&digest, &size, &data)
	if errors.Is(err, sql.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err == nil && data == nil {
		data, err = storage.readArchiveBlob(ctx, digest, size)
	}
	if err != nil {
		http.Error(w, "attachment is unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}
