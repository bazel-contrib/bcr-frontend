"""starlark plugin definitions"""

def _configure(ctx):
    """_configure prepares the PluginConfiguration for the builtin prost plugin.

    Args:
        ctx (protoc.PluginContext): The context object.
    Returns:
        config (PluginConfiguration): The configured PluginConfiguration object.
    """
    outputs = dict()
    for file in ctx.proto_library.files:
        outputs[file.pkg.name + ".rs"] = None

    config = protoc.PluginConfiguration(
        label = "@monosol//bazel_tools/rust:protoc-gen-prost",
        outputs = outputs.keys(),
        options = ctx.plugin_config.options,
    )

    return config

protoc.Plugin(
    name = "protoc-gen-prost",
    configure = _configure,
)
