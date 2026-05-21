"""Pre-render SPA routes using hermetic chrome-headless-shell from rules_browsers.

`prerender_home` captures a single URL (the home page) into one HTML file.
`prerender_pages` captures every URL listed in a text file (one path per line,
e.g. `/modules/rules_buf`) and emits a tar containing entries at
`modules/<name>/index.html` so the release pipeline can drop them into the
final release archive verbatim.

Both rules boot `releaseserver` on a free port and drive
chrome-headless-shell via `statichtmlcompiler`. The browser binary, server,
and compiler tool defaults are baked in as private attrs; callers usually
just need to supply `tarball` and (for prerender_pages) `url_list`.
"""

load("@rules_browsers//browsers:named_files_info.bzl", "NamedFilesInfo")

_DEFAULT_CHROMIUM = "@rules_browsers//browsers/chromium:chromium"
_DEFAULT_RELEASESERVER = "//cmd/releaseserver"
_DEFAULT_STATICHTMLCOMPILER = "//cmd/statichtmlcompiler"

_TOOL_ATTRS = {
    "_chromium": attr.label(
        default = _DEFAULT_CHROMIUM,
        providers = [NamedFilesInfo, DefaultInfo],
        cfg = "exec",
    ),
    "_releaseserver": attr.label(
        default = _DEFAULT_RELEASESERVER,
        executable = True,
        cfg = "exec",
    ),
    "_statichtmlcompiler": attr.label(
        default = _DEFAULT_STATICHTMLCOMPILER,
        executable = True,
        cfg = "exec",
    ),
}

_PRERENDER_CMD = """\
set -e
PORT_FILE=$(mktemp -t bcr_prerender.XXXXXX)
SERVER_PID=""
cleanup() {{
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -f "$PORT_FILE"
}}
trap cleanup EXIT

{server} --port=0 --port_file="$PORT_FILE" {tarball} >/dev/null 2>&1 &
SERVER_PID=$!

# Wait up to 15s for the server to bind and write its port.
for i in $(seq 1 60); do
  if [ -s "$PORT_FILE" ]; then break; fi
  sleep 0.25
done
if [ ! -s "$PORT_FILE" ]; then
  echo "releaseserver did not write a port file" >&2
  exit 1
fi
PORT=$(cat "$PORT_FILE")

{compiler} \\
  --chromedp=true \\
  --chrome_path={chrome} \\
  --url="http://localhost:$PORT{path}" \\
  --output_file={output} \\
  --wait_ready=body \\
  --timeout=60
"""

def _prerender_home_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".html")

    chrome_bin = ctx.attr._chromium[NamedFilesInfo].value["CHROME-HEADLESS-SHELL"]
    chromium_runfiles = ctx.attr._chromium[DefaultInfo].default_runfiles.files

    cmd = _PRERENDER_CMD.format(
        server = ctx.executable._releaseserver.path,
        compiler = ctx.executable._statichtmlcompiler.path,
        chrome = chrome_bin.path,
        tarball = ctx.file.tarball.path,
        output = output.path,
        path = ctx.attr.path,
    )

    ctx.actions.run_shell(
        outputs = [output],
        inputs = depset(
            direct = [ctx.file.tarball],
            transitive = [chromium_runfiles],
        ),
        tools = [
            ctx.attr._releaseserver[DefaultInfo].files_to_run,
            ctx.attr._statichtmlcompiler[DefaultInfo].files_to_run,
        ],
        command = cmd,
        mnemonic = "PrerenderHome",
        progress_message = "Prerendering %s with chrome-headless-shell" % ctx.attr.path,
    )

    return [DefaultInfo(files = depset([output]))]

prerender_home = rule(
    implementation = _prerender_home_impl,
    attrs = dict({
        "tarball": attr.label(
            allow_single_file = [".tar"],
            mandatory = True,
            doc = "Release tarball to serve while prerendering.",
        ),
        "path": attr.string(
            default = "/",
            doc = "URL path to prerender (default: '/').",
        ),
    }, **_TOOL_ATTRS),
)

_PRERENDER_SHARD_CMD = """\
set -e

PORT_FILE=$(mktemp -t bcr_prerender_pages.XXXXXX)
WORKDIR=$(mktemp -d -t bcr_prerender_pages_workdir.XXXXXX)
SERVER_PID=""
cleanup() {{
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -f "$PORT_FILE"
  rm -rf "$WORKDIR"
}}
trap cleanup EXIT

{server} --port=0 --port_file="$PORT_FILE" {tarball} >/dev/null 2>&1 &
SERVER_PID=$!

for i in $(seq 1 60); do
  if [ -s "$PORT_FILE" ]; then break; fi
  sleep 0.25
done
if [ ! -s "$PORT_FILE" ]; then
  echo "releaseserver did not write a port file" >&2
  exit 1
fi
PORT=$(cat "$PORT_FILE")
BASE_URL="http://localhost:$PORT"

# Take 1/N of the URL list — every line whose 0-based index modulo
# {shard_total} equals {shard_index}. This evenly distributes work
# across shards without a separate split step.
SHARD_LIST=$(mktemp -t bcr_prerender_shard.XXXXXX)
awk -v idx={shard_index} -v n={shard_total} '(NR-1) % n == idx' "{url_list}" > "$SHARD_LIST"

# Build --url / --output_file flag pairs from the (sharded) URL list.
# Each line is `<url> <comma-separated-output-paths>`. We forward the
# comma list verbatim to statichtmlcompiler's --output_file flag, which
# writes the captured HTML to every path — that's how
# /modules/<name>/<latest> and /modules/<name> end up with the same
# prerendered file from a single render.
URL_ARGS=""
URL_COUNT=0
while IFS=' ' read -r url paths || [ -n "$url" ]; do
  [ -z "$url" ] && continue
  case "$url" in
    /*) ;;
    *) url="/$url" ;;
  esac
  abs_paths=""
  for path in ${{paths//,/ }}; do
    abs="$WORKDIR/$path"
    mkdir -p "$(dirname "$abs")"
    if [ -z "$abs_paths" ]; then
      abs_paths="$abs"
    else
      abs_paths="$abs_paths,$abs"
    fi
  done
  URL_ARGS="$URL_ARGS --url=$BASE_URL$url --output_file=$abs_paths"
  URL_COUNT=$((URL_COUNT + 1))
done < "$SHARD_LIST"

# Empty shard is fine (e.g., URL list shorter than shard_total) — emit
# an empty tar so the merge step still works.
if [ "$URL_COUNT" -eq 0 ]; then
  tar -cf {output} -C "$WORKDIR" .
  exit 0
fi

# Mirror compiler logs to a tail-able file so progress is visible mid-
# action. Bazel buffers an action's stderr until it finishes, so this
# is the only way to watch a long shard in real time:
#   tail -f /tmp/bcr_prerender_shard{shard_index}.log
PROGRESS_LOG=/tmp/bcr_prerender_shard{shard_index}.log
echo "Mirroring prerender progress to $PROGRESS_LOG (tail -f to watch)" >&2

{compiler} \\
  --chromedp=true \\
  --chrome_path={chrome} \\
  --chromedp_pool={pool} \\
  --tab_max_pages={tab_max_pages} \\
  --ready_signal=true \\
  --block_resources=images,fonts,media \\
  --progress_log="$PROGRESS_LOG" \\
  --retries={retries} \\
  --timeout={timeout} \\
  --settle_ms={settle_ms} \\
  --warmup_concurrency={warmup_concurrency} \\
  $URL_ARGS

tar -cf {output} -C "$WORKDIR" .
"""

_MERGE_SHARDS_CMD = """\
set -e
WORKDIR=$(mktemp -d -t bcr_prerender_merge.XXXXXX)
trap "rm -rf $WORKDIR" EXIT
{extract_lines}
tar -cf {output} -C "$WORKDIR" .
"""

def _prerender_pages_impl(ctx):
    chrome_bin = ctx.attr._chromium[NamedFilesInfo].value["CHROME-HEADLESS-SHELL"]
    chromium_runfiles = ctx.attr._chromium[DefaultInfo].default_runfiles.files

    n = ctx.attr.shards
    if n < 1:
        fail("shards must be >= 1, got %d" % n)

    shard_outputs = []
    for i in range(n):
        shard_out = ctx.actions.declare_file(
            "{}.shard{}.tar".format(ctx.label.name, i),
        )
        cmd = _PRERENDER_SHARD_CMD.format(
            server = ctx.executable._releaseserver.path,
            compiler = ctx.executable._statichtmlcompiler.path,
            chrome = chrome_bin.path,
            tarball = ctx.file.tarball.path,
            url_list = ctx.file.url_list.path,
            output = shard_out.path,
            shard_index = i,
            shard_total = n,
            timeout = ctx.attr.timeout_seconds,
            settle_ms = ctx.attr.settle_ms,
            pool = ctx.attr.pool_size,
            tab_max_pages = ctx.attr.tab_max_pages,
            retries = ctx.attr.retries,
            warmup_concurrency = ctx.attr.warmup_concurrency,
        )
        ctx.actions.run_shell(
            outputs = [shard_out],
            inputs = depset(
                direct = [ctx.file.tarball, ctx.file.url_list],
                transitive = [chromium_runfiles],
            ),
            tools = [
                ctx.attr._releaseserver[DefaultInfo].files_to_run,
                ctx.attr._statichtmlcompiler[DefaultInfo].files_to_run,
            ],
            command = cmd,
            mnemonic = "PrerenderPagesShard",
            progress_message = "Prerendering pages shard {} of {}".format(i + 1, n),
        )
        shard_outputs.append(shard_out)

    # Merge every shard's tar entries into one final tarball. Bazel runs
    # this only after all shards complete, so the merge action's
    # progress_message is the last thing the user sees in the UI.
    final_output = ctx.actions.declare_file(ctx.label.name + ".tar")
    extract_lines = "\n".join([
        'tar -xf "{}" -C "$WORKDIR"'.format(s.path)
        for s in shard_outputs
    ])
    ctx.actions.run_shell(
        outputs = [final_output],
        inputs = shard_outputs,
        command = _MERGE_SHARDS_CMD.format(
            extract_lines = extract_lines,
            output = final_output.path,
        ),
        mnemonic = "MergePrerenderShards",
        progress_message = "Merging {} prerender shards".format(n),
    )

    return [DefaultInfo(files = depset([final_output]))]

prerender_pages = rule(
    implementation = _prerender_pages_impl,
    attrs = dict({
        "tarball": attr.label(
            allow_single_file = [".tar"],
            mandatory = True,
            doc = "Release tarball to serve while prerendering.",
        ),
        "url_list": attr.label(
            allow_single_file = [".txt"],
            mandatory = True,
            doc = "Text file with one URL pathname per line (e.g. /modules/rules_buf).",
        ),
        "shards": attr.int(
            default = 1,
            doc = "Number of parallel shard actions to split rendering across. " +
                  "Each shard is its own Bazel action with its own Chrome process + " +
                  "tab pool. Default 1 follows the 'one Chrome instance, many tabs' " +
                  "guidance: tab-level parallelism inside the pool (see pool_size) " +
                  "is far cheaper than booting another Chrome. Crank up only when " +
                  "you specifically want Bazel-UI-level per-shard progress.",
        ),
        "timeout_seconds": attr.int(
            default = 30,
            doc = "Per-render timeout in seconds.",
        ),
        "settle_ms": attr.int(
            default = 300,
            doc = "Per-navigation settle cap (ms). With --ready_signal=true (default), this " +
                  "is the upper bound on how long to poll window.__bcrPrerenderReady; the " +
                  "SPA's RegistryApp.handleRouteDone flips it after each route change " +
                  "(initial Navigate and subsequent pushState), so renders typically come " +
                  "in well under the cap. The cap is the fallback for routes that fail " +
                  "to settle.",
        ),
        "pool_size": attr.int(
            default = 8,
            doc = "Number of reusable chromedp tabs per shard. One Chrome process hosts all " +
                  "tabs; each tab is reused for many SPA-pushState renders. Default 8 keeps " +
                  "memory headroom; at 16 the combined V8 heaps + accumulated SPA state can " +
                  "OOM mid-batch on smaller machines.",
        ),
        "tab_max_pages": attr.int(
            default = 27,
            doc = "Recycle each tab after this many renders. Keeps JS heap bounded across " +
                  "long batches — the previous warm-tab attempt was abandoned because the " +
                  "SPA's per-route state accumulated without bound; this bounds it. Default " +
                  "25 balances heap ceiling against per-recycle Navigate cost: too aggressive " +
                  "(10) and the extra Navigates dominate; too lax (50 at pool_size=16) and " +
                  "the combined heaps OOM the machine.",
        ),
        "retries": attr.int(
            default = 1,
            doc = "Retry a failed render up to N times with a fresh tab. Per-render " +
                  "failures are usually transient (tab crash, renderer OOM, CDP race, " +
                  "per-render timeout) and a one-shot retry on a fresh tab resolves " +
                  "almost all of them. Increase if you see a particular module " +
                  "consistently failing once but rendering fine on a second try.",
        ),
        "warmup_concurrency": attr.int(
            default = 4,
            doc = "Pre-warm every pool tab against the SPA root before processing real " +
                  "URLs, with at most this many REGISTRY_DATA parses in flight. " +
                  "Without warmup, all pool_size tabs Navigate simultaneously on cold " +
                  "start and the 16-way concurrent ~2.7MB protobuf parse contends hard " +
                  "enough to push tabs past --timeout_seconds (observed: 30s+ tail, " +
                  "11 timeouts clustered in the first batch). Serializing the parse to " +
                  "4-way concurrency lets each tab pay close to the ~1.5s solo cost. " +
                  "Set to 0 to disable warmup.",
        ),
    }, **_TOOL_ATTRS),
)
