"provides the octicons_closure_template_library rule"

def _executable(ctx, biome):
    ctx.actions.write(
        ctx.outputs.executable,
        "{biome} format app/bcr/*.js".format(
            biome = biome.short_path,
        ),
        is_executable = True,
    )

def _biome_format_impl(ctx):
    biome = ctx.executable._biome
    _executable(ctx, biome)

    return [
        DefaultInfo(
            executable = ctx.outputs.executable,
            runfiles = ctx.runfiles(files = [biome]),
        ),
    ]

biome_format = rule(
    implementation = _biome_format_impl,
    attrs = {
        "_biome": attr.label(
            default = "@github_com_biomejs_biome_releases_download_biomejs_biome_2_3_10_biome_darwin_arm64//file",
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
)
