/**
 * @fileoverview Settings components for theme and appearance configuration.
 */
goog.module("bcrfrontend.settings");

const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { getApplication } = goog.require("bcrfrontend.common");
const { RefreshController, RefreshMode } = goog.require("bcrfrontend.refresh");
const { settingsAppearanceComponent, settingsSelect } = goog.require(
	"soy.bcrfrontend.settings",
);

/**
 * @enum {string}
 */
const LocalStorageKey = {
	COLOR_MODE: "color-mode",
	DISPLAY_MODE: "display-mode",
	REFRESH_MODE: "refresh-mode",
};

/**
 * @enum {string}
 */
const DisplayMode = {
	CONSUMER: "consumer",
	MAINTAINER: "maintainer",
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

		/** @private @type {?HTMLSelectElement} */
		this.refreshSelectEl_ = null;
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
		this.enterRefreshSelect();
	}

	/**
	 * @override
	 */
	exitDocument() {
		this.themeSelectEl_ = null;
		this.displaySelectEl_ = null;
		this.refreshSelectEl_ = null;
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
			displayMode = DisplayMode.CONSUMER;
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
		const displayMode = this.displaySelectEl_.value || DisplayMode.CONSUMER;
		this.setDocumentDisplayMode(displayMode);
		this.setLocalStorageDisplayMode(displayMode);
		window.location.reload();
	}

	enterRefreshSelect() {
		this.refreshSelectEl_ = /** @type {!HTMLSelectElement} */ (
			this.getCssElement("refresh")
		);

		let refreshMode = this.getLocalStorageRefreshMode();
		if (
			refreshMode !== RefreshMode.OFF &&
			refreshMode !== RefreshMode.NOTIFY &&
			refreshMode !== RefreshMode.AUTO
		) {
			refreshMode = RefreshMode.NOTIFY;
			this.setLocalStorageRefreshMode(refreshMode);
		}
		this.refreshSelectEl_.value = refreshMode;

		this.getHandler().listen(
			this.refreshSelectEl_,
			events.EventType.CHANGE,
			this.handleRefreshSelectChange,
		);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 */
	handleRefreshSelectChange(e) {
		const refreshMode = this.refreshSelectEl_.value || RefreshMode.NOTIFY;
		this.setLocalStorageRefreshMode(refreshMode);
		// Notify the live controller — no page reload needed, this setting
		// only controls the polling behavior, not anything rendered.
		const controller = /** @type {?RefreshController} */ (
			getApplication(this).getRefreshController()
		);
		if (controller) {
			controller.setMode(refreshMode);
		}
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
	 * @returns {?string}
	 */
	getLocalStorageRefreshMode() {
		return window.localStorage?.getItem(LocalStorageKey.REFRESH_MODE);
	}

	/**
	 * @param {string} refreshMode
	 */
	setLocalStorageRefreshMode(refreshMode) {
		if (window.localStorage) {
			window.localStorage.setItem(LocalStorageKey.REFRESH_MODE, refreshMode);
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

/**
 * Get the current display mode from the document.
 * @return {string}
 */
function getDocumentDisplayMode() {
	return (
		document.documentElement.getAttribute("data-display-mode") ||
		DisplayMode.CONSUMER
	);
}

/**
 * Check if the display mode is "maintainer".
 * @return {boolean}
 */
function isDocumentDisplayModeMaintainer() {
	return getDocumentDisplayMode() === DisplayMode.MAINTAINER;
}

exports.SettingsSelect = SettingsSelect;
exports.DisplayMode = DisplayMode;
exports.isDocumentDisplayModeMaintainer = isDocumentDisplayModeMaintainer;
