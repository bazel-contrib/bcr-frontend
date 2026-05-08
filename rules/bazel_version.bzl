"""Provides the bazel_version rule."""

load("//rules:providers.bzl", "BazelVersionInfo")

def _compile_bazel_help_action(ctx, commands):
    output = ctx.actions.declare_file(ctx.label.name + ".bazelhelp.pb")
    inputs = [command.output for command in commands]

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--version")
    args.add(ctx.attr.version)
    args.add_all(inputs)

    ctx.actions.run(
        executable = ctx.executable._bazelhelpcompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [output],
        mnemonic = "CompileBazelHelp",
    )

    return output

def _make_command_output_struct(ctx, command_name):
    return struct(
        name = command_name,
        output = ctx.actions.declare_file("%s.%s" % (ctx.label.name, command_name)),
    )

def _bazel_command_help_action(ctx):
    commands = [_make_command_output_struct(ctx, name) for name in ctx.attr.commands]

    # Run all commands for this version in a single bazelisk invocation. The
    # wrapper loops sequentially, reusing the same bazel server, so we get one
    # bazel startup per version instead of N. Parallel actions across versions
    # (each with its own output_base) still run concurrently.
    args = ["--allow-unknown-command", "--multi-help"]
    args.extend(["%s=%s" % (c.name, c.output.path) for c in commands])

    ctx.actions.run(
        executable = ctx.executable._bazelisk,
        arguments = args,
        env = {"USE_BAZEL_VERSION": ctx.attr.version},
        inputs = [],
        outputs = [c.output for c in commands],
        mnemonic = "ExtractBazelHelp",
        progress_message = "Extracting bazel help for version %s" % ctx.attr.version,
        execution_requirements = {
            "requires-network": "1",
            "no-sandbox": "1",
        },
        use_default_shell_env = True,
    )

    return commands

def _bazel_version_impl(ctx):
    commands = _bazel_command_help_action(ctx)
    bazel_help = _compile_bazel_help_action(ctx, commands)

    return [
        DefaultInfo(
            files = depset([command.output for command in commands]),
        ),
        OutputGroupInfo(
            bazel_help = depset([bazel_help]),
            **{command.name: depset([command.output]) for command in commands}
        ),
        BazelVersionInfo(
            version = ctx.attr.version,
            bazel_help = bazel_help,
        ),
    ]

bazel_version = rule(
    doc = "Defines information about a specific Bazel version from GitHub releases.",
    implementation = _bazel_version_impl,
    attrs = {
        "version": attr.string(
            doc = "str: Bazel version (e.g., '7.0.0')",
            mandatory = True,
        ),
        "commands": attr.string_list(
            doc = "list<str>: the set of commands to get",
            default = [
                "analyze-profile",
                "aquery",
                "build",
                "canonicalize-flags",
                "clean",
                "coverage",
                "cquery",
                "dump",
                "fetch",
                "help",
                "info",
                "license",
                "mobile-install",
                "mod",
                "print_action",
                "query",
                "run",
                "shutdown",
                "sync",
                "test",
                "vendor",
                "version",
                "startup_options",
            ],
        ),
        "_bazelhelpcompiler": attr.label(
            default = "//cmd/bazelhelpcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_bazelisk": attr.label(
            default = "//cmd/bazelisk",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [BazelVersionInfo],
)
