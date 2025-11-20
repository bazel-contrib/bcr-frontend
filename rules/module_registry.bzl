"provides the module_registry rule"

load("//rules:providers.bzl", "ModuleDependencyCycleInfo", "ModuleMetadataInfo", "ModuleRegistryInfo")

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

def _compile_codesearch_index_action(ctx, deps):
    output = ctx.actions.declare_file("csearchindex")
    files = []

    for module in deps:
        files.append(module.build_bazel)
        for mv in module.deps.to_list():
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

def _compile_static_html_action(ctx, deps):
    outputs = []

    for module in deps:
        urls = []
        outs = []

        for mv in module.deps.to_list():
            output = ctx.actions.declare_file("static/modules/%s/%s/index.html" % (mv.name, mv.version))
            outs.append(output)
            url = "http://localhost:8080/modules/%s/%s" % (mv.name, mv.version)
            urls.append(url)

        args = ctx.actions.args()
        args.add_all(outs, before_each = "--output_file")
        args.add_all(urls, before_each = "--url")

        ctx.actions.run(
            executable = ctx.executable._statichtmlcompiler,
            arguments = [args],
            outputs = outs,
            mnemonic = "CompileStaticHtml",
        )

        outputs.extend(outs)

    return outputs

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

def _compile_sitemap_action(ctx, registry_pb):
    output = ctx.actions.declare_file("sitemap.xml")

    # Build arguments for the compiler
    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--registry_file")
    args.add(registry_pb)
    args.add("--base_url")
    args.add(ctx.attr.registry_url)

    ctx.actions.run(
        executable = ctx.executable._sitemapcompiler,
        arguments = [args],
        inputs = [registry_pb],
        outputs = [output],
        mnemonic = "CompileSitemap",
        progress_message = "Compiling sitemap",
    )

    return output

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

def _compile_action(ctx, modules):
    output = ctx.actions.declare_file("registry.pb")

    args = ctx.actions.args()
    args.add("--output_file")
    args.add(output)
    args.add("--registry_url")
    args.add(ctx.attr.registry_url)
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
        executable = ctx.executable._compiler,
        arguments = [args],
        inputs = modules,
        outputs = [output],
        mnemonic = "CompileRegistry",
        progress_message = "Compiling registry for %{label}",
    )

    return output

def _module_registry_impl(ctx):
    deps = [d[ModuleMetadataInfo] for d in ctx.attr.deps]
    cycles = [d[ModuleDependencyCycleInfo] for d in ctx.attr.cycles]
    modules = [d.proto for d in deps]
    repository_metadatas = [dep.repository_metadata for dep in deps if dep.repository_metadata]

    registry_pb = _compile_action(ctx, modules)
    repos_json = _write_repos_json_action(ctx, deps)
    languages_json = _write_registry_languages_json_action(ctx, repository_metadatas)
    colors_css = _compile_colors_action(ctx, ctx.file._colors_json, languages_json)
    sitemap_xml = _compile_sitemap_action(ctx, registry_pb)
    robots_txt = _write_robots_txt_action(ctx)
    static_html = _compile_static_html_action(ctx, deps)
    codesearch_index = _compile_codesearch_index_action(ctx, deps)

    return [
        DefaultInfo(files = depset([registry_pb])),
        OutputGroupInfo(
            repos_json = [repos_json],
            languages_json = [languages_json],
            colors_css = [colors_css],
            sitemap_xml = [sitemap_xml],
            robots_txt = [robots_txt],
            registry_pb = [registry_pb],
            static_html = static_html,
            codesearch_index = [codesearch_index],
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
        "repository_url": attr.string(doc = "Repository URL of the registry (e.g. 'https://github.com/bazelbuild/bazel-central-registry')"),
        "registry_url": attr.string(doc = "URL of the registry UI (e.g. 'https://registry.bazel.build')", mandatory = True),
        "branch": attr.string(doc = "Branch name of the repository data (e.g. 'main')"),
        "commit": attr.string(doc = "Commit sha1 of the repository data"),
        "commit_date": attr.string(doc = "Timestamp of the commit date (same format as: git log --format='%ci')"),
        "_colors_json": attr.label(
            default = "@com_github_ozh_github_colors//:colors_json",
            allow_single_file = True,
        ),
        "_compiler": attr.label(
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
        "_statichtmlcompiler": attr.label(
            default = "//cmd/statichtmlcompiler",
            executable = True,
            cfg = "exec",
        ),
        "_codesearchcompiler": attr.label(
            default = "//cmd/codesearchcompiler",
            executable = True,
            cfg = "exec",
        ),
    },
    provides = [ModuleRegistryInfo],
)
