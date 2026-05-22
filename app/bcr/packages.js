goog.module("bcrfrontend.packages");

const ModuleVersionPackages = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleVersionPackages",
);
const SymbolSource = goog.require(
	"proto.build.stack.bazel.symbol.v1.SymbolSource",
);
const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Package = goog.require("proto.build.stack.starlark.v1beta1.Package");
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const RepositoryType = goog.require(
	"proto.build.stack.bazel.registry.v1.RepositoryType",
);
const Target = goog.require("proto.build.stack.starlark.v1beta1.Target");
const Trie = goog.require("goog.structs.Trie");
const dom = goog.require("goog.dom");
const path = goog.require("goog.string.path");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { getApplication } = goog.require("bcrfrontend.common");
const { highlightAll } = goog.require("bcrfrontend.syntax");
const { generateTargetCall, loadLabelToUrlKey, valueToStarlark } = goog.require(
	"bcrfrontend.starlark",
);
const {
	moduleVersionPackagesBlankslate,
	moduleVersionPackagesListComponent,
	moduleVersionPackagesSelect,
	packageInfoSelect,
	packageListComponent,
	targetInfoComponent,
} = goog.require("soy.bcrfrontend.packages");

/**
 * @enum {string}
 *
 * Underscore prefixes guard against collisions with Bazel target/package
 * names (e.g. a target literally named `list`). Bazel labels conventionally
 * don't start with `_`, so this leaves the namespace clear.
 */
const TabName = {
	LIST: "_list",
};

/**
 * URL/trie sentinel for the root package "@@repo//". The empty string can't
 * round-trip through the SPA router (it collides with the LIST tab url), so
 * we substitute this distinctive segment in the path and reverse-map it on
 * trie lookup.
 */
const ROOT_KEY = "ROOT";

/**
 * Strip the leading "@@<repo>//" segment (or "@<repo>//") from a Bazel
 * package label so we can use the remainder as a slash-separated trie key
 * and URL fragment — e.g. "@@rules_cc//lib/foo" -> "lib/foo". Root packages
 * return ROOT_KEY (empty path is unaddressable in the SPA router).
 *
 * @param {string} pkgName
 * @returns {string}
 */
function stripRepoPrefix(pkgName) {
	const idx = pkgName.indexOf("//");
	if (idx === -1) return pkgName;
	const rest = pkgName.substring(idx + 2);
	return rest === "" ? ROOT_KEY : rest;
}

/**
 * Prefix-keyed palette for well-known rule kinds. The first prefix in the
 * list that matches via .startsWith wins. Adapted from an earlier project's
 * ruleColors table; values are GitHub-style hex backgrounds with foreground
 * computed from perceptual luminance for legibility.
 *
 * @type {!Array<{prefix: string, bg: string}>}
 */
const RULE_KIND_COLORS = [
	{ prefix: "filegroup", bg: "#1A90F4" },
	{ prefix: "genrule", bg: "#FC4F05" },
	{ prefix: "platform", bg: "#3B5B3A" },
	{ prefix: "toolchain", bg: "#1A90F4" },
	{ prefix: "alias", bg: "#444444" },
	{ prefix: "config_setting", bg: "#E47182" },
	{ prefix: "constraint_", bg: "#A82273" },
	{ prefix: "package_group", bg: "#888888" },
	{ prefix: "proto_", bg: "#47B2B9" },
	{ prefix: "cc_", bg: "#ED306A" },
	{ prefix: "objc_", bg: "#3676FE" },
	{ prefix: "go_", bg: "#159CCF" },
	{ prefix: "py_", bg: "#295E94" },
	{ prefix: "python_", bg: "#295E94" },
	{ prefix: "java_", bg: "#A05F14" },
	{ prefix: "rust_", bg: "#D59471" },
	{ prefix: "scala_", bg: "#B21931" },
	{ prefix: "kt_", bg: "#EB7B27" },
	{ prefix: "kotlin_", bg: "#EB7B27" },
	{ prefix: "ts_", bg: "#236176" },
	{ prefix: "js_", bg: "#EEDC49" },
	{ prefix: "closure_", bg: "#EEDC49" },
	{ prefix: "nodejs_", bg: "#6CAE04" },
	{ prefix: "sh_", bg: "#7ADD40" },
	{ prefix: "docker", bg: "#2B3C42" },
	{ prefix: "container_", bg: "#2B3C42" },
	{ prefix: "haskell_", bg: "#4B3C72" },
	{ prefix: "swift_", bg: "#FE9B37" },
	{ prefix: "ruby_", bg: "#5C0C11" },
	{ prefix: "elm_", bg: "#50A6C0" },
	{ prefix: "csharp_", bg: "#187405" },
];

/**
 * Stable hash → HSL color for rule kinds not in RULE_KIND_COLORS.
 * @param {string} str
 * @returns {string}
 */
function hashHue(str) {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = (h * 31 + str.charCodeAt(i)) >>> 0;
	}
	return `hsl(${h % 360}, 45%, 40%)`;
}

/**
 * Compute the contrasting foreground color (black vs white) for a given
 * #RRGGBB or hsl(...) background using perceptual luminance.
 * @param {string} bg
 * @returns {string}
 */
function contrastFg(bg) {
	if (bg.startsWith("#") && bg.length === 7) {
		const r = parseInt(bg.slice(1, 3), 16);
		const g = parseInt(bg.slice(3, 5), 16);
		const b = parseInt(bg.slice(5, 7), 16);
		return (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.6 ? "#000" : "#fff";
	}
	// hsl(...) fallbacks always pair with white; the L=40% lookup keeps
	// luminance low enough for white text to remain legible.
	return "#fff";
}

/**
 * Pick a label style for a rule kind. Known kinds use a curated palette;
 * unknown kinds fall back to a deterministic hash → HSL so the same kind
 * always gets the same color across renders.
 * @param {string} kind
 * @returns {{bg: string, fg: string}}
 */
function ruleKindStyle(kind) {
	for (const entry of RULE_KIND_COLORS) {
		if (kind.startsWith(entry.prefix)) {
			return { bg: entry.bg, fg: contrastFg(entry.bg) };
		}
	}
	const bg = hashHue(kind);
	return { bg, fg: contrastFg(bg) };
}

/**
 * Aggregate every Target across every Package in a ModuleVersionPackages into
 * groups keyed by rule kind, suitable for rendering as a sticky sidebar tree
 * (analogous to buildNavSymbolGroups in documentation.js for the docs tab).
 *
 * The pre-computed styleBg/styleFg let Soy render the colored dot without
 * having to call back into the JS palette table.
 *
 * @param {!ModuleVersionPackages} packages
 * @returns {!Array<{ruleKind: string, styleBg: string, styleFg: string,
 *                    urlKey: string,
 *                    items: !Array<{pkgPath: string, name: string}>}>}
 */
function buildNavTargetGroups(packages) {
	/** @type {!Map<string, {ruleKind: string, styleBg: string, styleFg: string,
	 *                       urlKey: string,
	 *                       items: !Array<{pkgPath: string, name: string}>}>} */
	const byKind = new Map();
	for (const pkg of packages.getPackageList()) {
		const pkgPath = stripRepoPrefix(pkg.getName());
		const loads = pkg.getLoadList();
		for (const target of pkg.getTargetList()) {
			const ruleKind = target.getRule();
			if (!ruleKind) continue;
			let group = byKind.get(ruleKind);
			if (!group) {
				const style = ruleKindStyle(ruleKind);
				group = {
					ruleKind,
					styleBg: style.bg,
					styleFg: style.fg,
					urlKey: "", // populated below from the first matching load
					items: [],
				};
				byKind.set(ruleKind, group);
			}
			// Resolve the load coordinate the first time we see this kind. A
			// subsequent target with the same kind in a different package may
			// be loaded from a different .bzl, but we only use this for the
			// sidebar header link, so "first one wins" is fine.
			if (!group.urlKey) {
				outer: for (const ls of loads) {
					const lsLabel = ls.getLabel();
					if (!lsLabel) continue;
					for (const sym of ls.getSymbolList()) {
						const localName = sym.getTo() || sym.getFrom();
						if (localName === ruleKind) {
							group.urlKey = loadLabelToUrlKey(lsLabel, sym.getFrom());
							break outer;
						}
					}
				}
			}
			// Same nameless-target fallback as the list/detail views.
			group.items.push({
				pkgPath,
				name: target.getName() || ruleKind,
			});
		}
	}
	for (const group of byKind.values()) {
		group.items.sort((a, b) => {
			if (a.pkgPath !== b.pkgPath) return a.pkgPath.localeCompare(b.pkgPath);
			return a.name.localeCompare(b.name);
		});
	}
	/** @type {!Array<{ruleKind: string, styleBg: string, styleFg: string,
	 *                urlKey: string,
	 *                items: !Array<{pkgPath: string, name: string}>}>} */
	const groups = Array.from(byKind.values());
	groups.sort((a, b) => a.ruleKind.localeCompare(b.ruleKind));
	return groups;
}

/**
 * Build a GitHub source URL for a Target's BUILD file. Prefers BCR overlay
 * when the package's BUILD file is listed in source.json's overlay map (the
 * file lives in bazel-central-registry, not upstream); otherwise falls back
 * to the upstream repository on GitHub via the module's RepositoryMetadata.
 *
 * Mirrors the overlay-detection pattern used by BzlFileSourceComponent in
 * documentation.js. Returns "" when neither source is constructible.
 *
 * @param {!Registry} registry
 * @param {!ModuleVersion} moduleVersion
 * @param {!Package} pkg
 * @param {!Target} target
 * @returns {string}
 */
function computeSourceUrl(registry, moduleVersion, pkg, target) {
	const pkgPath = stripRepoPrefix(pkg.getName());
	const relPkg = pkgPath === ROOT_KEY ? "" : pkgPath;
	const filename = pkg.getFilename() || "";
	const buildBase =
		filename
			.split("/")
			.pop()
			?.replace(/\.package$/, "") || "BUILD.bazel";
	const relPath = relPkg ? `${relPkg}/${buildBase}` : buildBase;
	const line = target.getLocation()?.getStart()?.getLine() || 0;
	const lineFrag = line ? `#L${line}` : "";

	// Prefer BCR overlay if the file is overlay-served. source.json may carry
	// either the original name (BUILD.bazel) or the renamed form
	// (BUILD.bazel.package); check both.
	const overlayMap = moduleVersion.getSource()?.getOverlayMap();
	const isOverlay =
		!!overlayMap &&
		(overlayMap.has(relPath) || overlayMap.has(`${relPath}.package`));

	if (isOverlay) {
		const repoUrl = registry.getRepositoryUrl();
		const sha = registry.getCommitSha();
		if (!repoUrl || !sha) return "";
		return `${repoUrl}/blob/${sha}/modules/${moduleVersion.getName()}/${moduleVersion.getVersion()}/overlay/${relPath}${lineFrag}`;
	}

	// Upstream source via the module's RepositoryMetadata, mirroring
	// uri.soy's githubSourceUrl helper for .bzl files.
	const repoMeta = moduleVersion.getRepositoryMetadata();
	if (!repoMeta || repoMeta.getType() !== RepositoryType.GITHUB) return "";
	const upstreamSha = moduleVersion.getSource()?.getCommitSha();
	if (!upstreamSha) return "";
	const org = repoMeta.getOrganization();
	const repo = repoMeta.getName();
	return `https://github.com/${org}/${repo}/blob/${upstreamSha}/${relPath}${lineFrag}`;
}

/**
 * Top-level component for the "Packages" tab. Renders a list of packages by
 * default and routes nested URLs through a Trie into per-package
 * sub-components.
 */
class ModuleVersionPackagesSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {?ModuleVersionPackages} packages
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, packages, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {?ModuleVersionPackages} */
		this.packages_ = packages;

		/** @const @private @type {!Trie<!Package>} */
		this.packageTrie_ = new Trie();

		if (packages) {
			for (const pkg of packages.getPackageList()) {
				this.packageTrie_.set(stripRepoPrefix(pkg.getName()), pkg);
			}
		}
	}

	/** @override */
	createDom() {
		if (!this.packages_ || this.packages_.getPackageList().length === 0) {
			const detail = "Package data not available";
			this.setElementInternal(
				soy.renderAsElement(moduleVersionPackagesBlankslate, { detail }),
			);
			return;
		}

		// 2-pane shell: left = Source Details + per-rule-kind tree; right =
		// .content placeholder where the LIST view (and nested PackageSelect /
		// TargetInfo tabs) get mounted via addTab.
		const navTargetGroups = buildNavTargetGroups(this.packages_);
		this.setElementInternal(
			soy.renderAsElement(
				moduleVersionPackagesSelect,
				{
					moduleVersion: this.moduleVersion_,
					navTargetGroups,
				},
				// moduleSourceTable (left pane) calls bcrModuleVersionPatch /
				// OverlayFileUrl which take repositoryUrl + repositoryCommit
				// as @inject params.
				{
					repositoryUrl: this.registry_.getRepositoryUrl(),
					repositoryCommit: this.registry_.getCommitSha(),
				},
			),
		);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		if (!this.packages_ || this.packages_.getPackageList().length === 0) {
			route.done(this);
			return;
		}
		this.select(TabName.LIST, route.add(TabName.LIST));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (this.packages_ && this.packages_.getPackageList().length > 0) {
			if (name === TabName.LIST) {
				this.addTab(
					name,
					new ModuleVersionPackagesListComponent(
						this.moduleVersion_,
						this.packages_,
						this.dom_,
					),
				);
				this.select(name, route);
				return;
			}

			// Greedy longest-prefix match against the package trie — mirrors how
			// ModuleVersionSymbolsSelect routes into FileSelect for nested .bzl
			// paths.
			const unmatched = route.unmatchedPath();
			while (unmatched.length) {
				const prefix = unmatched.join("/");
				const pkg = this.packageTrie_.get(prefix);
				if (pkg) {
					let tab = this.getTab(prefix);
					if (!tab) {
						tab = this.addTab(
							prefix,
							new PackageSelect(
								this.module_,
								this.moduleVersion_,
								pkg,
								this.dom_,
							),
						);
					}
					this.showTab(prefix);
					tab.go(route.advance(unmatched.length - 1));
					return;
				}
				unmatched.pop();
			}
		}

		super.selectFail(name, route);
	}
}
exports.ModuleVersionPackagesSelect = ModuleVersionPackagesSelect;
exports.buildNavTargetGroups = buildNavTargetGroups;

/**
 * Default "list of packages" view rendered under the Packages tab.
 */
class ModuleVersionPackagesListComponent extends Component {
	/**
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!ModuleVersionPackages} packages
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(moduleVersion, packages, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const */
		this.moduleVersion_ = moduleVersion;

		/** @private @const */
		this.packages_ = packages;
	}

	/** @override */
	createDom() {
		const pkgs = this.packages_.getPackageList();

		// The largest non-error package sets the 100% width baseline; smaller
		// packages render proportionally narrower bars so the eye can compare
		// package sizes at a glance.
		let maxCount = 0;
		for (const pkg of pkgs) {
			if (pkg.getErrorList().length > 0) continue;
			const n = pkg.getTargetList().length;
			if (n > maxCount) maxCount = n;
		}

		const rows = pkgs.map((pkg) => {
			const errors = pkg.getErrorList();
			const pkgPath = stripRepoPrefix(pkg.getName());
			if (errors.length > 0) {
				return {
					pkgPath,
					filename: pkg.getFilename(),
					hasErrors: true,
					errors: errors.slice(),
					segments: [],
					totalCount: 0,
					widthPct: 0,
				};
			}
			/** @type {!Map<string, number>} */
			const byKind = new Map();
			for (const t of pkg.getTargetList()) {
				const k = t.getRule();
				if (!k) continue;
				byKind.set(k, (byKind.get(k) || 0) + 1);
			}
			const totalCount = pkg.getTargetList().length;
			/** @type {!Array<{ruleKind: string, count: number, percentage: number, color: string}>} */
			const segments = [];
			byKind.forEach(
				/**
				 * @param {number} count
				 * @param {string} ruleKind
				 */
				(count, ruleKind) => {
					const style = ruleKindStyle(ruleKind);
					segments.push({
						ruleKind,
						count,
						percentage: totalCount > 0 ? (count / totalCount) * 100 : 0,
						color: style.bg,
					});
				},
			);
			// Smallest leftmost so the largest kind sits at the right edge of
			// the bar — bar is right-aligned in the row, so the dominant color
			// anchors the layout's outer edge.
			segments.sort((a, b) => a.count - b.count);
			return {
				pkgPath,
				filename: pkg.getFilename(),
				hasErrors: false,
				errors: [],
				segments,
				totalCount,
				widthPct: maxCount > 0 ? (totalCount / maxCount) * 100 : 0,
			};
		});

		this.setElementInternal(
			soy.renderAsElement(moduleVersionPackagesListComponent, {
				moduleVersion: this.moduleVersion_,
				rows,
			}),
		);
	}
}
exports.ModuleVersionPackagesListComponent = ModuleVersionPackagesListComponent;

/**
 * Per-package component: renders the list of targets in the package by
 * default and routes nested URLs into per-target detail components.
 */
class PackageSelect extends ContentSelect {
	/**
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!Package} pkg
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(module, moduleVersion, pkg, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const */
		this.module_ = module;

		/** @private @const */
		this.moduleVersion_ = moduleVersion;

		/** @private @const */
		this.pkg_ = pkg;
	}

	/** @override */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(
				packageInfoSelect,
				{
					moduleVersion: this.moduleVersion_,
					pkg: this.pkg_,
				},
				{
					baseUrl: this.getPathUrl(),
				},
			),
		);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.LIST, route.add(TabName.LIST));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.LIST) {
			this.addTab(
				name,
				new PackageListComponent(
					this.module_,
					this.moduleVersion_,
					this.pkg_,
					this.dom_,
				),
			);
			this.select(name, route);
			return;
		}

		for (const target of this.pkg_.getTargetList()) {
			// Match by name, or by rule kind when the target is nameless
			// (e.g. exports_files). Mirror the fallback used when generating
			// the row hrefs.
			const key = target.getName() || target.getRule();
			if (key === name) {
				this.addTab(
					name,
					new TargetInfoComponent(
						this.module_,
						this.moduleVersion_,
						this.pkg_,
						target,
						this.dom_,
					),
				);
				this.select(name, route);
				return;
			}
		}

		super.selectFail(name, route);
	}
}
exports.PackageSelect = PackageSelect;

/**
 * Renders the list of targets for a single package.
 */
class PackageListComponent extends Component {
	/**
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!Package} pkg
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(module, moduleVersion, pkg, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const */
		this.module_ = module;

		/** @private @const */
		this.moduleVersion_ = moduleVersion;

		/** @private @const */
		this.pkg_ = pkg;
	}

	/** @override */
	createDom() {
		const targets = this.pkg_.getTargetList().map((t) => {
			const style = ruleKindStyle(t.getRule());
			// Rule calls like exports_files() omit the name attribute. Fall
			// back to the rule kind so the row is at least addressable; two
			// nameless calls of the same kind in one package will collide on
			// the route but that's an authoring edge case.
			return {
				name: t.getName() || t.getRule(),
				rule: t.getRule(),
				styleBg: style.bg,
				styleFg: style.fg,
			};
		});

		this.setElementInternal(
			soy.renderAsElement(packageListComponent, {
				moduleVersion: this.moduleVersion_,
				pkg: this.pkg_,
				targets,
			}),
		);
	}
}
exports.PackageListComponent = PackageListComponent;

/**
 * Detail view for a single Target: renders the reproduced BUILD call as
 * Starlark plus a list of the captured TargetAttribute values.
 */
class TargetInfoComponent extends Component {
	/**
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!Package} pkg
	 * @param {!Target} target
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(module, moduleVersion, pkg, target, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const */
		this.module_ = module;

		/** @private @const */
		this.moduleVersion_ = moduleVersion;

		/** @private @const */
		this.pkg_ = pkg;

		/** @private @const */
		this.target_ = target;
	}

	/** @override */
	createDom() {
		const exampleCode = generateTargetCall(this.pkg_, this.target_);

		const attributes = this.target_.getAttributeList().map((attr) => ({
			name: attr.getName(),
			valueText: valueToStarlark(attr.getValue(), ""),
		}));

		const style = ruleKindStyle(this.target_.getRule());

		const registry = getApplication(this).getRegistry();
		const sourceUrl = computeSourceUrl(
			registry,
			this.moduleVersion_,
			this.pkg_,
			this.target_,
		);
		const sourceLine = this.target_.getLocation()?.getStart()?.getLine() || 0;

		const displayName = this.target_.getName() || this.target_.getRule();

		const pkgFullName = this.pkg_.getName();
		const sepIdx = pkgFullName.indexOf("//");
		const repo =
			sepIdx === -1 ? "" : pkgFullName.substring(0, sepIdx).replace(/^@+/, "");
		const pkgPath = stripRepoPrefix(pkgFullName);

		this.setElementInternal(
			soy.renderAsElement(targetInfoComponent, {
				moduleVersion: this.moduleVersion_,
				pkg: this.pkg_,
				target: this.target_,
				displayName,
				repo,
				pkgPath,
				exampleCode,
				attributes,
				styleBg: style.bg,
				styleFg: style.fg,
				sourceUrl,
				sourceLine,
			}),
		);
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		highlightAll(this.getElementStrict());
	}
}
exports.TargetInfoComponent = TargetInfoComponent;
