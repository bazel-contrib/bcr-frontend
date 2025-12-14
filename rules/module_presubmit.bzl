"""Provides the module_presubmit rule."""

load("//rules:providers.bzl", "ModulePresubmitInfo")

def _module_presubmit_impl(ctx):
    return [
        ModulePresubmitInfo(
            presubmit_yml = ctx.file.presubmit_yml,
        ),
    ]

module_presubmit = rule(
    doc = "Defines presubmit configuration for a module version.",
    implementation = _module_presubmit_impl,
    attrs = {
        "presubmit_yml": attr.label(
            doc = "File: The presubmit.yml configuration file",
            allow_single_file = [".yml", ".yaml"],
        ),
    },
    provides = [ModulePresubmitInfo],
)
