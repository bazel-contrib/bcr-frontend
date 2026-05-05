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

_PRERENDER_PAGES_CMD = """\
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

# Build --url / --output_file flag pairs from the URL list. Each line is a
# pathname like /modules/rules_buf; we render BASE_URL+path into
# WORKDIR/<path>/index.html.
URL_ARGS=""
while IFS= read -r path || [ -n "$path" ]; do
  [ -z "$path" ] && continue
  case "$path" in
    /*) ;;
    *) path="/$path" ;;
  esac
  out="$WORKDIR$path/index.html"
  mkdir -p "$(dirname "$out")"
  URL_ARGS="$URL_ARGS --url=$BASE_URL$path --output_file=$out"
done < {url_list}

{compiler} \\
  --chromedp=true \\
  --chrome_path={chrome} \\
  --single_context \\
  --concurrency={concurrency} \\
  --timeout={timeout} \\
  --settle_ms={settle_ms} \\
  $URL_ARGS

# Pack everything under WORKDIR (which has the same layout we want in the
# final release tarball: <pathname>/index.html). tar's -C flag ensures the
# entries are stored relative to WORKDIR, so a path like /modules/rules_buf
# becomes ./modules/rules_buf/index.html in the archive.
tar -cf {output} -C "$WORKDIR" .
"""

def _prerender_pages_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".tar")

    chrome_bin = ctx.attr._chromium[NamedFilesInfo].value["CHROME-HEADLESS-SHELL"]
    chromium_runfiles = ctx.attr._chromium[DefaultInfo].default_runfiles.files

    cmd = _PRERENDER_PAGES_CMD.format(
        server = ctx.executable._releaseserver.path,
        compiler = ctx.executable._statichtmlcompiler.path,
        chrome = chrome_bin.path,
        tarball = ctx.file.tarball.path,
        url_list = ctx.file.url_list.path,
        output = output.path,
        concurrency = ctx.attr.concurrency,
        timeout = ctx.attr.timeout_seconds,
        settle_ms = ctx.attr.settle_ms,
    )

    ctx.actions.run_shell(
        outputs = [output],
        inputs = depset(
            direct = [ctx.file.tarball, ctx.file.url_list],
            transitive = [chromium_runfiles],
        ),
        tools = [
            ctx.attr._releaseserver[DefaultInfo].files_to_run,
            ctx.attr._statichtmlcompiler[DefaultInfo].files_to_run,
        ],
        command = cmd,
        mnemonic = "PrerenderPages",
        progress_message = "Prerendering module pages with chrome-headless-shell",
    )

    return [DefaultInfo(files = depset([output]))]

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
        "concurrency": attr.int(
            default = 4,
            doc = "Number of parallel workers (each holds its own chrome tab).",
        ),
        "timeout_seconds": attr.int(
            default = 30,
            doc = "Per-render timeout in seconds.",
        ),
        "settle_ms": attr.int(
            default = 300,
            doc = "Milliseconds to wait after each navigation before capturing HTML.",
        ),
    }, **_TOOL_ATTRS),
)
