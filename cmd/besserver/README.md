# Build event viewer POC

For a persistent deployment, see [installing the backend and Iroh companion as systemd user services](../../tools/invocation-iroh/README.md#install-as-systemd-user-services).

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

Open Build Events at `http://localhost:8080/tools/invocations`. Set the backend
URL to `http://localhost:1974`, click **Connect**, and select an invocation
from **Runs**. The timeline replays recorded events and continues to receive
live events. Select a mark in **Build frontier** to inspect an event.

The viewer opens a run at `/tools/invocation/<id>`. Reloading replays that run
with the backend remembered in the current tab. A shared link can be opened
with a backend URL or Iroh ticket supplied by the reader.

Publish a build to the backend.

```sh
bazel build //cmd/besserver \
  --bes_backend=grpc://localhost:1973 \
  --bes_results_url=https://registry.bazel.build/tools/invocation/ \
  --bes_upload_mode=wait_for_upload_complete
```

To connect before a build starts, generate a UUID, open
`/tools/invocation/<uuid>`, and click **Connect**. Pass that same UUID to Bazel
using `--invocation_id=<uuid>`.

Drop a binary file produced by `--build_event_binary_file=<path>` into the
upload area or choose **Upload file**. Open it again from **Uploads** while
the page is open.

## Invocation Groups

Publish builds with a shared group name.

```sh
bazel build //cmd/besserver \
  --bes_backend=grpc://localhost:1973 \
  --bes_results_url=https://registry.bazel.build/tools/invocations/release/ \
  --build_metadata=igroup=release
```

Open `/tools/invocations/release` and connect to the backend. Leave the group
name blank to browse existing groups and individual runs. **Current** follows
the newest active invocation through completion when newer builds arrive. The sidebar link reads **Last**
when the displayed run has finished. The **Runs** table shows the outcome, ID,
command and targets, and recorded start or finish time. Select a row to replay
it. Open **Runs** again to resume auto-follow after selecting a run.
Bazel appends the invocation ID to the results URL. Use a trailing slash
and match the group in the URL to the group in `--build_metadata`. The
resulting `/tools/invocations/<group>/<id>` link opens that run directly.

Metrics and Tests share a rolling window based on when the server first
received each invocation. The viewer defaults to 30 days.

- **Metrics** shows invocation counts and outcomes, success rate, and
  average, median, and 95th-percentile duration for completed builds with timing.
  It also shows action cache hits, misses, errors, and hit rate across observed
  lookups. The rate is total hits divided by total hits plus misses.
  Bazel-reported remote cache hits are available as a separate count.
- **Tests** shows failed or timed-out results and groups Bazel's explicit
  `FLAKY` results by target. Each invocation contributes its latest summary
  per target and configuration. Detailed cache and test aggregates use SQLite.

The first valid `igroup` value sets membership. Group names are case sensitive
and use up to 128 ASCII letters, digits, dots, underscores, or hyphens, starting
with a letter or digit. Membership is an analytics label independent of
invocation ownership and visibility.

## APIs and storage

The BES gRPC port also serves `InvocationService` with `ListInvocationGroups`,
`GetInvocationGroupMetrics`, `ListInvocations`, `GetInvocation`, and `WatchInvocation`. Pass
`invocation_group` to `ListInvocations` to filter by group. Watch requests
replay events after `after_cursor`, then follow new events until cancellation.
The cursor identifies a position in the selected backend. BES sequence numbers
belong to individual component streams.

The browser uses these HTTP endpoints.

- `GET /api/invocations` returns protobuf JSON invocation summaries.
- `GET /api/invocation-groups` lists group names. Use `?group=release` on
  `GET /api/invocations` to list one group's builds.
- `GET /api/invocation-groups/{name}/metrics` returns group aggregates.
- `GET /api/invocations/{id}` returns one protobuf JSON summary.
- `GET /api/invocations/{id}/events` returns an SSE subscription.

SSE `bep` events contain base64-encoded binary Bazel BuildEvent messages, decoded
by the existing generated Closure protobuf class. SSE `update` events advance
the cursor for transport and lifecycle events. The browser automatically resumes
using `Last-Event-ID`. A new connection can supply `?after=<cursor>`. Starting
at zero replays the stored arrival order. Replay and live events use
the same append lock and cursor, so subscribers cannot miss the transition.

A `bep-time` event precedes each `bep` event. It carries the cursor, original
receipt time, and server send time in milliseconds since the Unix epoch. The
viewer uses the receipt time to preserve frontier waits across reloads.

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

The [Storage interface](../../pkg/invocation/storage.go) provides these operations.

- `Append` commits the event and its projections before acknowledging ingestion.
  The identity is the request kind, invocation ID, build ID, component, and
  sequence number. Identical retries are no-ops and conflicting retries fail.
- `Get` and `List` read invocation summaries independently of event replay.
- `ListByGroup` and `ListGroups` read group membership and names.
- `GroupMetrics` aggregates recorded data for one group.
- `Replay` reads a bounded page for one invocation, ordered by arrival cursor.
  The service coordinates live wakeups with committed appends.
- `Close` releases the backend.

SQLite is the default at `invocations.sqlite`. It uses WAL mode with full
synchronous commits and one BES service per database. Indexed point lookups and
replay require no startup scan. Existing journals can be reopened with
`--journal=invocations.journal`. Each backend has its own cursor history.

### Local analytics

`invocations` holds repository, branch, commit, command, state, exit code,
duration, and the group name referenced by `invocation_group`. Join group members
to facts through `invocation_id`. `test_attempts` preserves configuration, run,
shard, retry number, status, cache flags, and duration. `test_summaries` holds
Bazel's overall status per label and configuration. `build_metrics` includes CPU and wall time,
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

The legacy journal reconstructs its in-memory event index at startup.
Journal-to-SQLite migration and timed finalization of interrupted uploads
are pending. Completion means all observed
tool streams have terminal markers and contiguous sequence numbers. Stored runs
remain available across restarts when the same database or journal is used.

An invocation with an ended attempt and missing tool events is marked incomplete.
An abandoned publisher has five minutes to reconnect before its invocation is
marked incomplete. Configure the grace period with `--incomplete_after` such as
`--incomplete_after=10m`. A live publishing connection protects a quiet build.
Late events can still restore completeness when all terminal sequences arrive.

The invocation list returns 100 runs by default, newest first. Follow
the response's `nextPageToken` with `page_token` to request the next page, or
choose **Load older runs** in the viewer. The API accepts `page_size` up to
200 and `window_days` from 1 to 90 for group metrics.

### Archive old build events

Configure a dedicated private REAPI CAS instance with durable storage and eviction
disabled. This example uses the file-backed cache in the same process:

```sh
besserver --sqlite=invocations.sqlite \
  --cache_listen=127.0.0.1:1975 --cache_dir=/var/lib/bcr/archive-cache \
  --archive_cache=grpc://127.0.0.1:1975 --archive_instance=build-events \
  --archive_after=720h
```

To use a separate CAS server, set `--archive_cache` to its `grpc://` or
`grpcs://` address and omit the local cache listener and directory. Bazel can
continue using its normal build cache. Back up both SQLite and the archive
instance. Replay depends on the archived blobs after the local copy is cleared,
so keep the same cache instance or migrate the blobs before changing it.

The service archives completed invocations after their last event reaches the
configured age. It writes gzip-compressed chunks via ByteStream, reads them
back to verify the digest, and then clears the SQLite payloads in a transaction.
The database retains summaries, metrics, test facts, original cursors, and
event deduplication keys. Replay reads archived chunks transparently. SQLite
reuses the freed pages for future writes. To stop offloading new events while
keeping archived replay available, omit `--archive_after` and retain the
cache address and instance flags.

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
  --cache_dir=./remote-cache \
  --cache_max_bytes=10737418240
```

To proxy an existing Bazel gRPC cache, omit `--cache_max_bytes` and replace `--cache_dir` with
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
from offset zero.

Set `--cache_max_bytes` to bound stored files and in-flight uploads across both
namespaces and all instance names. File sizes are rounded up to the filesystem
block size. When an upload would exceed the budget, the cache removes the
least recently used entries until projected usage is at or below 90%, where
possible. Open downloads are pinned until they complete. Recency survives
restarts. An action result whose output blobs were evicted is a cache miss.
Use a dedicated directory for this cache. The default budget of zero leaves
eviction disabled. Keep build-event archives on a separate, non-evicting cache
directory and listener.
