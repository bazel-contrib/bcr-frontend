"provides the module_metadata rule"

load("//rules:providers.bzl", "ModuleMaintainerInfo", "ModuleMetadataInfo", "ModuleVersionInfo", "RepositoryMetadataInfo")

def _compile_action(ctx, repository_metadata, versions):
    # Declare output file for compiled proto
    proto_out = ctx.actions.declare_file(ctx.label.name + ".module.pb")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--module_metadata_file")
    args.add(ctx.file.metadata_json)
    if repository_metadata:
        args.add("--repository_metadata_file")
        args.add(repository_metadata.json_file)
    args.add("--output_file")
    args.add(proto_out)
    args.add_all(versions)

    # Collect all input files
    inputs = [ctx.file.metadata_json] + versions
    if repository_metadata:
        inputs.append(repository_metadata.json_file)

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
    versions = [d.proto for d in deps]
    repository_metadata = ctx.attr.repository_metadata[RepositoryMetadataInfo] if ctx.attr.repository_metadata != None else None
    proto_out = _compile_action(ctx, repository_metadata, versions)

    return [
        DefaultInfo(files = depset([proto_out])),
        ModuleMetadataInfo(
            name = ctx.label.name,
            homepage = ctx.attr.homepage,
            maintainers = depset(maintainers),
            repository = ctx.attr.repository,
            repository_metadata = repository_metadata,
            versions = ctx.attr.versions,
            yanked_versions = ctx.attr.yanked_versions,
            deprecated = ctx.attr.deprecated,
            deps = depset(deps),
            metadata_json = ctx.file.metadata_json,
            build_bazel = ctx.file.build_bazel if ctx.file.build_bazel else None,
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
        "repository_metadata": attr.label(providers = [RepositoryMetadataInfo]),
        "build_bazel": attr.label(allow_single_file = True),
        "metadata_json": attr.label(allow_single_file = [".json"], mandatory = True),
        "_compiler": attr.label(
            default = "//cmd/modulecompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleMetadataInfo],
)
