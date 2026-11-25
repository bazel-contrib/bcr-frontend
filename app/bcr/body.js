goog.module("bcrfrontend.body");

const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { formatRelativePast } = goog.require("bcrfrontend.format");
const { Route } = goog.requireType("stack.ui");
const { getApplication, searchQueryPath } = goog.require("bcrfrontend.common");
const { BazelSelect } = goog.require("bcrfrontend.bazel");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { DocsSelect } = goog.require("bcrfrontend.documentation");
const { HomeSelect } = goog.require("bcrfrontend.home");
const { MaintainersSelect } = goog.require("bcrfrontend.maintainers");
const { DocumentationSearchComponent } = goog.require(
	"bcrfrontend.documentation",
);
const { ModulesMapSelect, ModuleSearchComponent } = goog.require(
	"bcrfrontend.modules",
);
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { SettingsSelect } = goog.require("bcrfrontend.settings");
const { TargetsSelect } = goog.require("bcrfrontend.targets");
const { ToolsSelect } = goog.require("bcrfrontend.tools");
const { bodySelect, searchSelectNav } = goog.require("soy.bcrfrontend.app");

/**
 * @enum {string}
 */
const TabName = {
	BAZEL: "bazel",
	DOCS: "docs",
	HOME: "home",
	MAINTAINERS: "maintainers",
	MODULES: "modules",
	OVERVIEW: "overview",
	SEARCH: "search",
	SETTINGS: "settings",
	SYMBOLS: "symbols",
	TARGETS: "targets",
	TOOLS: "tools",
};

/**
 * Main body of the application.
 */
class BodySelect extends ContentSelect {
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
			soy.renderAsElement(bodySelect, {
				registry: this.registry_,
				lastUpdated: formatRelativePast(this.registry_.getCommitDate()),
			}),
		);
	}

	/**
	 * Modifies behavior to use touch rather than progress to
	 * not advance the path pointer.
	 * @override
	 * @param {!Route} route
	 */
	go(route) {
		route.touch(this);
		if (route.atEnd()) {
			this.goHere(route);
		} else {
			this.goDown(route);
		}
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.HOME, route.add(TabName.HOME));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.HOME) {
			this.addTab(name, new HomeSelect(this.registry_, this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.MODULES) {
			this.addTab(name, new ModulesMapSelect(this.registry_, this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.BAZEL) {
			this.addTab(name, new BazelSelect(this.registry_, this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.DOCS) {
			// Wait for symbols to be available before loading docs
			getApplication(this)
				.getRegistryWithSymbols()
				.then(() => {
					if (this.isDisposed()) return;
					this.addTab(name, new DocsSelect(this.registry_, this.dom_));
					this.select(name, route);
				});
			return;
		}
		if (name === TabName.SEARCH) {
			this.addTab(name, new SearchSelectNav(this.registry_, this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.MAINTAINERS) {
			this.addTab(name, new MaintainersSelect(this.registry_, this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.TARGETS) {
			// Wait for packages (which the rule-usage index derives from) to
			// be loaded; same pattern as DOCS waiting for symbols.
			getApplication(this)
				.getRegistryWithPackages()
				.then(() => {
					if (this.isDisposed()) return;
					this.addTab(name, new TargetsSelect(this.registry_, this.dom_));
					this.select(name, route);
				});
			return;
		}
		if (name === TabName.SETTINGS) {
			this.addTab(name, new SettingsSelect(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.TOOLS) {
			this.addTab(name, new ToolsSelect(this.dom_));
			this.select(name, route);
			return;
		}

		super.selectFail(name, route);
	}
}
exports.BodySelect = BodySelect;

class SearchSelectNav extends SelectNav {
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
		this.setElementInternal(soy.renderAsElement(searchSelectNav));
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		// Add nav menu items only; components are created lazily in
		// selectFail so they survive dispose+recreate cycles.
		this.addNavTabDeferred(
			TabName.MODULES,
			"Modules",
			"Module Search",
			undefined,
			"search/" + TabName.MODULES,
		);
		this.addNavTabDeferred(
			TabName.SYMBOLS,
			"Symbols",
			"Symbol Search",
			undefined,
			"search/" + TabName.SYMBOLS,
		);
		this.getHandler().listen(
			this.getElementStrict(),
			events.EventType.INPUT,
			(/** !events.Event */ e) => {
				const input = e.target;
				if (
					input instanceof HTMLInputElement &&
					input.classList.contains("js-search-input")
				) {
					this.syncSearchTabs_(searchQueryPath(input.value));
				}
			},
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return TabName.MODULES;
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.syncSearchTabs_([]);
		this.select(TabName.MODULES, route.add(TabName.MODULES));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goDown(route) {
		this.syncSearchTabs_(route.unmatchedPath().slice(1));
		super.goDown(route);
	}

	/**
	 * @private
	 * @param {!Array<string>} queryPath
	 */
	syncSearchTabs_(queryPath) {
		/** @type {!Array<string>} */
		const names = [TabName.MODULES, TabName.SYMBOLS];
		for (const name of names) {
			const item = dom.getElement(this.makeId(name));
			if (item instanceof HTMLAnchorElement) {
				item.href = `/${[TabName.SEARCH, name, ...queryPath].join("/")}`;
			}
		}
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.MODULES) {
			this.addTab(name, new ModuleSearchComponent(this.registry_, this.dom_));
			this.select(name, route);
			return;
		}
		if (name === TabName.SYMBOLS) {
			this.addTab(
				name,
				new DocumentationSearchComponent(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}
		super.selectFail(name, route);
	}
}
