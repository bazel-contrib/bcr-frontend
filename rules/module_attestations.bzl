"""Provides the module_attestations rule."""

load("//rules:providers.bzl", "ModuleAttestationsInfo")

def _module_attestations_impl(ctx):
    return [
        ModuleAttestationsInfo(
            media_type = ctx.attr.media_type,
            urls = ctx.attr.urls,
            integrities = ctx.attr.integrities,
            attestations_json = ctx.file.attestations_json,
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
    },
    provides = [ModuleAttestationsInfo],
)
