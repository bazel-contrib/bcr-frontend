goog.module("bcrfrontend.body");

const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { formatRelativePast } = goog.require("bcrfrontend.format");
const { Route } = goog.requireType("stack.ui");
const { DocsSelect } = goog.require("bcrfrontend.documentation");
const { HomeSelect } = goog.require("bcrfrontend.home");
const { MaintainersSelect } = goog.require("bcrfrontend.maintainers");
const { ModulesMapSelect } = goog.require("bcrfrontend.modules");
const { SettingsSelect } = goog.require("bcrfrontend.settings");
const { bodySelect } = goog.require("soy.bcrfrontend.app");

/**
 * @enum {string}
 */
const TabName = {
	DOCS: "docs",
	HOME: "home",
	MAINTAINERS: "maintainers",
	MODULES: "modules",
	OVERVIEW: "overview",
	SETTINGS: "settings",
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
			this.addTab(TabName.DOCS, new DocsSelect(this.registry_, this.dom_));
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
