goog.module("bcrfrontend.home");

const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { createMaintainersMap, createModuleMap } = goog.require(
	"bcrfrontend.registry",
);
const { homeOverviewComponent, homeSelect } = goog.require(
	"soy.bcrfrontend.app",
);
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const { Component, Route } = goog.require("stack.ui");

/**
 * @enum {string}
 */
const TabName = {
	OVERVIEW: "overview",
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
				new HomeOverviewComponent(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		super.selectFail(name, route);
	}
}
exports.HomeSelect = HomeSelect;

class HomeOverviewComponent extends Component {
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

		// Collect all module versions with commit dates for sorting
		/** @type {!Array<!{m: !Module, v: !ModuleVersion}>} */
		const allVersions = [];

		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;

			for (const version of module.getVersionsList()) {
				const commit = version.getCommit();
				if (commit && commit.getDate()) {
					allVersions.push({ m: module, v: version });
				}
			}
		}

		// Sort by commit date (most recent first) and take top 15
		allVersions.sort((a, b) => {
			return (
				new Date(b.v.getCommit().getDate()) -
				new Date(a.v.getCommit().getDate())
			);
		});
		/** @type {!Array<!{moduleVersion: !ModuleVersion, commitDate: string}>} */
		const recentlyUpdated = allVersions.slice(0, 15).map((item) => {
			return {
				moduleVersion: item.v,
				commitDate: formatRelativeShort(item.v.getCommit().getDate()),
				isNew: item.m.getVersionsList().length === 1,
			};
		});

		this.setElementInternal(
			soy.renderAsElement(homeOverviewComponent, {
				registry: this.registry_,
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				recentlyUpdated,
			}),
		);
	}
}
