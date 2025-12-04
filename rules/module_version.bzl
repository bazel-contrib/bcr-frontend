"""Provides the module_version rule."""

load("@build_stack_rules_proto//rules:starlark_library.bzl", "StarlarkLibraryFileInfo")
load(
    "//rules:providers.bzl",
    "ModuleAttestationsInfo",
    "ModuleCommitInfo",
    "ModuleDependencyInfo",
    "ModulePresubmitInfo",
    "ModuleSourceInfo",
    "ModuleVersionInfo",
)

def _status_code_exists(code):
    return code >= 200 and code < 300

def _compile_published_documentation_action(ctx, files):
    if not files:
        return None

    output = ctx.actions.declare_file("%s/modules/%s/%s/documentationinfo.pb" % (ctx.label.name, ctx.attr.module_name, ctx.attr.version))

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add_all(files)

    ctx.actions.run(
        executable = ctx.executable._documentationcompiler,
        arguments = [args],
        inputs = files,
        outputs = [output],
        mnemonic = "CompileDocumenatationInfo",
    )

    return output

# def _compile_docs_action(ctx, source, deps, unresolved_deps):
#     # if the module_source has published / "offical" docs, use those (assuming
#     # the doc link isn't broken).
#     if len(source.docs) > 0 and _status_code_exists(source.docs_url_status_code):
#         return _compile_published_documentation_action(ctx, source.docs)

#     # if the module does not publish docs and this is NOT the latest version,
#     # skip.
#     if not ctx.attr.is_latest_version:
#         # print("skipping docgen for %s (not latest version)" % ctx.label)
#         return None

#     # if we have unresolved dependencies, the best effort method will fail
#     if unresolved_deps:
#         return None

#     # otherwise, attempt to extract docs automatically
#     return _compile_best_effort_extract_documentation_action(ctx, source, deps, transitive_deps)

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

        args.add("--url_status_code=" + str(source.url_status_code))
        args.add("--url_status_message=" + source.url_status_message)
        args.add("--docs_url_status_code=" + str(source.docs_url_status_code))
        args.add("--docs_url_status_message=" + source.docs_url_status_message)

    # optionally include docs
    # docs_out = _compile_docs_action(ctx, source, deps, unresolved_deps)
    # if docs_out:
    #     args.add("--documentation_info_file")
    #     args.add(docs_out)
    #     inputs.append(docs_out)

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
        executable = ctx.executable._moduleversioncompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [proto_out],
        mnemonic = "CompileModuleVersion",
        progress_message = "Compiling module version for %{label}",
    )

    return struct(
        module = proto_out,
        # docs = docs_out,
    )

def _module_version_impl(ctx):
    deps = [dep[ModuleDependencyInfo] for dep in ctx.attr.deps]
    bzl_srcs = ctx.attr.bzl_srcs[StarlarkLibraryFileInfo] if ctx.attr.bzl_srcs else None
    bzl_deps = [dep[StarlarkLibraryFileInfo] for dep in ctx.attr.bzl_deps]
    source = ctx.attr.source[ModuleSourceInfo]
    attestations = ctx.attr.attestations[ModuleAttestationsInfo] if ctx.attr.attestations and ModuleAttestationsInfo in ctx.attr.attestations else None
    presubmit = ctx.attr.presubmit[ModulePresubmitInfo] if ctx.attr.presubmit and ModulePresubmitInfo in ctx.attr.presubmit else None
    commit = ctx.attr.commit[ModuleCommitInfo] if ctx.attr.commit and ModuleCommitInfo in ctx.attr.commit else None

    compilation = _compile_action(ctx, source, deps, attestations, presubmit, commit)
    outputs = [compilation.module]

    return [
        DefaultInfo(
            files = depset(outputs),
        ),
        ModuleVersionInfo(
            id = "%s@%s" % (ctx.attr.module_name, ctx.attr.version),
            name = ctx.attr.module_name,
            attestations = attestations,
            bazel_compatibility = ctx.attr.bazel_compatibility,
            build_bazel = ctx.file.build_bazel if ctx.file.build_bazel else None,
            bzl_deps = bzl_deps,
            bzl_srcs = bzl_srcs,
            commit = commit,
            compatibility_level = ctx.attr.compatibility_level,
            deps = deps,
            is_latest_version = ctx.attr.is_latest_version,
            module_bazel = ctx.file.module_bazel if ctx.file.module_bazel else None,
            presubmit = presubmit,
            proto = compilation.module,
            published_docs = ctx.files.published_docs if ctx.attr.published_docs else [],
            repo_name = ctx.attr.repo_name,
            source = source,
            version = ctx.attr.version,
        ),
    ]

module_version = rule(
    doc = "Defines complete information about a specific module version.",
    implementation = _module_version_impl,
    attrs = {
        "module_name": attr.string(
            doc = "str: Module name (required)",
            mandatory = True,
        ),
        "version": attr.string(
            doc = "str: Module version",
        ),
        "is_latest_version": attr.bool(
            doc = "bool: Whether this is the latest version of the module",
        ),
        "compatibility_level": attr.int(
            doc = "int: Module compatibility level",
            default = 0,
        ),
        "bazel_compatibility": attr.string_list(
            doc = "list[str]: Compatible Bazel version ranges",
        ),
        "repo_name": attr.string(
            doc = "str: Repository name",
        ),
        "deps": attr.label_list(
            doc = "list[Target]: Dependency targets providing ModuleDependencyInfo",
            providers = [ModuleDependencyInfo],
        ),
        "mvs": attr.string_dict(
            doc = "dict[str, str]: MVS result for non-dev dependencies (module name -> version)",
        ),
        "mvs_dev": attr.string_dict(
            doc = "dict[str, str]: MVS result for dev dependencies (module name -> version)",
        ),
        "bzl_srcs": attr.label(
            doc = "Target]: Starlark repository labels providing StarlarkLibraryFileInfo for the bzl files for this moduleversion",
            providers = [StarlarkLibraryFileInfo],
        ),
        "bzl_deps": attr.label_list(
            doc = "list[Target]: Starlark repository labels providing StarlarkLibraryFileInfo (dependencies of bzl_srcs)",
            providers = [StarlarkLibraryFileInfo],
        ),
        "published_docs": attr.label_list(
            doc = "list[File]: Published documentation files from http_archive (typically from docs_url)",
            allow_files = True,
        ),
        "source": attr.label(
            doc = "Target: Source target providing ModuleSourceInfo",
            providers = [ModuleSourceInfo],
        ),
        "attestations": attr.label(
            doc = "Target | None: Attestations target providing ModuleAttestationsInfo",
            providers = [ModuleAttestationsInfo],
        ),
        "presubmit": attr.label(
            doc = "Target | None: Presubmit target providing ModulePresubmitInfo",
            providers = [ModulePresubmitInfo],
        ),
        "commit": attr.label(
            doc = "Target | None: Commit target providing ModuleCommitInfo",
            providers = [ModuleCommitInfo],
        ),
        "build_bazel": attr.label(
            doc = "File | None: The BUILD.bazel file",
            allow_single_file = True,
        ),
        "module_bazel": attr.label(
            doc = "File | None: The MODULE.bazel file",
            allow_single_file = True,
        ),
        "_moduleversioncompiler": attr.label(
            default = "//cmd/moduleversioncompiler",
            executable = True,
            cfg = "exec",
        ),
        "_documentationcompiler": attr.label(
            default = "//cmd/documentationcompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleVersionInfo],
)
