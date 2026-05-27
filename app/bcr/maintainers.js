goog.module("bcrfrontend.maintainers");

const Maintainer = goog.require(
	"proto.build.stack.bazel.registry.v1.Maintainer",
);
const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const arrays = goog.require("goog.array");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { getApplication } = goog.require("bcrfrontend.common");
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");
const {
	computeTopPrimaryLanguages,
	computeTotalBazelVersions,
	computeTotalSymbols,
	createContributorsMap,
	createMaintainersMap,
	createModuleMap,
	createPeopleMap,
	maintainerModuleVersions,
	refreshBcrSidePaneSymbols,
} = goog.require("bcrfrontend.registry");
const {
	maintainersSelect,
	maintainersMapSelectNav,
	maintainersMapComponent,
	maintainerComponent,
} = goog.require("soy.bcrfrontend.maintainers");
const { Component, Route } = goog.require("stack.ui");

/**
 * @enum {string}
 */
const MaintainersListTabName = {
	ALL: "all",
};

/**
 * @enum {string}
 */
const TabName = {
	LIST: "list",
};

class MaintainersSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Map<string,!Maintainer>} */
		this.maintainers_ = createMaintainersMap(registry);

		/** @private @const @type {!Map<string,!Maintainer>} */
		this.contributors_ = createContributorsMap(registry);
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(maintainersSelect));
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
				TabName.LIST,
				new MaintainersMapSelectNav(
					this.registry_,
					this.maintainers_,
					this.contributors_,
					this.dom_,
				),
			);
			this.select(name, route);
			return;
		}

		const person = this.maintainers_.get(name) || this.contributors_.get(name);
		if (person) {
			this.addTab(
				name,
				new MaintainerComponent(this.registry_, name, person),
			);
			this.select(name, route);
			return;
		} else {
			console.warn(
				`failed to get maintainer/contributor for ${name}`,
			);
		}

		super.selectFail(name, route);
	}
}
exports.MaintainersSelect = MaintainersSelect;

class MaintainersMapSelectNav extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {!Map<string,!Maintainer>} maintainers
	 * @param {!Map<string,!Maintainer>} contributors
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, maintainers, contributors, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Map<string,!Maintainer>} */
		this.maintainers_ = maintainers;

		/** @private @const @type {!Map<string,!Maintainer>} */
		this.contributors_ = contributors;

		/** @private @const @type {!Map<string,!Maintainer>} */
		this.people_ = createPeopleMap(registry);
	}

	/**
	 * @override
	 */
	createDom() {
		const modules = createModuleMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}
		this.setElementInternal(
			soy.renderAsElement(maintainersMapSelectNav, {
				registry: this.registry_,
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: this.maintainers_.size,
				totalContributors: this.contributors_.size,
				totalSymbols: computeTotalSymbols(this.registry_),
				topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
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
		this.select(
			MaintainersListTabName.ALL,
			route.add(MaintainersListTabName.ALL),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.enterAllTab();

		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}

	enterAllTab() {
		this.addNavTabLazy(
			MaintainersListTabName.ALL,
			"All",
			"List of all Maintainers and Contributors",
			this.people_.size,
			`${this.getPathUrl()}/${MaintainersListTabName.ALL}`,
			() => new MaintainersMapComponent(this.people_, this.dom_),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return MaintainersListTabName.ALL;
	}
}

class MaintainersMapComponent extends Component {
	/**
	 * @param {!Map<string,!Maintainer>} maintainers
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(maintainers, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Map<string,!Maintainer>} */
		this.maintainers_ = maintainers;
	}

	/**
	 * @override
	 */
	createDom() {
		/** @type {!Array<!Maintainer>} */
		const maintainers = Array.from(this.maintainers_.values());
		arrays.shuffle(maintainers);

		this.setElementInternal(
			soy.renderAsElement(maintainersMapComponent, {
				maintainers,
			}),
		);
	}
}

class MaintainerComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {string} name
	 * @param {!Maintainer} maintainer
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, name, maintainer, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {string} */
		this.maintainerName_ = name;

		/** @private @const @type {!Maintainer} */
		this.maintainer_ = maintainer;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(maintainerComponent, {
				name: this.maintainerName_,
				maintainer: this.maintainer_,
				moduleVersions: maintainerModuleVersions(
					this.registry_,
					this.maintainer_,
				),
				activity: computeMaintainerActivity(this.registry_, this.maintainer_),
			}),
		);
	}
}

/**
 * Returns every module version whose commit was authored by the maintainer's
 * GitHub user, formatted for the homeRecentTimeline template. Sorted newest
 * first; no top-N limit.
 *
 * @param {!Registry} registry
 * @param {!Maintainer} maintainer
 * @returns {!Array<!{moduleVersion: !ModuleVersion, commitDate: string, isNew: boolean, linkUrl: string, pullRequestUrl: string, displayName: string}>}
 */
function computeMaintainerActivity(registry, maintainer) {
	const githubUser = maintainer.getGithub();
	if (!githubUser) return [];

	/** @type {!Array<!{m: !Module, v: !ModuleVersion}>} */
	const items = [];
	for (const module of registry.getModulesList()) {
		for (const version of module.getVersionsList()) {
			const commit = version.getCommit();
			if (!commit || !commit.getDate()) continue;
			if (commit.getGithubUser() !== githubUser) continue;
			items.push({ m: module, v: version });
		}
	}

	items.sort((a, b) => {
		return (
			new Date(b.v.getCommit().getDate()) - new Date(a.v.getCommit().getDate())
		);
	});

	return items.map((item) => {
		const pr = item.v.getCommit().getPullRequest();
		return {
			moduleVersion: item.v,
			commitDate: formatRelativeShort(item.v.getCommit().getDate()),
			isNew: item.m.getVersionsList().length === 1,
			linkUrl: `/modules/${item.v.getName()}/${item.v.getVersion()}`,
			pullRequestUrl: pr
				? `https://github.com/bazelbuild/bazel-central-registry/pull/${pr}`
				: "",
			displayName: item.v.getName(),
		};
	});
}
