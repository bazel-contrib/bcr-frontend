"provides the module_version rule"

load("//rules:providers.bzl", "ModuleAttestationsInfo", "ModuleCommitInfo", "ModuleDependencyInfo", "ModulePresubmitInfo", "ModuleSourceInfo", "ModuleVersionInfo")

def _compile_action(ctx, source, deps, attestations, presubmit, commit):
    # Declare output file for compiled proto
    proto_out = ctx.actions.declare_file(ctx.label.name + ".moduleversion.pb")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--module_bazel_file")
    args.add(ctx.file.module_bazel)
    args.add("--output_file")
    args.add(proto_out)

    # All of the module dependency info is in the MODULE.bazel file, but the
    # 'unresolved' property is discovered during gazelle resolution.  Pass that
    # information into the compiler.
    unresolved_deps = [dep.name for dep in deps if dep.unresolved]
    if unresolved_deps:
        args.add("--unresolved_deps")
        args.add(",".join(unresolved_deps))

    # Collect all input files
    inputs = [ctx.file.module_bazel]

    # Add optional source.json file
    if source and source.source_json:
        args.add("--source_json_file")
        args.add(source.source_json)
        inputs.append(source.source_json)

    # Add optional presubmit.yml file
    if presubmit and presubmit.presubmit_yml:
        args.add("--presubmit_yml_file")
        args.add(presubmit.presubmit_yml)
        inputs.append(presubmit.presubmit_yml)

    # Add optional attestations.json file
    if attestations and attestations.attestations_json:
        args.add("--attestations_json_file")
        args.add(attestations.attestations_json)
        inputs.append(attestations.attestations_json)

    # Add optional commit metadata
    if commit:
        args.add("--commit_sha1")
        args.add(commit.sha1)
        args.add("--commit_date")
        args.add(commit.date)
        args.add("--commit_message")
        args.add(commit.message)

    # Run the compiler action
    ctx.actions.run(
        executable = ctx.executable._compiler,
        arguments = [args],
        inputs = inputs,
        outputs = [proto_out],
        mnemonic = "CompileModuleVersion",
        progress_message = "Compiling module version for %{label}",
    )

    return proto_out

def _module_version_impl(ctx):
    deps = [dep[ModuleDependencyInfo] for dep in ctx.attr.deps]
    source = ctx.attr.source[ModuleSourceInfo] if ctx.attr.source and ModuleSourceInfo in ctx.attr.source else None
    attestations = ctx.attr.attestations[ModuleAttestationsInfo] if ctx.attr.attestations and ModuleAttestationsInfo in ctx.attr.attestations else None
    presubmit = ctx.attr.presubmit[ModulePresubmitInfo] if ctx.attr.presubmit and ModulePresubmitInfo in ctx.attr.presubmit else None
    commit = ctx.attr.commit[ModuleCommitInfo] if ctx.attr.commit and ModuleCommitInfo in ctx.attr.commit else None
    proto_out = _compile_action(ctx, source, deps, attestations, presubmit, commit)

    outputs = [proto_out]

    return [
        DefaultInfo(files = depset(outputs)),
        ModuleVersionInfo(
            name = ctx.attr.module_name,
            version = ctx.attr.version,
            compatibility_level = ctx.attr.compatibility_level,
            bazel_compatibility = ctx.attr.bazel_compatibility,
            repo_name = ctx.attr.repo_name,
            deps = depset(deps),
            source = source,
            attestations = attestations,
            presubmit = presubmit,
            commit = commit,
            module_bazel = ctx.file.module_bazel if ctx.file.module_bazel else None,
            build_bazel = ctx.file.build_bazel if ctx.file.build_bazel else None,
            proto = proto_out,
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
        "presubmit": attr.label(providers = [ModulePresubmitInfo]),
        "commit": attr.label(providers = [ModuleCommitInfo]),
        "build_bazel": attr.label(allow_single_file = True),
        "module_bazel": attr.label(allow_single_file = True),
        "_compiler": attr.label(
            default = "//cmd/moduleversioncompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleVersionInfo],
)
