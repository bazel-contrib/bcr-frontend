goog.module("centrl.maintainers");

const Maintainer = goog.require('proto.build.stack.bazel.registry.v1.Maintainer');
const Registry = goog.require('proto.build.stack.bazel.registry.v1.Registry');
const arrays = goog.require('goog.array');
const dom = goog.require('goog.dom');
const soy = goog.require('goog.soy');
const { ContentSelect } = goog.require('centrl.ContentSelect');
const { SelectNav } = goog.require('centrl.SelectNav');
const { createMaintainersMap, maintainerModuleVersions } = goog.require('centrl.registry');
const { maintainersSelect, maintainersMapSelectNav, maintainersMapComponent, maintainerComponent } = goog.require('soy.centrl.maintainers');
const { Component, Route } = goog.require('stack.ui');


/**
 * @enum {string}
 */
const MaintainersListTabName = {
    ALL: "all",
};


/**
 * @enum {string}
 */
const TabName = {
    LIST: "list",
};


class MaintainersSelect extends ContentSelect {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Maintainer>} */
        this.maintainers_ = createMaintainersMap(registry);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainersSelect));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.LIST, route.add(TabName.LIST));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        if (name === TabName.LIST) {
            this.addTab(
                TabName.LIST,
                new MaintainersMapSelectNav(this.registry_, this.maintainers_, this.dom_),
            );
            this.select(name, route);
            return;
        }

        const maintainer = this.maintainers_.get(name);
        if (maintainer) {
            this.addTab(name, new MaintainerComponent(this.registry_, name, maintainer));
            this.select(name, route);
            return;
        } else {
            console.warn(`failed to get maintainer for ${name}`, this.maintainers_.keys());
        }

        super.selectFail(name, route);
    }
}
exports.MaintainersSelect = MaintainersSelect;


class MaintainersMapSelectNav extends SelectNav {
    /**
     * @param {!Registry} registry
     * @param {!Map<string,!Maintainer>} maintainers
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, maintainers, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Maintainer>} */
        this.maintainers_ = maintainers;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainersMapSelectNav));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(MaintainersListTabName.ALL, route.add(MaintainersListTabName.ALL));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.enterAllTab();
    }

    enterAllTab() {
        this.addNavTab(
            MaintainersListTabName.ALL,
            'All',
            'List of all Maintainers',
            this.maintainers_.size,
            new MaintainersMapComponent(this.maintainers_, this.dom_),
        );
    }

    /**
     * @override
     * @returns {string}
     */
    getDefaultTabName() {
        return MaintainersListTabName.ALL;
    }
}


class MaintainersMapComponent extends Component {
    /**
     * @param {!Map<string,!Maintainer>} maintainers
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(maintainers, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Map<string,!Maintainer>} */
        this.maintainers_ = maintainers;
    }

    /**
     * @override
     */
    createDom() {
        /** @type {!Array<!Maintainer>} */
        const maintainers = Array.from(this.maintainers_.values());
        arrays.shuffle(maintainers);

        this.setElementInternal(soy.renderAsElement(maintainersMapComponent, {
            maintainers,
        }));
    }
}


class MaintainerComponent extends Component {
    /**
     * @param {!Registry} registry
     * @param {string} name
     * @param {!Maintainer} maintainer
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, name, maintainer, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {string} */
        this.maintainerName_ = name;

        /** @private @const @type {!Maintainer} */
        this.maintainer_ = maintainer;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(maintainerComponent, {
            name: this.maintainerName_,
            maintainer: this.maintainer_,
            moduleVersions: maintainerModuleVersions(this.registry_, this.maintainer_),
        }));
    }
}
