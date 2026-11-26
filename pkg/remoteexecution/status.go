package remoteexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	pb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/remoteexecution/v1"
	re "github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2"
)

const (
	statusCheckTimeout = 2 * time.Second
	sweepStaleAfter    = 5 * time.Second
)

type sweepStatus struct {
	at          time.Time
	lastSuccess time.Time
	lastFailure time.Time
	failed      bool
}

type schedulerHealth struct {
	Ready            bool       `json:"ready"`
	DatabaseReady    bool       `json:"databaseReady"`
	CacheReady       bool       `json:"cacheReady"`
	LeaseSweep       string     `json:"leaseSweep"`
	StartedAt        time.Time  `json:"startedAt"`
	CheckedAt        time.Time  `json:"checkedAt"`
	LastSweepSuccess *time.Time `json:"lastSweepSuccess,omitempty"`
	LastSweepFailure *time.Time `json:"lastSweepFailure,omitempty"`
}

type schedulerWork struct {
	OnlineWorkers  uint64     `json:"onlineWorkers"`
	TotalSlots     uint64     `json:"totalSlots"`
	OccupiedSlots  uint64     `json:"occupiedSlots"`
	QueuedActions  uint64     `json:"queuedActions"`
	LeasedActions  uint64     `json:"leasedActions"`
	RunningActions uint64     `json:"runningActions"`
	OldestQueuedAt *time.Time `json:"oldestQueuedAt,omitempty"`
}

type schedulerPool struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	schedulerWork
}

type schedulerEvent struct {
	At       time.Time `json:"at"`
	PoolID   string    `json:"poolId"`
	WorkerID string    `json:"workerId"`
	Worker   string    `json:"worker,omitempty"`
	Action   string    `json:"action,omitempty"`
	Message  string    `json:"message"`
}

type schedulerStatus struct {
	schedulerHealth
	Work     *schedulerWork   `json:"work,omitempty"`
	Pools    []schedulerPool  `json:"pools,omitempty"`
	Activity []schedulerEvent `json:"activity,omitempty"`
}

func clockTime(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	value = value.UTC()
	return &value
}

func (s *Scheduler) checkStatus(ctx context.Context, detailed bool) schedulerStatus {
	var result schedulerStatus
	dbCtx, cancel := context.WithTimeout(ctx, statusCheckTimeout)
	var instance string
	err := s.transaction(dbCtx, func(tx *sql.Tx) error {
		pools, err := listPoolSettings(dbCtx, tx)
		if err != nil {
			return err
		}
		if len(pools) > 0 {
			instance = pools[0].Instance
		}
		if detailed {
			return result.readWork(dbCtx, tx, pools)
		}
		return nil
	})
	cancel()
	result.DatabaseReady = err == nil
	cacheCtx, cancel := context.WithTimeout(ctx, statusCheckTimeout)
	result.CacheReady = s.checkCache(cacheCtx, instance)
	cancel()
	result.StartedAt = s.startedAt.UTC()
	result.CheckedAt = time.Now().UTC()
	result.LeaseSweep = "pending"
	if sweep := s.sweep.Load(); sweep != nil {
		switch {
		case sweep.failed:
			result.LeaseSweep = "failed"
		case result.CheckedAt.Sub(sweep.at) > sweepStaleAfter:
			result.LeaseSweep = "stale"
		default:
			result.LeaseSweep = "ok"
		}
		result.LastSweepSuccess = clockTime(sweep.lastSuccess)
		result.LastSweepFailure = clockTime(sweep.lastFailure)
	}
	result.Ready = result.DatabaseReady && result.CacheReady && result.LeaseSweep == "ok"
	return result
}

func (s *Scheduler) checkCache(ctx context.Context, instance string) bool {
	if cache, ok := s.Backend.(interface{ CheckReady(context.Context) error }); ok {
		return cache.CheckReady(ctx) == nil
	}
	if s.Backend == nil {
		return false
	}
	capabilities, err := s.Backend.GetCapabilities(ctx, &re.GetCapabilitiesRequest{InstanceName: instance})
	return err == nil && capabilities.GetCacheCapabilities() != nil
}

func (result *schedulerStatus) readWork(ctx context.Context, tx *sql.Tx, settings []PoolConfig) error {
	var total schedulerWork
	var pools []schedulerPool
	for _, settings := range settings {
		pool, err := readPoolWork(ctx, tx, settings.ID)
		if err != nil {
			return err
		}
		total.add(pool.schedulerWork)
		pools = append(pools, pool)
	}
	events, err := recentSchedulerActivity(ctx, tx)
	if err != nil {
		return err
	}
	result.Work, result.Pools, result.Activity = &total, pools, events
	return nil
}

func readPoolWork(ctx context.Context, tx *sql.Tx, id string) (schedulerPool, error) {
	pool, err := getPool(ctx, tx, id)
	if err != nil {
		return schedulerPool{}, err
	}
	work := schedulerWork{
		OnlineWorkers: uint64(pool.OnlineWorkers), TotalSlots: uint64(pool.TotalSlots),
		OccupiedSlots: uint64(pool.OccupiedSlots), QueuedActions: pool.QueuedOperations,
		LeasedActions: pool.LeasedOperations, RunningActions: pool.RunningOperations,
	}
	if pool.OldestQueuedAt != nil {
		work.OldestQueuedAt = clockTime(pool.OldestQueuedAt.AsTime())
	}
	return schedulerPool{ID: pool.PoolId, Name: pool.DisplayName, schedulerWork: work}, nil
}

func (total *schedulerWork) add(work schedulerWork) {
	if work.OldestQueuedAt != nil && (total.OldestQueuedAt == nil || work.OldestQueuedAt.Before(*total.OldestQueuedAt)) {
		total.OldestQueuedAt = work.OldestQueuedAt
	}
	total.OnlineWorkers += work.OnlineWorkers
	total.TotalSlots += work.TotalSlots
	total.OccupiedSlots += work.OccupiedSlots
	total.QueuedActions += work.QueuedActions
	total.LeasedActions += work.LeasedActions
	total.RunningActions += work.RunningActions
}

func recentSchedulerActivity(ctx context.Context, tx *sql.Tx) ([]schedulerEvent, error) {
	rows, err := tx.QueryContext(ctx, "SELECT data FROM activity ORDER BY sequence DESC LIMIT 500")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []schedulerEvent
	for len(events) < 25 && rows.Next() {
		record := new(pb.ActivityEvent)
		if err := decode(rows, record); err != nil {
			return nil, err
		}
		event := schedulerEvent{At: record.ObservedAt.AsTime(), PoolID: record.PoolId, WorkerID: record.WorkerId}
		if worker := record.GetWorker(); worker != nil {
			event.Worker = worker.DisplayName
			switch worker.State {
			case pb.WorkerState_WORKER_STATE_ONLINE:
				event.Message = "Worker registered"
			case pb.WorkerState_WORKER_STATE_DRAINING:
				event.Message = "Worker draining"
			case pb.WorkerState_WORKER_STATE_OFFLINE:
				event.Message = "Worker went offline"
			}
		}
		if attempt := record.GetAttempt(); attempt != nil {
			event.Action = attempt.OperationName
			switch {
			case attempt.State == pb.AttemptState_ATTEMPT_STATE_LOST:
				event.Message = "Lease lost"
			case attempt.State == pb.AttemptState_ATTEMPT_STATE_FAILED:
				event.Message = "Attempt failed"
			case attempt.State == pb.AttemptState_ATTEMPT_STATE_LEASED && attempt.AttemptNumber > 1:
				event.Message = "Retry leased"
			}
		}
		if event.Message != "" {
			events = append(events, event)
		}
	}
	return events, rows.Err()
}

func (s *Scheduler) serveStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.checkStatus(r.Context(), true))
}

func (s *Scheduler) serveReadiness(w http.ResponseWriter, r *http.Request) {
	if !s.checkStatus(r.Context(), false).Ready {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
