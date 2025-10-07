"provides the module_registry rule"

load("//rules:providers.bzl", "ModuleMetadataInfo", "ModuleRegistryInfo")

def _module_registry_impl(ctx):
    deps = [d[ModuleMetadataInfo] for d in ctx.attr.deps]

    return [
        ModuleRegistryInfo(
            deps = depset(deps),
        ),
    ]

module_registry = rule(
    implementation = _module_registry_impl,
    attrs = {
        "deps": attr.label_list(providers = [ModuleMetadataInfo]),
    },
    provides = [ModuleRegistryInfo],
)
