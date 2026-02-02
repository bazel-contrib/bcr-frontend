"provides the release_archive rule"

def _write_executable_action(ctx, archive_file):
    ctx.actions.write(
        output = ctx.outputs.executable,
        content = """
{server} {archive_file}
""".format(
            server = ctx.executable._releaseserver.short_path,
            archive_file = archive_file.short_path,
        ),
        is_executable = True,
    )

def _compile_release_action(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".tar")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--index_html_file")
    args.add(ctx.file.index_html)
    args.add("--registry_file")
    args.add(ctx.file.registry_file)
    if ctx.file.module_registry_symbols_file:
        args.add("--module_registry_symbols_file")
        args.add(ctx.file.module_registry_symbols_file)

    # Collect files to exclude from hashing
    exclude_from_hash = [src.basename for src in ctx.files.srcs]

    # Add worker modules to exclude list (don't hash WASM/JS modules)
    exclude_from_hash.extend([mod.basename for mod in ctx.files.worker_modules])
    if len(exclude_from_hash) > 0:
        args.add("--exclude_from_hash", ",".join(exclude_from_hash))

    args.add_all(ctx.files.srcs)
    args.add_all(ctx.files.hashed_srcs)
    args.add_all(ctx.files.worker_modules)

    # Build inputs list
    inputs = ctx.files.srcs + ctx.files.hashed_srcs + ctx.files.worker_modules + [
        ctx.file.index_html,
        ctx.file.registry_file,
    ] + (
        [ctx.file.module_registry_symbols_file] if ctx.file.module_registry_symbols_file else []
    )

    ctx.actions.run(
        executable = ctx.executable._releasecompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [output],
        mnemonic = "CompileRelease",
        progress_message = "Compiling app release",
    )

    return output

def _release_archive_impl(ctx):
    archive_file = _compile_release_action(ctx)
    _write_executable_action(ctx, archive_file)

    return [
        DefaultInfo(
            files = depset([archive_file]),
            runfiles = ctx.runfiles(files = [archive_file, ctx.executable._releaseserver]),
        ),
    ]

release_archive = rule(
    implementation = _release_archive_impl,
    attrs = {
        "hashed_srcs": attr.label_list(allow_files = True),
        "srcs": attr.label_list(allow_files = True),
        "worker_modules": attr.label_list(
            allow_files = [".wasm", ".js", ".mjs"],
            doc = "WASM/JS modules for Worker (excluded from hashing)",
        ),
        "index_html": attr.label(allow_single_file = True, mandatory = True),
        "registry_file": attr.label(allow_single_file = True, mandatory = True),
        "module_registry_symbols_file": attr.label(allow_single_file = True, mandatory = True),
        "_releasecompiler": attr.label(
            default = "//cmd/releasecompiler",
            executable = True,
            cfg = "exec",
        ),
        "_releaseserver": attr.label(
            default = "//cmd/releaseserver",
            executable = True,
            cfg = "exec",
        ),
    },
    executable = True,
)
