goog.module("bcrfrontend.bazel");

const Module = goog.requireType("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const {
	computeTotalBazelVersions,
	computeTotalSymbols,
	createMaintainersMap,
	createModuleMap,
	refreshBcrSidePaneSymbols,
} = goog.require("bcrfrontend.registry");
const { getApplication } = goog.require("bcrfrontend.common");
const {
	bazelOverviewSelectNav,
	bazelSelect,
	bazelVersionDetail,
	homeRecentTimeline,
} = goog.require("soy.bcrfrontend.app");
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");

const BAZEL_TOOLS = "bazel_tools";

/**
 * @enum {string}
 */
const TabName = {
	VERSIONS: "versions",
};

/**
 * Top-level container for the /bazel route. Routes the literal "versions"
 * to the timeline overview; any other segment is treated as a Bazel version
 * string and resolved against bazel_tools.
 */
class BazelSelect extends ContentSelect {
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
		this.setElementInternal(soy.renderAsElement(bazelSelect));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.VERSIONS, route.add(TabName.VERSIONS));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.VERSIONS) {
			this.addTab(
				TabName.VERSIONS,
				new BazelOverviewSelectNav(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		const bazelTools = findBazelToolsModule(this.registry_);
		if (bazelTools) {
			const moduleVersion = bazelTools
				.getVersionsList()
				.find((v) => v.getVersion() === name);
			if (moduleVersion) {
				this.addTab(
					name,
					new BazelVersionDetailComponent(
						this.registry_,
						moduleVersion,
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
exports.BazelSelect = BazelSelect;

/**
 * Tabbed overview at /bazel/versions. The single registered tab today is the
 * Versions timeline; the SelectNav shape leaves room for future siblings.
 */
class BazelOverviewSelectNav extends SelectNav {
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
			soy.renderAsElement(bazelOverviewSelectNav, {
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
		return TabName.VERSIONS;
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addNavTabLazy(
			TabName.VERSIONS,
			"Versions",
			"Bazel Versions",
			undefined,
			`${this.getPathUrl()}/${TabName.VERSIONS}`,
			() => new BazelVersionsComponent(this.registry_, this.dom_),
		);

		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}
}

class BazelVersionsComponent extends Component {
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
				recentlyUpdated: computeBazelVersions(this.registry_),
			}),
		);
	}
}

/**
 * Detail page for a single Bazel release at /bazel/<version>.
 */
class BazelVersionDetailComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {!ModuleVersion} moduleVersion
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, moduleVersion, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;
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
			soy.renderAsElement(bazelVersionDetail, {
				registry: this.registry_,
				moduleVersion: this.moduleVersion_,
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
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}
}

/**
 * @param {!Registry} registry
 * @returns {?Module}
 */
function findBazelToolsModule(registry) {
	const modules = createModuleMap(registry);
	return modules.get(BAZEL_TOOLS) || null;
}

/**
 * Every bazel_tools version with a commit date, newest first. Shaped for the
 * shared homeRecentTimeline template (linkUrl points to /bazel/<version>).
 *
 * @param {!Registry} registry
 * @returns {!Array<!{moduleVersion: !ModuleVersion, commitDate: string, isNew: boolean, linkUrl: string, pullRequestUrl: string, displayName: string}>}
 */
function computeBazelVersions(registry) {
	const bazelTools = findBazelToolsModule(registry);
	if (!bazelTools) return [];

	/** @type {!Array<!ModuleVersion>} */
	const versions = [];
	for (const v of bazelTools.getVersionsList()) {
		const commit = v.getCommit();
		if (commit && commit.getDate()) {
			versions.push(v);
		}
	}

	versions.sort((a, b) => {
		return (
			new Date(b.getCommit().getDate()) - new Date(a.getCommit().getDate())
		);
	});

	return versions.map((v) => {
		const pr = v.getCommit().getPullRequest();
		return {
			moduleVersion: v,
			commitDate: formatRelativeShort(v.getCommit().getDate()),
			isNew: false,
			linkUrl: `/#/bazel/${v.getVersion()}`,
			pullRequestUrl: pr
				? `https://github.com/bazelbuild/bazel/pull/${pr}`
				: "",
			displayName: "bazel",
		};
	});
}
