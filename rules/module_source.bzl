"""Provides the module_source rule."""

load("//rules:providers.bzl", "ModuleSourceInfo")

def _module_source_impl(ctx):
    return [
        ModuleSourceInfo(
            url = ctx.attr.url,
            url_status_code = ctx.attr.url_status_code,
            url_status_message = ctx.attr.url_status_message,
            integrity = ctx.attr.integrity,
            strip_prefix = ctx.attr.strip_prefix,
            patch_strip = ctx.attr.patch_strip,
            patches = ctx.attr.patches,
            source_json = ctx.file.source_json,
            docs_url = ctx.attr.docs_url,
            docs_url_status_code = ctx.attr.docs_url_status_code,
            docs_url_status_message = ctx.attr.docs_url_status_message,
            commit_sha = ctx.attr.commit_sha,
        ),
    ]

module_source = rule(
    doc = "Defines source archive information for a module version.",
    implementation = _module_source_impl,
    attrs = {
        "url": attr.string(
            doc = "str: Source archive URL",
        ),
        "url_status_code": attr.int(
            doc = "int: HTTP status code of the source URL",
        ),
        "url_status_message": attr.string(
            doc = "str: HTTP status message of the source URL",
        ),
        "integrity": attr.string(
            doc = "str: Source integrity hash (e.g., sha256-...)",
        ),
        "strip_prefix": attr.string(
            doc = "str: Directory prefix to strip from the archive",
        ),
        "patch_strip": attr.int(
            doc = "int: Number of leading path components to strip from patches",
            default = 0,
        ),
        "patches": attr.string_dict(
            doc = "dict[str, str]: Mapping of patch filename to integrity hash",
        ),
        "docs_url": attr.string(
            doc = "str: Documentation archive URL (empty string if not set)",
        ),
        "docs_url_status_code": attr.int(
            doc = "int: HTTP status code of the docs URL",
        ),
        "docs_url_status_message": attr.string(
            doc = "str: HTTP status message of the docs URL",
        ),
        "commit_sha": attr.string(
            doc = "str: Git commit SHA for the source URL (resolved from tags/releases)",
        ),
        "source_json": attr.label(
            doc = "File: The source.json file (required)",
            allow_single_file = [".json"],
            mandatory = True,
        ),
    },
    provides = [ModuleSourceInfo],
)
