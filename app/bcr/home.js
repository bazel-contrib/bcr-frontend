goog.module("bcrfrontend.home");

const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { getApplication } = goog.require("bcrfrontend.common");
const {
	computeTotalBazelVersions,
	computeTotalSymbols,
	createMaintainersMap,
	createModuleMap,
	refreshBcrSidePaneSymbols,
} = goog.require("bcrfrontend.registry");
const { homeOverviewSelectNav, homeRecentTimeline, homeSelect } = goog.require(
	"soy.bcrfrontend.app",
);
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const { Component, Route } = goog.require("stack.ui");

/**
 * @enum {string}
 */
const TabName = {
	OVERVIEW: "overview",
};

/**
 * @enum {string}
 */
const RecentTabName = {
	UPDATED: "updated",
	ADDED: "added",
};

class HomeSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(homeSelect, {
				registry: this.registry_,
			}),
		);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.OVERVIEW, route.add(TabName.OVERVIEW));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.OVERVIEW) {
			this.addTab(
				TabName.OVERVIEW,
				new HomeOverviewSelectNav(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		super.selectFail(name, route);
	}
}
exports.HomeSelect = HomeSelect;

class HomeOverviewSelectNav extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		const modules = createModuleMap(this.registry_);
		const maintainers = createMaintainersMap(this.registry_);

		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}

		this.setElementInternal(
			soy.renderAsElement(homeOverviewSelectNav, {
				registry: this.registry_,
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalSymbols: computeTotalSymbols(this.registry_),
				totalBazelVersions: computeTotalBazelVersions(this.registry_),
				uiCommitSha: uiCommitSha,
			}),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return RecentTabName.UPDATED;
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addNavTabLazy(
			RecentTabName.UPDATED,
			"Recently Updated",
			"Recently Updated",
			undefined,
			`${this.getPathUrl()}/${RecentTabName.UPDATED}`,
			() => new HomeRecentlyUpdatedComponent(this.registry_, this.dom_),
		);

		this.addNavTabLazy(
			RecentTabName.ADDED,
			"Recently Added",
			"Recently Added",
			undefined,
			`${this.getPathUrl()}/${RecentTabName.ADDED}`,
			() => new HomeRecentlyAddedComponent(this.registry_, this.dom_),
		);

		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}
}

class HomeRecentlyUpdatedComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(homeRecentTimeline, {
				recentlyUpdated: computeRecentlyUpdated(this.registry_),
			}),
		);
	}
}

class HomeRecentlyAddedComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(homeRecentTimeline, {
				recentlyUpdated: computeRecentlyAdded(this.registry_),
			}),
		);
	}
}

/**
 * Top 15 module versions by commit date (most recent first).
 * @param {!Registry} registry
 * @returns {!Array<!{moduleVersion: !ModuleVersion, commitDate: string, isNew: boolean, linkUrl: string, pullRequestUrl: string, displayName: string}>}
 */
function computeRecentlyUpdated(registry) {
	const modules = createModuleMap(registry);

	/** @type {!Array<!{m: !Module, v: !ModuleVersion}>} */
	const allVersions = [];
	for (const module of modules.values()) {
		for (const version of module.getVersionsList()) {
			const commit = version.getCommit();
			if (commit && commit.getDate()) {
				allVersions.push({ m: module, v: version });
			}
		}
	}

	allVersions.sort((a, b) => {
		return (
			new Date(b.v.getCommit().getDate()) - new Date(a.v.getCommit().getDate())
		);
	});

	return allVersions.slice(0, 15).map((item) => {
		const pr = item.v.getCommit().getPullRequest();
		return {
			moduleVersion: item.v,
			commitDate: formatRelativeShort(item.v.getCommit().getDate()),
			isNew: item.m.getVersionsList().length === 1,
			linkUrl: `/#/modules/${item.v.getName()}/${item.v.getVersion()}`,
			pullRequestUrl: pr
				? `https://github.com/bazelbuild/bazel-central-registry/pull/${pr}`
				: "",
			displayName: item.v.getName(),
		};
	});
}

/**
 * Top 15 modules by their first version's commit date (most recent first).
 * Versions are stored newest-first, so the first version is the last entry.
 * @param {!Registry} registry
 * @returns {!Array<!{moduleVersion: !ModuleVersion, commitDate: string, isNew: boolean, linkUrl: string, pullRequestUrl: string, displayName: string}>}
 */
function computeRecentlyAdded(registry) {
	const modules = createModuleMap(registry);

	/** @type {!Array<!{m: !Module, v: !ModuleVersion}>} */
	const firsts = [];
	for (const module of modules.values()) {
		const versions = module.getVersionsList();
		if (versions.length === 0) continue;
		const first = versions[versions.length - 1];
		const commit = first.getCommit();
		if (!commit || !commit.getDate()) continue;
		firsts.push({ m: module, v: first });
	}

	firsts.sort((a, b) => {
		return (
			new Date(b.v.getCommit().getDate()) - new Date(a.v.getCommit().getDate())
		);
	});

	return firsts.slice(0, 15).map((item) => {
		const pr = item.v.getCommit().getPullRequest();
		return {
			moduleVersion: item.v,
			commitDate: formatRelativeShort(item.v.getCommit().getDate()),
			isNew: true,
			linkUrl: `/#/modules/${item.v.getName()}/${item.v.getVersion()}`,
			pullRequestUrl: pr
				? `https://github.com/bazelbuild/bazel-central-registry/pull/${pr}`
				: "",
			displayName: item.v.getName(),
		};
	});
}
