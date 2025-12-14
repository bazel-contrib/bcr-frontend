"""Provides the module_maintainer rule."""

load("//rules:providers.bzl", "ModuleMaintainerInfo")

def _module_maintainer_impl(ctx):
    return [
        ModuleMaintainerInfo(
            email = ctx.attr.email,
            username = ctx.attr.name,
            github = ctx.attr.github,
            do_not_notify = ctx.attr.do_not_notify,
            github_user_id = ctx.attr.github_user_id,
        ),
    ]

module_maintainer = rule(
    doc = "Defines a module maintainer with contact information.",
    implementation = _module_maintainer_impl,
    attrs = {
        "email": attr.string(
            doc = "str: Maintainer email address",
        ),
        "username": attr.string(
            doc = "str: Maintainer username",
        ),
        "github": attr.string(
            doc = "str: GitHub username",
        ),
        "do_not_notify": attr.bool(
            doc = "bool: Whether to suppress notifications to this maintainer",
        ),
        "github_user_id": attr.int(
            doc = "int: GitHub user ID",
        ),
    },
    provides = [ModuleMaintainerInfo],
)
