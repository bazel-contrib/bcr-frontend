"""starlark rule implementation of proto_rust_library"""

def _make_proto_rust_library_rule(rctx, pctx):
    srcs = [
        src
        for src in pctx.outputs
        if src.endswith(".rs")
    ]
    if len(srcs) == 0:
        return None

    # choose a representative from the list of srcs to get the proto package
    # name (assumed they all have the same package)
    rep = pctx.proto_library.files[0]
    pkg = rep.pkg.name

    r = gazelle.Rule(
        kind = "proto_rust_library",
        name = "%s_pb" % pkg.replace(".", "_"),
        attrs = {
            "srcs": srcs,
            "pkg": pkg,
            "deps": [],
            "visibility": rctx.visibility,
        },
    )
    return r

protoc.Rule(
    name = "proto_rust_library",
    load_info = lambda: gazelle.LoadInfo(
        name = "@monosol//bazel_tools/rust:proto_rust_library.bzl",
        symbols = ["proto_rust_library"],
    ),
    kind_info = lambda: gazelle.KindInfo(
        match_attrs = ["srcs"],
        non_empty_attrs = {"srcs": True},
        mergeable_attrs = {"srcs": True, "deps": True},
        resolve_attrs = {"deps": True},
    ),
    provide_rule = lambda rctx, pctx: struct(
        name = "proto_rust_library",
        rule = lambda: _make_proto_rust_library_rule(rctx, pctx),
        experimental_resolve_attr = "deps",
    ),
)
