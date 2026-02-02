goog.module("bcrfrontend.body");

const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { formatRelativePast } = goog.require("bcrfrontend.format");
const { Route } = goog.requireType("stack.ui");
const { getApplication } = goog.require("bcrfrontend.common");
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
const { bodySelect, searchSelectNav } = goog.require("soy.bcrfrontend.app");

/**
 * @enum {string}
 */
const TabName = {
	DOCS: "docs",
	HOME: "home",
	MAINTAINERS: "maintainers",
	MODULES: "modules",
	OVERVIEW: "overview",
	SEARCH: "search",
	SETTINGS: "settings",
	SYMBOLS: "symbols",
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
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addTab(TabName.HOME, new HomeSelect(this.registry_, this.dom_));
		this.addTab(
			TabName.MODULES,
			new ModulesMapSelect(this.registry_, this.dom_),
		);
		this.addTab(TabName.SETTINGS, new SettingsSelect(this.dom_));
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
		// install the maintainers tab lazily as it loads quite a few images
		// from github.
		if (name === TabName.DOCS) {
			// Wait for symbols to be available before loading docs
			getApplication(this)
				.getRegistryWithSymbols()
				.then(() => {
					this.addTab(TabName.DOCS, new DocsSelect(this.registry_, this.dom_));
					this.select(name, route);
				});
			return;
		}
		if (name === TabName.SEARCH) {
			this.addTab(
				TabName.SEARCH,
				new SearchSelectNav(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}
		if (name === TabName.MAINTAINERS) {
			this.addTab(
				TabName.MAINTAINERS,
				new MaintainersSelect(this.registry_, this.dom_),
			);
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
		this.addNavTab(
			TabName.MODULES,
			"Modules",
			"Module Search",
			undefined,
			new ModuleSearchComponent(this.registry_, this.dom_),
		);
		this.addNavTab(
			TabName.SYMBOLS,
			"Symbols",
			"Symbol Search",
			undefined,
			new DocumentationSearchComponent(this.registry_, this.dom_),
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
		this.select(TabName.MODULES, route.add(TabName.MODULES));
	}
}
