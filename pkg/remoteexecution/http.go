package remoteexecution

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const HTTPPrefix = "/api/remote-execution/"

func (s *Scheduler) Handler(origins ...string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+HTTPPrefix+"status", s.serveStatus)
	mux.HandleFunc("GET "+HTTPPrefix+"readyz", s.serveReadiness)
	mux.HandleFunc("GET "+HTTPPrefix+"instances", s.serveInstances)
	mux.HandleFunc("GET "+HTTPPrefix+"admin/instances", s.listManagedInstances)
	mux.HandleFunc("PUT "+HTTPPrefix+"admin/instances", s.putInstance)
	mux.HandleFunc("GET "+HTTPPrefix+"admin/pools", s.listManagedPools)
	mux.HandleFunc("PUT "+HTTPPrefix+"admin/pools/{pool}", s.putManagedPool)
	mux.HandleFunc("POST "+HTTPPrefix+"worker/register", jsonRPC(func() *pb.RegisterWorkerRequest { return new(pb.RegisterWorkerRequest) }, s.RegisterWorker))
	mux.HandleFunc("POST "+HTTPPrefix+"worker/lease", jsonRPC(func() *pb.LeaseWorkRequest { return new(pb.LeaseWorkRequest) }, s.LeaseWork))
	mux.HandleFunc("POST "+HTTPPrefix+"worker/acknowledge", jsonRPC(func() *pb.AcknowledgeLeaseRequest { return new(pb.AcknowledgeLeaseRequest) }, s.AcknowledgeLease))
	mux.HandleFunc("POST "+HTTPPrefix+"worker/heartbeat", jsonRPC(func() *pb.HeartbeatRequest { return new(pb.HeartbeatRequest) }, s.Heartbeat))
	mux.HandleFunc("POST "+HTTPPrefix+"worker/complete", jsonRPC(func() *pb.CompleteLeaseRequest { return new(pb.CompleteLeaseRequest) }, s.CompleteLease))

	blobPath := HTTPPrefix + "worker/{session}/{lease}/blobs/{hash}/{size}"
	mux.HandleFunc("GET "+blobPath, s.readBlobHTTP)
	mux.HandleFunc("PUT "+blobPath, s.writeBlobHTTP)

	mux.HandleFunc("GET "+HTTPPrefix+"pools", withPage(func(r *http.Request, size int32, token string) (*pb.ListPoolsResponse, error) {
		return s.ListPools(r.Context(), &pb.ListPoolsRequest{PageSize: size, PageToken: token})
	}))
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}", func(w http.ResponseWriter, r *http.Request) {
		result, err := s.GetPool(r.Context(), &pb.GetPoolRequest{PoolId: r.PathValue("pool")})
		writeJSON(w, result, err)
	})
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/workers", withPage(func(r *http.Request, size int32, token string) (*pb.ListWorkersResponse, error) {
		return s.ListWorkers(r.Context(), &pb.ListWorkersRequest{PoolId: r.PathValue("pool"), PageSize: size, PageToken: token})
	}))
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/workers/{worker}", func(w http.ResponseWriter, r *http.Request) {
		result, err := s.GetWorker(r.Context(), &pb.GetWorkerRequest{PoolId: r.PathValue("pool"), WorkerId: r.PathValue("worker")})
		writeJSON(w, result, err)
	})
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/operations", withPage(func(r *http.Request, size int32, token string) (*pb.ListOperationsResponse, error) {
		return s.ListOperations(r.Context(), &pb.ListOperationsRequest{PoolId: r.PathValue("pool"), PageSize: size, PageToken: token})
	}))
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/operations/{operation}", func(w http.ResponseWriter, r *http.Request) {
		result, err := s.operationDetail(r.Context(), r.PathValue("pool"), r.PathValue("operation"))
		writeJSON(w, result, err)
	})
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/workers/{worker}/attempts", withPage(func(r *http.Request, size int32, token string) (*pb.ListWorkerAttemptsResponse, error) {
		return s.ListWorkerAttempts(r.Context(), &pb.ListWorkerAttemptsRequest{PoolId: r.PathValue("pool"), WorkerId: r.PathValue("worker"), PageSize: size, PageToken: token})
	}))
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/activity", s.serveActivity)
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/timeline", s.serveTimeline)
	mux.HandleFunc("GET "+HTTPPrefix+"pools/{pool}/workers/{worker}/activity", s.serveActivity)

	return HTTPAccess(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := bearer(r.Header.Get("Authorization"))
		worker := strings.HasPrefix(r.URL.Path, HTTPPrefix+"worker/")
		admin := strings.HasPrefix(r.URL.Path, HTTPPrefix+"admin/")
		probe := r.URL.Path == HTTPPrefix+"readyz" && (r.Method == http.MethodGet || r.Method == http.MethodHead)
		if admin && (s.config.AdminToken == "" || !tokenMatches(s.config.AdminToken, key)) {
			writeError(w, status.Error(codes.Unauthenticated, "invalid execution admin credential"))
			return
		}
		if !probe && !worker && !admin && !tokenMatches(s.config.ViewerToken, key) {
			writeError(w, status.Error(codes.Unauthenticated, "invalid execution viewer credential"))
			return
		}
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), tokenKey{}, key)))
	}), origins...)
}

func (s *Scheduler) serveInstances(w http.ResponseWriter, r *http.Request) {
	instances, err := s.listInstanceSummaries(r.Context())
	writeInstances(w, instances, err)
}

func (s *Scheduler) listManagedInstances(w http.ResponseWriter, r *http.Request) {
	instances, err := listInstances(r.Context(), s.db)
	writeInstances(w, instances, err)
}

func writeInstances[T any](w http.ResponseWriter, instances []T, err error) {
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Instances []T `json:"instances"`
	}{Instances: instances})
}

func (s *Scheduler) putInstance(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Name        *string `json:"name"`
		DisplayName string  `json:"displayName"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || request.Name == nil || decoder.Decode(new(any)) != io.EOF {
		writeError(w, status.Error(codes.InvalidArgument, "invalid instance settings"))
		return
	}
	if err := s.saveInstance(r.Context(), Instance{Name: *request.Name, DisplayName: request.DisplayName}); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HTTPAccess applies the browser and transport policies shared by the scheduler and its proxy.
// The underlying handler authenticates requests.
func HTTPAccess(next http.Handler, origins ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Add("Vary", "Origin")
		if origin := r.Header.Get("Origin"); origin != "" {
			if !slices.Contains(origins, origin) {
				http.Error(w, "origin is not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if r.TLS == nil && !net.ParseIP(host).IsLoopback() {
			writeError(w, status.Error(codes.PermissionDenied, "remote execution requires TLS"))
			return
		}
		worker := strings.HasPrefix(r.URL.Path, HTTPPrefix+"worker/")
		admin := strings.HasPrefix(r.URL.Path, HTTPPrefix+"admin/")
		if r.Method == http.MethodOptions && !worker {
			if admin {
				w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			} else {
				w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Last-Event-ID")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Scheduler) listManagedPools(w http.ResponseWriter, r *http.Request) {
	pools, err := listPoolSettings(r.Context(), s.db)
	if err != nil {
		writeError(w, err)
		return
	}
	pools = slices.DeleteFunc(pools, func(pool PoolConfig) bool {
		return slices.ContainsFunc(s.config.Pools, func(config PoolConfig) bool { return config.ID == pool.ID })
	})
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Pools []PoolConfig `json:"pools"`
	}{Pools: pools})
}

func (s *Scheduler) putManagedPool(w http.ResponseWriter, r *http.Request) {
	var pool PoolConfig
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&pool); err != nil || pool.ID != r.PathValue("pool") || decoder.Decode(new(any)) != io.EOF {
		writeError(w, status.Error(codes.InvalidArgument, "invalid pool settings"))
		return
	}
	if err := s.updatePool(r.Context(), pool); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func jsonRPC[I proto.Message, O proto.Message](makeRequest func() I, invoke func(context.Context, I) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
		if err != nil {
			writeError(w, status.Error(codes.InvalidArgument, "invalid or oversized worker request"))
			return
		}
		request := makeRequest()
		binary := r.Header.Get("Content-Type") == "application/protobuf"
		if binary {
			err = proto.Unmarshal(data, request)
		} else {
			err = protojson.Unmarshal(data, request)
		}
		if err != nil {
			writeError(w, status.Error(codes.InvalidArgument, "invalid worker request message"))
			return
		}
		result, err := invoke(r.Context(), request)
		if !binary || err != nil {
			writeJSON(w, result, err)
			return
		}
		data, err = proto.Marshal(result)
		if err != nil {
			writeError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/protobuf")
		w.Write(data)
	}
}

func withPage[O proto.Message](invoke func(*http.Request, int32, string) (O, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		var size int64
		if value := query.Get("page_size"); value != "" {
			var err error
			size, err = strconv.ParseInt(value, 10, 32)
			if err != nil {
				writeError(w, status.Error(codes.InvalidArgument, "invalid page size"))
				return
			}
		}
		result, err := invoke(r, int32(size), query.Get("page_token"))
		writeJSON(w, result, err)
	}
}

func writeJSON(w http.ResponseWriter, value proto.Message, err error) {
	if err != nil {
		writeError(w, err)
		return
	}
	data, err := protojson.Marshal(value)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func writeError(w http.ResponseWriter, err error) {
	message := status.Convert(err).Message()
	var code int
	switch status.Code(err) {
	case codes.InvalidArgument:
		code = http.StatusBadRequest
	case codes.Unauthenticated:
		code = http.StatusUnauthorized
	case codes.PermissionDenied:
		code = http.StatusForbidden
	case codes.NotFound:
		code = http.StatusNotFound
	case codes.OutOfRange:
		code = http.StatusRequestedRangeNotSatisfiable
	case codes.FailedPrecondition, codes.Aborted:
		code = http.StatusConflict
	case codes.ResourceExhausted:
		code = http.StatusTooManyRequests
	case codes.Unavailable:
		code = http.StatusServiceUnavailable
	default:
		code = http.StatusInternalServerError
		message = "remote execution request failed"
	}
	http.Error(w, message, code)
}

func (s *Scheduler) serveActivity(w http.ResponseWriter, r *http.Request) {
	req := &pb.WatchActivityRequest{PoolId: r.PathValue("pool"), WorkerId: r.PathValue("worker")}
	position := r.Header.Get("Last-Event-ID")
	if position == "" {
		position = r.URL.Query().Get("after")
	}
	if position != "" {
		var err error
		req.AfterSequence, err = strconv.ParseUint(position, 10, 64)
		if err != nil {
			writeError(w, status.Error(codes.InvalidArgument, "invalid activity cursor"))
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	flusher := http.NewResponseController(w)
	headersSent := false
	startStream := func() {
		if !headersSent {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("X-Accel-Buffering", "no")
			headersSent = true
		}
	}
	err := s.watchActivity(ctx, req, func(event *pb.ActivityEvent) error {
		data, err := protojson.Marshal(event)
		if err != nil {
			return err
		}
		startStream()
		if _, err := fmt.Fprintf(w, "id: %d\ndata: %s\n\n", event.Sequence, data); err != nil {
			return err
		}
		return flusher.Flush()
	})
	if !headersSent {
		if status.Code(err) == codes.DeadlineExceeded || errors.Is(err, context.DeadlineExceeded) {
			startStream()
			fmt.Fprint(w, ": reconnect\n\n")
			return
		}
		writeError(w, err)
	}
}

func (s *Scheduler) workerBlob(r *http.Request) (string, *re.Digest, error) {
	now := time.Now()
	ctx := r.Context()
	if _, err := s.currentSession(ctx, s.db, r.PathValue("session"), now); err != nil {
		return "", nil, err
	}
	lease, err := leaseForSession(ctx, s.db, r.PathValue("lease"), r.PathValue("session"))
	if err != nil {
		return "", nil, err
	}
	if lease.attempt.State != executing || lease.deadline <= now.UnixNano() {
		return "", nil, status.Error(codes.FailedPrecondition, "lease is no longer current")
	}
	size, err := strconv.ParseInt(r.PathValue("size"), 10, 64)
	if err != nil || size < 0 || size > 4<<30 {
		return "", nil, status.Error(codes.InvalidArgument, "invalid worker blob size")
	}
	digest := &re.Digest{Hash: r.PathValue("hash"), SizeBytes: size}
	if err := checkDigest(digest); err != nil {
		return "", nil, err
	}
	op, err := readOperation(ctx, s.db, lease.attempt.OperationName)
	if err != nil {
		return "", nil, err
	}
	instance := op.instance
	if instance != "" {
		instance += "/"
	}
	return instance, digest, nil
}

type blobDownload struct {
	grpc.ServerStream
	ctx    context.Context
	writer http.ResponseWriter
	sent   bool
	size   int64
}

func (d *blobDownload) Context() context.Context { return d.ctx }

func (d *blobDownload) Send(message *bs.ReadResponse) error {
	if !d.sent {
		d.writer.Header().Set("Content-Type", "application/octet-stream")
		d.writer.Header().Set("Content-Length", strconv.FormatInt(d.size, 10))
		d.sent = true
	}
	_, err := d.writer.Write(message.Data)
	return err
}

func (s *Scheduler) readBlobHTTP(w http.ResponseWriter, r *http.Request) {
	instance, digest, err := s.workerBlob(r)
	if err != nil {
		writeError(w, err)
		return
	}
	stream := &blobDownload{ctx: r.Context(), size: digest.SizeBytes, writer: w}
	err = s.Backend.Read(&bs.ReadRequest{ResourceName: fmt.Sprintf("%sblobs/%s/%d", instance, digest.Hash, digest.SizeBytes)}, stream)
	if err != nil && !stream.sent {
		writeError(w, err)
	}
}

type blobUpload struct {
	grpc.ServerStream
	ctx                     context.Context
	body                    io.Reader
	resource                string
	size, offset, committed int64
	finished                bool
}

func (u *blobUpload) Context() context.Context { return u.ctx }

func (u *blobUpload) SendAndClose(message *bs.WriteResponse) error {
	u.committed = message.CommittedSize
	return nil
}

func (u *blobUpload) Recv() (*bs.WriteRequest, error) {
	if u.finished {
		return nil, io.EOF
	}
	count := min(128<<10, u.size-u.offset)
	data := make([]byte, count)
	if _, err := io.ReadFull(u.body, data); err != nil {
		return nil, status.Error(codes.InvalidArgument, "upload body is shorter than the digest size")
	}
	req := &bs.WriteRequest{ResourceName: u.resource, Data: data, WriteOffset: u.offset}
	u.offset += count
	if u.offset == u.size {
		var extra [1]byte
		if _, err := io.ReadFull(u.body, extra[:]); err != io.EOF {
			return nil, status.Error(codes.InvalidArgument, "upload body is longer than the digest size")
		}
		req.FinishWrite = true
		u.finished = true
	}
	return req, nil
}

func (s *Scheduler) writeBlobHTTP(w http.ResponseWriter, r *http.Request) {
	instance, digest, err := s.workerBlob(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if r.ContentLength >= 0 && r.ContentLength != digest.SizeBytes {
		writeError(w, status.Error(codes.InvalidArgument, "upload Content-Length must match digest"))
		return
	}
	// Keep upload body reads bounded even if the peer stops sending.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(2 * time.Minute))
	stream := &blobUpload{
		ctx: r.Context(), body: r.Body, size: digest.SizeBytes,
		resource: fmt.Sprintf("%suploads/%s/blobs/%s/%d", instance, identifier(), digest.Hash, digest.SizeBytes),
	}
	if err := s.Backend.Write(stream); err != nil {
		writeError(w, err)
		return
	}
	if stream.committed != digest.SizeBytes {
		writeError(w, status.Error(codes.DataLoss, "cache committed an unexpected size"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
