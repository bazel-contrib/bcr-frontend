goog.module("centrl.presubmit");

const Presubmit = goog.require('proto.build.stack.bazel.bzlmod.v1.Presubmit');
const Module = goog.require('proto.build.stack.bazel.bzlmod.v1.Module');
const ModuleVersion = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleVersion');
const dom = goog.require('goog.dom');
const soy = goog.require('goog.soy');
const { MarkdownComponent } = goog.require('centrl.markdown');
const { Route } = goog.require('stack.ui');
const { ContentSelect } = goog.require('centrl.ContentSelect');
const { presubmitComponent, presubmitSelect } = goog.require('soy.centrl.app');
const { highlightAll } = goog.require('centrl.syntax');

/**
 * @enum {string}
 */
const TabName = {
    OVERVIEW: "overview",
};


class PresubmitSelect extends ContentSelect {
    /**
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {?Presubmit} presubmit
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(module, moduleVersion, presubmit, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const */
        this.moduleVersion_ = moduleVersion;

        /** @private @const @type {?Presubmit} */
        this.presubmit_ = presubmit;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(presubmitSelect, {
        }));
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
        if (this.presubmit_) {
            if (name === TabName.OVERVIEW) {
                this.addTab(name, new PresubmitOverviewComponent(this.moduleVersion_, this.presubmit_, this.dom_));
                this.select(name, route);
                return;
            }
        }
        super.selectFail(name, route);
    }
}
exports.PresubmitSelect = PresubmitSelect;


class PresubmitOverviewComponent extends MarkdownComponent {
    /**
     * @param {!ModuleVersion} moduleVersion
     * @param {!Presubmit} presubmit
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(moduleVersion, presubmit, opt_domHelper) {
        super(opt_domHelper);

        /** @protected @const */
        this.moduleVersion_ = moduleVersion;

        /** @protected @const */
        this.presubmit_ = presubmit;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(presubmitComponent, {
            moduleVersion: this.moduleVersion_,
            presubmit: this.presubmit_,
        }));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        highlightAll(this.getElementStrict());
    }
}