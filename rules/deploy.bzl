"provides the cloudflare_deploy rule"

def _write_executable_action(ctx):
    ctx.actions.write(
        output = ctx.outputs.executable,
        content = """#!/usr/bin/env bash
set -euo pipefail

# Create temporary directory
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Extract tarball to temporary directory
tar -xf {tarball} -C "$TMPDIR"

# Create wrangler.toml configuration for SPA
cat > "$TMPDIR/wrangler.toml" << EOF
name = "{project}"
compatibility_date = "2023-01-01"

[assets]
directory = "."
not_found_handling = "single-page-application"
EOF

# Deploy using wrangler
{wrangler} deploy --cwd "$TMPDIR"
""".format(
            wrangler = ctx.executable._wrangler.short_path,
            tarball = ctx.file.tarball.short_path,
            project = ctx.attr.project,
        ),
        is_executable = True,
    )

def _cloudflare_deploy_impl(ctx):
    _write_executable_action(ctx)

    return [
        DefaultInfo(
            files = depset([ctx.outputs.executable]),
            runfiles = ctx.runfiles(files = [ctx.file.tarball, ctx.executable._wrangler])
                .merge(ctx.attr._wrangler[DefaultInfo].default_runfiles),
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
        "_cfdeploy": attr.label(
            default = "//cmd/cfdeploy",
            executable = True,
            cfg = "exec",
        ),
        "_wrangler": attr.label(
            default = "//cmd/wranglerdeploy",
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
)
