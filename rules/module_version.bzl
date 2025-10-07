"provides the module_version rule"

load("//rules:providers.bzl", "ModuleAttestationsInfo", "ModuleDependencyInfo", "ModulePresubmitInfo", "ModuleSourceInfo", "ModuleVersionInfo")

def _compile_action(ctx, source, attestations, presubmit):
    # Declare output file for compiled proto
    proto_out = ctx.actions.declare_file(ctx.label.name + ".moduleversion.json")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--module_bazel_file")
    args.add(ctx.file.module_bazel)
    args.add("--output_file")
    args.add(proto_out)

    # Collect all input files
    inputs = [ctx.file.module_bazel]

    # Add optional source.json file
    source_json = None
    if source:
        source_json = source.source_json
        if source_json:
            args.add("--source_json_file")
            args.add(source_json)
            inputs.append(source_json)

    # Add optional presubmit.yml file
    presubmit_yml = None
    if presubmit:
        presubmit_yml = presubmit.presubmit_yml
        if presubmit_yml:
            args.add("--presubmit_yml_file")
            args.add(presubmit_yml)
            inputs.append(presubmit_yml)

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
    proto_out = _compile_action(ctx, source, attestations, presubmit)

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
            module_bazel = ctx.file.module_bazel if ctx.file.module_bazel else None,
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
        "module_bazel": attr.label(allow_single_file = True),
        "_compiler": attr.label(
            default = "//cmd/moduleversioncompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleVersionInfo],
)
