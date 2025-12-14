"""Provides the module_dependency rule."""

load("//rules:providers.bzl", "ModuleDependencyCycleInfo", "ModuleDependencyInfo", "ModuleOverrideInfo", "ModuleVersionInfo")

def _module_dependency_impl(ctx):
    module = ctx.attr.module[ModuleVersionInfo] if ctx.attr.module and ModuleVersionInfo in ctx.attr.module else None
    cycle = ctx.attr.cycle[ModuleDependencyCycleInfo] if ctx.attr.cycle and ModuleDependencyCycleInfo in ctx.attr.cycle else None
    override = ctx.attr.override[ModuleOverrideInfo] if ctx.attr.override and ModuleOverrideInfo in ctx.attr.override else None

    return [
        ModuleDependencyInfo(
            name = ctx.attr.dep_name,
            version = ctx.attr.version,
            repo_name = ctx.attr.repo_name,
            dev = ctx.attr.dev,
            unresolved = ctx.attr.unresolved,
            module = module,
            cycle = cycle,
            override = override,
        ),
    ]

module_dependency = rule(
    doc = "Defines a dependency relationship between modules.",
    implementation = _module_dependency_impl,
    attrs = {
        "dep_name": attr.string(
            doc = "str: Dependency module name (required)",
            mandatory = True,
        ),
        "version": attr.string(
            doc = "str: Dependency module version",
        ),
        "repo_name": attr.string(
            doc = "str: Effective repository name for the dependency",
        ),
        "dev": attr.bool(
            doc = "bool: Whether this is a dev dependency",
            default = False,
        ),
        "unresolved": attr.bool(
            doc = "bool: Whether this dependency failed to resolve",
            default = False,
        ),
        "module": attr.label(
            doc = "Target | None: Module version target providing ModuleVersionInfo",
            providers = [ModuleVersionInfo],
        ),
        "cycle": attr.label(
            doc = "Target | None: Cycle target providing ModuleDependencyCycleInfo",
            providers = [ModuleDependencyCycleInfo],
        ),
        "override": attr.label(
            doc = "Target | None: Override target providing ModuleOverrideInfo",
            providers = [ModuleOverrideInfo],
        ),
    },
    provides = [ModuleDependencyInfo],
)
