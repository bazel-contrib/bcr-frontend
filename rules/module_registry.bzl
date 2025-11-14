"provides the module_registry rule"

load("//rules:providers.bzl", "ModuleDependencyCycleInfo", "ModuleMetadataInfo", "ModuleRegistryInfo")

def _write_repos_json_action(ctx, deps):
    # Declare output file for repos_json proto
    output = ctx.actions.declare_file(ctx.label.name + ".repos.json")

    repos = []
    for dep in deps:
        repos.extend(dep.repository)

    ctx.actions.write(output, json.encode(depset(repos).to_list()))

    return output

def _compile_action(ctx, modules):
    # Declare output file for compiled proto
    output = ctx.actions.declare_file(ctx.label.name + ".registry.pb")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    if ctx.attr.repository_url:
        args.add("--repository_url")
        args.add(ctx.attr.repository_url)
    if ctx.attr.registry_url:
        args.add("--registry_url")
        args.add(ctx.attr.registry_url)
    if ctx.attr.branch:
        args.add("--branch")
        args.add(ctx.attr.branch)
    if ctx.attr.commit:
        args.add("--commit")
        args.add(ctx.attr.commit)
    if ctx.attr.commit_date:
        args.add("--commit_date")
        args.add(ctx.attr.commit_date)
    args.add_all(modules)

    # Collect all input files
    inputs = modules

    # Run the compiler action
    ctx.actions.run(
        executable = ctx.executable._compiler,
        arguments = [args],
        inputs = inputs,
        outputs = [output],
        mnemonic = "CompileRegistry",
        progress_message = "Compiling registry for %{label}",
    )

    return output

def _module_registry_impl(ctx):
    deps = [d[ModuleMetadataInfo] for d in ctx.attr.deps]
    cycles = [d[ModuleDependencyCycleInfo] for d in ctx.attr.cycles]
    modules = [d.proto for d in deps]

    proto_out = _compile_action(ctx, modules)
    repos_json_out = _write_repos_json_action(ctx, deps)

    return [
        DefaultInfo(files = depset([proto_out])),
        OutputGroupInfo(repos_json = [repos_json_out]),
        ModuleRegistryInfo(
            deps = depset(deps),
            cycles = depset(cycles),
            proto = proto_out,
            repository_url = ctx.attr.repository_url,
            registry_url = ctx.attr.registry_url,
            branch = ctx.attr.branch,
            commit = ctx.attr.commit,
            commit_date = ctx.attr.commit_date,
        ),
    ]

module_registry = rule(
    implementation = _module_registry_impl,
    attrs = {
        "deps": attr.label_list(providers = [ModuleMetadataInfo]),
        "cycles": attr.label_list(providers = [ModuleDependencyCycleInfo]),
        "repository_url": attr.string(doc = "Repository URL of the registry (e.g. 'https://github.com/bazelbuild/bazel-central-registry')"),
        "registry_url": attr.string(doc = "URL of the registry UI (e.g. 'https://registry.bazel.build')"),
        "branch": attr.string(doc = "Branch name of the repository data (e.g. 'main')"),
        "commit": attr.string(doc = "Commit sha1 of the repository data"),
        "commit_date": attr.string(doc = "Timestamp of the commit date (same format as: git log --format='%ci')"),
        "_compiler": attr.label(
            default = "//cmd/registrycompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleRegistryInfo],
)
