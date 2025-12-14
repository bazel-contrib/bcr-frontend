/**
 * @fileoverview Settings components for theme and appearance configuration.
 */
goog.module("centrl.settings");

const dom = goog.require('goog.dom');
const events = goog.require('goog.events');
const soy = goog.require('goog.soy');
const { Component, Route } = goog.require('stack.ui');
const { ContentSelect } = goog.require('centrl.ContentSelect');
const { settingsAppearanceComponent, settingsSelect } = goog.require('soy.centrl.settings');

/**
 * @enum {string}
 */
const LocalStorageKey = {
    COLOR_MODE: 'color-mode',
};

/**
 * @enum {string}
 */
const TabName = {
    APPEARANCE: 'appearance',
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
        this.setElementInternal(soy.renderAsElement(settingsSelect, {
        }, {
            pathUrl: this.getPathUrl(),
        }));
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
    }

    /**
     * @override
     */
    exitDocument() {
        this.themeSelectEl_ = null;
        super.exitDocument();
    }

    enterThemeSelect() {
        this.themeSelectEl_ = /** @type {!HTMLSelectElement} */(this.getCssElement('theme'));

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
        const colorMode = this.themeSelectEl_.value || 'auto';
        this.setDocumentColorMode(colorMode);
        this.setLocalStorageColorMode(colorMode);
    }

    /**
     * @returns {string}
     */
    getDocumentColorMode() {
        return this.themeSelectEl_.ownerDocument.documentElement.getAttribute('data-color-mode') || 'auto';
    }

    /**
     * @param {string} colorMode
     */
    setDocumentColorMode(colorMode) {
        this.themeSelectEl_.ownerDocument.documentElement.setAttribute('data-color-mode', colorMode);
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
exports.SettingsAppearanceComponent = SettingsAppearanceComponent;
