package remotecache

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	bs "google.golang.org/genproto/googleapis/bytestream"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/stats"
	"google.golang.org/grpc/status"
)

// Monitor tracks aggregate gRPC cache traffic and reports the backing store's capacity.
type Monitor struct {
	started     time.Time
	files       *fileCache
	traffic     cacheTraffic
	connections atomic.Int64

	mu        sync.Mutex
	instances map[string]*cacheTraffic
}

type cacheTraffic struct {
	uploaded     atomic.Int64
	downloaded   atomic.Int64
	uploads      atomic.Int64
	downloads    atomic.Int64
	actionHits   atomic.Int64
	actionMisses atomic.Int64
	actionErrors atomic.Int64
}

func NewMonitor(backend Backend) *Monitor {
	files, _ := backend.(*fileCache)
	return &Monitor{started: time.Now(), files: files, instances: make(map[string]*cacheTraffic)}
}

type cacheRPC uint8

const (
	uploadRPC cacheRPC = iota + 1
	downloadRPC
	actionLookupRPC
)

type cacheRPCKey struct{}

type cacheRequest struct {
	operation cacheRPC
	instance  atomic.Pointer[cacheTraffic]
}

func (m *Monitor) TagRPC(ctx context.Context, info *stats.RPCTagInfo) context.Context {
	var operation cacheRPC
	switch info.FullMethodName {
	case "/google.bytestream.ByteStream/Write",
		"/build.bazel.remote.execution.v2.ContentAddressableStorage/BatchUpdateBlobs":
		operation = uploadRPC
	case "/google.bytestream.ByteStream/Read",
		"/build.bazel.remote.execution.v2.ContentAddressableStorage/BatchReadBlobs":
		operation = downloadRPC
	case "/build.bazel.remote.execution.v2.ActionCache/GetActionResult":
		operation = actionLookupRPC
	default:
		if !strings.HasPrefix(info.FullMethodName, "/build.bazel.remote.execution.v2.") &&
			info.FullMethodName != "/google.bytestream.ByteStream/QueryWriteStatus" {
			return ctx
		}
	}
	return context.WithValue(ctx, cacheRPCKey{}, &cacheRequest{operation: operation})
}

func (traffic *cacheTraffic) active(operation cacheRPC, delta int64) {
	switch operation {
	case uploadRPC:
		traffic.uploads.Add(delta)
	case downloadRPC:
		traffic.downloads.Add(delta)
	}
}

func (traffic *cacheTraffic) finish(operation cacheRPC, code codes.Code) {
	traffic.active(operation, -1)
	if operation != actionLookupRPC {
		return
	}
	switch code {
	case codes.OK:
		traffic.actionHits.Add(1)
	case codes.NotFound:
		traffic.actionMisses.Add(1)
	default:
		traffic.actionErrors.Add(1)
	}
}

func (m *Monitor) instance(name string) *cacheTraffic {
	m.mu.Lock()
	defer m.mu.Unlock()
	if traffic := m.instances[name]; traffic != nil {
		return traffic
	}
	// Instance names come from clients. Keep telemetry allocation bounded while
	// still including every request in the aggregate.
	if len(name) > 1024 || len(m.instances) >= 4096 {
		return nil
	}
	traffic := new(cacheTraffic)
	m.instances[name] = traffic
	return traffic
}

func requestInstance(payload any) (string, bool) {
	switch req := payload.(type) {
	case interface{ GetInstanceName() string }:
		return req.GetInstanceName(), true
	case *bs.ReadRequest:
		return byteStreamInstance(req.GetResourceName(), false)
	case *bs.WriteRequest:
		return byteStreamInstance(req.GetResourceName(), true)
	case *bs.QueryWriteStatusRequest:
		return byteStreamInstance(req.GetResourceName(), true)
	default:
		return "", false
	}
}

func byteStreamInstance(resource string, upload bool) (string, bool) {
	if len(resource) > 4096 {
		return "", false
	}
	parts := strings.Split(resource, "/")
	for i, part := range parts {
		switch {
		case upload && part == "uploads" && len(parts) >= i+5 && parts[i+1] != "" &&
			(parts[i+2] == "blobs" || parts[i+2] == "compressed-blobs"):
			return strings.Join(parts[:i], "/"), true
		case !upload && (part == "blobs" || part == "compressed-blobs") && len(parts) >= i+3:
			return strings.Join(parts[:i], "/"), true
		}
	}
	return "", false
}

func (m *Monitor) HandleRPC(ctx context.Context, event stats.RPCStats) {
	request, ok := ctx.Value(cacheRPCKey{}).(*cacheRequest)
	if !ok {
		return
	}
	operation := request.operation
	switch event := event.(type) {
	case *stats.Begin:
		m.traffic.active(operation, 1)
	case *stats.End:
		code := status.Code(event.Error)
		m.traffic.finish(operation, code)
		if instance := request.instance.Load(); instance != nil {
			instance.finish(operation, code)
		}
	case *stats.InPayload:
		instance := request.instance.Load()
		if instance == nil {
			if name, found := requestInstance(event.Payload); found {
				instance = m.instance(name)
				if instance != nil && request.instance.CompareAndSwap(nil, instance) {
					instance.active(operation, 1)
				}
			}
		}
		var size int64
		switch message := event.Payload.(type) {
		case *bs.WriteRequest:
			size = int64(len(message.GetData()))
		case *re.BatchUpdateBlobsRequest:
			for _, entry := range message.GetRequests() {
				size += int64(len(entry.GetData()))
			}
		}
		if size > 0 {
			m.traffic.uploaded.Add(size)
			if instance != nil {
				instance.uploaded.Add(size)
			}
		}
	case *stats.OutPayload:
		var size int64
		switch message := event.Payload.(type) {
		case *bs.ReadResponse:
			size = int64(len(message.GetData()))
		case *re.BatchReadBlobsResponse:
			for _, entry := range message.GetResponses() {
				size += int64(len(entry.GetData()))
			}
		}
		if size > 0 {
			m.traffic.downloaded.Add(size)
			if instance := request.instance.Load(); instance != nil {
				instance.downloaded.Add(size)
			}
		}
	}
}

func (m *Monitor) TagConn(ctx context.Context, _ *stats.ConnTagInfo) context.Context {
	return ctx
}

func (m *Monitor) HandleConn(_ context.Context, event stats.ConnStats) {
	switch event.(type) {
	case *stats.ConnBegin:
		m.connections.Add(1)
	case *stats.ConnEnd:
		m.connections.Add(-1)
	}
}

type storageStatus struct {
	Mode                string  `json:"mode"`
	UsedBytes           int64   `json:"usedBytes"`
	LimitBytes          int64   `json:"limitBytes"`
	ReservedBytes       int64   `json:"reservedBytes"`
	EvictedEntries      int64   `json:"evictedEntries"`
	EvictedBytes        int64   `json:"evictedBytes"`
	FilesystemFreeBytes *uint64 `json:"filesystemFreeBytes,omitempty"`
}

func (m *Monitor) storage() storageStatus {
	if m.files == nil {
		return storageStatus{Mode: "proxy"}
	}
	result := storageStatus{Mode: "unbounded"}
	if b := m.files.budget; b != nil {
		b.mu.Lock()
		result.Mode = "bounded"
		result.UsedBytes = b.used
		result.LimitBytes = b.limit
		result.ReservedBytes = b.reserved
		result.EvictedEntries = b.evictedEntries
		result.EvictedBytes = b.evictedBytes
		b.mu.Unlock()
	}
	var disk syscall.Statfs_t
	if syscall.Statfs(m.files.root, &disk) == nil {
		available := uint64(disk.Bavail) * uint64(disk.Bsize)
		result.FilesystemFreeBytes = &available
	}
	return result
}

type trafficStatus struct {
	UploadedBytes   int64 `json:"uploadedBytes"`
	DownloadedBytes int64 `json:"downloadedBytes"`
	ActiveUploads   int64 `json:"activeUploads"`
	ActiveDownloads int64 `json:"activeDownloads"`
	ActionHits      int64 `json:"actionHits"`
	ActionMisses    int64 `json:"actionMisses"`
	ActionErrors    int64 `json:"actionErrors"`
}

func (traffic *cacheTraffic) snapshot() trafficStatus {
	return trafficStatus{
		UploadedBytes: traffic.uploaded.Load(), DownloadedBytes: traffic.downloaded.Load(),
		ActiveUploads: traffic.uploads.Load(), ActiveDownloads: traffic.downloads.Load(),
		ActionHits: traffic.actionHits.Load(), ActionMisses: traffic.actionMisses.Load(),
		ActionErrors: traffic.actionErrors.Load(),
	}
}

type instanceTraffic struct {
	Name string `json:"name"`
	trafficStatus
}

func (m *Monitor) instanceSnapshots() []instanceTraffic {
	m.mu.Lock()
	instances := make([]instanceTraffic, 0, len(m.instances))
	for name, traffic := range m.instances {
		instances = append(instances, instanceTraffic{Name: name, trafficStatus: traffic.snapshot()})
	}
	m.mu.Unlock()
	slices.SortFunc(instances, func(a, b instanceTraffic) int { return strings.Compare(a.Name, b.Name) })
	return instances
}

type cacheStatus struct {
	StartedAt time.Time `json:"startedAt"`
	SampledAt time.Time `json:"sampledAt"`
	trafficStatus
	Connections int64             `json:"connections"`
	Storage     storageStatus     `json:"storage"`
	Instances   []instanceTraffic `json:"instances"`
}

// Handler serves a read-only snapshot with the same frontend origin policy as Build Events.
func (m *Monitor) Handler(origins ...string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/remote-cache/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		if origin := r.Header.Get("Origin"); origin != "" {
			if !slices.Contains(origins, origin) {
				http.Error(w, "origin is not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cacheStatus{
			StartedAt: m.started, SampledAt: time.Now(),
			trafficStatus: m.traffic.snapshot(), Connections: m.connections.Load(),
			Storage: m.storage(), Instances: m.instanceSnapshots(),
		})
	})
	return mux
}
