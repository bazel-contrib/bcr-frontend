"provides the module_version rule"

load("//rules:providers.bzl", "ModuleAttestationsInfo", "ModuleDependencyInfo", "ModuleSourceInfo", "ModuleVersionInfo")

def _module_version_impl(ctx):
    return [
        ModuleVersionInfo(
            name = ctx.attr.module_name,
            version = ctx.attr.version,
            compatibility_level = ctx.attr.compatibility_level,
            repo_name = ctx.attr.repo_name,
            deps = ctx.attr.deps,
            source = ctx.attr.source,
            attestations = ctx.attr.attestations,
        ),
    ]

module_version = rule(
    implementation = _module_version_impl,
    attrs = {
        "module_name": attr.string(mandatory = True),
        "version": attr.string(),
        "compatibility_level": attr.int(default = 0),
        "repo_name": attr.string(),
        "deps": attr.label_list(providers = [ModuleDependencyInfo]),
        "source": attr.label(providers = [ModuleSourceInfo]),
        "attestations": attr.label(providers = [ModuleAttestationsInfo]),
    },
    provides = [ModuleVersionInfo],
)
