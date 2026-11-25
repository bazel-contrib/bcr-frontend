"""starlark rule implementation of closure_jspb_library"""

def _closure_wkt_dep(proto_import):
    """Returns the jspb label for a google/protobuf import, if applicable."""
    prefix = "google/protobuf/"
    suffix = ".proto"
    if not proto_import.startswith(prefix) or not proto_import.endswith(suffix):
        return None
    name = proto_import[len(prefix):-len(suffix)]
    return "@protobufapis//google/protobuf:%s_js_proto" % name

def _closure_local_dep(proto_import):
    """Returns the jspb label for an import within the generated repository."""
    suffix = ".proto"
    if not proto_import.startswith("src/") or not proto_import.endswith(suffix):
        return None
    parts = proto_import.split("/")
    name = parts[-1][:-len(suffix)]
    package = "/".join(parts[:-1])
    return "//%s:%s_js_proto" % (package, name)

def _closure_wkt_deps(proto_files):
    deps = []
    for proto_file in proto_files:
        for proto_import in proto_file.imports:
            dep = _closure_wkt_dep(proto_import.filename)
            if dep == None:
                dep = _closure_local_dep(proto_import.filename)
            if dep != None:
                deps.append(dep)
    return deps

def _make_closure_jspb_library_rule(rctx, pctx):
    srcs = pctx.outputs
    if len(srcs) == 0:
        return None

    r = gazelle.Rule(
        kind = "closure_jspb_library",
        name = pctx.proto_library.base_name + "_js_proto",
        attrs = {
            "srcs": srcs,
            # Generate dependencies directly from the parsed imports. Do not
            # also run rules_proto's experimental resolver: it resolves the
            # same labels in canonical form and Bazel then reports duplicates.
            "deps": _closure_wkt_deps(pctx.proto_library.files),
            "internal_descriptors": [":" + pctx.proto_library.name],
            # protoc models enum values as named enum types while jspb's
            # reader/writer APIs accept primitive numbers. Newer Closure
            # compilers report that generated-code mismatch under checkTypes.
            "suppress": ["checkTypes"],
            "visibility": rctx.visibility,
        },
    )
    return r

protoc.Rule(
    name = "closure_jspb_library",
    load_info = lambda: gazelle.LoadInfo(
        name = "@stackb_rules_closure//closure/protobuf:defs.bzl",
        symbols = ["closure_jspb_library"],
    ),
    kind_info = lambda: gazelle.KindInfo(
        match_attrs = ["srcs"],
        non_empty_attrs = {"srcs": True},
        mergeable_attrs = {"srcs": True, "deps": True, "suppress": True},
        resolve_attrs = {"deps": True},
    ),
    provide_rule = lambda rctx, pctx: struct(
        name = "closure_jspb_library",
        rule = lambda: _make_closure_jspb_library_rule(rctx, pctx),
    ),
)
