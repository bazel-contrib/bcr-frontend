"provides the octicons_closure_template_library rule"

def _executable(ctx, biome):
    ctx.actions.write(
        ctx.outputs.executable,
        """
{biome} {command} --write --config-path=$BUILD_WORKSPACE_DIRECTORY/biome.json $BUILD_WORKSPACE_DIRECTORY/
""".format(
            biome = biome.short_path,
            command = ctx.attr.command,
        ),
        is_executable = True,
    )

def _biome_format_impl(ctx):
    biome = ctx.executable._biome
    _executable(ctx, biome)

    # Collect runfiles from dependencies (needed for Java executables like soy_formatter)
    runfiles = ctx.runfiles(files = [biome])

    return [
        DefaultInfo(
            executable = ctx.outputs.executable,
            runfiles = runfiles,
        ),
    ]

biome_format = rule(
    implementation = _biome_format_impl,
    attrs = {
        "command": attr.string(
            values = ["format", "check"],
            default = "format",
        ),
        "_biome": attr.label(
            default = "@github_com_biomejs_biome_releases_download_biomejs_biome_2_3_10_biome_darwin_arm64//file",
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
)
