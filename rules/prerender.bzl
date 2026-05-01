"""Pre-render an SPA route using hermetic chrome-headless-shell from rules_browsers.

This rule boots `releaseserver` against a release tarball on a free port, drives
chrome-headless-shell via `statichtmlcompiler` to capture the rendered HTML for
a given URL path, and writes the result to a file that can replace `index.html`
in the final release archive.
"""

load("@rules_browsers//browsers:named_files_info.bzl", "NamedFilesInfo")

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

    chrome_bin = ctx.attr.chromium[NamedFilesInfo].value["CHROME-HEADLESS-SHELL"]
    chromium_runfiles = ctx.attr.chromium[DefaultInfo].default_runfiles.files

    cmd = _PRERENDER_CMD.format(
        server = ctx.executable.releaseserver.path,
        compiler = ctx.executable.statichtmlcompiler.path,
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
            ctx.attr.releaseserver[DefaultInfo].files_to_run,
            ctx.attr.statichtmlcompiler[DefaultInfo].files_to_run,
        ],
        command = cmd,
        mnemonic = "PrerenderHome",
        progress_message = "Prerendering %s with chrome-headless-shell" % ctx.attr.path,
    )

    return [DefaultInfo(files = depset([output]))]

prerender_home = rule(
    implementation = _prerender_home_impl,
    attrs = {
        "tarball": attr.label(
            allow_single_file = [".tar"],
            mandatory = True,
            doc = "Release tarball to serve while prerendering.",
        ),
        "chromium": attr.label(
            mandatory = True,
            providers = [NamedFilesInfo, DefaultInfo],
            cfg = "exec",
            doc = "rules_browsers browser_group for chromium.",
        ),
        "path": attr.string(
            default = "/",
            doc = "URL path to prerender (default: '/').",
        ),
        "releaseserver": attr.label(
            executable = True,
            cfg = "exec",
            mandatory = True,
        ),
        "statichtmlcompiler": attr.label(
            executable = True,
            cfg = "exec",
            mandatory = True,
        ),
    },
)
