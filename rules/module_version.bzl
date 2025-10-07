"provides the module_version rule"

load("//rules:providers.bzl", "ModuleAttestationsInfo", "ModuleDependencyInfo", "ModuleSourceInfo", "ModuleVersionInfo")

def _module_version_impl(ctx):
    deps = [dep[ModuleDependencyInfo] for dep in ctx.attr.deps]
    source = ctx.attr.source[ModuleSourceInfo] if ctx.attr.source and ModuleSourceInfo in ctx.attr.source else None
    attestations = ctx.attr.attestations[ModuleAttestationsInfo] if ctx.attr.attestations and ModuleAttestationsInfo in ctx.attr.attestations else None

    return [
        ModuleVersionInfo(
            name = ctx.attr.module_name,
            version = ctx.attr.version,
            compatibility_level = ctx.attr.compatibility_level,
            bazel_compatibility = ctx.attr.bazel_compatibility,
            repo_name = ctx.attr.repo_name,
            deps = depset(deps),
            source = source,
            attestations = attestations,
        ),
    ]

module_version = rule(
    implementation = _module_version_impl,
    attrs = {
        "module_name": attr.string(mandatory = True),
        "version": attr.string(),
        "compatibility_level": attr.int(default = 0),
        "bazel_compatibility": attr.string_list(),
        "repo_name": attr.string(),
        "deps": attr.label_list(providers = [ModuleDependencyInfo]),
        "source": attr.label(providers = [ModuleSourceInfo]),
        "attestations": attr.label(providers = [ModuleAttestationsInfo]),
    },
    provides = [ModuleVersionInfo],
)
