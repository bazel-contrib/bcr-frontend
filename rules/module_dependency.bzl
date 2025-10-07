"provides the module_dependency rule"

load("//rules:providers.bzl", "ModuleDependencyCycleInfo", "ModuleDependencyInfo", "ModuleOverrideInfo", "ModuleVersionInfo")

def _module_dependency_impl(ctx):
    return [
        ModuleDependencyInfo(
            name = ctx.attr.dep_name,
            version = ctx.attr.version,
            dev = ctx.attr.dev,
            module = ctx.attr.module,
            cycle = ctx.attr.cycle,
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
