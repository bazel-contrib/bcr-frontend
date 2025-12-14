"""Provides the module_dependency_cycle rule."""

load("//rules:providers.bzl", "ModuleDependencyCycleInfo")

def _module_dependency_cycle_impl(ctx):
    return [
        ModuleDependencyCycleInfo(
            modules = ctx.attr.deps,
            cycle_name = ctx.attr.name,
        ),
    ]

module_dependency_cycle = rule(
    doc = "Defines a dependency cycle in the module graph.",
    implementation = _module_dependency_cycle_impl,
    attrs = {
        "deps": attr.string_list(
            doc = "list[str]: Module version strings that form the cycle",
        ),
        "cycle_modules": attr.string_list(
            doc = "list[str]: Alternative representation of cycle modules (deprecated)",
        ),
    },
    provides = [ModuleDependencyCycleInfo],
)
