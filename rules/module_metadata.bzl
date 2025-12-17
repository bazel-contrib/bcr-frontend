"""Provides the module_metadata rule."""

load("//rules:providers.bzl", "ModuleMaintainerInfo", "ModuleMetadataInfo", "ModuleVersionInfo", "RepositoryMetadataInfo")

def _make_maintainer(maintainer):
    return {
        k: v
        for k, v in {
            "email": maintainer.email,
            "github_user_id": maintainer.github_user_id,
            "username": maintainer.username,
            "github": maintainer.github,
        }.items()
        if v
    }

def _metadata_json_action(ctx, module_versions, maintainers):
    output = ctx.actions.declare_file("modules/%s/metadata.json" % ctx.label.name)
    ctx.actions.write(output, json.encode_indent({
        "homepage": ctx.attr.homepage,
        "repository": [],
        "versions": [mv.version for mv in module_versions],
        "yanked_versions": ctx.attr.yanked_versions,
        "maintainers": [_make_maintainer(m) for m in maintainers],
    }))
    return output

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
    metadata_json = _metadata_json_action(ctx, deps, maintainers)

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
            deps = deps,
            metadata_json = ctx.file.metadata_json,
            build_bazel = ctx.file.build_bazel if ctx.file.build_bazel else None,
            proto = proto_out,
        ),
        OutputGroupInfo(
            metadata_json = depset([metadata_json]),
        ),
    ]

module_metadata = rule(
    doc = "Defines metadata for a Bazel module including versions, maintainers, and repository information.",
    implementation = _module_metadata_impl,
    attrs = {
        "homepage": attr.string(
            doc = "str: Homepage URL for the module",
        ),
        "maintainers": attr.label_list(
            doc = "list[Target]: Maintainer targets providing ModuleMaintainerInfo",
            providers = [ModuleMaintainerInfo],
        ),
        "repository": attr.string_list(
            doc = "list[str]: Repository URLs",
        ),
        "versions": attr.string_list(
            doc = "list[str]: Module version strings",
        ),
        "yanked_versions": attr.string_dict(
            doc = "dict[str, str]: Mapping of yanked version to reason",
        ),
        "deprecated": attr.string(
            doc = "str: Deprecation message (empty string if not deprecated)",
        ),
        "deps": attr.label_list(
            doc = "list[Target]: Module version targets providing ModuleVersionInfo",
            providers = [ModuleVersionInfo],
        ),
        "repository_metadata": attr.label(
            doc = "Target | None: Repository metadata target providing RepositoryMetadataInfo",
            providers = [RepositoryMetadataInfo],
        ),
        "build_bazel": attr.label(
            doc = "File | None: The BUILD.bazel file",
            allow_single_file = True,
        ),
        "metadata_json": attr.label(
            doc = "File: The metadata.json file (required)",
            allow_single_file = [".json"],
            mandatory = False,
        ),
        "_compiler": attr.label(
            default = "//cmd/modulecompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleMetadataInfo],
)
