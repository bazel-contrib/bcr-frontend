"provides the cloudflare_deploy rule"

def _write_executable_action(ctx):
    ctx.actions.write(
        output = ctx.outputs.executable,
        content = """
{wrangler} --help --account_id {account_id} --project {project} --tarball {tarball}
""".format(
            cfdeploy = ctx.executable._cfdeploy.short_path,
            wrangler = ctx.executable._wrangler.short_path,
            account_id = ctx.attr.account_id,
            project = ctx.attr.project,
            tarball = ctx.file.tarball.short_path,
        ),
        is_executable = True,
    )

def _cloudflare_deploy_impl(ctx):
    _write_executable_action(ctx)

    return [
        DefaultInfo(
            files = depset([ctx.outputs.executable]),
            runfiles = ctx.runfiles(files = [ctx.file.tarball, ctx.executable._cfdeploy, ctx.executable._wrangler]),
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
            default = "//cmd/wranglerdeploy:wrangler",
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
)
