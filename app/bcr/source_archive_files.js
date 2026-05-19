/**
 * @fileoverview In-app file viewer for the two sub-tabs that browse files
 * inside the bazel-central-registry submodule for a given module-version:
 *   - overlay: files merged on top of the upstream source archive
 *   - patches: patch files applied at checkout time
 *
 * Both sub-tabs share `SourceArchiveFileSelect`, a `ContentSelect` that builds
 * a Trie of filenames from the appropriate map on the module-version's
 * source.json and greedy-longest-prefix-matches inside `selectFail` to route
 * `/source/<kind>/<path>` into a `SourceArchiveFileComponent`. The file
 * component reuses `GitHubSourceFileComponent`'s fetch + Shiki-highlight
 * plumbing, overriding `fetchSource_()` to point at `raw.githubusercontent.com`
 * against the BCR submodule at its pinned commit.
 */
goog.module("bcrfrontend.sourceArchiveFiles");

const Trie = goog.require("goog.structs.Trie");
const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleSource = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleSource",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { GitHubSourceFileComponent, parseGitHubRepoUrl } = goog.require(
	"bcrfrontend.githubsourcefile",
);
const { sourceArchiveFileListPane, sourceArchiveFileSelectShell, sourceArchiveFileView } =
	goog.require("soy.registry");

/**
 * Sub-tab name for the file-list view (the default landing when no specific
 * file is in the URL).
 * @const {string}
 */
const TAB_LIST = "list";

/** @const {string} */
const KIND_OVERLAY = "overlay";

/** @const {string} */
const KIND_PATCHES = "patches";

/**
 * Heuristic mapping from file extension / basename to a Shiki language id.
 * Unknown files render as plain text — Shiki renders that fine, just without
 * syntax colors.
 * @param {string} filePath
 * @param {string} kind
 * @return {string}
 */
function inferLang(filePath, kind) {
	if (kind === KIND_PATCHES) return "diff";
	const lower = filePath.toLowerCase();
	if (
		/(?:^|\/)(?:BUILD|BUILD\.bazel|MODULE\.bazel|WORKSPACE|WORKSPACE\.bazel)$/.test(
			filePath,
		)
	) {
		return "python";
	}
	if (lower.endsWith(".bzl") || lower.endsWith(".py")) return "python";
	if (lower.endsWith(".sh")) return "bash";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
	if (lower.endsWith(".json")) return "json";
	if (lower.endsWith(".md")) return "markdown";
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
	if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "javascript";
	return "text";
}

/**
 * Returns the appropriate filename map on a ModuleSource for `kind`.
 * @param {!ModuleSource} source
 * @param {string} kind
 * @return {!jspb.Map<string,string>|undefined}
 */
function mapForKind(source, kind) {
	return kind === KIND_OVERLAY
		? source.getOverlayMap()
		: source.getPatchesMap();
}

/**
 * Two-level ContentSelect that hosts a Trie-routed file list for either the
 * overlay or patches map on a module-version's source.json.
 */
class SourceArchiveFileSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!ModuleSource} source
	 * @param {string} kind "overlay" or "patches"
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, source, kind, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {!ModuleSource} */
		this.source_ = source;

		/** @private @const @type {string} */
		this.kind_ = kind;

		/** @private @const @type {!Trie<string>} */
		this.fileTrie_ = new Trie();

		const map = mapForKind(source, kind);
		if (map) {
			for (const filename of map.keys()) {
				this.fileTrie_.set(filename, filename);
			}
		}
	}

	/** @override */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(sourceArchiveFileSelectShell, {}),
		);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TAB_LIST, route.add(TAB_LIST));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TAB_LIST) {
			this.addTab(
				name,
				new SourceArchiveFileListComponent(
					this.moduleVersion_,
					this.source_,
					this.kind_,
					this.dom_,
				),
			);
			this.select(name, route);
			return;
		}

		// Greedy longest-prefix match against the file trie. Mirrors
		// ModuleVersionSymbolsSelect's pattern — overlay paths can contain
		// slashes (e.g. "python/BUILD.bazel"), so we shrink unmatched until
		// a known filename is found.
		const unmatched = route.unmatchedPath();
		while (unmatched.length) {
			const prefix = unmatched.join("/");
			const filename = this.fileTrie_.get(prefix);
			if (filename) {
				let tab = this.getTab(prefix);
				if (!tab) {
					tab = this.addTab(
						prefix,
						new SourceArchiveFileComponent(
							this.registry_,
							this.module_,
							this.moduleVersion_,
							this.kind_,
							filename,
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

		super.selectFail(name, route);
	}
}

/**
 * Renders the condensed-Box file list — same shape as the old static
 * overlay/patches panes, but with in-app subpath links instead of github.com
 * tree URLs.
 */
class SourceArchiveFileListComponent extends Component {
	/**
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!ModuleSource} source
	 * @param {string} kind
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(moduleVersion, source, kind, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {!ModuleSource} */
		this.source_ = source;

		/** @private @const @type {string} */
		this.kind_ = kind;
	}

	/** @override */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(sourceArchiveFileListPane, {
				moduleVersion: this.moduleVersion_,
				source: this.source_,
				kind: this.kind_,
			}),
		);
	}
}

/**
 * Fetches and renders a single overlay/patch file's raw bytes from the BCR
 * submodule at its pinned commit, then runs Shiki highlight with an extension-
 * inferred language (or "diff" for patches).
 */
class SourceArchiveFileComponent extends GitHubSourceFileComponent {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {string} kind
	 * @param {string} filePath
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, kind, filePath, opt_domHelper) {
		super(
			module,
			moduleVersion,
			filePath,
			sourceArchiveFileView,
			{ kind, lang: inferLang(filePath, kind) },
			opt_domHelper,
		);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {string} */
		this.kind_ = kind;
	}

	/** @override */
	fetchSource_() {
		const repoUrl = this.registry_.getRepositoryUrl();
		const sha = this.registry_.getCommitSha();
		const parsed = repoUrl ? parseGitHubRepoUrl(repoUrl) : null;
		if (!parsed || !sha) {
			// Registry's repository URL isn't a github.com pattern we recognize
			// — fall back to upstream-repo fetch, which will 404 for an
			// overlay/patch file but at least surfaces a meaningful error.
			super.fetchSource_();
			return;
		}
		const path = `modules/${this.moduleVersion_.getName()}/${this.moduleVersion_.getVersion()}/${this.kind_}/${this.filePath_}`;
		const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${sha}/${path}`;
		const blobUrl = `https://github.com/${parsed.owner}/${parsed.repo}/blob/${sha}/${path}`;
		this.templateData_ = {
			...(this.templateData_ || {}),
			githubUrl: blobUrl,
		};
		this.fetchAndRender_(rawUrl);
	}
}

exports = {
	SourceArchiveFileSelect,
	SourceArchiveFileComponent,
	SourceArchiveFileListComponent,
	KIND_OVERLAY,
	KIND_PATCHES,
};
