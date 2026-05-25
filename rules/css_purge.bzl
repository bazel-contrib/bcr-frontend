"""css_purge — tree-shake a vendor CSS file by scanning project sources.

Two-action pipeline:

  1. //cmd/cssusage scans `scan_sources` for class-name tokens that also
     appear as selectors in `src`. Output: one-name-per-line text file.
     Intersecting with the CSS's own class set avoids hand-curated prefix
     allow-lists — anything in the CSS that nothing in scan_sources
     references is a candidate for removal.

  2. //cmd/csspurge uses lightningcss to parse `src`, drop rules whose
     selectors reference no used class, and re-emit minified CSS. Global
     selectors (`:root`, `*`, `html`, `body`, tag-only, `@keyframes`,
     `@font-face`, `@font-palette-values`, `@property`, etc.) are kept
     unconditionally — see selector_matches() in cmd/csspurge/src/main.rs.

The optional `safelist` is a file with one class name per line (`#` lines
ignored) — entries get added to the used set regardless of whether the
scan turned them up. Use this for dynamically-constructed class names
that static scanning misses (e.g. `mt-${n}` templating in JS).
"""

def _css_purge_impl(ctx):
    used = ctx.actions.declare_file(ctx.label.name + ".used.txt")

    # Preserve the source's basename — releasecompiler's hashed-filename
    # placeholder lookup (e.g. `{primer.css}` in index.html) matches on
    # the original basename, so renaming here would break the substitution.
    out = ctx.actions.declare_file(ctx.label.name + "/" + ctx.file.src.basename)

    # Stage 1: scan project sources for class-name references that appear
    # in the source CSS's own selectors.
    usage_args = ctx.actions.args()
    usage_args.add("--css", ctx.file.src)
    usage_args.add("--output", used)
    for s in ctx.files.scan_sources:
        usage_args.add("--source", s)
    if ctx.file.safelist:
        usage_args.add("--safelist", ctx.file.safelist)

    usage_inputs = [ctx.file.src] + ctx.files.scan_sources
    if ctx.file.safelist:
        usage_inputs.append(ctx.file.safelist)
    ctx.actions.run(
        executable = ctx.executable._cssusage,
        arguments = [usage_args],
        inputs = usage_inputs,
        outputs = [used],
        mnemonic = "CssUsageScan",
        progress_message = "Scanning %d sources for CSS class references" % len(ctx.files.scan_sources),
    )

    # Stage 2: filter the CSS by the used-class list.
    purge_args = ctx.actions.args()
    purge_args.add("--input", ctx.file.src)
    purge_args.add("--used", used)
    purge_args.add("--output", out)
    ctx.actions.run(
        executable = ctx.executable._csspurge,
        arguments = [purge_args],
        inputs = [ctx.file.src, used],
        outputs = [out],
        mnemonic = "CssPurge",
        progress_message = "Purging %s by %s" % (ctx.file.src.short_path, used.short_path),
    )

    return [DefaultInfo(files = depset([out]))]

css_purge = rule(
    implementation = _css_purge_impl,
    doc = "Tree-shake a CSS file by scanning project sources for referenced class names.",
    attrs = {
        "src": attr.label(
            allow_single_file = [".css"],
            mandatory = True,
            doc = "Input CSS file (e.g. a vendor stylesheet like primer.css).",
        ),
        "scan_sources": attr.label_list(
            allow_files = True,
            doc = "Project source files to scan for class-name references.",
        ),
        "safelist": attr.label(
            allow_single_file = True,
            doc = "Optional file with extra class names to keep, one per line.",
        ),
        "_cssusage": attr.label(
            default = "//cmd/cssusage",
            executable = True,
            cfg = "exec",
        ),
        "_csspurge": attr.label(
            default = "//cmd/csspurge",
            executable = True,
            cfg = "exec",
        ),
    },
)
