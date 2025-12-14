"""Provides the module_commit rule."""

load("//rules:providers.bzl", "ModuleCommitInfo")

def _module_commit_impl(ctx):
    return [
        ModuleCommitInfo(
            sha1 = ctx.attr.sha1,
            date = ctx.attr.date,
            message = ctx.attr.message,
        ),
    ]

module_commit = rule(
    doc = "Defines Git commit information for a module version.",
    implementation = _module_commit_impl,
    attrs = {
        "sha1": attr.string(
            doc = "str: Git commit SHA-1 hash (required)",
            mandatory = True,
        ),
        "date": attr.string(
            doc = "str: Commit date in ISO 8601 format (required)",
            mandatory = True,
        ),
        "message": attr.string(
            doc = "str: Git commit message (required)",
            mandatory = True,
        ),
    },
    provides = [ModuleCommitInfo],
)
