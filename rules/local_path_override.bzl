"provides the local_path_override rule"

load("//rules:providers.bzl", "LocalPathOverrideInfo", "ModuleOverrideInfo")

def _local_path_override_impl(ctx):
    return [
        ModuleOverrideInfo(
            module_name = ctx.attr.module_name,
        ),
        LocalPathOverrideInfo(
            module_name = ctx.attr.module_name,
            path = ctx.attr.path,
        ),
    ]

local_path_override = rule(
    implementation = _local_path_override_impl,
    attrs = {
        "module_name": attr.string(mandatory = True),
        "path": attr.string(),
    },
    provides = [ModuleOverrideInfo, LocalPathOverrideInfo],
)
