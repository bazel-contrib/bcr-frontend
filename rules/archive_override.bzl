"""Provides the archive_override rule."""

load("//rules:providers.bzl", "ArchiveOverrideInfo", "ModuleOverrideInfo")

def _archive_override_impl(ctx):
    return [
        ModuleOverrideInfo(
            module_name = ctx.attr.module_name,
        ),
        ArchiveOverrideInfo(
            module_name = ctx.attr.module_name,
            integrity = ctx.attr.integrity,
            patch_strip = ctx.attr.patch_strip,
            patches = ctx.attr.patches,
            strip_prefix = ctx.attr.strip_prefix,
            urls = ctx.attr.urls,
        ),
    ]

archive_override = rule(
    doc = "Defines an archive-based module override configuration.",
    implementation = _archive_override_impl,
    attrs = {
        "module_name": attr.string(
            doc = "str: Name of the module being overridden (required)",
            mandatory = True,
        ),
        "integrity": attr.string(
            doc = "str: Archive integrity hash",
        ),
        "patch_strip": attr.int(
            doc = "int: Number of leading path components to strip from patches",
            default = 0,
        ),
        "patches": attr.string_list(
            doc = "list[str]: Patch file paths",
        ),
        "strip_prefix": attr.string(
            doc = "str: Directory prefix to strip from the archive",
        ),
        "urls": attr.string_list(
            doc = "list[str]: Archive URLs",
        ),
    },
    provides = [ModuleOverrideInfo, ArchiveOverrideInfo],
)
