goog.module("bcrfrontend.home");

const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const SymbolType = goog.require("proto.build.stack.bazel.symbol.v1.SymbolType");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { createMaintainersMap, createModuleMap } = goog.require(
	"bcrfrontend.registry",
);
const { homeOverviewComponent, homeSelect } = goog.require(
	"soy.bcrfrontend.app",
);
const { formatRelativePast } = goog.require("bcrfrontend.format");
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
		const symbolCounts = {
			rules: 0,
			functions: 0,
			providers: 0,
			aspects: 0,
			moduleExtensions: 0,
			repositoryRules: 0,
			macros: 0,
			ruleMacros: 0,
			loads: 0,
			values: 0,
		};

		// Collect all module versions with commit dates for sorting
		/** @type {!Array<!{m: !Module, v: !ModuleVersion}>} */
		const allVersions = [];

		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;

			// Collect versions with commit dates
			for (const version of module.getVersionsList()) {
				const commit = version.getCommit();
				if (commit && commit.getDate()) {
					allVersions.push({ m: module, v: version });
				}

				// Count symbols from all versions
				const source = version.getSource();
				if (!source) continue;

				const docs = source.getDocumentation();
				if (!docs) continue;

				for (const file of docs.getFileList()) {
					if (file.getError()) continue;

					for (const sym of file.getSymbolList()) {
						const type = sym.getType();
						switch (type) {
							case SymbolType.SYMBOL_TYPE_RULE:
								symbolCounts.rules++;
								break;
							case SymbolType.SYMBOL_TYPE_FUNCTION:
								symbolCounts.functions++;
								break;
							case SymbolType.SYMBOL_TYPE_PROVIDER:
								symbolCounts.providers++;
								break;
							case SymbolType.SYMBOL_TYPE_ASPECT:
								symbolCounts.aspects++;
								break;
							case SymbolType.SYMBOL_TYPE_MODULE_EXTENSION:
								symbolCounts.moduleExtensions++;
								break;
							case SymbolType.SYMBOL_TYPE_REPOSITORY_RULE:
								symbolCounts.repositoryRules++;
								break;
							case SymbolType.SYMBOL_TYPE_MACRO:
								symbolCounts.macros++;
								break;
							case SymbolType.SYMBOL_TYPE_RULE_MACRO:
								symbolCounts.ruleMacros++;
								break;
							case SymbolType.SYMBOL_TYPE_LOAD_STMT:
								symbolCounts.loads++;
								break;
							case SymbolType.SYMBOL_TYPE_VALUE:
								symbolCounts.values++;
								break;
						}
					}
				}
			}
		}

		// Sort by commit date (most recent first) and take top 10
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
				commitDate: formatRelativePast(item.v.getCommit().getDate()),
				isNew: item.m.getVersionsList().length === 1,
			};
		});

		this.setElementInternal(
			soy.renderAsElement(homeOverviewComponent, {
				registry: this.registry_,
				lastUpdated: formatRelativePast(this.registry_.getCommitDate()),
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalRules: symbolCounts.rules + symbolCounts.ruleMacros,
				totalFunctions: symbolCounts.functions,
				totalProviders: symbolCounts.providers,
				totalAspects: symbolCounts.aspects,
				totalModuleExtensions: symbolCounts.moduleExtensions,
				totalRepositoryRules: symbolCounts.repositoryRules,
				totalMacros: symbolCounts.macros,
				recentlyUpdated,
			}),
		);
	}
}
