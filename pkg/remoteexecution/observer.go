package remoteexecution

import (
	"context"
	"database/sql"
	"encoding/base64"
	"strings"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func getPool(ctx context.Context, db queryer, id string) (*pb.Pool, error) {
	pool := new(pb.Pool)
	if err := decode(db.QueryRowContext(ctx, "SELECT data FROM pools WHERE id = ?", id), pool); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, "SELECT data FROM workers WHERE pool = ?", id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		worker := new(pb.Worker)
		if err := decode(rows, worker); err != nil {
			rows.Close()
			return nil, err
		}
		if worker.State != pb.WorkerState_WORKER_STATE_OFFLINE {
			pool.OnlineWorkers++
			pool.TotalSlots += worker.TotalSlots
			pool.OccupiedSlots += worker.OccupiedSlots
		}
		if worker.State == pb.WorkerState_WORKER_STATE_DRAINING {
			pool.DrainingWorkers++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	op := pb.OperationState_OPERATION_STATE_QUEUED
	var oldest sql.NullInt64
	err = db.QueryRowContext(ctx, `SELECT COUNT(*) FILTER (WHERE state = ?),
		COUNT(*) FILTER (WHERE state = ?), COUNT(*) FILTER (WHERE state = ?),
		MIN(enqueued) FILTER (WHERE state = ?) FROM operations WHERE pool = ?`,
		op, pb.OperationState_OPERATION_STATE_RUNNING, pb.OperationState_OPERATION_STATE_LEASED,
		op, id).Scan(&pool.QueuedOperations, &pool.RunningOperations, &pool.LeasedOperations, &oldest)
	if oldest.Valid {
		pool.OldestQueuedAt = timestamp(oldest.Int64)
	}
	return pool, err
}

func typedPage[T proto.Message](ctx context.Context, db queryer, scope, token string, size int32, makeMessage func() T, query string, args ...any) ([]T, string, error) {
	if size < 0 {
		return nil, "", status.Error(codes.InvalidArgument, "negative page size")
	}
	if size == 0 {
		size = 50
	}
	size = min(size, 200)
	key := ""
	if token != "" {
		data, err := base64.RawURLEncoding.DecodeString(token)
		prefix, decoded, ok := strings.Cut(string(data), "\x00")
		if err != nil || !ok || prefix != scope || decoded == "" || len(decoded) > 512 {
			return nil, "", status.Error(codes.InvalidArgument, "invalid page token")
		}
		key = decoded
	}
	rows, err := db.QueryContext(ctx, query, append(args, key, size+1)...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var items []T
	var last string
	for rows.Next() {
		if int32(len(items)) == size {
			return items, base64.RawURLEncoding.EncodeToString([]byte(scope + "\x00" + last)), nil
		}
		var data []byte
		if err := rows.Scan(&last, &data); err != nil {
			return nil, "", err
		}
		item := makeMessage()
		if err := proto.Unmarshal(data, item); err != nil {
			return nil, "", err
		}
		items = append(items, item)
	}
	return items, "", rows.Err()
}

func (s *Scheduler) ListPools(ctx context.Context, req *pb.ListPoolsRequest) (*pb.ListPoolsResponse, error) {
	result := new(pb.ListPoolsResponse)
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		list, token, err := typedPage(ctx, tx, "pools", req.PageToken, req.PageSize, func() *pb.Pool { return new(pb.Pool) },
			"SELECT id, data FROM pools WHERE id > ? ORDER BY id LIMIT ?")
		if err != nil {
			return err
		}
		result.NextPageToken = token
		for _, config := range list {
			pool, err := getPool(ctx, tx, config.PoolId)
			if err != nil {
				return err
			}
			result.Pools = append(result.Pools, pool)
		}
		return nil
	})
	return result, err
}

func activitySequence(ctx context.Context, db queryer) (uint64, error) {
	var sequence uint64
	err := db.QueryRowContext(ctx, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'activity'), 0)").Scan(&sequence)
	return sequence, err
}

func (s *Scheduler) GetPool(ctx context.Context, req *pb.GetPoolRequest) (*pb.GetPoolResponse, error) {
	result := new(pb.GetPoolResponse)
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		var err error
		result.Pool, err = getPool(ctx, tx, req.PoolId)
		if err != nil {
			return err
		}
		result.ActivitySequence, err = activitySequence(ctx, tx)
		return err
	})
	return result, err
}

func (s *Scheduler) ListWorkers(ctx context.Context, req *pb.ListWorkersRequest) (*pb.ListWorkersResponse, error) {
	items, token, err := typedPage(ctx, s.db, "workers/"+req.PoolId, req.PageToken, req.PageSize, func() *pb.Worker { return new(pb.Worker) },
		"SELECT id, data FROM workers WHERE pool = ? AND id > ? ORDER BY id LIMIT ?", req.PoolId)
	return &pb.ListWorkersResponse{Workers: items, NextPageToken: token}, err
}

func (s *Scheduler) GetWorker(ctx context.Context, req *pb.GetWorkerRequest) (*pb.GetWorkerResponse, error) {
	result := &pb.GetWorkerResponse{Worker: new(pb.Worker)}
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		if err := decode(tx.QueryRowContext(ctx, "SELECT data FROM workers WHERE pool = ? AND id = ?", req.PoolId, req.WorkerId), result.Worker); err != nil {
			return err
		}
		var err error
		result.ActivitySequence, err = activitySequence(ctx, tx)
		return err
	})
	return result, err
}

func (s *Scheduler) ListOperations(ctx context.Context, req *pb.ListOperationsRequest) (*pb.ListOperationsResponse, error) {
	items, token, err := typedPage(ctx, s.db, "operations/"+req.PoolId+"/"+req.State.String(), req.PageToken, req.PageSize,
		func() *pb.ExecutionOperation { return new(pb.ExecutionOperation) },
		`SELECT key, data FROM (SELECT printf('%020d:%s', 9223372036854775807-enqueued, name) AS key, data
		  FROM operations WHERE pool = ? AND (? = 0 OR state = ?)) WHERE key > ? ORDER BY key LIMIT ?`,
		req.PoolId, req.State, req.State)
	return &pb.ListOperationsResponse{Operations: items, NextPageToken: token}, err
}

func (s *Scheduler) operationDetail(ctx context.Context, pool, id string) (*pb.ExecutionOperationDetail, error) {
	var op *operationRecord
	result := new(pb.ExecutionOperationDetail)
	err := s.transaction(ctx, func(tx *sql.Tx) error {
		var err error
		op, err = readOperation(ctx, tx, "operations/"+id)
		if err != nil {
			return err
		}
		if op.summary.GetPoolId() != pool {
			return status.Error(codes.NotFound, "execution operation not found in this pool")
		}
		rows, err := tx.QueryContext(ctx, "SELECT data FROM leases WHERE operation = ? ORDER BY attempt", op.summary.GetOperationName())
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			attempt := new(pb.ExecutionAttempt)
			if err := decode(rows, attempt); err != nil {
				return err
			}
			result.Attempts = append(result.Attempts, attempt)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	result.Operation = op.summary
	result.InstanceName = op.instance
	result.TimeoutMillis = op.timeout.Milliseconds()
	result.Cacheable = op.cacheable
	if actionResult := op.response.GetResult(); actionResult != nil {
		result.ExecutionMetadata = actionResult.GetExecutionMetadata()
		if result.ExecutionMetadata != nil {
			result.ExecutionMetadata.AuxiliaryMetadata = nil
		}
		result.StdoutDigest = actionResult.GetStdoutDigest()
		result.StderrDigest = actionResult.GetStderrDigest()
		result.StdoutBytes = max(int64(len(actionResult.GetStdoutRaw())), result.StdoutDigest.GetSizeBytes())
		result.StderrBytes = max(int64(len(actionResult.GetStderrRaw())), result.StderrDigest.GetSizeBytes())
	}

	// The summary and attempts remain readable when CAS evicts the action or command.
	var action re.Action
	var command re.Command
	if s.readCAS(ctx, op.instance, op.summary.GetActionDigest(), &action) == nil &&
		s.readCAS(ctx, op.instance, action.GetCommandDigest(), &command) == nil {
		outputs := command.GetOutputPaths()
		if len(outputs) == 0 {
			outputs = append(command.GetOutputFiles(), command.GetOutputDirectories()...)
		}
		result.Process = &pb.ExecutionProcess{
			Arguments: command.GetArguments(), WorkingDirectory: command.GetWorkingDirectory(), OutputPaths: outputs,
		}
	}
	return result, nil
}

func (s *Scheduler) ListWorkerAttempts(ctx context.Context, req *pb.ListWorkerAttemptsRequest) (*pb.ListWorkerAttemptsResponse, error) {
	items, token, err := typedPage(ctx, s.db, "attempts/"+req.PoolId+"/"+req.WorkerId, req.PageToken, req.PageSize,
		func() *pb.ExecutionAttempt { return new(pb.ExecutionAttempt) },
		`SELECT key, data FROM (SELECT printf('%020d', 9223372036854775807-l.rowid) AS key, l.data AS data
		  FROM leases l JOIN operations o ON l.operation = o.name WHERE o.pool = ? AND l.worker = ?)
		  WHERE key > ? ORDER BY key LIMIT ?`, req.PoolId, req.WorkerId)
	return &pb.ListWorkerAttemptsResponse{Attempts: items, NextPageToken: token}, err
}

func (s *Scheduler) WatchActivity(req *pb.WatchActivityRequest, stream pb.ExecutionObserverService_WatchActivityServer) error {
	return s.watchActivity(stream.Context(), req, stream.Send)
}

func (s *Scheduler) watchActivity(ctx context.Context, req *pb.WatchActivityRequest, send func(*pb.ActivityEvent) error) error {
	if !validID.MatchString(req.PoolId) || (req.WorkerId != "" && !validID.MatchString(req.WorkerId)) {
		return status.Error(codes.InvalidArgument, "invalid pool or worker ID")
	}
	latest, err := activitySequence(ctx, s.db)
	if err != nil {
		return err
	}
	var oldest uint64
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MIN(sequence), 0) FROM activity").Scan(&oldest); err != nil {
		return err
	}
	if req.AfterSequence > latest || (oldest > 0 && req.AfterSequence < oldest-1) {
		return status.Error(codes.OutOfRange, "refresh the execution snapshot")
	}
	cursor := req.AfterSequence
	for {
		events, err := readEvents(ctx, s.db, req.PoolId, req.WorkerId, cursor)
		if err != nil {
			return err
		}
		for _, record := range events {
			if err := send(record); err != nil {
				return err
			}
			cursor = record.Sequence
		}
		if len(events) == 0 {
			if err := pause(ctx, pollInterval); err != nil {
				return err
			}
		}
	}
}

const activityBatchSize = 128

func readEvents(ctx context.Context, db queryer, pool, worker string, after uint64) ([]*pb.ActivityEvent, error) {
	query := "SELECT sequence, data FROM activity WHERE pool = ? AND sequence > ?"
	args := []any{pool, after}
	if worker != "" {
		query += " AND worker = ?"
		args = append(args, worker)
	}
	rows, err := db.QueryContext(ctx, query+" ORDER BY sequence LIMIT ?", append(args, activityBatchSize)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []*pb.ActivityEvent
	for rows.Next() {
		var sequence uint64
		var data []byte
		if err := rows.Scan(&sequence, &data); err != nil {
			return nil, err
		}
		record := new(pb.ActivityEvent)
		if err := proto.Unmarshal(data, record); err != nil {
			return nil, err
		}
		record.Sequence = sequence
		result = append(result, record)
	}
	return result, rows.Err()
}
