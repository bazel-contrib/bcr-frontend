"""Provides the single_version_override rule."""

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
    doc = "Defines a single-version module override configuration.",
    implementation = _single_version_override_impl,
    attrs = {
        "module_name": attr.string(
            doc = "str: Name of the module being overridden (required)",
            mandatory = True,
        ),
        "patch_strip": attr.int(
            doc = "int: Number of leading path components to strip from patches",
            default = 0,
        ),
        "patches": attr.string_list(
            doc = "list[str]: Patch file paths",
        ),
        "version": attr.string(
            doc = "str: Specific version to use",
        ),
    },
    provides = [ModuleOverrideInfo, SingleVersionOverrideInfo],
)
