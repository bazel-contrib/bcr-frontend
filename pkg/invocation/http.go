package invocation

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/invocation/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
)

// Handler exposes the local POC browser API. The configured origin permits a
// separately served BCR frontend. Authentication and tenant filtering are future work.
func (s *Store) Handler(origin string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/invocations", func(w http.ResponseWriter, r *http.Request) {
		result, err := s.ListInvocations(r.Context(), &pb.ListInvocationsRequest{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		data, err := protojson.Marshal(result)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	})
	mux.HandleFunc("GET /api/invocations/{id}", func(w http.ResponseWriter, r *http.Request) {
		result, err := s.GetInvocation(r.Context(), &pb.GetInvocationRequest{InvocationId: r.PathValue("id")})
		if err != nil {
			code := http.StatusInternalServerError
			if status.Code(err) == codes.NotFound {
				code = http.StatusNotFound
			}
			http.Error(w, err.Error(), code)
			return
		}
		data, err := protojson.Marshal(result)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
	})
	mux.HandleFunc("GET /api/invocations/{id}/events", s.serveEvents)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requestOrigin := r.Header.Get("Origin"); requestOrigin != "" {
			if requestOrigin != origin {
				http.Error(w, "origin is not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Store) serveEvents(w http.ResponseWriter, r *http.Request) {
	cursorText := r.Header.Get("Last-Event-ID")
	if cursorText == "" {
		cursorText = r.URL.Query().Get("after")
	}
	var cursor uint64
	if cursorText != "" {
		var err error
		cursor, err = strconv.ParseUint(cursorText, 10, 64)
		if err != nil {
			http.Error(w, "invalid cursor", 400)
			return
		}
	}
	events, next, changed, err := s.batch(r.Context(), r.PathValue("id"), cursor)
	if err != nil {
		code := http.StatusInternalServerError
		if status.Code(err) == codes.OutOfRange {
			code = http.StatusBadRequest
		}
		http.Error(w, err.Error(), code)
		return
	}
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	// Bound each network write without imposing a timeout on the subscription.
	write := func(message string) error {
		if err := controller.SetWriteDeadline(time.Now().Add(15 * time.Second)); err != nil {
			return err
		}
		if _, err := fmt.Fprint(w, message); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err := write(": connected\n\n"); err != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		for _, event := range events {
			kind, data := "update", ""
			if payload := event.OrderedEvent.Event.GetBazelEvent(); payload != nil {
				kind, data = "bep", base64.StdEncoding.EncodeToString(payload.Value)
			}
			if err := write(fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", event.Cursor, kind, data)); err != nil {
				return
			}
		}
		if cursor != next {
			cursor = next
		} else {
			select {
			case <-r.Context().Done():
				return
			case <-changed:
			case <-heartbeat.C:
				if err := write(": heartbeat\n\n"); err != nil {
					return
				}
			}
		}
		events, next, changed, err = s.batch(r.Context(), r.PathValue("id"), cursor)
		if err != nil {
			return
		}
	}
}
