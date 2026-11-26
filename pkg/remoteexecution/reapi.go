package remoteexecution

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	lro "cloud.google.com/go/longrunning/autogen/longrunningpb"
	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/remotecache"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	rpccode "google.golang.org/genproto/googleapis/rpc/code"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	rpcstatus "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type tokenKey struct{}

func bearer(value string) string {
	prefix, token, ok := strings.Cut(value, " ")
	if !ok || !strings.EqualFold(prefix, "bearer") {
		return ""
	}
	return token
}

func requestToken(ctx context.Context) string {
	if token, ok := ctx.Value(tokenKey{}).(string); ok {
		return token
	}
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get("authorization")
	if len(values) != 1 {
		return ""
	}
	return bearer(values[0])
}

func (s *Scheduler) authorizeClient(ctx context.Context) error {
	if !tokenMatches(s.config.ClientToken, requestToken(ctx)) {
		return status.Error(codes.Unauthenticated, "invalid execution client credential")
	}
	return nil
}

func (s *Scheduler) GetCapabilities(ctx context.Context, req *re.GetCapabilitiesRequest) (*re.ServerCapabilities, error) {
	capabilities, err := s.Backend.GetCapabilities(ctx, req)
	if err != nil {
		return nil, err
	}
	capabilities = proto.CloneOf(capabilities)
	var enabled bool
	err = s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pool_settings WHERE instance_name = ?)", req.InstanceName).Scan(&enabled)
	if err != nil {
		return nil, err
	}
	if enabled {
		capabilities.ExecutionCapabilities = &re.ExecutionCapabilities{ExecEnabled: true, DigestFunction: re.DigestFunction_SHA256}
	}
	return capabilities, nil
}

type operationRecord struct {
	summary   *pb.ExecutionOperation
	instance  string
	timeout   time.Duration
	cacheable bool
	response  *re.ExecuteResponse
}

func readOperation(ctx context.Context, db queryer, name string) (*operationRecord, error) {
	result := &operationRecord{summary: new(pb.ExecutionOperation)}
	var data, response []byte
	err := db.QueryRowContext(ctx, `SELECT data, timeout_ns, cacheable, response, instance FROM operations WHERE name=?`, name).
		Scan(&data, &result.timeout, &result.cacheable, &response, &result.instance)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, status.Error(codes.NotFound, "execution operation not found")
	}
	if err != nil {
		return nil, err
	}
	if err := proto.Unmarshal(data, result.summary); err != nil {
		return nil, err
	}
	if response != nil {
		result.response = new(re.ExecuteResponse)
		if err := proto.Unmarshal(response, result.response); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func updateOperation(ctx context.Context, tx *sql.Tx, op *operationRecord, worker string) error {
	response, err := proto.Marshal(op.response)
	if err != nil {
		return err
	}
	if op.response == nil {
		response = nil
	}
	if err := save(ctx, tx, op.summary, "UPDATE operations SET data=?, state=?, response=? WHERE name=?",
		op.summary.State, response, op.summary.OperationName); err != nil {
		return err
	}
	return operationEvent(ctx, tx, op.summary, worker)
}

func setOutcome(op *operationRecord, response *re.ExecuteResponse, now time.Time) {
	op.summary.State = completed
	op.summary.FinishedAt = timestamppb.New(now)
	code := rpccode.Code(response.Status.GetCode())
	op.summary.ExecutionCode = &code
	if response.Result != nil {
		op.summary.ExitCode = &response.Result.ExitCode
	}
	op.summary.CachedResult = response.CachedResult
	op.response = response
}

func (op *operationRecord) asREAPI() (*lro.Operation, error) {
	stage := re.ExecutionStage_QUEUED
	switch op.summary.State {
	case running:
		stage = re.ExecutionStage_EXECUTING
	case completed:
		stage = re.ExecutionStage_COMPLETED
	}
	meta, err := anypb.New(&re.ExecuteOperationMetadata{
		Stage: stage, ActionDigest: op.summary.ActionDigest, DigestFunction: op.summary.DigestFunction,
	})
	if err != nil {
		return nil, err
	}
	result := &lro.Operation{Name: op.summary.OperationName, Metadata: meta, Done: op.summary.State == completed}
	if result.Done {
		response, err := anypb.New(op.response)
		if err != nil {
			return nil, err
		}
		result.Result = &lro.Operation_Response{Response: response}
	}
	return result, nil
}

func checkDigest(digest *re.Digest) error {
	hash := digest.GetHash()
	if _, err := hex.DecodeString(hash); err != nil || len(hash) != 64 || strings.ToLower(hash) != hash || digest.GetSizeBytes() < 0 {
		return status.Error(codes.InvalidArgument, "invalid SHA-256 digest")
	}
	return nil
}

func missingDigest(digest *re.Digest) error {
	result, err := status.New(codes.FailedPrecondition, "action inputs are missing from CAS").WithDetails(
		&errdetails.PreconditionFailure{Violations: []*errdetails.PreconditionFailure_Violation{
			{Type: "MISSING", Subject: fmt.Sprintf("blobs/%s/%d", digest.Hash, digest.SizeBytes)},
		}})
	if err != nil {
		return err
	}
	return result.Err()
}

func (s *Scheduler) readCAS(ctx context.Context, instance string, digest *re.Digest, target proto.Message) error {
	if err := checkDigest(digest); err != nil {
		return err
	}
	result, err := s.Backend.BatchReadBlobs(ctx, &re.BatchReadBlobsRequest{
		InstanceName: instance, Digests: []*re.Digest{digest}, DigestFunction: re.DigestFunction_SHA256,
	})
	if err != nil {
		return err
	}
	if len(result.GetResponses()) != 1 {
		return status.Error(codes.Internal, "unexpected CAS result")
	}
	entry := result.Responses[0]
	switch codes.Code(entry.Status.GetCode()) {
	case codes.NotFound:
		return missingDigest(digest)
	case codes.OK:
		if err := proto.Unmarshal(entry.Data, target); err != nil {
			return status.Error(codes.InvalidArgument, "invalid action message in CAS")
		}
		return nil
	default:
		return status.ErrorProto(entry.Status)
	}
}

func (s *Scheduler) checkResultBlobs(ctx context.Context, instance string, result *re.ActionResult) error {
	digests := make([]*re.Digest, 0, len(result.OutputFiles)+2)
	for _, file := range result.OutputFiles {
		digests = append(digests, file.GetDigest())
	}
	for _, digest := range []*re.Digest{result.StdoutDigest, result.StderrDigest} {
		if digest != nil {
			digests = append(digests, digest)
		}
	}
	for _, dir := range result.OutputDirectories {
		if root := dir.GetRootDirectoryDigest(); root != nil {
			digests = append(digests, root)
		}
		digest := dir.GetTreeDigest()
		if digest == nil {
			if dir.GetRootDirectoryDigest() == nil {
				return status.Error(codes.InvalidArgument, "output directory requires a digest")
			}
			continue
		}
		var tree re.Tree
		if err := s.readCAS(ctx, instance, digest, &tree); err != nil {
			return err
		}
		if tree.Root == nil {
			return status.Error(codes.InvalidArgument, "output tree requires a root")
		}
		for _, directory := range append([]*re.Directory{tree.Root}, tree.Children...) {
			for _, file := range directory.GetFiles() {
				digests = append(digests, file.GetDigest())
			}
		}
	}
	seen := make(map[string]int64, len(digests))
	var batch []*re.Digest
	for _, digest := range digests {
		if err := checkDigest(digest); err != nil {
			return err
		}
		size, already := seen[digest.Hash]
		if already {
			if size != digest.SizeBytes {
				return status.Error(codes.InvalidArgument, "inconsistent output digest size")
			}
			continue
		}
		seen[digest.Hash] = digest.SizeBytes
		batch = append(batch, digest)
	}
	for len(batch) > 0 {
		count := min(512, len(batch))
		result, err := s.Backend.FindMissingBlobs(ctx, &re.FindMissingBlobsRequest{
			InstanceName: instance, BlobDigests: batch[:count], DigestFunction: re.DigestFunction_SHA256,
		})
		if err != nil {
			return err
		}
		if missing := result.GetMissingBlobDigests(); len(missing) > 0 {
			return status.Error(codes.FailedPrecondition, "execution result references missing CAS outputs")
		}
		batch = batch[count:]
	}
	return nil
}

func selectPool(ctx context.Context, db queryer, instance string, platform *re.Platform) (PoolConfig, error) {
	required := make(map[string]string)
	for _, property := range platform.GetProperties() {
		key, value := property.GetName(), property.GetValue()
		if _, found := required[key]; found || key == "" || value == "" {
			return PoolConfig{}, status.Error(codes.InvalidArgument, "invalid action platform")
		}
		required[key] = value
	}
	pools, err := queryPoolSettings(ctx, db, "WHERE instance_name = ?", instance)
	if err != nil {
		return PoolConfig{}, err
	}
	for _, pool := range pools {
		if matchPlatform(platformProto(pool.Platform), required) {
			return pool, nil
		}
	}
	return PoolConfig{}, status.Error(codes.FailedPrecondition, "no execution pool matches the instance and platform")
}

func (s *Scheduler) Execute(req *re.ExecuteRequest, stream re.Execution_ExecuteServer) error {
	ctx := stream.Context()
	if err := s.authorizeClient(ctx); err != nil {
		return err
	}
	if req.DigestFunction != re.DigestFunction_UNKNOWN && req.DigestFunction != re.DigestFunction_SHA256 {
		return status.Error(codes.InvalidArgument, "execution supports SHA-256")
	}
	if _, err := readInstance(ctx, s.db, req.InstanceName); err != nil {
		if status.Code(err) == codes.NotFound {
			return status.Error(codes.FailedPrecondition, "execution instance is not configured")
		}
		return err
	}
	action := new(re.Action)
	if err := s.readCAS(ctx, req.InstanceName, req.ActionDigest, action); err != nil {
		return err
	}
	command := new(re.Command)
	if err := s.readCAS(ctx, req.InstanceName, action.CommandDigest, command); err != nil {
		return err
	}
	platform := action.GetPlatform()
	if platform == nil {
		platform = command.GetPlatform()
	}
	timeout := defaultTimeout
	if action.Timeout != nil {
		timeout = action.Timeout.AsDuration()
		if !action.Timeout.IsValid() || timeout <= 0 || timeout > maxTimeout {
			return status.Error(codes.InvalidArgument, "action timeout must be positive and at most one hour")
		}
	}
	now := time.Now()
	op := &operationRecord{
		summary: &pb.ExecutionOperation{
			OperationName: "operations/" + identifier(),
			ActionDigest:  req.ActionDigest, DigestFunction: re.DigestFunction_SHA256,
			State: queued, QueuedAt: timestamppb.New(now), InvocationId: remotecache.RequestInvocationID(ctx),
		},
		instance: req.InstanceName, timeout: timeout, cacheable: !action.DoNotCache,
	}
	var response []byte
	if op.cacheable && !req.SkipCacheLookup {
		cached, err := s.Backend.GetActionResult(ctx, &re.GetActionResultRequest{
			InstanceName: req.InstanceName, ActionDigest: req.ActionDigest, DigestFunction: re.DigestFunction_SHA256,
		})
		if err == nil {
			setOutcome(op, &re.ExecuteResponse{Result: cached, CachedResult: true, Status: &rpcstatus.Status{}}, now)
			response, err = proto.Marshal(op.response)
			if err != nil {
				return err
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
	}
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		pool, err := selectPool(ctx, tx, req.InstanceName, platform)
		if err != nil {
			return err
		}
		op.summary.PoolId = pool.ID
		if err := save(ctx, tx, op.summary, `INSERT INTO operations(data,name,pool,instance,state,enqueued,timeout_ns,cacheable,response)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, op.summary.OperationName, pool.ID, op.instance, op.summary.State,
			now.UnixNano(), op.timeout, op.cacheable, response); err != nil {
			return err
		}
		if err := operationEvent(ctx, tx, op.summary, ""); err != nil {
			return err
		}
		return poolEvent(ctx, tx, pool.ID)
	})
	if err != nil {
		return err
	}
	return s.followOperation(ctx, op.summary.OperationName, stream.Send)
}

func (s *Scheduler) WaitExecution(req *re.WaitExecutionRequest, stream re.Execution_WaitExecutionServer) error {
	if err := s.authorizeClient(stream.Context()); err != nil {
		return err
	}
	return s.followOperation(stream.Context(), req.Name, stream.Send)
}

func (s *Scheduler) followOperation(ctx context.Context, name string, send func(*lro.Operation) error) error {
	var previous *lro.Operation
	for {
		op, err := readOperation(ctx, s.db, name)
		if err != nil {
			return err
		}
		message, err := op.asREAPI()
		if err != nil {
			return err
		}
		if !proto.Equal(previous, message) {
			if err := send(message); err != nil {
				return err
			}
			previous = message
		}
		if message.Done {
			return nil
		}
		if err := pause(ctx, pollInterval); err != nil {
			return err
		}
	}
}

type operationsService struct {
	lro.UnimplementedOperationsServer
	scheduler *Scheduler
}

func (service operationsService) GetOperation(ctx context.Context, req *lro.GetOperationRequest) (*lro.Operation, error) {
	s := service.scheduler
	if err := s.authorizeClient(ctx); err != nil {
		return nil, err
	}
	op, err := readOperation(ctx, s.db, req.Name)
	if err != nil {
		return nil, err
	}
	return op.asREAPI()
}

func (service operationsService) CancelOperation(ctx context.Context, req *lro.CancelOperationRequest) (*emptypb.Empty, error) {
	s := service.scheduler
	if err := s.authorizeClient(ctx); err != nil {
		return nil, err
	}
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		op, err := readOperation(ctx, tx, req.Name)
		if err != nil || op.summary.State == completed {
			return err
		}
		now := time.Now()
		if op.summary.State == leased || op.summary.State == running {
			record, err := scanLease(tx.QueryRowContext(ctx, leaseFields+" WHERE operation=? AND state IN (?, ?)", req.Name, offered, executing))
			if err != nil {
				return err
			}
			record.attempt.State = pb.AttemptState_ATTEMPT_STATE_CANCELLED
			record.attempt.FinishedAt = timestamppb.New(now)
			if err := updateLease(ctx, tx, record); err != nil {
				return err
			}
			if err := refreshWorker(ctx, tx, record.session); err != nil {
				return err
			}
		}
		setOutcome(op, &re.ExecuteResponse{Status: &rpcstatus.Status{Code: int32(codes.Canceled), Message: "execution cancelled"}}, now)
		if err := updateOperation(ctx, tx, op, op.summary.WorkerId); err != nil {
			return err
		}
		return poolEvent(ctx, tx, op.summary.PoolId)
	})
	return &emptypb.Empty{}, err
}

func (s *Scheduler) RegisterREAPI(server *grpc.Server) {
	re.RegisterExecutionServer(server, s)
	lro.RegisterOperationsServer(server, &operationsService{scheduler: s})
}

// ServerOptions protects the shared REAPI and cache listener when execution is enabled.
func (s *Scheduler) ServerOptions() []grpc.ServerOption {
	return []grpc.ServerOption{
		grpc.ChainUnaryInterceptor(func(ctx context.Context, request any, _ *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
			if err := s.authorizeClient(ctx); err != nil {
				return nil, err
			}
			return next(ctx, request)
		}),
		grpc.ChainStreamInterceptor(func(server any, stream grpc.ServerStream, _ *grpc.StreamServerInfo, next grpc.StreamHandler) error {
			if err := s.authorizeClient(stream.Context()); err != nil {
				return err
			}
			return next(server, stream)
		}),
	}
}
