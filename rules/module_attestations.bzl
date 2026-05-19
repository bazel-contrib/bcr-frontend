"""Provides the module_attestations rule."""

load("//rules:providers.bzl", "ModuleAttestationsInfo")

def _compile_action(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".attestations.pb")

    args = ctx.actions.args()
    args.add("--attestations_json_file", ctx.file.attestations_json)
    args.add("--output_file", out)

    inputs = [ctx.file.attestations_json]
    # PR 3 will append --intoto_file=<filename>=<path> per fetched .intoto.jsonl
    # bundle. Until then, the compiler emits a proto whose entries carry url +
    # integrity but no parsed payload.

    ctx.actions.run(
        executable = ctx.executable._attestationscompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [out],
        mnemonic = "CompileAttestations",
        progress_message = "Compiling attestations for %{label}",
    )
    return out

def _module_attestations_impl(ctx):
    proto = _compile_action(ctx)
    return [
        DefaultInfo(files = depset([proto])),
        ModuleAttestationsInfo(
            media_type = ctx.attr.media_type,
            urls = ctx.attr.urls,
            integrities = ctx.attr.integrities,
            attestations_json = ctx.file.attestations_json,
            proto = proto,
        ),
    ]

module_attestations = rule(
    doc = "Defines attestation information for a module version.",
    implementation = _module_attestations_impl,
    attrs = {
        "media_type": attr.string(
            doc = "str: Media type for the attestations file",
        ),
        "urls": attr.string_dict(
            doc = "dict[str, str]: Mapping of filename to attestation URL",
        ),
        "integrities": attr.string_dict(
            doc = "dict[str, str]: Mapping of filename to attestation integrity hash",
        ),
        "attestations_json": attr.label(
            doc = "File: The attestations.json file",
            allow_single_file = [".json"],
        ),
        "_attestationscompiler": attr.label(
            default = "//cmd/attestationscompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleAttestationsInfo],
)
