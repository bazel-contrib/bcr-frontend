"""Generate a small JS module exposing the UI's git commit SHA.

The action runs `//cmd/uiversion`, which reads STABLE_GIT_COMMIT from the
workspace status file (populated by `tools/workspace_status.sh` via
--workspace_status_command) and substitutes it for the placeholder
__BCR_FRONTEND_COMMIT_SHA__ in the supplied template. Falls back to
"unknown" when stamping is disabled or the key is missing/empty.
"""

def _ui_version_js_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".js")
    ctx.actions.run(
        inputs = [ctx.info_file, ctx.file.template],
        outputs = [out],
        executable = ctx.executable._tool,
        arguments = [
            "--info_file",
            ctx.info_file.path,
            "--template",
            ctx.file.template.path,
            "--out",
            out.path,
        ],
        mnemonic = "UiVersionJs",
        progress_message = "Stamping UI commit SHA into %s" % out.short_path,
    )
    return [DefaultInfo(files = depset([out]))]

ui_version_js = rule(
    implementation = _ui_version_js_impl,
    attrs = {
        "template": attr.label(
            allow_single_file = True,
            mandatory = True,
            doc = "JS template containing the __BCR_FRONTEND_COMMIT_SHA__ placeholder.",
        ),
        "_tool": attr.label(
            default = "//cmd/uiversion",
            executable = True,
            cfg = "exec",
        ),
    },
)
