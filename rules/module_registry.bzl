"provides the module_registry rule"

load("@build_stack_rules_proto//rules:starlark_module_library.bzl", "StarlarkModuleLibraryInfo")
load(
    "//rules:providers.bzl",
    "BazelVersionInfo",
    "ModuleDependencyCycleInfo",
    "ModuleMetadataInfo",
    "ModuleRegistryInfo",
    "RouteInfo",
)
load("//rules:route_info.bzl", "route")

def _write_repos_json_action(ctx, deps):
    output = ctx.actions.declare_file(ctx.label.name + ".repos.json")

    repos = []
    for dep in deps:
        repos.extend(dep.repository)

    ctx.actions.write(output, json.encode(depset(repos).to_list()))

    return output

def _write_registry_languages_json_action(ctx, mds):
    output = ctx.actions.declare_file(ctx.label.name + ".languages.json")

    # Merge all language dictionaries
    languages = {}
    for md in mds:
        if getattr(md, "languages"):
            languages.update(md.languages)

    # Extract language names as a sorted list
    language_list = sorted(languages.keys())

    ctx.actions.write(output, json.encode(language_list))

    return output

def _write_prerender_urls_action(ctx, deps):
    """Emit a per-module prerender directive list (`<url> <paths>` per line).

    Each line tells the prerender pipeline to render `<url>` once and write
    the captured HTML to every comma-separated path in `<paths>`. For
    modules with a known latest version we render the versioned URL once
    and write to BOTH the versioned and unversioned output paths so
    `/modules/<name>/<latest>` and `/modules/<name>` serve the same
    prerendered HTML without rendering twice. Modules without an
    `is_latest_version=True` ModuleVersionInfo fall back to the unversioned
    URL with a single output path. Sorted alphabetically by module name.
    """
    output = ctx.actions.declare_file(ctx.label.name + ".prerender_urls.txt")

    sorted_deps = sorted(
        [d for d in deps if d.name],
        key = lambda d: d.name,
    )

    lines = []
    for d in sorted_deps:
        latest = None
        for mv in d.deps:
            if mv.is_latest_version:
                latest = mv.version
                break
        if latest:
            url = "/modules/{}/{}".format(d.name, latest)
            paths = "modules/{}/{}/index.html,modules/{}/index.html".format(
                d.name,
                latest,
                d.name,
            )
            lines.append(url + " " + paths)
        else:
            url = "/modules/" + d.name
            lines.append(url + " modules/" + d.name + "/index.html")

    ctx.actions.write(output, "\n".join(lines) + "\n")

    return output

# Minimum bazel version we extract help text for. Older versions had a
# different help format and aren't worth supporting in the flag DB.
_MIN_HELP_BAZEL_VERSION = (6, 0, 0)

def _is_allowed_bazel_help_release(v):
    """True iff v is a final stable release (no rc/pre) at or above _MIN_HELP_BAZEL_VERSION."""
    parts = v.split(".")
    if len(parts) != 3:
        return False
    for p in parts:
        if not p.isdigit():
            return False
    parsed = (int(parts[0]), int(parts[1]), int(parts[2]))
    return parsed >= _MIN_HELP_BAZEL_VERSION

def _compile_bazel_help_registry_action(ctx, bazel_versions):
    output = ctx.actions.declare_file("bazelhelpregistry.pb")
    want_versions = [v for v in bazel_versions if _is_allowed_bazel_help_release(v.version)]
    files = [v.bazel_help for v in want_versions]
    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add_all(files)

    ctx.actions.run(
        executable = ctx.executable._bazelhelpregistrycompiler,
        arguments = [args],
        inputs = files,
        outputs = [output],
        mnemonic = "CompileBazelHelpRegistry",
    )

    return output

def _compile_bazel_flag_db_action(ctx, bazelhelpregistry_pb):
    output = ctx.actions.declare_file("bazelflagdb.pb")
    args = ctx.actions.args()
    args.add("--output_file", output)
    args.add(bazelhelpregistry_pb)

    ctx.actions.run(
        executable = ctx.executable._bazelflagdbcompiler,
        arguments = [args],
        inputs = [bazelhelpregistry_pb],
        outputs = [output],
        mnemonic = "CompileBazelFlagDb",
    )

    return output

def _compile_codesearch_index_action(ctx, deps):
    output = ctx.actions.declare_file("csearchindex")
    files = []

    for module in deps:
        files.append(module.build_bazel)
        for mv in module.deps:
            files.append(mv.module_bazel)
            files.append(mv.build_bazel)
            # files.append(mv.source.source_json)

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add_all(files)

    ctx.actions.run(
        executable = ctx.executable._codesearchcompiler,
        arguments = [args],
        inputs = files,
        outputs = [output],
        mnemonic = "CompileCodesearchIndex",
    )

    return output

def _compile_module_registry_symbols(ctx, doc_results):
    output = ctx.actions.declare_file("symbols.pb")
    inputs = [result.output for result in doc_results if result.output != None]

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    for result in doc_results:
        if result.output != None:
            args.add("--input_file=%s=%s" % (result.mv.id, result.output.path))
        else:
            # Stub entry: signals "no .bzl files to extract" so the frontend
            # can render a blankslate without attempting a 404 fetch.
            args.add("--empty=%s" % result.mv.id)

    ctx.actions.run(
        executable = ctx.executable._moduleregistrysymbolscompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [output],
        mnemonic = "CompileModuleRegistrySymbols",
    )

    return output

def _compile_module_registry_packages(ctx, pkg_results):
    output = ctx.actions.declare_file("packages.pb")
    inputs = [result.output for result in pkg_results if result.output != None]

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    for result in pkg_results:
        if result.output != None:
            args.add("--input_file=%s=%s" % (result.mv.id, result.output.path))
        else:
            args.add("--empty=%s" % result.mv.id)

    ctx.actions.run(
        executable = ctx.executable._moduleregistrypackagescompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [output],
        mnemonic = "CompileModuleRegistryPackages",
    )

    return output

def _get_module_version_id_from_bzl_repository_repo_name(repo_name):
    parts = repo_name.split("+")
    if len(parts) == 0:
        return repo_name
    last_part = parts[len(parts) - 1]
    name_version = last_part[len("bzl."):]
    return name_version.replace("---", "@")

def _add_args_for_starlark_modules(args, module_name, starlark_modules, deps):
    for starlark_module in starlark_modules:
        arg = "--bzl_file=%s|%s|%s" % (module_name, starlark_module.label, starlark_module.src.path)
        args.add(arg)
    if len(deps) == 0:
        args.add("--module_dep=%s:NONE" % module_name)
    else:
        for dep in deps:
            args.add("--module_dep=%s:%s=%s" % (module_name, dep.name, dep.repo_name))

def _add_args_for_starlark_packages(args, module_name, starlark_packages, deps):
    for starlark_package in starlark_packages:
        arg = "--package_file=%s|%s|%s" % (module_name, starlark_package.label, starlark_package.src.path)
        args.add(arg)
    if len(deps) == 0:
        args.add("--module_dep=%s:NONE" % module_name)
    else:
        for dep in deps:
            args.add("--module_dep=%s:%s=%s" % (module_name, dep.name, dep.repo_name))

def _status_code_exists(code):
    return code >= 200 and code < 300

def _documentation_info_output_result(ctx, mv):
    # NOTE: the format can be controlled with the suffix (.pb, .json, .textproto, +/- .gz)
    output = ctx.actions.declare_file("%s/%s/documentationinfo.pb.gz" % (mv.name, mv.version))
    # output = ctx.actions.declare_file("%s/%s/documentationinfo.json" % (mv.name, mv.version))

    return struct(
        mv = mv,
        output = output,
    )

def _compile_stardoc_for_module_version(ctx, mv, files):
    if not files:
        return None

    result = _documentation_info_output_result(ctx, mv)

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(result.output)
    args.add_all(files)

    ctx.actions.run(
        executable = ctx.executable._stardoccompiler,
        arguments = [args],
        inputs = files,
        outputs = [result.output],
        mnemonic = "CompileStardocInfo",
    )

    return result

def _compile_bzl_for_module_version(ctx, mv, all_mv_by_id):
    """Generate documentation extraction action for a single module version.

    Args:
        ctx: The rule context
        mv: ModuleVersionInfo provider for the module version
        all_mv_by_id: dict k->v where k is string like "rules_cc@0.0.9" and v is the ModuleVersionInfo provider
    Returns:
        struct having the moduleVersionInfo and the output file for the documentation, or None if cannot generate
    """

    # Declare output file for this module version
    result = _documentation_info_output_result(ctx, mv)

    # JavaRuntimeInfo
    java_runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    java_executable = java_runtime.java_executable_exec_path

    # StarlarkModuleLibraryInfo
    bzl_builtins = ctx.attr._bzl_builtins[StarlarkModuleLibraryInfo]
    bzl_bazel_tools = ctx.attr._bzl_bazel_tools[StarlarkModuleLibraryInfo]

    # List[StarlarkModuleLibraryInfo]
    bzl_modules = [bzl_builtins, bzl_bazel_tools, mv.bzl_src] + mv.bzl_deps

    # List[DepSet]
    transitive_srcs = [depset([m.src for m in bzl_module.modules]) for bzl_module in bzl_modules]

    # DepSet[File]
    inputs = depset([ctx.file._starlarkserverjar], transitive = transitive_srcs)

    # Build arguments
    args = ctx.actions.args()
    args.use_param_file("@%s", use_always = True)
    args.set_param_file_format("multiline")

    args.add("--output_file", result.output)

    args.add("--java_interpreter_file", java_executable)
    args.add("--server_jar_file", ctx.file._starlarkserverjar)

    # use these for development
    #
    # git checkout /Users/pcj/go/src/github.com/pcj/bazel
    # git checkout master
    # bazel run //src/main/java/build/stack/devtools/build/constellate:server -- --listen_port=3535 2>&1 | tee starlarkserver.log
    # args.add("--port", 3524)  # e.g. java -jar ./cmd/bzlcompiler/constellate.jar --listen_port=3535

    # args.add("--error_limit=0")
    args.add("--log_file", "/tmp/bzlcompiler.log")

    # Add bzl_files and module_deps without flattening depsets

    # 1. Bazel tools and @_builtins
    _add_args_for_starlark_modules(args, "_builtins", bzl_builtins.modules, [])
    _add_args_for_starlark_modules(args, "bazel_tools", bzl_bazel_tools.modules, [])

    # 2. Root module (bzl_src)
    _add_args_for_starlark_modules(args, mv.name, mv.bzl_src.modules, mv.deps)

    # 3. Dependencies (bzl_deps)
    for starlark_module in mv.bzl_deps:
        id = _get_module_version_id_from_bzl_repository_repo_name(starlark_module.label.repo_name)
        module_version = all_mv_by_id.get(id)

        if not module_version:
            # buildifier: disable=print
            print("🔴 WARN for module %s, the module for bzl source dependency %s was not found!" % (module_version.id, starlark_module.label.repo_name))
            continue

        # buildifier: disable=print
        # print("🟢 module %s, the module for bzl source dependency is %s " % (dep_mv.id, bzl_dep.label.repo_name))

        _add_args_for_starlark_modules(args, module_version.name, starlark_module.modules, module_version.deps)

    # Add root module source files as positional arguments
    args.add_all(mv.bzl_src.srcs)

    # Run the action
    ctx.actions.run(
        mnemonic = "CompileModuleInfo",
        progress_message = "Extracting docs for %s@%s (%d files)" % (mv.name, mv.version, len(mv.bzl_src.srcs)),
        execution_requirements = {
            "supports-workers": "1",
            "requires-worker-protocol": "proto",
        },
        executable = ctx.executable._bzlcompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [result.output],
        tools = java_runtime.files.to_list(),
    )

    return result

def _packages_info_output_result(ctx, mv):
    output = ctx.actions.declare_file("%s/%s/packageinfo.pb.gz" % (mv.name, mv.version))

    # output = ctx.actions.declare_file("%s/%s/packageinfo.json" % (mv.name, mv.version))
    return struct(
        mv = mv,
        output = output,
    )

def _compile_packages_for_module_version(ctx, mv, all_mv_by_id):
    """Generate BUILD-file extraction action for a single module version.

    Args:
        ctx: The rule context
        mv: ModuleVersionInfo provider for the module version
        all_mv_by_id: dict k->v where k is string like "rules_cc@0.0.9" and v is the ModuleVersionInfo provider
    Returns:
        struct having the moduleVersionInfo and the output file for the packages, or None if cannot generate
    """
    if not mv.pkg_src or len(mv.pkg_src.srcs) == 0:
        return None

    result = _packages_info_output_result(ctx, mv)

    java_runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    java_executable = java_runtime.java_executable_exec_path

    # PackageInfo evaluates BUILD files but still walks transitive .bzl loads,
    # so we feed it the same baseline as bzlcompiler.
    bzl_builtins = ctx.attr._bzl_builtins[StarlarkModuleLibraryInfo]
    bzl_bazel_tools = ctx.attr._bzl_bazel_tools[StarlarkModuleLibraryInfo]

    bzl_modules = [bzl_builtins, bzl_bazel_tools]
    if mv.bzl_src:
        bzl_modules.append(mv.bzl_src)
    bzl_modules.extend(mv.bzl_deps)

    transitive_srcs = [depset([m.src for m in bzl_module.modules]) for bzl_module in bzl_modules]
    transitive_pkg_srcs = [depset([p.src for p in mv.pkg_src.packages])]
    for pkg_dep in mv.pkg_deps:
        transitive_pkg_srcs.append(depset([p.src for p in pkg_dep.packages]))

    inputs = depset(
        [ctx.file._starlarkserverjar],
        transitive = transitive_srcs + transitive_pkg_srcs,
    )

    args = ctx.actions.args()
    args.use_param_file("@%s", use_always = True)
    args.set_param_file_format("multiline")

    args.add("--output_file", result.output)
    args.add("--java_interpreter_file", java_executable)
    args.add("--server_jar_file", ctx.file._starlarkserverjar)
    args.add("--log_file", "/tmp/packagecompiler.log")

    # bazel run //src/main/java/build/stack/devtools/build/constellate:server -- --listen_port=3535 2>&1 | tee starlarkserver.log
    # args.add("--port", 3524)  # e.g. java -jar ./cmd/bzlcompiler/constellate.jar --listen_port=3535

    # 1. Bazel tools and @_builtins (shared .bzl baseline for load resolution).
    _add_args_for_starlark_modules(args, "_builtins", bzl_builtins.modules, [])
    _add_args_for_starlark_modules(args, "bazel_tools", bzl_bazel_tools.modules, [])

    # 2. Root module's .bzl files so loads from the BUILD files resolve.
    if mv.bzl_src:
        _add_args_for_starlark_modules(args, mv.name, mv.bzl_src.modules, mv.deps)

    # 3. Dependency .bzl files.
    for starlark_module in mv.bzl_deps:
        id = _get_module_version_id_from_bzl_repository_repo_name(starlark_module.label.repo_name)
        module_version = all_mv_by_id.get(id)
        if not module_version:
            continue
        _add_args_for_starlark_modules(args, module_version.name, starlark_module.modules, module_version.deps)

    # 4. Root module's BUILD (.package) files.
    _add_args_for_starlark_packages(args, mv.name, mv.pkg_src.packages, mv.deps)

    # 5. Dependency BUILD (.package) files.
    for starlark_package in mv.pkg_deps:
        id = _get_module_version_id_from_bzl_repository_repo_name(starlark_package.label.repo_name)
        module_version = all_mv_by_id.get(id)
        if not module_version:
            continue
        _add_args_for_starlark_packages(args, module_version.name, starlark_package.packages, module_version.deps)

    # Positional args are the .package files to extract.
    args.add_all(mv.pkg_src.srcs)

    ctx.actions.run(
        mnemonic = "CompilePackageInfo",
        progress_message = "Extracting packages for %s@%s (%d files)" % (mv.name, mv.version, len(mv.pkg_src.srcs)),
        execution_requirements = {
            "supports-workers": "1",
            "requires-worker-protocol": "proto",
        },
        executable = ctx.executable._packagecompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [result.output],
        tools = java_runtime.files.to_list(),
    )

    return result

def _compile_packages(ctx, deps):
    all_mv_by_id = {}
    for m in deps:
        for mv in m.deps:
            all_mv_by_id[mv.id] = mv

    results = []
    for module in deps:
        for mv in module.deps:
            result = _compile_packages_for_module_version(ctx, mv, all_mv_by_id)
            if result:
                results.append(result)
            else:
                # Stub so the registry-wide aggregation can record an empty
                # entry the same way symbols does.
                results.append(struct(mv = mv, output = None))
    return results

def _compile_builtin_info(ctx):
    """Call constellate's BuiltinInfo RPC and reshape the response into a ModuleVersionSymbols .pb for @_builtins.

    The RPC returns both Bazel's complete-but-thin builtin.Builtins proto
    and six rich language-module ModuleInfo protos (cpp, java, objc,
    proto, python, shell). The tool reshapes the builtins payload into
    symbol form AND enriches each Rule's attribute list with stardoc
    AttributeType + docstring info from the matching ModuleInfo entries.
    The result fans out across every _builtins/<v> module-version downstream
    (moduleregistrysymbolscompiler stamps the name+version per-call).
    """
    output = ctx.actions.declare_file("_builtins.symbols.pb")
    java_runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    java_executable = java_runtime.java_executable_exec_path
    args = ctx.actions.args()
    args.use_param_file("@%s", use_always = True)
    args.set_param_file_format("multiline")
    args.add("--output_file", output)
    args.add("--java_interpreter_file", java_executable)
    args.add("--server_jar_file", ctx.file._starlarkserverjar)
    args.add("--log_file", ctx.label.name + ".builtininfo")
    # args.add("--port", 3524)

    ctx.actions.run(
        executable = ctx.executable._builtininfocompiler,
        arguments = [args],
        inputs = depset([ctx.file._starlarkserverjar]),
        outputs = [output],
        mnemonic = "CompileBuiltinInfo",
        tools = java_runtime.files.to_list(),
    )
    return output

def _compile_documentation_for_module_version(ctx, mv, all_mv_by_id, builtins_symbols):
    # The @_builtins pseudo-module's documentation comes from a single
    # action that calls constellate's BuiltinInfo RPC and reshapes the
    # response (complete builtins + rich rule attribute info from the six
    # language ModuleInfos) into ModuleVersionSymbols. See
    # _compile_builtin_info above.
    if mv.name == "_builtins":
        return struct(mv = mv, output = builtins_symbols)

    # if the module_source has published / "offical" docs, use those
    # (assuming the doc link isn't broken).
    if len(mv.published_docs) > 0 and _status_code_exists(mv.source.docs_url_status_code):
        return _compile_stardoc_for_module_version(ctx, mv, mv.published_docs)

    # otherwise best effort if there is something to compile
    if mv.bzl_src and len(mv.bzl_src.srcs) > 0:
        return _compile_bzl_for_module_version(ctx, mv, all_mv_by_id)

    # Module version has no .bzl files to extract. Return a stub so the
    # registry-wide aggregation records an empty BEST_EFFORT entry — the
    # frontend uses this to render "Module contains no .bzl module files"
    # instead of attempting a guaranteed-404 per-version fetch.
    return struct(mv = mv, output = None)

def _compile_documentation_for_module(ctx, module, all_mv_by_id, builtins_symbols):
    results = []
    for mv in module.deps:
        result = _compile_documentation_for_module_version(ctx, mv, all_mv_by_id, builtins_symbols)
        if result:
            results.append(result)
    return results

def _compile_documentation(ctx, deps):
    all_mv_by_id = {}
    for m in deps:
        for mv in m.deps:
            all_mv_by_id[mv.id] = mv

    # Reshape the Bazel builtins snapshot once; reused for every _builtins/<v>.
    builtins_symbols = _compile_builtin_info(ctx)

    results = []
    for module in deps:
        results.extend(_compile_documentation_for_module(ctx, module, all_mv_by_id, builtins_symbols))
    return results

def _compile_colors_action(ctx, colors_json, languages_json):
    output = ctx.actions.declare_file(ctx.label.name + ".colors.css")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--colors_json_file")
    args.add(colors_json)
    args.add("--languages_json_file")
    args.add(languages_json)

    ctx.actions.run(
        executable = ctx.executable._colorcompiler,
        arguments = [args],
        inputs = [colors_json, languages_json],
        outputs = [output],
        mnemonic = "CompileColors",
        progress_message = "Compiling css colors for languages",
    )

    return output

def _compile_sitemap_action(ctx, registry_pb, bazel_flag_db_pb):
    output = ctx.actions.declare_file("sitemap.xml")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--registry_file")
    args.add(registry_pb)
    args.add("--base_url")
    args.add(ctx.attr.registry_url)
    args.add("--bazel_flag_db_file")
    args.add(bazel_flag_db_pb)

    ctx.actions.run(
        executable = ctx.executable._sitemapcompiler,
        arguments = [args],
        inputs = [registry_pb, bazel_flag_db_pb],
        outputs = [output],
        mnemonic = "CompileSitemap",
        progress_message = "Compiling sitemap",
    )

    return output

_STATIC_TOP_LEVEL_ROUTES = [
    route(loc = "/", priority = 1.0, changefreq = "daily"),
    route(loc = "/modules", priority = 0.9, changefreq = "daily"),
    route(loc = "/bazel", priority = 0.9, changefreq = "weekly"),
    route(loc = "/bazel/versions", priority = 0.9, changefreq = "weekly"),
    route(loc = "/bazel/versions/versions", priority = 0.9, changefreq = "weekly"),
    route(loc = "/bazel/flags", priority = 0.9, changefreq = "weekly"),
    route(loc = "/bazel/flags/list", priority = 0.9, changefreq = "weekly"),
    route(loc = "/bazel/flags/list/categories", priority = 0.9, changefreq = "weekly"),
    route(loc = "/bazel/flags/list/tags", priority = 0.9, changefreq = "weekly"),
    route(loc = "/targets", priority = 0.7, changefreq = "weekly"),
]

def _route_to_dict(r):
    """Converts a route struct into a plain dict for json.encode.

    Starlark structs don't serialize directly via json.encode, so we flatten
    each route into a dict immediately before writing the routes manifest.
    """
    return {
        "loc": r.loc,
        "lastmod": r.lastmod,
        "priority": r.priority,
        "changefreq": r.changefreq,
    }

def _compile_sitemap_index_action(ctx):
    """Produces sitemap.xml.gz + sitemapindex.xml from aggregated RouteInfo.

    Aggregates RouteInfo across all module dependencies, writes the merged
    routes manifest, and runs cmd/sitemapindexcompiler. Lands alongside the
    existing sitemap.xml from _compile_sitemap_action — the two pipelines
    coexist during the migration.
    """
    transitive_routes = [dep[RouteInfo].routes for dep in ctx.attr.deps if RouteInfo in dep]
    all_routes = depset(
        direct = _STATIC_TOP_LEVEL_ROUTES,
        transitive = transitive_routes,
    )

    routes_json = ctx.actions.declare_file("routes.json")
    ctx.actions.write(
        routes_json,
        json.encode([_route_to_dict(r) for r in all_routes.to_list()]),
    )

    sitemap_gz = ctx.actions.declare_file("sitemap.xml.gz")
    sitemap_index = ctx.actions.declare_file("sitemapindex.xml")

    args = ctx.actions.args()
    args.add("--routes_file", routes_json)
    args.add("--base_url", ctx.attr.registry_url)
    args.add("--sitemap_output", sitemap_gz)
    args.add("--sitemapindex_output", sitemap_index)
    args.add("--sitemap_url", ctx.attr.registry_url + "/sitemap.xml.gz")

    ctx.actions.run(
        executable = ctx.executable._sitemapindexcompiler,
        arguments = [args],
        inputs = [routes_json],
        outputs = [sitemap_gz, sitemap_index],
        mnemonic = "CompileSitemapIndex",
        progress_message = "Compiling sitemap index",
    )
    return sitemap_gz, sitemap_index, routes_json

def _write_robots_txt_action(ctx):
    output = ctx.actions.declare_file("robots.txt")

    ctx.actions.write(output, """User-agent: *
Allow: /
Disallow: /settings
Sitemap: {registry_url}/sitemap.xml
""".format(
        registry_url = ctx.attr.registry_url,
    ))

    return output

def _compile_registry_action(ctx, filename, modules, symbols = None):
    output = ctx.actions.declare_file(filename)
    inputs = [] + modules

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--registry_url")
    args.add(ctx.attr.registry_url)
    if symbols:
        args.add("--documentation_registry_file")
        args.add(symbols)
        inputs.append(symbols)
    if ctx.attr.repository_url:
        args.add("--repository_url")
        args.add(ctx.attr.repository_url)
    if ctx.attr.branch:
        args.add("--branch")
        args.add(ctx.attr.branch)
    if ctx.attr.commit:
        args.add("--commit")
        args.add(ctx.attr.commit)
    if ctx.attr.commit_date:
        args.add("--commit_date")
        args.add(ctx.attr.commit_date)
    args.add_all(modules)

    ctx.actions.run(
        executable = ctx.executable._registrycompiler,
        arguments = [args],
        inputs = inputs,
        outputs = [output],
        mnemonic = "CompileRegistry",
        progress_message = "Compiling registry for %{label}",
    )

    return output

def _module_registry_impl(ctx):
    deps = [d[ModuleMetadataInfo] for d in ctx.attr.deps]
    cycles = [d[ModuleDependencyCycleInfo] for d in ctx.attr.cycles]
    bazel_versions = [d[BazelVersionInfo] for d in ctx.attr.bazel_versions]

    modules = [d.proto for d in deps]
    repository_metadatas = [dep.repository_metadata for dep in deps if dep.repository_metadata]

    repos_json = _write_repos_json_action(ctx, deps)
    languages_json = _write_registry_languages_json_action(ctx, repository_metadatas)
    colors_css = _compile_colors_action(ctx, ctx.file._colors_json, languages_json)
    robots_txt = _write_robots_txt_action(ctx)
    codesearch_index = _compile_codesearch_index_action(ctx, deps)
    doc_results = _compile_documentation(ctx, deps)
    symbols_pb = _compile_module_registry_symbols(ctx, doc_results)
    pkg_results = _compile_packages(ctx, deps)
    packages_pb = _compile_module_registry_packages(ctx, pkg_results)
    registry_pb = _compile_registry_action(ctx, "registry.pb", modules, symbols_pb)
    registrylite_pb = _compile_registry_action(ctx, "registrylite.pb", modules)

    bazel_help = _compile_bazel_help_registry_action(ctx, bazel_versions)
    bazel_flag_db = _compile_bazel_flag_db_action(ctx, bazel_help)
    sitemap_xml = _compile_sitemap_action(ctx, registry_pb, bazel_flag_db)
    sitemap_gz, sitemap_index, routes_json = _compile_sitemap_index_action(ctx)
    prerender_urls = _write_prerender_urls_action(ctx, deps)

    # Per-module-version output groups.
    per_mv_output_groups = {}
    for d in doc_results:
        if d.output != None:
            per_mv_output_groups[d.mv.id.replace("@", "-") + ".moduleinfo"] = depset([d.output])
    for p in pkg_results:
        if p.output != None:
            per_mv_output_groups[p.mv.id.replace("@", "-") + ".packageinfo"] = depset([p.output])

    # for k in per_mv_output_groups.keys():
    #     print("output_group: %s" % k)

    return [
        DefaultInfo(files = depset([registry_pb])),
        OutputGroupInfo(
            repos_json = [repos_json],
            languages_json = [languages_json],
            colors_css = [colors_css],
            sitemap_xml = [sitemap_xml],
            sitemap_gz = [sitemap_gz],
            sitemapindex_xml = [sitemap_index],
            routes_json = [routes_json],
            prerender_urls = [prerender_urls],
            robots_txt = [robots_txt],
            registry_pb = [registry_pb],
            registrylite_pb = [registrylite_pb],
            codesearch_index = [codesearch_index],
            doc_results = depset([d.output for d in doc_results if d.output != None]),
            docs = depset([r.output for r in doc_results if r.output != None]),
            symbols_pb = depset([symbols_pb]),
            packages_pb = depset([packages_pb]),
            pkg_results = depset([r.output for r in pkg_results if r.output != None]),
            bazel_help = depset([bazel_help]),
            bazel_flag_db = depset([bazel_flag_db]),
            **per_mv_output_groups
        ),
        ModuleRegistryInfo(
            deps = depset(deps),
            cycles = depset(cycles),
            proto = registry_pb,
            repository_url = ctx.attr.repository_url,
            registry_url = ctx.attr.registry_url,
            branch = ctx.attr.branch,
            commit = ctx.attr.commit,
            commit_date = ctx.attr.commit_date,
        ),
    ]

module_registry = rule(
    implementation = _module_registry_impl,
    attrs = {
        "deps": attr.label_list(providers = [ModuleMetadataInfo]),
        "cycles": attr.label_list(providers = [ModuleDependencyCycleInfo]),
        "bazel_versions": attr.label_list(
            doc = "List of bazel_version targets",
            providers = [BazelVersionInfo],
        ),
        "repository_url": attr.string(doc = "Repository URL of the registry (e.g. 'https://github.com/bazelbuild/bazel-central-registry')"),
        "registry_url": attr.string(doc = "URL of the registry UI (e.g. 'https://registry.bazel.build')", mandatory = True),
        "branch": attr.string(doc = "Branch name of the repository data (e.g. 'main')"),
        "commit": attr.string(doc = "Commit sha1 of the repository data"),
        "commit_date": attr.string(doc = "Timestamp of the commit date (same format as: git log --format='%ci')"),
        "_colors_json": attr.label(
            default = "@com_github_ozh_github_colors//:colors_json",
            allow_single_file = True,
        ),
        "_registrycompiler": attr.label(
            default = "//cmd/registrycompiler",
            executable = True,
            cfg = "exec",
        ),
        "_colorcompiler": attr.label(
            default = "//cmd/colorcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_sitemapcompiler": attr.label(
            default = "//cmd/sitemapcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_sitemapindexcompiler": attr.label(
            default = "//cmd/sitemapindexcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_codesearchcompiler": attr.label(
            default = "//cmd/codesearchcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_stardoccompiler": attr.label(
            default = "//cmd/stardoccompiler",
            executable = True,
            cfg = "exec",
        ),
        "_bzlcompiler": attr.label(
            default = "//cmd/bzlcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_packagecompiler": attr.label(
            default = "//cmd/packagecompiler",
            executable = True,
            cfg = "exec",
        ),
        "_moduleregistrysymbolscompiler": attr.label(
            default = "//cmd/moduleregistrysymbolscompiler",
            executable = True,
            cfg = "exec",
        ),
        "_builtininfocompiler": attr.label(
            default = "//cmd/builtininfocompiler",
            executable = True,
            cfg = "exec",
        ),
        "_moduleregistrypackagescompiler": attr.label(
            default = "//cmd/moduleregistrypackagescompiler",
            executable = True,
            cfg = "exec",
        ),
        "_bazelhelpregistrycompiler": attr.label(
            default = "//cmd/bazelhelpregistrycompiler",
            executable = True,
            cfg = "exec",
        ),
        "_bazelflagdbcompiler": attr.label(
            default = "//cmd/bazelflagdbcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_java_runtime": attr.label(
            default = "@bazel_tools//tools/jdk:current_java_runtime",
            cfg = "exec",
            providers = [java_common.JavaRuntimeInfo],
        ),
        "_starlarkserverjar": attr.label(
            default = "@constellate_server_jar//jar:file",
            allow_single_file = True,
        ),
        "_bzl_bazel_tools": attr.label(
            default = "@bzl.bazel_tools//tools:modules",
            providers = [StarlarkModuleLibraryInfo],
        ),
        "_bzl_builtins": attr.label(
            default = "@bzl.bazel_tools//src/main/starlark/builtins_bzl:modules",
            providers = [StarlarkModuleLibraryInfo],
        ),
    },
    provides = [ModuleRegistryInfo],
)
