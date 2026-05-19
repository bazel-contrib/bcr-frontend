"""Provides the module_attestations rule."""

load("//rules:providers.bzl", "ModuleAttestationsInfo")

# Suffix appended by attestation http_file rules to their downloaded files
# (downloaded_file_path = "<entry-filename>.intoto.jsonl"). The _compile_action
# strips this suffix to recover the original attestations.json entry filename.
_INTOTO_SUFFIX = ".intoto.jsonl"

def _compile_action(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".attestations.pb")

    args = ctx.actions.args()
    args.add("--attestations_json_file", ctx.file.attestations_json)
    args.add("--output_file", out)

    inputs = [ctx.file.attestations_json]

    # Pass each fetched .intoto.jsonl as --intoto_file=<entry-filename>=<path>.
    # The entry filename is recovered from the file's basename: Gazelle emits
    # http_file rules with downloaded_file_path = "<entry-filename>.intoto.jsonl",
    # so stripping the trailing suffix yields the original key (e.g. "source.json",
    # "MODULE.bazel", "re.bzl-v0.2.0.tar.gz").
    for f in ctx.files.attestations_intoto:
        if not f.basename.endswith(_INTOTO_SUFFIX):
            fail("attestation file %s does not end with %s" % (f.path, _INTOTO_SUFFIX))
        entry_filename = f.basename[:-len(_INTOTO_SUFFIX)]
        args.add("--intoto_file", "%s=%s" % (entry_filename, f.path))
        inputs.append(f)

    # Entries whose .intoto.jsonl URL was dead at Gazelle time. The compiler
    # records these as Attestation.Payload.ParseError so the frontend can
    # distinguish "URL unavailable" from "not yet parsed".
    for entry_filename in ctx.attr.unavailable_entries:
        args.add("--unavailable_entry", entry_filename)

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
        "attestations_intoto": attr.label_list(
            doc = "list[Label]: Fetched .intoto.jsonl bundles, one per live entry in attestations.json. Each label resolves to a file named '<entry-filename>.intoto.jsonl'.",
            allow_files = [".jsonl"],
        ),
        "unavailable_entries": attr.string_list(
            doc = "list[str]: Entries from attestations.json whose .intoto.jsonl URL was dead at Gazelle time. The compiler emits an Attestation with Payload.ParseError set instead of a parsed payload.",
        ),
        "_attestationscompiler": attr.label(
            default = "//cmd/attestationscompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleAttestationsInfo],
)
