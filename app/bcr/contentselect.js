/**
 * @fileoverview ContentSelect base class for Select components with not-found handling.
 */
goog.module("centrl.ContentSelect");

const dom = goog.require('goog.dom');
const soy = goog.require('goog.soy');
const Select = goog.require('stack.ui.Select');
const { Component, Route } = goog.require('stack.ui');
const { notFoundComponent } = goog.require('soy.centrl.app');

/**
 * Tab name constant for the not found page.
 * @const {string}
 */
const NOT_FOUND = "404";

/**
 * Base Select component that shows a not found page for unknown routes.
 * @abstract
 */
class ContentSelect extends Select {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
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

    /**
     * @override
     * @return {Element} Element to contain child elements (null if none).
     */
    getContentElement() {
        return this.getCssElement(goog.getCssName("content"));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        let tab = this.getTab(NOT_FOUND);
        if (tab) {
            this.showTab(NOT_FOUND);
            tab.go(route);
        } else {
            this.addTab(NOT_FOUND, new NotFoundComponent(this.dom_));
            this.select(name, route);
        }
    }
}

/**
 * Component for displaying a 404 not found page.
 */
class NotFoundComponent extends Component {
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
        this.setElementInternal(soy.renderAsElement(notFoundComponent));
    }
}

exports.ContentSelect = ContentSelect;
exports.NOT_FOUND = NOT_FOUND;
exports.NotFoundComponent = NotFoundComponent;
