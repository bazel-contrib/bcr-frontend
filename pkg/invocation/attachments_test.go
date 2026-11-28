package invocation

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestInvocationAttachments(t *testing.T) {
	for _, mode := range []string{"sqlite", "archive"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("BCR_INVOKE_TOKEN", "upload-token")
			var archive BlobArchive
			if mode == "archive" {
				archive = &testArchive{blobs: make(map[string][]byte)}
			}
			storage, err := OpenSQLiteWithArchive(filepath.Join(t.TempDir(), "events.sqlite"), archive)
			if err != nil {
				t.Fatal(err)
			}
			defer storage.Close()
			handler := NewStore(storage).Handler("http://localhost:8081")
			const path = "/api/invocations/34567812-1234-4acd-9abc-987654321001/attachments/action-map"
			request := func(method, body, token string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, path, strings.NewReader(body))
				r.Header.Set("Authorization", token)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w
			}

			if w := request("GET", "", ""); w.Code != http.StatusNotFound {
				t.Fatalf("missing attachment: HTTP %d", w.Code)
			}
			if w := request("PUT", "graph", ""); w.Code != http.StatusForbidden {
				t.Fatalf("anonymous upload: HTTP %d", w.Code)
			}
			for range 2 {
				if w := request("PUT", "graph", "Bearer upload-token"); w.Code != http.StatusNoContent {
					t.Fatalf("upload before BEP: HTTP %d %s", w.Code, w.Body)
				}
			}
			if w := request("PUT", "different graph", "Bearer upload-token"); w.Code != http.StatusConflict {
				t.Fatalf("replacement upload: HTTP %d", w.Code)
			}
			if w := request("GET", "", ""); w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), []byte("graph")) {
				t.Fatalf("attachment: HTTP %d %q", w.Code, w.Body)
			}
		})
	}
}
