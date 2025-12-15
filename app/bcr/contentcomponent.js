/**
 * @fileoverview ContentComponent base class.
 */
goog.module("centrl.ContentComponent");

const dom = goog.require('goog.dom');
const { Component } = goog.require('stack.ui');

/**
 * Base component class that provides helper for getting CSS elements.
 */
class ContentComponent extends Component {
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
}

exports.ContentComponent = ContentComponent;
