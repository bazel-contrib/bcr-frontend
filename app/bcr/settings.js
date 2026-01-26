/**
 * @fileoverview Settings components for theme and appearance configuration.
 */
goog.module("bcrfrontend.settings");

const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { settingsAppearanceComponent, settingsSelect } = goog.require(
	"soy.bcrfrontend.settings",
);

/**
 * @enum {string}
 */
const LocalStorageKey = {
	COLOR_MODE: "color-mode",
	DISPLAY_MODE: "display-mode",
};

/**
 * @enum {string}
 */
const TabName = {
	APPEARANCE: "appearance",
};

/**
 * Settings page with navigation.
 */
class SettingsSelect extends ContentSelect {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(
				settingsSelect,
				{},
				{
					pathUrl: this.getPathUrl(),
				},
			),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addTab(TabName.APPEARANCE, new SettingsAppearanceComponent(this.dom_));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.APPEARANCE, route.add(TabName.APPEARANCE));
	}
}

/**
 * Theme/appearance settings component.
 */
class SettingsAppearanceComponent extends Component {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);

		/** @private @type {?HTMLSelectElement} */
		this.themeSelectEl_ = null;

		/** @private @type {?HTMLSelectElement} */
		this.displaySelectEl_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(settingsAppearanceComponent));
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.enterThemeSelect();
		this.enterDisplaySelect();
	}

	/**
	 * @override
	 */
	exitDocument() {
		this.themeSelectEl_ = null;
		this.displaySelectEl_ = null;
		super.exitDocument();
	}

	enterThemeSelect() {
		this.themeSelectEl_ = /** @type {!HTMLSelectElement} */ (
			this.getCssElement("theme")
		);

		let colorMode = this.getLocalStorageColorMode();
		if (colorMode) {
			this.setDocumentColorMode(colorMode);
		} else {
			colorMode = this.getDocumentColorMode();
			this.setLocalStorageColorMode(colorMode);
		}
		this.themeSelectEl_.value = colorMode;

		this.getHandler().listen(
			this.themeSelectEl_,
			events.EventType.CHANGE,
			this.handleThemeSelectChange,
		);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 */
	handleThemeSelectChange(e) {
		const colorMode = this.themeSelectEl_.value || "auto";
		this.setDocumentColorMode(colorMode);
		this.setLocalStorageColorMode(colorMode);
	}

	enterDisplaySelect() {
		this.displaySelectEl_ = /** @type {!HTMLSelectElement} */ (
			this.getCssElement("display")
		);

		let displayMode = this.getLocalStorageDisplayMode();
		if (displayMode) {
			this.setDocumentDisplayMode(displayMode);
		} else {
			displayMode = "consumer";
			this.setLocalStorageDisplayMode(displayMode);
			this.setDocumentDisplayMode(displayMode);
		}
		this.displaySelectEl_.value = displayMode;

		this.getHandler().listen(
			this.displaySelectEl_,
			events.EventType.CHANGE,
			this.handleDisplaySelectChange,
		);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 */
	handleDisplaySelectChange(e) {
		const displayMode = this.displaySelectEl_.value || "consumer";
		this.setDocumentDisplayMode(displayMode);
		this.setLocalStorageDisplayMode(displayMode);
	}

	/**
	 * @returns {string}
	 */
	getDocumentColorMode() {
		return (
			this.themeSelectEl_.ownerDocument.documentElement.getAttribute(
				"data-color-mode",
			) || "auto"
		);
	}

	/**
	 * @param {string} colorMode
	 */
	setDocumentColorMode(colorMode) {
		this.themeSelectEl_.ownerDocument.documentElement.setAttribute(
			"data-color-mode",
			colorMode,
		);
	}

	/**
	 * @returns {?string}
	 */
	getLocalStorageColorMode() {
		return window.localStorage?.getItem(LocalStorageKey.COLOR_MODE);
	}

	/**
	 * @param {string} colorMode
	 */
	setLocalStorageColorMode(colorMode) {
		if (window.localStorage) {
			window.localStorage.setItem(LocalStorageKey.COLOR_MODE, colorMode);
		}
	}

	/**
	 * @returns {?string}
	 */
	getLocalStorageDisplayMode() {
		return window.localStorage?.getItem(LocalStorageKey.DISPLAY_MODE);
	}

	/**
	 * @param {string} displayMode
	 */
	setLocalStorageDisplayMode(displayMode) {
		if (window.localStorage) {
			window.localStorage.setItem(LocalStorageKey.DISPLAY_MODE, displayMode);
		}
	}

	/**
	 * @param {string} displayMode
	 */
	setDocumentDisplayMode(displayMode) {
		this.displaySelectEl_.ownerDocument.documentElement.setAttribute(
			"data-display-mode",
			displayMode,
		);
	}

	/**
	 * @param {string} cssName
	 * @return {!HTMLElement}
	 */
	getCssElement(cssName) {
		return /** @type {!HTMLElement} */ (
			dom.getRequiredElementByClass(cssName, this.getElementStrict())
		);
	}
}
exports.SettingsSelect = SettingsSelect;
