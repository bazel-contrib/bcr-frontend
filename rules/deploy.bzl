"provides the cloudflare_deploy rule"

def _write_worker_executable(ctx):
    """Generate deployment script for Worker with assets"""

    # Build WASM modules flag if provided
    wasm_modules_flag = ""
    if ctx.files.worker_modules:
        # Modules will be extracted from tarball to TMPDIR
        module_names = [f.basename for f in ctx.files.worker_modules]
        module_paths = ["$TMPDIR/" + name for name in module_names]
        wasm_modules_flag = "--wasm_modules=\"{}\" ".format(",".join(module_paths))

    content = """#!/usr/bin/env bash
set -euo pipefail

# Check required environment variable
if [ -z "${{CLOUDFLARE_API_TOKEN:-}}" ]; then
  echo "Error: CLOUDFLARE_API_TOKEN environment variable not set"
  exit 1
fi

# Create temporary directory for assets
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Extract tarball to temporary directory
tar -xf {tarball} -C "$TMPDIR"

# Deploy worker with assets
{cfdeploy} worker --account_id={account_id} --name={name} {script_flag}{wasm_flag}--assets="$TMPDIR" --compatibility_date={compat_date}
""".format(
        cfdeploy = ctx.executable._cfdeploy.short_path,
        account_id = ctx.attr.account_id,
        name = ctx.attr.worker_name if ctx.attr.worker_name else ctx.attr.project,
        script_flag = "--script={} ".format(ctx.file.worker_script.short_path) if ctx.file.worker_script else "",
        wasm_flag = wasm_modules_flag,
        tarball = ctx.file.tarball.short_path,
        compat_date = ctx.attr.compatibility_date,
    )

    ctx.actions.write(
        output = ctx.outputs.executable,
        content = content,
        is_executable = True,
    )

    runfiles = [ctx.file.tarball, ctx.executable._cfdeploy]
    if ctx.file.worker_script:
        runfiles.append(ctx.file.worker_script)
    return runfiles

def _cloudflare_deploy_impl(ctx):
    runfiles_list = _write_worker_executable(ctx)

    return [
        DefaultInfo(
            files = depset([ctx.outputs.executable]),
            runfiles = ctx.runfiles(files = runfiles_list),
        ),
    ]

cloudflare_deploy = rule(
    implementation = _cloudflare_deploy_impl,
    attrs = {
        "account_id": attr.string(
            mandatory = True,
        ),
        "project": attr.string(
            mandatory = True,
        ),
        "tarball": attr.label(
            allow_single_file = [".tar"],
        ),
        "worker_script": attr.label(
            allow_single_file = [".js", ".mjs"],
            doc = "Optional Worker script. If provided, deploys as Worker with assets.",
        ),
        "worker_modules": attr.label_list(
            allow_files = [".wasm", ".js", ".mjs"],
            doc = "Optional WASM/JS modules to deploy with Worker. Should match files in tarball.",
        ),
        "worker_name": attr.string(
            doc = "Worker name (defaults to project name if not specified)",
        ),
        "compatibility_date": attr.string(
            default = "2024-01-01",
            doc = "Cloudflare Worker compatibility date",
        ),
        "_cfdeploy": attr.label(
            default = "//cmd/cfdeploy",
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
)
