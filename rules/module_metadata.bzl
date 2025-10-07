"provides the module_metadata rule"

load("//rules:providers.bzl", "ModuleMaintainerInfo", "ModuleMetadataInfo", "ModuleOverrideInfo", "ModuleVersionInfo")

def _module_metadata_impl(ctx):
    maintainers = [m[ModuleMaintainerInfo] for m in ctx.attr.maintainers]
    deps = [d[ModuleVersionInfo] for d in ctx.attr.deps]
    overrides = [o[ModuleOverrideInfo] for o in ctx.attr.overrides]

    return [
        ModuleMetadataInfo(
            homepage = ctx.attr.homepage,
            maintainers = depset(maintainers),
            repository = ctx.attr.repository,
            versions = ctx.attr.versions,
            yanked_versions = ctx.attr.yanked_versions,
            deprecated = ctx.attr.deprecated,
            deps = depset(deps),
            overrides = depset(overrides),
        ),
    ]

module_metadata = rule(
    implementation = _module_metadata_impl,
    attrs = {
        "homepage": attr.string(),
        "maintainers": attr.label_list(providers = [ModuleMaintainerInfo]),
        "repository": attr.string_list(),
        "versions": attr.string_list(),
        "yanked_versions": attr.string_dict(),
        "deprecated": attr.string(),
        "deps": attr.label_list(providers = [ModuleVersionInfo]),
        "overrides": attr.label_list(providers = [ModuleOverrideInfo]),
    },
    provides = [ModuleMetadataInfo],
)
