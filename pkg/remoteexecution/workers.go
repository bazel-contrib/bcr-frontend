package remoteexecution

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	rpcstatus "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	irohWorkerPrefix     = "iroh-"
	irohCredentialPrefix = "bcr-iroh-worker-v1"
)

var validIrohID = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (s *Scheduler) workerPool(ctx context.Context, db queryer, id string) (PoolConfig, error) {
	token := requestToken(ctx)
	denied := status.Error(codes.Unauthenticated, "invalid worker credential")
	if worker, ok := s.config.Workers[id]; ok {
		if tokenMatches(worker.Token, token) {
			return readPoolSettings(ctx, db, worker.Pool)
		}
		return PoolConfig{}, denied
	}
	// The gateway signs the pool and the authenticated Iroh peer ID together.
	claim, signatureText, ok := strings.Cut(token, ":")
	if !ok || claim != irohCredentialPrefix || len(token) > 320 {
		return PoolConfig{}, denied
	}
	poolID, rest, ok := strings.Cut(signatureText, ":")
	if !ok || !validID.MatchString(poolID) {
		return PoolConfig{}, denied
	}
	peer, signatureText, ok := strings.Cut(rest, ":")
	if !ok || !validIrohID.MatchString(peer) || id != irohWorkerPrefix+peer {
		return PoolConfig{}, denied
	}
	pool, err := readPoolSettings(ctx, db, poolID)
	if status.Code(err) == codes.NotFound {
		return PoolConfig{}, denied
	}
	if err != nil {
		return PoolConfig{}, err
	}
	key, _ := hex.DecodeString(pool.IrohGatewayID)
	signature, err := base64.RawURLEncoding.DecodeString(signatureText)
	if len(key) != ed25519.PublicKeySize || err != nil ||
		!ed25519.Verify(ed25519.PublicKey(key), []byte(irohCredentialPrefix+":"+poolID+":"+peer), signature) ||
		slices.Contains(pool.RevokedWorkers, id) {
		return PoolConfig{}, denied
	}
	return pool, nil
}

const (
	queued    = pb.OperationState_OPERATION_STATE_QUEUED
	leased    = pb.OperationState_OPERATION_STATE_LEASED
	running   = pb.OperationState_OPERATION_STATE_RUNNING
	completed = pb.OperationState_OPERATION_STATE_COMPLETED
	offered   = pb.AttemptState_ATTEMPT_STATE_LEASED
	executing = pb.AttemptState_ATTEMPT_STATE_RUNNING
)

func identifier() string {
	var bytes [16]byte
	rand.Read(bytes[:])
	return hex.EncodeToString(bytes[:])
}

type session struct {
	worker       *pb.Worker
	id           string
	registration string
	deadline     int64
}

func readSession(ctx context.Context, db queryer, query string, arg string) (*session, error) {
	result := &session{worker: new(pb.Worker)}
	var data []byte
	err := db.QueryRowContext(ctx, "SELECT data, session, registration, deadline FROM workers WHERE "+query, arg).
		Scan(&data, &result.id, &result.registration, &result.deadline)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, status.Error(codes.NotFound, "worker session not found")
	}
	if err != nil {
		return nil, err
	}
	return result, proto.Unmarshal(data, result.worker)
}

func (s *Scheduler) currentSession(ctx context.Context, db queryer, id string, now time.Time) (*session, error) {
	if !validID.MatchString(id) {
		return nil, status.Error(codes.Unauthenticated, "invalid worker session")
	}
	result, err := readSession(ctx, db, "session = ?", id)
	if status.Code(err) == codes.NotFound {
		return nil, status.Error(codes.Unauthenticated, "unknown worker session")
	}
	if err != nil {
		return nil, err
	}
	pool, err := s.workerPool(ctx, db, result.worker.WorkerId)
	if err != nil {
		return nil, err
	}
	if pool.ID != result.worker.PoolId {
		return nil, status.Error(codes.Unauthenticated, "invalid worker credential")
	}
	if result.deadline <= now.UnixNano() {
		return nil, status.Error(codes.FailedPrecondition, "worker session expired")
	}
	return result, nil
}

func matchPlatform(platform *re.Platform, requirements map[string]string) bool {
	properties := make(map[string]string, len(platform.GetProperties()))
	for _, property := range platform.GetProperties() {
		if _, exists := properties[property.GetName()]; exists || property.GetName() == "" || property.GetValue() == "" {
			return false
		}
		properties[property.GetName()] = property.GetValue()
	}
	for name, value := range requirements {
		if properties[name] != value {
			return false
		}
	}
	return true
}

func (s *Scheduler) RegisterWorker(ctx context.Context, req *pb.RegisterWorkerRequest) (*pb.RegisterWorkerResponse, error) {
	if !validID.MatchString(req.RegistrationId) || req.Slots == 0 || req.Slots > 1024 ||
		len(req.DisplayName) > 256 || len(req.Version) > 128 || len(req.Platform.GetProperties()) > 64 {
		return nil, status.Error(codes.InvalidArgument, "invalid worker registration")
	}
	result := &pb.RegisterWorkerResponse{HeartbeatInterval: durationpb.New(heartbeatInterval)}
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		pool, err := s.workerPool(ctx, tx, req.WorkerId)
		if err != nil {
			return err
		}
		if !matchPlatform(req.Platform, pool.Platform) {
			return status.Error(codes.FailedPrecondition, "worker platform does not satisfy its pool")
		}
		poolID := pool.ID
		result.PoolId = poolID
		now := time.Now()
		old, err := readSession(ctx, tx, "id = ?", req.WorkerId)
		switch status.Code(err) {
		case codes.OK:
			if _, preconfigured := s.config.Workers[req.WorkerId]; !preconfigured && old.worker.PoolId != poolID {
				return status.Error(codes.PermissionDenied, "Iroh worker identity already belongs to another pool")
			}
			if old.registration == req.RegistrationId && old.deadline > now.UnixNano() {
				result.SessionId = old.id
				return nil
			}
			if _, err := tx.ExecContext(ctx, "UPDATE leases SET deadline = 0 WHERE session = ? AND state IN (?, ?)", old.id, offered, executing); err != nil {
				return err
			}
			if err := expire(ctx, tx, now); err != nil {
				return err
			}
		case codes.NotFound:
		default:
			return err
		}
		result.SessionId = identifier()
		worker := &pb.Worker{
			WorkerId: req.WorkerId, PoolId: poolID, DisplayName: req.DisplayName, Version: req.Version,
			Platform: req.Platform, State: pb.WorkerState_WORKER_STATE_ONLINE, TotalSlots: req.Slots,
			RegisteredAt: timestamppb.New(now), LastSeenAt: timestamppb.New(now),
		}
		if err := save(ctx, tx, worker, `INSERT INTO workers(data,id,pool,session,registration,deadline)
			VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, pool=excluded.pool,
			session=excluded.session, registration=excluded.registration, deadline=excluded.deadline`,
			worker.WorkerId, worker.PoolId, result.SessionId, req.RegistrationId, now.Add(leaseDuration).UnixNano()); err != nil {
			return err
		}
		if err := workerEvent(ctx, tx, worker); err != nil {
			return err
		}
		return poolEvent(ctx, tx, worker.PoolId)
	})
	return result, err
}

type lease struct {
	id         string
	session    string
	deadline   int64
	attempt    *pb.ExecutionAttempt
	completion []byte
}

func scanLease(row interface{ Scan(...any) error }) (*lease, error) {
	result := &lease{attempt: new(pb.ExecutionAttempt)}
	var data []byte
	if err := row.Scan(&result.id, &result.session, &result.deadline, &data, &result.completion); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, status.Error(codes.NotFound, "lease not found")
		}
		return nil, err
	}
	return result, proto.Unmarshal(data, result.attempt)
}

const leaseFields = "SELECT id, session, deadline, data, completion FROM leases"

func readLease(ctx context.Context, db queryer, id string) (*lease, error) {
	return scanLease(db.QueryRowContext(ctx, leaseFields+" WHERE id = ?", id))
}

func leaseForSession(ctx context.Context, db queryer, id, sessionID string) (*lease, error) {
	result, err := readLease(ctx, db, id)
	if err == nil && result.session != sessionID {
		return nil, status.Error(codes.NotFound, "lease not found")
	}
	return result, err
}

func leaseOffer(record *lease, op *operationRecord) *pb.LeaseOffer {
	return &pb.LeaseOffer{
		LeaseId: record.id, OperationName: op.summary.OperationName, InstanceName: op.instance,
		ActionDigest: op.summary.ActionDigest, DigestFunction: op.summary.DigestFunction,
		AcknowledgeBy: timestamp(record.deadline), ExecutionTimeout: durationpb.New(op.timeout),
	}
}

func (s *Scheduler) LeaseWork(ctx context.Context, req *pb.LeaseWorkRequest) (*pb.LeaseWorkResponse, error) {
	if !validID.MatchString(req.RequestId) {
		return nil, status.Error(codes.InvalidArgument, "request ID is required")
	}
	result := new(pb.LeaseWorkResponse)
	stopAt := time.Now().Add(longPoll)
	for {
		stop := false
		err := s.transaction(ctx, func(tx *sql.Tx) error {
			now := time.Now()
			current, err := s.currentSession(ctx, tx, req.SessionId, now)
			if err != nil {
				return err
			}
			record, err := scanLease(tx.QueryRowContext(ctx, leaseFields+" WHERE session = ? AND request_id = ?", req.SessionId, req.RequestId))
			switch status.Code(err) {
			case codes.OK:
				stop = true
				if record.attempt.State != offered || record.deadline <= now.UnixNano() {
					return nil
				}
				op, err := readOperation(ctx, tx, record.attempt.OperationName)
				if err == nil {
					result.Offer = leaseOffer(record, op)
				}
				return err
			case codes.NotFound:
			default:
				return err
			}
			worker := current.worker
			if worker.State != pb.WorkerState_WORKER_STATE_ONLINE || worker.OccupiedSlots >= worker.TotalSlots {
				stop = true
				return nil
			}
			var name string
			err = tx.QueryRowContext(ctx, "SELECT name FROM operations WHERE pool = ? AND state = ? ORDER BY enqueued, name LIMIT 1",
				worker.PoolId, queued).Scan(&name)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			op, err := readOperation(ctx, tx, name)
			if err != nil {
				return err
			}
			op.summary.AttemptCount++
			op.summary.State = leased
			op.summary.WorkerId = worker.WorkerId
			record = &lease{id: identifier(), session: current.id, deadline: now.Add(offerDuration).UnixNano(), attempt: &pb.ExecutionAttempt{
				OperationName: name, PoolId: worker.PoolId, WorkerId: worker.WorkerId, AttemptNumber: op.summary.AttemptCount,
				State: offered, LeasedAt: timestamppb.New(now), InvocationId: op.summary.InvocationId,
			}}
			if err := save(ctx, tx, record.attempt, `INSERT INTO leases(data,id,operation,session,worker,request_id,deadline,state,attempt)
				VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, record.id, name, req.SessionId, worker.WorkerId, req.RequestId, record.deadline, offered, record.attempt.AttemptNumber); err != nil {
				return err
			}
			if err := updateOperation(ctx, tx, op, worker.WorkerId); err != nil {
				return err
			}
			if err := attemptEvent(ctx, tx, record.attempt); err != nil {
				return err
			}
			if err := refreshWorker(ctx, tx, current.id); err != nil {
				return err
			}
			result.Offer = leaseOffer(record, op)
			stop = true
			return poolEvent(ctx, tx, worker.PoolId)
		})
		if err != nil || stop || time.Now().After(stopAt) {
			return result, err
		}
		if err := pause(ctx, pollInterval); err != nil {
			return nil, err
		}
	}
}

func (s *Scheduler) AcknowledgeLease(ctx context.Context, req *pb.AcknowledgeLeaseRequest) (*pb.AcknowledgeLeaseResponse, error) {
	result := new(pb.AcknowledgeLeaseResponse)
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		now := time.Now()
		if _, err := s.currentSession(ctx, tx, req.SessionId, now); err != nil {
			return err
		}
		record, err := leaseForSession(ctx, tx, req.LeaseId, req.SessionId)
		if err != nil {
			return err
		}
		if record.deadline <= now.UnixNano() || (record.attempt.State != offered && record.attempt.State != executing) {
			return status.Error(codes.FailedPrecondition, "lease is no longer current")
		}
		if record.attempt.State == executing {
			result.LeaseExpiresAt = timestamp(record.deadline)
			return nil
		}
		op, err := readOperation(ctx, tx, record.attempt.OperationName)
		if err != nil {
			return err
		}
		record.attempt.State = executing
		record.attempt.StartedAt = timestamppb.New(now)
		record.deadline = now.Add(leaseDuration).UnixNano()
		op.summary.State = running
		op.summary.StartedAt = record.attempt.StartedAt
		result.LeaseExpiresAt = timestamp(record.deadline)
		if err := updateLease(ctx, tx, record); err != nil {
			return err
		}
		if err := updateOperation(ctx, tx, op, record.attempt.WorkerId); err != nil {
			return err
		}
		return poolEvent(ctx, tx, record.attempt.PoolId)
	})
	return result, err
}

func (s *Scheduler) Heartbeat(ctx context.Context, req *pb.HeartbeatRequest) (*pb.HeartbeatResponse, error) {
	if len(req.ActiveLeaseIds) > 1024 {
		return nil, status.Error(codes.InvalidArgument, "too many active lease IDs")
	}
	result := new(pb.HeartbeatResponse)
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		now := time.Now()
		current, err := s.currentSession(ctx, tx, req.SessionId, now)
		if err != nil {
			return err
		}
		worker := current.worker
		if req.Draining && len(req.ActiveLeaseIds) == 0 {
			if _, err := tx.ExecContext(ctx, "UPDATE workers SET deadline = 0 WHERE session = ?", req.SessionId); err != nil {
				return err
			}
			return expire(ctx, tx, now)
		}
		drainStarted := req.Draining && worker.State == pb.WorkerState_WORKER_STATE_ONLINE
		if drainStarted {
			worker.State = pb.WorkerState_WORKER_STATE_DRAINING
		}
		worker.LastSeenAt = timestamppb.New(now)
		deadline := now.Add(leaseDuration)
		if err := save(ctx, tx, worker, "UPDATE workers SET data=?, deadline=? WHERE session=?", deadline.UnixNano(), req.SessionId); err != nil {
			return err
		}
		for _, id := range req.ActiveLeaseIds {
			directive := &pb.LeaseDirective{LeaseId: id}
			record, err := leaseForSession(ctx, tx, id, req.SessionId)
			switch {
			case status.Code(err) == codes.NotFound:
				directive.Directive = &pb.LeaseDirective_Revoke{Revoke: pb.LeaseRevocationReason_LEASE_REVOCATION_REASON_SUPERSEDED}
			case err != nil:
				return err
			case record.attempt.State == pb.AttemptState_ATTEMPT_STATE_CANCELLED:
				directive.Directive = &pb.LeaseDirective_Revoke{Revoke: pb.LeaseRevocationReason_LEASE_REVOCATION_REASON_CANCELLED}
			case record.completion != nil:
				// A completion response can be lost. Keep the pending result
				// on the worker so it can retry the original request.
				directive.Directive = &pb.LeaseDirective_RenewedUntil{RenewedUntil: timestamppb.New(deadline)}
			case record.attempt.State != executing || record.deadline <= now.UnixNano():
				directive.Directive = &pb.LeaseDirective_Revoke{Revoke: pb.LeaseRevocationReason_LEASE_REVOCATION_REASON_EXPIRED}
			default:
				if _, err := tx.ExecContext(ctx, "UPDATE leases SET deadline=? WHERE id=?", deadline.UnixNano(), id); err != nil {
					return err
				}
				directive.Directive = &pb.LeaseDirective_RenewedUntil{RenewedUntil: timestamppb.New(deadline)}
			}
			result.Leases = append(result.Leases, directive)
		}
		if drainStarted {
			if err := workerEvent(ctx, tx, worker); err != nil {
				return err
			}
			return poolEvent(ctx, tx, worker.PoolId)
		}
		return nil
	})
	return result, err
}

func (s *Scheduler) CompleteLease(ctx context.Context, req *pb.CompleteLeaseRequest) (*pb.CompleteLeaseResponse, error) {
	result, failure := req.GetResult(), req.GetWorkerFailure()
	if (result == nil && failure == nil) || (failure != nil && failure.Kind == 0) {
		return nil, status.Error(codes.InvalidArgument, "a valid execution outcome is required")
	}
	if result != nil && (result.ExecutionStatus == nil || (result.ExecutionStatus.Code == 0 && result.ActionResult == nil)) {
		return nil, status.Error(codes.InvalidArgument, "execution status and successful action result are required")
	}
	completion, err := proto.MarshalOptions{Deterministic: true}.Marshal(req)
	if err != nil {
		return nil, err
	}
	fingerprint := sha256.Sum256(completion)
	err = s.transaction(ctx, func(tx *sql.Tx) error {
		now := time.Now()
		if _, err := s.currentSession(ctx, tx, req.SessionId, now); err != nil {
			return err
		}
		record, err := leaseForSession(ctx, tx, req.LeaseId, req.SessionId)
		if err != nil {
			return err
		}
		if bytes.Equal(record.completion, fingerprint[:]) {
			return nil
		}
		if record.attempt.State != executing || record.deadline <= now.UnixNano() {
			return status.Error(codes.FailedPrecondition, "lease is no longer current")
		}
		op, err := readOperation(ctx, tx, record.attempt.OperationName)
		if err != nil {
			return err
		}
		record.completion = fingerprint[:]
		if result == nil {
			return endAttempt(ctx, tx, record, op, now, pb.AttemptState_ATTEMPT_STATE_FAILED)
		}
		response := &re.ExecuteResponse{Result: result.ActionResult, Status: result.ExecutionStatus}
		cacheCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if result.ActionResult != nil {
			if err := s.checkResultBlobs(cacheCtx, op.instance, result.ActionResult); err != nil {
				return err
			}
		}
		if op.cacheable && result.ExecutionStatus.Code == 0 && result.ActionResult.GetExitCode() == 0 {
			if _, err := s.Backend.UpdateActionResult(cacheCtx, &re.UpdateActionResultRequest{
				InstanceName: op.instance, ActionDigest: op.summary.ActionDigest,
				DigestFunction: op.summary.DigestFunction, ActionResult: result.ActionResult,
			}); err != nil {
				return err
			}
		}
		record.attempt.State = pb.AttemptState_ATTEMPT_STATE_COMPLETED
		record.attempt.FinishedAt = timestamppb.New(now)
		setOutcome(op, response, now)
		record.attempt.ExecutionCode = op.summary.ExecutionCode
		record.attempt.ExitCode = op.summary.ExitCode
		if err := updateLease(ctx, tx, record); err != nil {
			return err
		}
		if err := updateOperation(ctx, tx, op, record.attempt.WorkerId); err != nil {
			return err
		}
		if err := refreshWorker(ctx, tx, record.session); err != nil {
			return err
		}
		return poolEvent(ctx, tx, record.attempt.PoolId)
	})
	return &pb.CompleteLeaseResponse{}, err
}

func updateLease(ctx context.Context, tx *sql.Tx, record *lease) error {
	if err := save(ctx, tx, record.attempt, "UPDATE leases SET data=?, state=?, deadline=?, completion=? WHERE id=?",
		record.attempt.State, record.deadline, record.completion, record.id); err != nil {
		return err
	}
	return attemptEvent(ctx, tx, record.attempt)
}

func refreshWorker(ctx context.Context, tx *sql.Tx, sessionID string) error {
	current, err := readSession(ctx, tx, "session = ?", sessionID)
	if status.Code(err) == codes.NotFound {
		return nil
	}
	if err != nil {
		return err
	}
	var occupied uint32
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM leases WHERE session=? AND state IN (?, ?)",
		sessionID, offered, executing).Scan(&occupied); err != nil {
		return err
	}
	if current.worker.OccupiedSlots == occupied {
		return nil
	}
	current.worker.OccupiedSlots = occupied
	if err := save(ctx, tx, current.worker, "UPDATE workers SET data=? WHERE session=?", sessionID); err != nil {
		return err
	}
	return workerEvent(ctx, tx, current.worker)
}

func endAttempt(ctx context.Context, tx *sql.Tx, record *lease, op *operationRecord, now time.Time, state pb.AttemptState) error {
	record.attempt.State = state
	record.attempt.FinishedAt = timestamppb.New(now)
	if err := updateLease(ctx, tx, record); err != nil {
		return err
	}
	if op.summary.AttemptCount >= maxAttempts {
		setOutcome(op, &re.ExecuteResponse{Status: &rpcstatus.Status{Code: int32(codes.Unavailable), Message: "worker attempts exhausted"}}, now)
	} else {
		op.summary.State = queued
		op.summary.WorkerId = ""
		op.summary.StartedAt = nil
	}
	if err := updateOperation(ctx, tx, op, record.attempt.WorkerId); err != nil {
		return err
	}
	if err := refreshWorker(ctx, tx, record.session); err != nil {
		return err
	}
	return poolEvent(ctx, tx, record.attempt.PoolId)
}

func (s *Scheduler) Sweep(ctx context.Context) error {
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		if err := expire(ctx, tx, time.Now()); err != nil {
			return err
		}
		latest, err := activitySequence(ctx, tx)
		if err != nil || latest <= activityRetention {
			return err
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM activity WHERE sequence <= ?", latest-activityRetention)
		return err
	})
	if ctx.Err() == nil {
		last := s.sweep.Load()
		sample := &sweepStatus{at: time.Now(), failed: err != nil}
		if last != nil {
			sample.lastSuccess, sample.lastFailure = last.lastSuccess, last.lastFailure
		}
		if err == nil {
			sample.lastSuccess = sample.at
		} else {
			sample.lastFailure = sample.at
		}
		s.sweep.Store(sample)
	}
	return err
}

func expire(ctx context.Context, tx *sql.Tx, now time.Time) error {
	rows, err := tx.QueryContext(ctx, leaseFields+` WHERE state IN (?, ?) AND (deadline <= ? OR
		session IN (SELECT session FROM workers WHERE deadline <= ?))`, offered, executing, now.UnixNano(), now.UnixNano())
	if err != nil {
		return err
	}
	var expired []*lease
	for rows.Next() {
		record, err := scanLease(rows)
		if err != nil {
			rows.Close()
			return err
		}
		expired = append(expired, record)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, record := range expired {
		op, err := readOperation(ctx, tx, record.attempt.OperationName)
		if err != nil {
			return err
		}
		if err := endAttempt(ctx, tx, record, op, now, pb.AttemptState_ATTEMPT_STATE_LOST); err != nil {
			return err
		}
	}
	rows, err = tx.QueryContext(ctx, "SELECT data FROM workers WHERE deadline <= ? AND deadline != -1", now.UnixNano())
	if err != nil {
		return err
	}
	var offline []*pb.Worker
	for rows.Next() {
		worker := new(pb.Worker)
		if err := decode(rows, worker); err != nil {
			rows.Close()
			return err
		}
		offline = append(offline, worker)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, worker := range offline {
		worker.State = pb.WorkerState_WORKER_STATE_OFFLINE
		worker.OccupiedSlots = 0
		if err := save(ctx, tx, worker, "UPDATE workers SET data=?, deadline=-1 WHERE id=?", worker.WorkerId); err != nil {
			return err
		}
		if err := workerEvent(ctx, tx, worker); err != nil {
			return err
		}
		if err := poolEvent(ctx, tx, worker.PoolId); err != nil {
			return err
		}
	}
	return nil
}
