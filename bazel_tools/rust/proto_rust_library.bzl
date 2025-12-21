load("@rules_rust//rust:defs.bzl", "rust_library")

def _proto_rust_lib_impl(ctx):
    lines = [
        """
""",
    ]
    parts = ctx.attr.pkg.split(".")
    for part in parts:
        lines.append("pub mod %s {" % part)
    for file in ctx.files.srcs:
        if file.basename.endswith(".tonic.rs"):
            continue  # it's already include!d in the proto generated source
        if file.basename.endswith(".serde.rs"):
            continue  # it's already include!d in the proto generated source
        lines.append("""include!("%s");""" % file.basename)

    for part in parts:
        lines.append("}")

    ctx.actions.write(ctx.outputs.lib, "\n".join(lines))

    return [
        DefaultInfo(
            files = depset([ctx.outputs.lib]),
        ),
    ]

_proto_rust_lib = rule(
    implementation = _proto_rust_lib_impl,
    attrs = {
        "srcs": attr.label_list(
            allow_files = True,
            mandatory = True,
            doc = "generated srcs",
        ),
        "pkg": attr.string(
            doc = "name of proto package, used to determine pub heirarchy",
            mandatory = True,
        ),
    },
    outputs = {
        "lib": "%{name}.lib.rs",
    },
)

def proto_rust_library(name, **kwargs):
    lib_name = name + "_lib"

    srcs = kwargs.pop("srcs", [])
    deps = kwargs.pop("deps", [])
    rustc_flags = kwargs.pop("rustc_flags", [])

    pkg = kwargs.pop("pkg", "")
    if not pkg:
        fail("pkg attribute is required (proto package name for this library)")

    _proto_rust_lib(
        name = lib_name,
        srcs = srcs,
        pkg = pkg,
    )

    rust_library(
        name = name,
        crate_root = lib_name,
        srcs = srcs,
        deps = deps + [
            "@crates//:prost",
            "@crates//:serde",
            "@crates//:pbjson",
        ],
        rustc_flags = [
            "-A",
            "clippy::needless_lifetimes",
            "-A",
            "non_snake_case",
        ] + rustc_flags,
        **kwargs
    )
