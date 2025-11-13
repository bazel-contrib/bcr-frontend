"provides the cloudflare_deploy rule"

def _write_executable_action(ctx):
    index = ctx.files.srcs[0]

    ctx.actions.write(
        output = ctx.outputs.executable,
        content = """
set -x
ls -al {cwd}
pwd
wrangler pages deploy . --project-name {project} --no-bundle --cwd {cwd}
exit 1
""".format(
            cwd = ctx.label.package,
            project = ctx.attr.project,
        ),
        is_executable = True,
    )

def _cloudflare_deploy_impl(ctx):
    srcs = ctx.files.srcs

    _write_executable_action(ctx)

    return [
        DefaultInfo(
            files = depset([ctx.outputs.executable]),
            runfiles = ctx.runfiles(files = srcs, collect_data = True, collect_default = True),
        ),
    ]

cloudflare_deploy = rule(
    implementation = _cloudflare_deploy_impl,
    attrs = {
        "srcs": attr.label_list(
            allow_files = True,
        ),
        "project": attr.string(
            mandatory = True,
        ),
    },
    executable = True,
)
