"provides the module_metadata rule"

load("//rules:providers.bzl", "ModuleMaintainerInfo", "ModuleMetadataInfo", "ModuleOverrideInfo", "ModuleVersionInfo")

def _module_metadata_impl(ctx):
    return [
        ModuleMetadataInfo(
            homepage = ctx.attr.homepage,
            maintainers = ctx.attr.maintainers,
            repository = ctx.attr.repository,
            versions = ctx.attr.versions,
            yanked_versions = ctx.attr.yanked_versions,
            deprecated = ctx.attr.deprecated,
            deps = ctx.attr.deps,
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
