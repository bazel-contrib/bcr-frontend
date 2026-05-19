goog.module("bcrfrontend.targets");

const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const Trie = goog.require("goog.structs.Trie");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { getApplication } = goog.require("bcrfrontend.common");
const { parseLoadUrlKey } = goog.require("bcrfrontend.starlark");
const {
	computeTotalBazelVersions,
	computeTotalSymbols,
	createMaintainersMap,
	createModuleMap,
} = goog.require("bcrfrontend.registry");
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");
const {
	targetsSelect,
	targetsListComponent,
	targetUsagesComponent,
} = goog.require("soy.bcrfrontend.targets");

/**
 * @enum {string}
 *
 * Underscore prefix on LIST guards against collisions with real `@repo/...`
 * urlKey segments. None ever start with `_` so routing stays unambiguous.
 */
const TabName = {
	LIST: "_list",
};

/**
 * One target invocation indexed by its load-coordinate.
 * @typedef {{
 *   moduleName: string,
 *   version: string,
 *   pkgPath: string,
 *   targetName: string,
 *   ruleKind: string,
 * }}
 */
let TargetRef;

/**
 * Map<urlKey, Array<TargetRef>> — the cross-registry rule-usage index.
 * @typedef {!Map<string, !Array<!TargetRef>>}
 */
let RuleUsageIndex;

/**
 * Top-level Targets view: 2-pane shell with bcrSidePane on the left and a
 * `.content` placeholder on the right. The default LIST view and per-key
 * detail views both mount into the placeholder, so the sidebar persists
 * across drill-in.
 */
class TargetsSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @type {?RuleUsageIndex} */
		this.usageIndex_ = null;

		/** @private @type {!Trie<string>} */
		this.urlKeyTrie_ = new Trie();

		/** @private @type {?Route} */
		this.pendingRoute_ = null;

		/** @private @type {string} */
		this.pendingName_ = "";
	}

	/** @override */
	createDom() {
		const modules = createModuleMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}
		this.setElementInternal(
			soy.renderAsElement(targetsSelect, {
				registry: this.registry_,
				totalModules: modules.size,
				totalModuleVersions,
				totalMaintainers: createMaintainersMap(this.registry_).size,
				totalSymbols: computeTotalSymbols(this.registry_),
				totalBazelVersions: computeTotalBazelVersions(this.registry_),
				uiCommitSha: uiCommitSha,
			}),
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
		if (!this.usageIndex_) {
			// Index not yet resolved — stash the route and retry once the
			// promise lands. enterDocument kicked off the fetch.
			this.pendingName_ = name;
			this.pendingRoute_ = route;
			return;
		}

		if (name === TabName.LIST) {
			this.addTab(
				name,
				new TargetsListComponent(this.usageIndex_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		// Greedy longest-prefix match against the urlKey trie.
		const unmatched = route.unmatchedPath();
		while (unmatched.length) {
			const prefix = unmatched.join("/");
			if (this.urlKeyTrie_.containsKey(prefix)) {
				let tab = this.getTab(prefix);
				if (!tab) {
					tab = this.addTab(
						prefix,
						new TargetUsagesComponent(
							prefix,
							this.usageIndex_.get(prefix) || [],
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

		// No trie match. If the URL still parses as a valid load coordinate
		// (greedy `.bzl` segment found), render an empty-usages detail page
		// instead of 404 — the symbol exists in the docs but no BUILD file
		// invokes it directly.
		const fullPath = route.unmatchedPath().join("/");
		if (parseLoadUrlKey(fullPath)) {
			let tab = this.getTab(fullPath);
			if (!tab) {
				tab = this.addTab(
					fullPath,
					new TargetUsagesComponent(fullPath, [], this.dom_),
				);
			}
			this.showTab(fullPath);
			tab.go(route.advance(route.unmatchedPath().length - 1));
			return;
		}

		super.selectFail(name, route);
	}

	/** @override */
	enterDocument() {
		super.enterDocument();

		getApplication(this)
			.getRuleUsageIndex()
			.then((index) => {
				if (this.isDisposed()) return;
				this.usageIndex_ = /** @type {!RuleUsageIndex} */ (index);
				this.urlKeyTrie_ = new Trie();
				for (const key of this.usageIndex_.keys()) {
					this.urlKeyTrie_.set(key, key);
				}
				// Replay any route that arrived before the index resolved.
				if (this.pendingRoute_) {
					const route = this.pendingRoute_;
					const name = this.pendingName_;
					this.pendingRoute_ = null;
					this.pendingName_ = "";
					this.selectFail(name, route);
				}
			});
	}
}
exports.TargetsSelect = TargetsSelect;

/**
 * Default LIST view: condensed Box of every loaded callable found in the
 * registry-wide packages, sorted alphabetically by displayLabel.
 */
class TargetsListComponent extends Component {
	/**
	 * @param {!RuleUsageIndex} usageIndex
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(usageIndex, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!RuleUsageIndex} */
		this.usageIndex_ = usageIndex;
	}

	/** @override */
	createDom() {
		/** @type {!Array<{urlKey: string, displayLabel: string, count: number}>} */
		const entries = [];
		this.usageIndex_.forEach(
			/**
			 * @param {!Array<!TargetRef>} usages
			 * @param {string} urlKey
			 */
			(usages, urlKey) => {
				entries.push({
					urlKey,
					displayLabel: urlKeyToDisplayLabel(urlKey),
					count: usages.length,
				});
			},
		);
		entries.sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));

		this.setElementInternal(
			soy.renderAsElement(targetsListComponent, { entries }),
		);
	}
}
exports.TargetsListComponent = TargetsListComponent;

/**
 * Detail view for a single load-coordinate urlKey: header + usages grouped
 * by module-version.
 */
class TargetUsagesComponent extends Component {
	/**
	 * @param {string} urlKey
	 * @param {!Array<!TargetRef>} usages
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(urlKey, usages, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {string} */
		this.urlKey_ = urlKey;

		/** @private @const @type {!Array<!TargetRef>} */
		this.usages_ = usages;
	}

	/** @override */
	createDom() {
		const grouped = groupTargetsByModule(this.usages_);
		this.setElementInternal(
			soy.renderAsElement(targetUsagesComponent, {
				displayLabel: urlKeyToDisplayLabel(this.urlKey_),
				totalCount: this.usages_.length,
				grouped,
			}),
		);
	}
}
exports.TargetUsagesComponent = TargetUsagesComponent;

/**
 * Build the user-facing label form (`@repo//pkg:file%symbol`) from the
 * slash-form urlKey used by the router.
 *
 * @param {string} urlKey
 * @returns {string}
 */
function urlKeyToDisplayLabel(urlKey) {
	const parsed = parseLoadUrlKey(urlKey);
	if (!parsed) return urlKey;
	const pkg = parsed.pkg ? parsed.pkg : "";
	return `@${parsed.repo}//${pkg}:${parsed.file}%${parsed.symbol}`;
}

/**
 * @typedef {{
 *   moduleName: string,
 *   version: string,
 *   targets: !Array<{pkgPath: string, targetName: string}>,
 * }}
 */
let ModuleGroup;

/**
 * Bucket usages by `moduleName@version`, sort items within each bucket by
 * (pkgPath, targetName), then return the buckets sorted by module name.
 *
 * @param {!Array<!TargetRef>} usages
 * @returns {!Array<!ModuleGroup>}
 */
function groupTargetsByModule(usages) {
	/** @type {!Map<string, !ModuleGroup>} */
	const byModule = new Map();
	for (const u of usages) {
		const id = `${u.moduleName}@${u.version}`;
		let bucket = byModule.get(id);
		if (!bucket) {
			bucket = { moduleName: u.moduleName, version: u.version, targets: [] };
			byModule.set(id, bucket);
		}
		bucket.targets.push({ pkgPath: u.pkgPath, targetName: u.targetName });
	}
	byModule.forEach(
		/** @param {!ModuleGroup} bucket */
		(bucket) => {
			bucket.targets.sort((a, b) => {
				if (a.pkgPath !== b.pkgPath) return a.pkgPath.localeCompare(b.pkgPath);
				return a.targetName.localeCompare(b.targetName);
			});
		},
	);
	/** @type {!Array<!ModuleGroup>} */
	const groups = Array.from(byModule.values());
	groups.sort(
		/**
		 * @param {!ModuleGroup} a
		 * @param {!ModuleGroup} b
		 */
		(a, b) => a.moduleName.localeCompare(b.moduleName),
	);
	return groups;
}
