"provides the module_metadata rule"

load("//rules:providers.bzl", "ModuleMaintainerInfo", "ModuleMetadataInfo", "ModuleOverrideInfo", "ModuleVersionInfo", "RepositoryMetadataInfo")

def _compile_action(ctx, versions):
    # Declare output file for compiled proto
    proto_out = ctx.actions.declare_file(ctx.label.name + ".module.pb")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--module_metadata_file")
    args.add(ctx.file.metadata_json)
    args.add("--output_file")
    args.add(proto_out)
    args.add_all(versions)

    # Collect all input files
    inputs = [ctx.file.metadata_json] + versions

    # Run the compiler action
    ctx.actions.run(
        executable = ctx.executable._compiler,
        arguments = [args],
        inputs = inputs,
        outputs = [proto_out],
        mnemonic = "CompileModule",
        progress_message = "Compiling module for %{label}",
    )

    return proto_out

def _module_metadata_impl(ctx):
    maintainers = [m[ModuleMaintainerInfo] for m in ctx.attr.maintainers]
    deps = [d[ModuleVersionInfo] for d in ctx.attr.deps]
    overrides = [o[ModuleOverrideInfo] for o in ctx.attr.overrides]
    versions = [d.proto for d in deps]

    proto_out = _compile_action(ctx, versions)

    return [
        DefaultInfo(files = depset([proto_out])),
        ModuleMetadataInfo(
            homepage = ctx.attr.homepage,
            maintainers = depset(maintainers),
            repository = ctx.attr.repository,
            versions = ctx.attr.versions,
            yanked_versions = ctx.attr.yanked_versions,
            deprecated = ctx.attr.deprecated,
            deps = depset(deps),
            overrides = depset(overrides),
            metadata_json = ctx.file.metadata_json,
            proto = proto_out,
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
        "repos": attr.string_keyed_label_dict(providers = [RepositoryMetadataInfo]),
        "overrides": attr.label_list(providers = [ModuleOverrideInfo]),
        "metadata_json": attr.label(allow_single_file = [".json"], mandatory = True),
        "_compiler": attr.label(
            default = "//cmd/modulecompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleMetadataInfo],
)
