"""Provides the multiple_version_override rule."""

load("//rules:providers.bzl", "ModuleOverrideInfo", "MultipleVersionOverrideInfo")

def _multiple_version_override_impl(ctx):
    return [
        ModuleOverrideInfo(
            module_name = ctx.attr.module_name,
        ),
        MultipleVersionOverrideInfo(
            module_name = ctx.attr.module_name,
            versions = ctx.attr.versions,
            registry = ctx.attr.registry,
        ),
    ]

multiple_version_override = rule(
    doc = "Defines a multiple-version module override configuration.",
    implementation = _multiple_version_override_impl,
    attrs = {
        "module_name": attr.string(
            doc = "str: Name of the module being overridden (required)",
            mandatory = True,
        ),
        "versions": attr.string_list(
            doc = "list[str]: Versions allowed to coexist",
            mandatory = True,
        ),
        "registry": attr.string(
            doc = "str: Registry from which to resolve the module",
        ),
    },
    provides = [ModuleOverrideInfo, MultipleVersionOverrideInfo],
)
