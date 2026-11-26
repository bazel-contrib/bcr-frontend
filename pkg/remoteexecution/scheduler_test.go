package remoteexecution

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	lro "cloud.google.com/go/longrunning/autogen/longrunningpb"
	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	rpcstatus "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestManagedPoolAndIrohWorker(t *testing.T) {
	ctx := context.Background()
	config := Config{
		ClientToken: "client-execution-test-token",
		ViewerToken: "viewer-execution-test-token",
		AdminToken:  "admin-execution-test-token",
	}
	path := filepath.Join(t.TempDir(), "execution.sqlite")
	open := func() *Scheduler {
		t.Helper()
		s, err := Open(path, config, nil)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	s := open()
	defer func() { s.Close() }()
	public, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	pool := PoolConfig{ID: "linux", Instance: "builds", Platform: map[string]string{"OSFamily": "Linux"}, IrohGatewayID: fmt.Sprintf("%x", public)}
	request := func(method, path, token string, payload any, expected int) {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, HTTPPrefix+path, bytes.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, req)
		if res.Code != expected {
			t.Fatalf("save pool: HTTP %d: %s", res.Code, res.Body)
		}
	}
	put := func(token string, expected int) {
		request(http.MethodPut, "admin/pools/linux", token, pool, expected)
	}
	put(config.ViewerToken, http.StatusUnauthorized)
	put(config.AdminToken, http.StatusConflict)
	instance := Instance{Name: "builds", DisplayName: "Build fleet"}
	request(http.MethodPut, "admin/instances", config.ViewerToken, instance, http.StatusUnauthorized)
	request(http.MethodPut, "admin/instances", config.AdminToken, instance, http.StatusNoContent)
	put(config.AdminToken, http.StatusNoContent)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = open()
	if got, err := readPoolSettings(ctx, s.db, pool.ID); err != nil || got.IrohGatewayID != pool.IrohGatewayID || got.Instance != instance.Name {
		t.Fatalf("pool persisted: %+v, %v", got, err)
	}
	peer := fmt.Sprintf("%064x", 1)
	claim := irohCredentialPrefix + ":linux:" + peer
	credential := claim + ":" + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(claim)))
	workerCtx := context.WithValue(ctx, tokenKey{}, credential)
	workerRequest := &pb.RegisterWorkerRequest{
		WorkerId: irohWorkerPrefix + fmt.Sprintf("%064x", 2), RegistrationId: "process-1", Slots: 1, Platform: platformProto(pool.Platform),
	}
	if _, err := s.RegisterWorker(workerCtx, workerRequest); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("spoofed worker ID: %v", err)
	}
	workerRequest.WorkerId = irohWorkerPrefix + peer
	workerRequest.Platform = platformProto(map[string]string{"OSFamily": "Other"})
	if _, err := s.RegisterWorker(workerCtx, workerRequest); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("incompatible platform: %v", err)
	}
	workerRequest.Platform = platformProto(pool.Platform)
	registered, err := s.RegisterWorker(workerCtx, workerRequest)
	if err != nil || registered.GetPoolId() != pool.ID {
		t.Fatalf("register worker: %v, %v", registered, err)
	}
	summaries, err := s.listInstanceSummaries(ctx)
	if err != nil || len(summaries) != 1 || summaries[0].DisplayName != instance.DisplayName ||
		summaries[0].OnlineWorkers != 1 || len(summaries[0].Pools) != 1 || summaries[0].Pools[0].ID != pool.ID {
		t.Fatalf("unexpected instance summary: %+v, %v", summaries, err)
	}
	if _, err := s.Heartbeat(workerCtx, &pb.HeartbeatRequest{SessionId: registered.SessionId}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Heartbeat(workerCtx, &pb.HeartbeatRequest{SessionId: registered.SessionId, Draining: true}); err != nil {
		t.Fatal(err)
	}
	worker, err := s.GetWorker(ctx, &pb.GetWorkerRequest{PoolId: pool.ID, WorkerId: workerRequest.WorkerId})
	if err != nil || worker.GetWorker().GetState() != pb.WorkerState_WORKER_STATE_OFFLINE {
		t.Fatalf("drained worker should already be offline: %v, %v", worker, err)
	}
	workerRequest.RegistrationId = "process-2"
	registered, err = s.RegisterWorker(workerCtx, workerRequest)
	if err != nil || registered.GetSessionId() == "" {
		t.Fatalf("register worker again: %v, %v", registered, err)
	}
	pool.RevokedWorkers = []string{workerRequest.WorkerId}
	put(config.AdminToken, http.StatusNoContent)
	if _, err := s.Heartbeat(workerCtx, &pb.HeartbeatRequest{SessionId: registered.SessionId}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("revoked worker heartbeat: %v", err)
	}
	if _, err := s.RegisterWorker(workerCtx, workerRequest); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("revoked worker registration: %v", err)
	}
}

func TestMigrateInstanceRecordsFromVersionTwo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "execution.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(schema + `CREATE TABLE pool_settings (
		id TEXT PRIMARY KEY REFERENCES pools(id), data BLOB NOT NULL, legacy_order INTEGER
	); PRAGMA user_version = 2;`); err != nil {
		t.Fatal(err)
	}
	for _, spec := range []PoolConfig{
		{ID: "linux", Instance: "ci/linux"},
		{ID: "linux-secondary", Instance: "ci/linux"},
		{ID: "default"},
	} {
		snapshot, err := proto.Marshal(&pb.Pool{PoolId: spec.ID, InstanceName: spec.Instance})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO pools VALUES (?, ?)", spec.ID, snapshot); err != nil {
			t.Fatal(err)
		}
		settings, err := json.Marshal(spec)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO pool_settings VALUES (?, ?, NULL)", spec.ID, settings); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path, Config{
		ClientToken: "client-execution-test-token",
		ViewerToken: "viewer-execution-test-token",
		AdminToken:  "admin-execution-test-token",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	summaries, err := s.listInstanceSummaries(ctx)
	if err != nil || len(summaries) != 2 || summaries[0].Name != "" ||
		len(summaries[0].Pools) != 1 || summaries[1].Name != "ci/linux" || len(summaries[1].Pools) != 2 {
		t.Fatalf("unexpected migrated instances: %+v, %v", summaries, err)
	}
	pool, err := selectPool(ctx, s.db, "ci/linux", nil)
	if err != nil || pool.ID != "linux" {
		t.Fatalf("routing order changed during migration: %+v, %v", pool, err)
	}
}

func TestSchedulerStatusAndReadiness(t *testing.T) {
	dir := t.TempDir()
	cacheDir := filepath.Join(dir, "cache")
	cache, err := remotecache.NewFileCache(cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	config := Config{
		ClientToken: "client-execution-test-token",
		ViewerToken: "viewer-execution-test-token",
		Pools:       []PoolConfig{{ID: "linux"}},
	}
	s, err := Open(filepath.Join(dir, "execution.sqlite"), config, cache)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	handler := s.Handler()
	get := func(path, token string, code int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, HTTPPrefix+path, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != code {
			t.Fatalf("%s: got HTTP %d, want %d: %s", path, res.Code, code, res.Body)
		}
		return res
	}
	get("status", "", http.StatusUnauthorized)
	get("readyz", "", http.StatusServiceUnavailable)
	if err := s.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	get("readyz", "", http.StatusNoContent)
	var snapshot schedulerStatus
	res := get("status", config.ViewerToken, http.StatusOK)
	if err := json.Unmarshal(res.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if !snapshot.Ready || snapshot.LastSweepSuccess == nil || len(snapshot.Pools) != 1 || snapshot.Pools[0].ID != "linux" {
		t.Fatalf("unexpected scheduler snapshot: %+v", snapshot)
	}
	if err := os.Remove(cacheDir); err != nil {
		t.Fatal(err)
	}
	get("readyz", "", http.StatusServiceUnavailable)
}

func TestSchedulerLeaseAndCache(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	dir := t.TempDir()
	cache, err := remotecache.NewFileCache(filepath.Join(dir, "cache"))
	if err != nil {
		t.Fatal(err)
	}
	config := Config{
		ClientToken: "client-execution-test-token",
		ViewerToken: "viewer-execution-test-token",
		Pools:       []PoolConfig{{ID: "linux", Instance: "builds", Platform: map[string]string{"OSFamily": "Linux"}}},
		Workers:     map[string]WorkerConfig{"worker": {Pool: "linux", Token: "worker-execution-test-token"}},
	}
	dbPath := filepath.Join(dir, "execution.sqlite")
	s, err := Open(dbPath, config, cache)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	listener := bufconn.Listen(2 << 20)
	server := remotecache.NewServer(s, nil, nil, s.ServerOptions()...)
	s.RegisterREAPI(server)
	go server.Serve(listener)
	defer server.Stop()
	conn, err := grpc.NewClient("passthrough:///remote-execution",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client := re.NewExecutionClient(conn)
	if _, err := re.NewCapabilitiesClient(conn).GetCapabilities(ctx, &re.GetCapabilitiesRequest{InstanceName: "builds"}); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("unauthenticated capabilities: %v", err)
	}
	metadataBytes, _ := proto.Marshal(&re.RequestMetadata{ToolInvocationId: "test-invocation"})
	clientCtx := metadata.NewOutgoingContext(ctx, metadata.Pairs("authorization", "Bearer "+config.ClientToken,
		"build.bazel.remote.execution.v2.requestmetadata-bin", string(metadataBytes)))
	capabilities, err := re.NewCapabilitiesClient(conn).GetCapabilities(clientCtx, &re.GetCapabilitiesRequest{InstanceName: "builds"})
	if err != nil || !capabilities.GetExecutionCapabilities().GetExecEnabled() {
		t.Fatalf("get execution capabilities: %v, %v", capabilities, err)
	}
	handler := s.Handler("https://frontend.example")
	rpc := func(method string, request, result proto.Message) {
		t.Helper()
		data, err := proto.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, HTTPPrefix+"worker/"+method, bytes.NewReader(data))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Authorization", "Bearer "+config.Workers["worker"].Token)
		req.Header.Set("Content-Type", "application/protobuf")
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusOK {
			t.Fatalf("%s: HTTP %d: %s", method, res.Code, res.Body)
		}
		if err := proto.Unmarshal(res.Body.Bytes(), result); err != nil {
			t.Fatal(err)
		}
	}
	registration := &pb.RegisterWorkerResponse{}
	rpc("register", &pb.RegisterWorkerRequest{
		WorkerId: "worker", RegistrationId: "process-1", Slots: 1,
		Platform: platformProto(config.Pools[0].Platform),
	}, registration)
	add := func(message proto.Message) *re.Digest {
		t.Helper()
		data, err := proto.Marshal(message)
		if err != nil {
			t.Fatal(err)
		}
		digest := &re.Digest{Hash: fmt.Sprintf("%x", sha256.Sum256(data)), SizeBytes: int64(len(data))}
		resp, err := cache.BatchUpdateBlobs(ctx, &re.BatchUpdateBlobsRequest{InstanceName: "builds", Requests: []*re.BatchUpdateBlobsRequest_Request{{Digest: digest, Data: data}}})
		if err != nil || resp.GetResponses()[0].GetStatus().GetCode() != 0 {
			t.Fatalf("upload: %v, %v", resp, err)
		}
		return digest
	}
	command := add(&re.Command{
		Arguments: []string{"example", "--test"}, WorkingDirectory: "src", OutputPaths: []string{"out"},
		EnvironmentVariables: []*re.Command_EnvironmentVariable{{Name: "EXAMPLE", Value: "do-not-include"}},
		Platform:             platformProto(config.Pools[0].Platform),
	})
	action := add(&re.Action{CommandDigest: command, InputRootDigest: add(&re.Directory{})})
	first, err := client.Execute(clientCtx, &re.ExecuteRequest{InstanceName: "builds", ActionDigest: action})
	if err != nil {
		t.Fatal(err)
	}
	initial, err := first.Recv()
	if err != nil || initial.GetDone() {
		t.Fatalf("Execute: %v, %v", initial, err)
	}
	leaseRequest := &pb.LeaseWorkRequest{SessionId: registration.SessionId, RequestId: "poll-1"}
	work, retry := new(pb.LeaseWorkResponse), new(pb.LeaseWorkResponse)
	rpc("lease", leaseRequest, work)
	rpc("lease", leaseRequest, retry)
	if !proto.Equal(work, retry) || work.GetOffer().GetOperationName() != initial.Name {
		t.Fatalf("unexpected leases %v, %v", work, retry)
	}
	id := work.Offer.LeaseId
	rpc("acknowledge", &pb.AcknowledgeLeaseRequest{SessionId: registration.SessionId, LeaseId: id}, new(pb.AcknowledgeLeaseResponse))
	rpc("heartbeat", &pb.HeartbeatRequest{SessionId: registration.SessionId, ActiveLeaseIds: []string{id}}, new(pb.HeartbeatResponse))
	output := []byte("worker output\n")
	digest := &re.Digest{Hash: fmt.Sprintf("%x", sha256.Sum256(output)), SizeBytes: int64(len(output))}
	path := fmt.Sprintf("%sworker/%s/%s/blobs/%s/%d", HTTPPrefix, registration.SessionId, id, digest.Hash, digest.SizeBytes)
	for _, method := range []string{http.MethodPut, http.MethodGet} {
		var body io.Reader
		if method == http.MethodPut {
			body = bytes.NewReader(output)
		}
		req := httptest.NewRequestWithContext(ctx, method, path, body)
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Authorization", "Bearer "+config.Workers["worker"].Token)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if method == http.MethodPut && res.Code != http.StatusNoContent ||
			method == http.MethodGet && (res.Code != http.StatusOK || !bytes.Equal(res.Body.Bytes(), output)) {
			t.Fatalf("%s blob: %d %q", method, res.Code, res.Body)
		}
	}
	finish := &pb.CompleteLeaseRequest{SessionId: registration.SessionId, LeaseId: id,
		Outcome: &pb.CompleteLeaseRequest_Result{Result: &pb.WorkerExecutionResult{
			ExecutionStatus: &rpcstatus.Status{}, ActionResult: &re.ActionResult{StdoutDigest: digest},
		}},
	}
	rpc("complete", finish, new(pb.CompleteLeaseResponse))
	rpc("complete", finish, new(pb.CompleteLeaseResponse))
	reconnected, err := client.WaitExecution(clientCtx, &re.WaitExecutionRequest{Name: initial.Name})
	if err != nil {
		t.Fatal(err)
	}
	final, err := reconnected.Recv()
	if err != nil || !final.GetDone() {
		t.Fatalf("WaitExecution: %v, %v", final, err)
	}
	cached, err := client.Execute(clientCtx, &re.ExecuteRequest{InstanceName: "builds", ActionDigest: action})
	if err != nil {
		t.Fatal(err)
	}
	final, err = cached.Recv()
	var result re.ExecuteResponse
	if err != nil || !final.GetDone() || final.GetResponse().UnmarshalTo(&result) != nil || !result.CachedResult {
		t.Fatalf("expected cached result: %v, %v", final, err)
	}
	operations := lro.NewOperationsClient(conn)
	if op, err := operations.GetOperation(clientCtx, &lro.GetOperationRequest{Name: initial.Name}); err != nil || !op.GetDone() {
		t.Fatalf("GetOperation: %v, %v", op, err)
	}
	detailPath := HTTPPrefix + "pools/linux/" + initial.Name
	for _, test := range []struct {
		path, token string
		code        int
	}{
		{detailPath, "", http.StatusUnauthorized},
		{HTTPPrefix + "pools/other/" + initial.Name, config.ViewerToken, http.StatusNotFound},
		{detailPath, config.ViewerToken, http.StatusOK},
	} {
		request := httptest.NewRequestWithContext(ctx, http.MethodGet, test.path, nil)
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Authorization", "Bearer "+test.token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.code {
			t.Fatalf("operation detail: HTTP %d, want %d: %s", response.Code, test.code, response.Body)
		}
		if test.code != http.StatusOK {
			continue
		}
		for _, want := range []string{initial.Name, "test-invocation", "workingDirectory", "--test", "attemptNumber", digest.Hash} {
			if !bytes.Contains(response.Body.Bytes(), []byte(want)) {
				t.Errorf("operation detail missing %q: %s", want, response.Body)
			}
		}
		if bytes.Contains(response.Body.Bytes(), []byte("do-not-include")) || bytes.Contains(response.Body.Bytes(), output) {
			t.Fatal("operation detail included environment values or output contents")
		}
	}
	history, err := s.ListWorkerAttempts(ctx, &pb.ListWorkerAttemptsRequest{PoolId: "linux", WorkerId: "worker"})
	if err != nil || len(history.GetAttempts()) != 1 || history.Attempts[0].InvocationId != "test-invocation" {
		t.Fatalf("worker history: %v, %v", history, err)
	}
	uncached, err := client.Execute(clientCtx, &re.ExecuteRequest{InstanceName: "builds", ActionDigest: action, SkipCacheLookup: true})
	if err != nil {
		t.Fatal(err)
	}
	recovery, err := uncached.Recv()
	if err != nil || recovery.GetDone() {
		t.Fatalf("queue restart fixture: %v, %v", recovery, err)
	}
	active := new(pb.LeaseWorkResponse)
	rpc("lease", &pb.LeaseWorkRequest{SessionId: registration.SessionId, RequestId: "poll-before-restart"}, active)
	rpc("acknowledge", &pb.AcknowledgeLeaseRequest{SessionId: registration.SessionId, LeaseId: active.GetOffer().GetLeaseId()}, new(pb.AcknowledgeLeaseResponse))

	server.Stop()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dbPath, config, cache)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := s.GetWorker(ctx, &pb.GetWorkerRequest{PoolId: "linux", WorkerId: "worker"})
	if err != nil || worker.GetWorker().GetState() != pb.WorkerState_WORKER_STATE_OFFLINE {
		t.Fatalf("worker after restart: %v, %v", worker, err)
	}
	previous := active.GetOffer().GetLeaseId()
	workerCtx := context.WithValue(ctx, tokenKey{}, config.Workers["worker"].Token)
	if _, err := s.AcknowledgeLease(workerCtx, &pb.AcknowledgeLeaseRequest{SessionId: registration.SessionId, LeaseId: previous}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("old session remained current: %v", err)
	}
	registered, err := s.RegisterWorker(workerCtx, &pb.RegisterWorkerRequest{
		WorkerId: "worker", RegistrationId: "process-2", Slots: 1, Platform: platformProto(config.Pools[0].Platform),
	})
	if err != nil {
		t.Fatal(err)
	}
	reissued, err := s.LeaseWork(workerCtx, &pb.LeaseWorkRequest{SessionId: registered.SessionId, RequestId: "poll-after-restart"})
	if err != nil || reissued.GetOffer().GetOperationName() != recovery.Name || reissued.GetOffer().GetLeaseId() == previous {
		t.Fatalf("expected a new lease for the recovered operation: %v, %v", reissued, err)
	}
	events, err := readEvents(ctx, s.db, "linux", "worker", 0)
	if err != nil || len(events) == 0 {
		t.Fatalf("expected retained worker events: %v, %v", events, err)
	}

}

func TestPoolTimelineReplaysEveryOperationTransition(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "execution.sqlite"), Config{
		ClientToken: "client-execution-test-token",
		ViewerToken: "viewer-execution-test-token",
		Pools:       []PoolConfig{{ID: "linux"}, {ID: "other"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	initial, err := s.readTimeline(ctx, "linux", nil)
	if err != nil || !initial.Snapshot || initial.Cursor != "0" {
		t.Fatalf("initial timeline: %+v, %v", initial, err)
	}
	err = s.transaction(ctx, func(tx *sql.Tx) error {
		for _, state := range []pb.OperationState{queued, leased, running, completed} {
			for _, pool := range []string{"linux", "other"} {
				if err := operationEvent(ctx, tx, &pb.ExecutionOperation{
					PoolId: pool, OperationName: "operations/test", State: state,
				}, "worker"); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var after uint64
	replay, err := s.readTimeline(ctx, "linux", &after)
	if err != nil || replay.Snapshot || replay.Cursor != "8" || len(replay.Events) != 4 {
		t.Fatalf("timeline replay: %+v, %v", replay, err)
	}
	for index, expected := range []pb.OperationState{queued, leased, running, completed} {
		var event pb.ActivityEvent
		if err := protojson.Unmarshal(replay.Events[index], &event); err != nil {
			t.Fatal(err)
		}
		if event.GetOperation().GetState() != expected || event.Sequence != uint64(2*index+1) {
			t.Fatalf("event %d: %v", index, &event)
		}
	}
	after = 9
	reset, err := s.readTimeline(ctx, "linux", &after)
	if err != nil || !reset.Snapshot || reset.Cursor != "8" {
		t.Fatalf("invalid cursor did not get a new snapshot: %+v, %v", reset, err)
	}
}
