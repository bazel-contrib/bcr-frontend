"provides the module_source rule"

load("//rules:providers.bzl", "ModuleSourceInfo")

def _compile_starlark_action(ctx, files):
    output = ctx.actions.declare_file(ctx.label.name + ".moduleinfo.json")

    java_runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    java_executable = java_runtime.java_executable_exec_path
    # print("java_runtime:", java_runtime)

    args = ctx.actions.args()
    args.use_param_file("@%s", use_always = True)
    args.set_param_file_format("multiline")

    args.add("--output_file", output)
    args.add("--port", 3524)
    args.add("--java_interpreter_file", java_executable)
    args.add("--server_jar_file", ctx.file._starlarkserverjar)
    args.add("--workspace_cwd", "/Users/pcj/go/src/github.com/stackb/centrl")
    args.add("--workspace_output_base", "/private/var/tmp/_bazel_pcj/4d50590a9155e202dda3b0ac2e024c3f")

    args.add_all(files)

    ctx.actions.run(
        mnemonic = "CompileModuleInfo",
        progress_message = "Extracting %s (%d files)" % (str(ctx.label), len(files)),
        execution_requirements = {
            "supports-workers": "0",
            "requires-worker-protocol": "proto",
        },
        executable = ctx.executable._starlarkcompiler,
        arguments = [args],
        inputs = [ctx.file._starlarkserverjar] + files,
        outputs = [output],
        tools = java_runtime.files.to_list(),
    )

    return output

def _compile_stardoc_action(ctx, docs):
    output = ctx.actions.declare_file(ctx.label.name + ".docs.pb")

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add_all(docs)

    ctx.actions.run(
        executable = ctx.executable._documentationcompiler,
        arguments = [args],
        inputs = docs,
        outputs = [output],
        mnemonic = "CompileDocumenatationInfo",
    )

    return output

def _module_source_impl(ctx):
    documentation_info = None
    if ctx.files.docs:
        documentation_info = _compile_stardoc_action(ctx, ctx.files.docs)

    module_info = None
    if ctx.files.docs_bundle:
        module_info = _compile_starlark_action(ctx, ctx.files.docs_bundle)

    return [
        DefaultInfo(
            files = depset([module_info] if module_info else []),
        ),
        OutputGroupInfo(
            documentation_info = depset([documentation_info] if documentation_info else []),
        ),
        ModuleSourceInfo(
            url = ctx.attr.url,
            integrity = ctx.attr.integrity,
            strip_prefix = ctx.attr.strip_prefix,
            patch_strip = ctx.attr.patch_strip,
            patches = ctx.attr.patches,
            docs = ctx.files.docs,
            docs_url = ctx.attr.docs_url,
            documentation_info = documentation_info,
            source_json = ctx.file.source_json,
        ),
    ]

module_source = rule(
    implementation = _module_source_impl,
    attrs = {
        "url": attr.string(),
        "integrity": attr.string(),
        "strip_prefix": attr.string(),
        "patch_strip": attr.int(default = 0),
        "patches": attr.string_dict(),
        "docs": attr.label_list(allow_files = True),
        "docs_bundle": attr.label_list(allow_files = True),
        "docs_url": attr.string(),
        "source_json": attr.label(allow_single_file = [".json"], mandatory = True),
        "_documentationcompiler": attr.label(
            default = "//cmd/documentationcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_starlarkcompiler": attr.label(
            default = "//cmd/starlarkcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_java_runtime": attr.label(
            default = "@bazel_tools//tools/jdk:current_java_runtime",
            cfg = "exec",
            providers = [java_common.JavaRuntimeInfo],
        ),
        "_starlarkserverjar": attr.label(
            default = "//cmd/starlarkcompiler:constellate_jar_file",
            allow_single_file = True,
        ),
    },
    provides = [ModuleSourceInfo],
)
