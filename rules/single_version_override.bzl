"provides the single_version_override rule"

load("//rules:providers.bzl", "ModuleOverrideInfo", "SingleVersionOverrideInfo")

def _single_version_override_impl(ctx):
    return [
        ModuleOverrideInfo(
            module_name = ctx.attr.module_name,
        ),
        SingleVersionOverrideInfo(
            module_name = ctx.attr.module_name,
            patch_strip = ctx.attr.patch_strip,
            patches = ctx.attr.patches,
            version = ctx.attr.version,
        ),
    ]

single_version_override = rule(
    implementation = _single_version_override_impl,
    attrs = {
        "module_name": attr.string(mandatory = True),
        "patch_strip": attr.int(default = 0),
        "patches": attr.string_list(),
        "version": attr.string(),
    },
    provides = [ModuleOverrideInfo, SingleVersionOverrideInfo],
)
