# Build event viewer POC

Start the backend from the repository root.

```sh
go run ./cmd/besserver \
  --listen=localhost:1973 \
  --http_listen=localhost:1974 \
  --frontend_origin=http://localhost:8080 \
  --sqlite=invocations.sqlite
```

Serve the Closure frontend with the existing release server.

```sh
bazel run //app/bcr:release --//app/bcr:release_type=dummy
```

Open `http://localhost:8080/tools/invocation`. Set the backend URL to
`http://localhost:1974`. Use **Refresh saved runs**, select an invocation, and
click **Replay and follow**. The timeline replays recorded events and continues
to receive live events. Its event selector and filters also work for saved runs.

Publish a build to the backend.

```sh
bazel build //cmd/besserver \
  --bes_backend=grpc://localhost:1973 \
  --bes_upload_mode=wait_for_upload_complete
```

To connect before a build starts, generate a UUID, enter it in the viewer's
Invocation ID field, click **Replay and follow**, then pass that same UUID to
Bazel using `--invocation_id=<uuid>`.

The local file viewer remains available for binary files produced by
`--build_event_binary_file=<path>`.

## APIs and storage

The BES gRPC port also serves `InvocationService` with `ListInvocations`,
`GetInvocation`, and `WatchInvocation`. Watch requests replay events after
`after_cursor`, then follow new events until cancellation. The cursor identifies
a position in the selected backend. BES sequence numbers belong to individual
component streams.

The browser uses these HTTP endpoints.

- `GET /api/invocations` returns protobuf JSON invocation summaries.
- `GET /api/invocations/{id}` returns one protobuf JSON summary.
- `GET /api/invocations/{id}/events` returns an SSE subscription.

SSE `bep` events contain base64-encoded binary Bazel BuildEvent messages, decoded
by the existing generated Closure protobuf class. SSE `update` events advance
the cursor for transport and lifecycle events. The browser automatically resumes
using `Last-Event-ID`. A new connection can supply `?after=<cursor>`. Starting
at zero replays the stored arrival order. Replay and live events use
the same append lock and cursor, so subscribers cannot miss the transition.

### Storage design

BuildBuddy uses an invocation database for metadata and writes chunked protobuf
events to blob storage. Its target tracker persists test statuses, and its
analytics path can flush completed invocation statistics to ClickHouse.
[BuildBuddy event handler](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/server/build_event_protocol/build_event_handler/build_event_handler.go)
[BuildBuddy target tracker](https://raw.githubusercontent.com/buildbuddy-io/buildbuddy/master/server/build_event_protocol/target_tracker/target_tracker.go)

NativeLink puts versioned BES request protobufs in a configurable store under keys
derived from event kind, build ID, invocation ID, and sequence. It acknowledges
after persistence. Its v1.7.6 release pipelines these writes while preserving
acknowledgement order.
[NativeLink BES server](https://raw.githubusercontent.com/TraceMachina/nativelink/main/nativelink-service/src/bep_server.rs)
[NativeLink v1.7.6](https://github.com/TraceMachina/nativelink/releases/tag/v1.7.6)

The [Storage interface](../../pkg/invocation/storage.go) provides five operations.

- `Append` commits the event and its projections before acknowledging ingestion.
  The identity is the request kind, invocation ID, build ID, component, and
  sequence number. Identical retries are no-ops and conflicting retries fail.
- `Get` and `List` read invocation summaries independently of event replay.
- `Replay` reads a bounded page for one invocation, ordered by arrival cursor.
  The service coordinates live wakeups with committed appends.
- `Close` releases the backend.

SQLite is the default at `invocations.sqlite`. It uses WAL mode with full
synchronous commits and one BES service per database. Indexed point lookups and
replay require no startup scan. Existing journals can be reopened with
`--journal=invocations.journal`. Each backend has its own cursor history.

### Local analytics

`invocations` holds repository, branch, commit, command, state, exit code, and
duration. `test_attempts` preserves configuration, run, shard, retry number,
status, cache flags, and duration. `test_summaries` holds Bazel's overall status
per label and configuration. `build_metrics` includes CPU and wall time,
analysis and execution time, actions executed, and Bazel's critical-path
duration when supplied. Each fact points back to the source event cursor.

Open the database read-only for ad hoc queries.

```sh
sqlite3 -readonly invocations.sqlite
```

```sql
SELECT date(created_us / 1000000, 'unixepoch') AS day,
       count(*) AS finished_builds, avg(duration_ms) AS mean_duration_ms
FROM invocations
WHERE repo = :repo AND duration_ms IS NOT NULL
GROUP BY day ORDER BY day;

SELECT t.label, t.configuration,
       count(DISTINCT t.invocation_id) AS flaky_invocations
FROM test_summaries t JOIN invocations i ON i.id = t.invocation_id
WHERE i.repo = :repo AND t.status = 2
GROUP BY t.label, t.configuration
ORDER BY flaky_invocations DESC;

SELECT i.id, i.commit_sha, m.wall_ms, m.analysis_ms, m.execution_ms,
       m.critical_path_ms, m.actions_executed
FROM invocations i JOIN build_metrics m ON m.invocation_id = i.id
WHERE i.repo = :repo AND i.created_us >= :since_us
ORDER BY i.created_us DESC;
```

The flake query counts Bazel's explicit `FLAKY` status. The attempts table also
supports analysis of failures followed by passes within the same invocation,
configuration, run, and shard. A profile or dependency graph is required for
action-by-action critical-path analysis. Raw BEP replay preserves any profile
references published in `BuildToolLogs`, and the viewer currently leaves
profile retrieval and parsing to clients.

For a later hosted backend, keep the same ingest and replay contract and add a
separate typed analytics reader when callers need it. Candidate queries are
invocation trends by repository and time window, test history by repository and
label, and build metrics by invocation. The raw stream provides the input for
backfilling new projections.

## Current limits

This is a loopback POC with an explicit allowed frontend origin. Authentication
and tenant filtering are pending. Raw event payloads are retained, including
their client-supplied metadata. Summaries populate command, tool version,
workspace, timestamps, result, user, host, and selected source-control metadata.

The legacy journal reconstructs its in-memory event index at startup. Retention,
invocation-list pagination, journal-to-SQLite migration, and timed finalization
of interrupted uploads are pending. Completion means all observed
tool streams have terminal markers and contiguous sequence numbers. Stored runs
remain available across restarts when the same database or journal is used.

The browser coalesces timeline redraws in 250 ms batches and preserves the event
filters and selection as events arrive. Disconnect displays any pending events
before freezing the timeline for inspection.

### Instrumented remote cache

Use the same process for BES, the invocation API, and the cache frontend so the
API can read both Bazel's remote hit count and the observed cache traffic.

```sh
bazel run //cmd/besserver -- \
  --sqlite=invocations.sqlite \
  --cache_listen=localhost:1975 \
  --cache_dir=./remote-cache
```

To proxy an existing Bazel gRPC cache, replace `--cache_dir` with
`--cache_upstream=grpcs://cache.example.com:443`. The proxy forwards Bazel's
request metadata, instance namespace, and custom headers to the configured
upstream. Use the plaintext frontend on a trusted listener. The existing BES
service and cache frontend share a local trust boundary.

Point Bazel at both listeners.

```sh
bazel build //path:target \
  --bes_backend=grpc://localhost:1973 \
  --remote_cache=grpc://localhost:1975
```

The invocation detail API returns `bazelRemoteCacheHits` when BEP reports a
runner breakdown and `remoteCache` when the proxy observes requests carrying
the matching REAPI tool invocation ID. SQLite retains both across restarts.
The cache counts observed RPC attempts, including client retries. Use
`ac_lookup` hits and misses for the lookup hit rate. CAS presence and download
counts are independent. Transfer sizes are observed cache blob payload bytes.

The file backend uses separate AC and CAS namespaces per instance, validates
SHA-256 uploads, and publishes completed writes atomically. It supports
uncompressed transfers and discards interrupted uploads so clients can retry
from offset zero. Manage the cache directory's capacity externally.
