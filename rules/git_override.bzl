"""Provides the git_override rule."""

load("//rules:providers.bzl", "GitOverrideInfo", "ModuleOverrideInfo")

def _git_override_impl(ctx):
    return [
        ModuleOverrideInfo(
            module_name = ctx.attr.module_name,
        ),
        GitOverrideInfo(
            module_name = ctx.attr.module_name,
            commit = ctx.attr.commit,
            remote = ctx.attr.remote,
            branch = ctx.attr.branch,
            patch_strip = ctx.attr.patch_strip,
            patches = ctx.attr.patches,
        ),
    ]

git_override = rule(
    doc = "Defines a Git-based module override configuration.",
    implementation = _git_override_impl,
    attrs = {
        "module_name": attr.string(
            doc = "str: Name of the module being overridden (required)",
            mandatory = True,
        ),
        "commit": attr.string(
            doc = "str: Git commit hash",
        ),
        "remote": attr.string(
            doc = "str: Git remote URL",
        ),
        "branch": attr.string(
            doc = "str: Git branch name",
        ),
        "patch_strip": attr.int(
            doc = "int: Number of leading path components to strip from patches",
            default = 0,
        ),
        "patches": attr.string_list(
            doc = "list[str]: Patch file paths",
        ),
    },
    provides = [ModuleOverrideInfo, GitOverrideInfo],
)
