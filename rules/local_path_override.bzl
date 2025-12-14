"""Provides the local_path_override rule."""

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
    doc = "Defines a local filesystem path module override configuration.",
    implementation = _local_path_override_impl,
    attrs = {
        "module_name": attr.string(
            doc = "str: Name of the module being overridden (required)",
            mandatory = True,
        ),
        "path": attr.string(
            doc = "str: Local filesystem path to the module",
        ),
    },
    provides = [ModuleOverrideInfo, LocalPathOverrideInfo],
)
