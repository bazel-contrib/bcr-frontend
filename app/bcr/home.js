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
const { getApplication } = goog.require("bcrfrontend.common");
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
				commitDate: formatRelativePast(item.v.getCommit().getDate()),
				isNew: item.m.getVersionsList().length === 1,
			};
		});

		// Render with 0 for symbol stats (populated async in enterDocument)
		this.setElementInternal(
			soy.renderAsElement(homeOverviewComponent, {
				registry: this.registry_,
				lastUpdated: formatRelativePast(this.registry_.getCommitDate()),
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalRules: 0,
				totalFunctions: 0,
				totalProviders: 0,
				totalAspects: 0,
				totalModuleExtensions: 0,
				totalRepositoryRules: 0,
				totalMacros: 0,
				recentlyUpdated,
			}),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		// Lazy-load symbol stats after symbols.pb.gz is fetched and decoded
		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => this.updateSymbolStats_());
	}

	/**
	 * Compute symbol counts from the now-decorated registry and update the DOM.
	 * @private
	 */
	updateSymbolStats_() {
		const el = this.getElement();
		if (!el) return;

		const container = el.querySelector(".js-symbol-stats");
		if (!container) return;

		const counts = {
			rules: 0,
			functions: 0,
			providers: 0,
			aspects: 0,
			moduleExtensions: 0,
			repositoryRules: 0,
			macros: 0,
			ruleMacros: 0,
		};

		for (const module of this.registry_.getModulesList()) {
			for (const version of module.getVersionsList()) {
				const source = version.getSource();
				if (!source) continue;

				const docs = source.getDocumentation();
				if (!docs) continue;

				for (const file of docs.getFileList()) {
					if (file.getError()) continue;

					for (const sym of file.getSymbolList()) {
						switch (sym.getType()) {
							case SymbolType.SYMBOL_TYPE_RULE:
								counts.rules++;
								break;
							case SymbolType.SYMBOL_TYPE_FUNCTION:
								counts.functions++;
								break;
							case SymbolType.SYMBOL_TYPE_PROVIDER:
								counts.providers++;
								break;
							case SymbolType.SYMBOL_TYPE_ASPECT:
								counts.aspects++;
								break;
							case SymbolType.SYMBOL_TYPE_MODULE_EXTENSION:
								counts.moduleExtensions++;
								break;
							case SymbolType.SYMBOL_TYPE_REPOSITORY_RULE:
								counts.repositoryRules++;
								break;
							case SymbolType.SYMBOL_TYPE_MACRO:
								counts.macros++;
								break;
							case SymbolType.SYMBOL_TYPE_RULE_MACRO:
								counts.ruleMacros++;
								break;
						}
					}
				}
			}
		}

		// Update stat values in DOM order: Rules, Functions, Providers,
		// Extensions, Repo Rules, Aspects, Macros
		const values = [
			counts.rules + counts.ruleMacros,
			counts.functions,
			counts.providers,
			counts.moduleExtensions,
			counts.repositoryRules,
			counts.aspects,
			counts.macros,
		];
		const statEls = container.querySelectorAll(".f2-mktg");
		for (let i = 0; i < values.length && i < statEls.length; i++) {
			statEls[i].textContent = String(values[i]);
		}

		// Show the symbol stats row
		container.style.display = "";
	}
}
