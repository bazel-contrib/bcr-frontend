"provides the archive_override rule"

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
    implementation = _archive_override_impl,
    attrs = {
        "module_name": attr.string(mandatory = True),
        "integrity": attr.string(),
        "patch_strip": attr.int(default = 0),
        "patches": attr.string_list(),
        "strip_prefix": attr.string(),
        "urls": attr.string_list(),
    },
    provides = [ModuleOverrideInfo, ArchiveOverrideInfo],
)
