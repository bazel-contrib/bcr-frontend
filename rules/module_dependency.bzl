"provides the module_dependency rule"

load("//rules:providers.bzl", "ModuleDependencyCycleInfo", "ModuleDependencyInfo", "ModuleOverrideInfo", "ModuleVersionInfo")

def _module_dependency_impl(ctx):
    module = ctx.attr.module[ModuleVersionInfo] if ctx.attr.module and ModuleVersionInfo in ctx.attr.module else None
    cycle = ctx.attr.cycle[ModuleDependencyCycleInfo] if ctx.attr.cycle and ModuleDependencyCycleInfo in ctx.attr.cycle else None
    override = ctx.attr.override[ModuleOverrideInfo] if ctx.attr.override and ModuleOverrideInfo in ctx.attr.override else None

    return [
        ModuleDependencyInfo(
            name = ctx.attr.dep_name,
            version = ctx.attr.version,
            dev = ctx.attr.dev,
            module = module,
            cycle = cycle,
            override = override,
        ),
    ]

module_dependency = rule(
    implementation = _module_dependency_impl,
    attrs = {
        "dep_name": attr.string(mandatory = True),
        "version": attr.string(),
        "dev": attr.bool(default = False),
        "module": attr.label(providers = [ModuleVersionInfo]),
        "cycle": attr.label(providers = [ModuleDependencyCycleInfo]),
        "override": attr.label(providers = [ModuleOverrideInfo]),
    },
    provides = [ModuleDependencyInfo],
)
