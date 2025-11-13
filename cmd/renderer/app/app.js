goog.module("centrl.App");

const ComponentEventType = goog.require("goog.ui.Component.EventType");
const Maintainer = goog.require("proto.build.stack.bazel.bzlmod.v1.Maintainer");
const Message = goog.require("jspb.Message");
const Module = goog.require("proto.build.stack.bazel.bzlmod.v1.Module");
const ModuleDependency = goog.require("proto.build.stack.bazel.bzlmod.v1.ModuleDependency");
const ModuleVersion = goog.require("proto.build.stack.bazel.bzlmod.v1.ModuleVersion");
const Registry = goog.require("proto.build.stack.bazel.bzlmod.v1.Registry");
const Select = goog.require("stack.ui.Select");
const arrays = goog.require("goog.array");
const asserts = goog.require("goog.asserts");
const dataset = goog.require("goog.dom.dataset");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const strings = goog.require("goog.string");
const { App, Component, Route, RouteEvent, RouteEventType } = goog.require("stack.ui");
const { Application, Searchable } = goog.require("centrl.common");
const { ModuleSearchHandler, SearchComponent } = goog.require('centrl.search');
const {
    app,
    body,
    home,
    maintainerComponent,
    maintainerList,
    maintainersComponent,
    moduleComponent,
    moduleList,
    moduleVersionComponent,
    moduleVersionList,
    moduleVersionOverviewComponent,
    modulesComponent,
    notFound,
} = goog.require('soy.centrl.app');
const {
    registryModuleVersions,
} = goog.require('soy.registry');

const SYNTAX_HIGHLIGHT = false;

/**
 * Top-level app component.
 * @implements {Application}
 */
class RegistryApp extends App {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const */
        this.registry_ = registry;

        /** @private @type {!Map<string,string>} */
        this.options_ = new Map();

        /** @private @type {?Component} */
        this.activeComponent_ = null;

        /** @private @type {!Body} */
        this.body_ = new Body(registry, opt_domHelper);

        /** @const @private @type {!ModuleSearchHandler} */
        this.moduleSearchHandler_ = new ModuleSearchHandler();

        /** @private @type {?SearchComponent} */
        this.search_ = null;
    }

    /**
     * Returns a set of named flags.  This is a way to pass in compile-time global
     * constants into goog.modules.
     * @override
     * @returns {!Map<string,string>}
     */
    getOptions() {
        return this.options_;
    }

    /** @override */
    createDom() {
        this.setElementInternal(soy.renderAsElement(app));
    }

    /** @override */
    enterDocument() {
        super.enterDocument();

        this.addChild(this.body_, true);

        this.enterRouter();
        this.enterSearch();
        this.enterKeys();
        this.enterTopLevelClickEvents();
    }

    /**
     * Setup event listeners that bubble up to the app.
     */
    enterTopLevelClickEvents() {
        this.getHandler().listen(
            this.getElementStrict(),
            events.EventType.CLICK,
            this.handleElementClick,
        );
    }

    /**
     * Register for router events.
     */
    enterRouter() {
        const handler = this.getHandler();
        const router = this.getRouter();

        handler.listen(router, ComponentEventType.ACTION, this.handleRouteBegin);
        handler.listen(router, RouteEventType.DONE, this.handleRouteDone);
        handler.listen(router, RouteEventType.PROGRESS, this.handleRouteProgress);
        handler.listen(router, RouteEventType.FAIL, this.handleRouteFail);
    }

    /**
     * Setup the search component.
     */
    enterSearch() {
        const formEl = asserts.assertElement(
            this.getElementStrict().querySelector("form"),
        );

        this.search_ = new SearchComponent(this, formEl);

        events.listen(this.search_, events.EventType.FOCUS, () =>
            this.getKbd().setEnabled(false),
        );
        events.listen(this.search_, events.EventType.BLUR, () =>
            this.getKbd().setEnabled(true),
        );

        this.moduleSearchHandler_.addModules(this.registry_.getModulesList());
        this.rebuildSearch();
    }


    /**
     * Setup keyboard shorcuts.
     */
    enterKeys() {
        this.getHandler().listen(
            window.document.documentElement,
            "keydown",
            this.onKeyDown,
        );
        this.getKbd().setEnabled(true);
    }


    /**
     * @param {!events.BrowserEvent=} e
     * suppress {checkTypes}
     */
    onKeyDown(e) {
        if (this.search_.isActive()) {
            switch (e.keyCode) {
                case events.KeyCodes.ESC:
                    this.blurSearchBox(e);
                    break;
            }
            return;
        }

        switch (e.keyCode) {
            case events.KeyCodes.SLASH:
                if (this.getKbd().isEnabled()) {
                    this.focusSearchBox(e);
                }
                break;
        }

        if (this.activeComponent_) {
            this.activeComponent_.dispatchEvent(e);
        }
    }

    /**
     * Focuses the search box.
     *
     * @param {!events.BrowserEvent=} opt_e The browser event this action is
     *     in response to. If provided, the event's propagation will be cancelled.
     */
    focusSearchBox(opt_e) {
        this.search_.focus();
        if (opt_e) {
            opt_e.preventDefault();
            opt_e.stopPropagation();
        }
    }

    /**
     * UnFocuses the search box.
     *
     * @param {!events.BrowserEvent=} opt_e The browser event this action is
     *     in response to. If provided, the event's propagation will be cancelled.
     */
    blurSearchBox(opt_e) {
        this.search_.blur();
        if (opt_e) {
            opt_e.preventDefault();
            opt_e.stopPropagation();
        }
    }

    /**
     * @param {!events.Event} e
     */
    handleRouteBegin(e) { }

    /**
     * @param {!events.Event} e
     */
    handleRouteDone(e) {
        const routeEvent = /** @type {!RouteEvent} */ (e);
        this.activeComponent_ = routeEvent.component || null;
        this.rebuildSearch();

    }

    /**
     * @param {!events.Event} e
     */
    handleRouteProgress(e) {
        const routeEvent = /** @type {!RouteEvent} */ (e);
        console.info(`progress: ${routeEvent.route.unmatchedPath()}`, routeEvent);
    }

    /**
     * @param {!events.Event} e
     */
    handleRouteFail(e) {
        const route = /** @type {!Route} */ (e.target);
        this.getRouter().unlistenRoute();
        this.activeComponent_ = null;
        console.error('not found:', route.getPath());
        // this.route("/" + TabName.NOT_FOUND + route.getPath());
        this.rebuildSearch();
    }

    /** 
     * @override
     * @param {!Route} route the route object
     */
    go(route) {
        route.touch(this);
        route.progress(this);
        this.body_.go(route);
    }

    /**
     * Handle element click event and search for an el with a 'data-route'
     * or data-clippy element.  If found, send it.
     *
     * @param {!events.Event} e
     */
    handleElementClick(e) {
        const target = /** @type {?Node} */ (e.target);
        if (!target) {
            return;
        }

        dom.getAncestor(
            target,
            (node) => {
                if (!(node instanceof Element)) {
                    return false;
                }
                const route = dataset.get(node, "route");
                if (route) {
                    this.setLocation(route.split("/"));
                    return true;
                }
                const clippy = dataset.get(node, "clippy");
                if (clippy) {
                    copyToClipboard(clippy);
                    events.listen(node, events.EventType.CLICK, handleClippyElementClick);
                    // this.toastSuccess(`"${clippy}" copied to clipboard`);
                    return true;
                }
                return false;
            },
            true,
        );
    }

    rebuildSearch() {
        this.search_.findSearchProviders(this.activeComponent_);
        this.search_.addSearchProvider(
            this.moduleSearchHandler_.getSearchProvider(),
        );
        this.search_.rebuild();
    }

}
exports = RegistryApp;


/**
 * @enum {string}
 */
const TabName = {
    HOME: "home",
    LIST: "list",
    MODULE_VERSIONS: "moduleversions",
    MAINTAINERS: "maintainers",
    MODULES: "modules",
    NOT_FOUND: "404",
    OVERVIEW: "overview",
};

/**
 * Main body of the application.
 */
class Body extends Select {
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
        this.setElementInternal(soy.renderAsElement(body));
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
     */
    enterDocument() {
        super.enterDocument();

        this.addTab(TabName.HOME, new Home(this.registry_, this.dom_));
        this.addTab(TabName.MODULES, new ModulesComponent(this.registry_, this.dom_));
        this.addTab(TabName.NOT_FOUND, new NotFound(this.dom_));
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
        if (name === TabName.MAINTAINERS) {
            this.addTab(TabName.MAINTAINERS, new MaintainersComponent(this.registry_, this.dom_));
            this.select(name, route);
            return;
        }
        super.selectFail(name, route);
    }
}


/**
 * @abstract
 */
class TabBase extends Select {
    /**
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(opt_domHelper) {
        super(opt_domHelper);
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.getHandler().listen(
            this,
            [ComponentEventType.SHOW, ComponentEventType.HIDE],
            this.handleShowHide,
        );
    }

    /**
     * @abstract
     * @returns {string}
     */
    getDefaultTabName() { }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(this.getDefaultTabName(), route.add(this.getDefaultTabName()));
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
     * @return {!HTMLElement}
     */
    getMenuElement() {
        return this.getCssElement(goog.getCssName("menu"));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Component} c
     * @returns {!Component}
     */
    addTab(name, c) {
        const rv = super.addTab(name, c);

        const item = this.createMenuItem(strings.capitalize(name), c.getPathUrl());
        const fragmentId = this.makeId(c.getId());
        item.id = fragmentId;

        dom.append(this.getMenuElement(), item);
        return rv;
    }

    /**
     * @param {string} name
     * @param {string} path
     * @return {!HTMLElement}
     */
    createMenuItem(name, path) {
        const a = dom.createDom(dom.TagName.A, "appnav-item", name);
        a.href = "/#/" + path;
        dataset.set(a, "name", name);
        return a;
    }

    /**
     * @param {!events.Event} e
     */
    handleShowHide(e) {
        const target = /** @type {!Component} */ (e.target);

        // Check that the target is a child of us
        const child = this.getChild(target.getId());
        if (!child) {
            return;
        }

        // Find the menu item element corresponding to the child
        const fragmentId = this.makeId(target.getId());
        const item = dom.getElement(fragmentId);
        if (!item) {
            return;
        }

        // Get the parent element and find the current active item.
        const menu = dom.getParentElement(item);
        const activeItems = dom.getElementsByClass("appnav-item", menu);
        if (activeItems && activeItems.length) {
            arrays.forEach(activeItems, (el) => dom.classlist.remove(el, "selected"));
        }

        dom.classlist.add(item, "selected");
    }
}

class Home extends Select {
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
        this.setElementInternal(soy.renderAsElement(home, {
            registry: this.registry_,
        }));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(TabName.MODULE_VERSIONS, route.add(TabName.MODULE_VERSIONS));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        this.addTab(
            TabName.MODULE_VERSIONS,
            new ModuleVersionList(this.registry_, this.dom_),
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

    /**
     * @override
     * @return {Element} Element to contain child elements (null if none).
     */
    getContentElement() {
        return this.getCssElement(goog.getCssName("content"));
    }
}


class ModuleVersionList extends Component {
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
        this.setElementInternal(soy.renderAsElement(moduleVersionList, {
            registry: this.registry_,
        }));
    }
}


class ModuleVersionOverviewComponent extends Component {
    /**
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(module, moduleVersion, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.moduleVersion_ = moduleVersion;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleVersionOverviewComponent, {
            module: this.module_,
            metadata: asserts.assertObject(this.module_.getMetadata()),
            deps: this.moduleVersion_.getDepsList().filter(d => !d.getDev()),
            devDeps: this.moduleVersion_.getDepsList().filter(d => d.getDev()),
            moduleVersion: this.moduleVersion_,
        }));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();

        if (SYNTAX_HIGHLIGHT) {
            const preEls = this.dom_.getElementsByTagNameAndClass(dom.TagName.CODE, goog.getCssName('shiki'), this.getElementStrict());
            arrays.forEach(preEls, el => syntaxHighlight(this.dom_.getWindow(), el));
        }
    }
}


class MaintainersComponent extends Select {
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
        this.setElementInternal(soy.renderAsElement(maintainersComponent));
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
     */
    enterDocument() {
        super.enterDocument();

        this.addTab(
            TabName.LIST,
            new MaintainerList(this.maintainers_, this.dom_),
        );
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
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

class ModulesComponent extends Select {
    /**
     * @param {!Registry} registry
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(registry, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Registry} */
        this.registry_ = registry;

        /** @private @const @type {!Map<string,!Module>} */
        this.modules_ = createModuleMap(registry);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(modulesComponent, {
        }));
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
     */
    enterDocument() {
        super.enterDocument();
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        const module = this.modules_.get(name);

        if (name === TabName.LIST) {
            this.addTab(
                TabName.LIST,
                new ModuleList(this.registry_, this.dom_),
            );
            this.select(name, route);
            return;
        }

        if (module) {
            this.addTab(name, new ModuleComponent(name, module));
            this.select(name, route);
            return;
        } else {
            console.warn(`failed to get module for ${name}`, this.modules_.keys());
        }

        super.selectFail(name, route);
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


class ModuleList extends Component {
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
        this.setElementInternal(soy.renderAsElement(registryModuleVersions, {
            moduleVersions: getLatestModuleVersions(this.registry_),
        }));
    }
}

class MaintainerList extends Component {
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
        this.setElementInternal(soy.renderAsElement(maintainerList, {
            maintainers: this.maintainers_,
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

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();
    }
}


class ModuleComponent extends Select {
    /**
     * @param {string} name
     * @param {!Module} module
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(name, module, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {string} */
        this.moduleName_ = name;

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.latest_ = getLatestModuleVersion(module);

        /** @private @const @type {!Map<string,!ModuleVersion>} */
        this.moduleVersions_ = createModuleVersionMap(module);
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleComponent, {
            name: this.moduleName_,
            module: this.module_,
        }));
    }

    /**
     * @override
     * @param {!Route} route
     */
    goHere(route) {
        this.select(this.latest_.getVersion(), route.add(this.latest_.getVersion()));
    }

    /**
     * @override
     */
    enterDocument() {
        super.enterDocument();
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        const moduleVersion = this.moduleVersions_.get(name);

        if (moduleVersion) {
            this.addTab(name, new ModuleVersionComponent(this.module_, moduleVersion));
            this.select(name, route);
            return;
        }

        super.selectFail(name, route);
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


class ModuleVersionComponent extends Select {
    /**
     * @param {!Module} module
     * @param {!ModuleVersion} moduleVersion
     * @param {?dom.DomHelper=} opt_domHelper
     */
    constructor(module, moduleVersion, opt_domHelper) {
        super(opt_domHelper);

        /** @private @const @type {!Module} */
        this.module_ = module;

        /** @private @const @type {!ModuleVersion} */
        this.moduleVersion_ = moduleVersion;
    }

    /**
     * @override
     */
    createDom() {
        this.setElementInternal(soy.renderAsElement(moduleVersionComponent, {
            moduleVersion: this.moduleVersion_,
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
     */
    enterDocument() {
        super.enterDocument();

        this.addTab(TabName.OVERVIEW, new ModuleVersionOverviewComponent(this.module_, this.moduleVersion_));
    }

    /**
     * @override
     * @param {string} name
     * @param {!Route} route
     */
    selectFail(name, route) {
        super.selectFail(name, route);
    }
}

class NotFound extends Component {
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
        this.setElementInternal(soy.renderAsElement(notFound));
    }
}

/**
 * Builds a mapping of modules from the registry.
 * 
 * @param {!Registry} registry
 * @returns {!Map<string,!Module>} set of modules by name
 */
function createModuleMap(registry) {
    const result = new Map();
    registry.getModulesList().forEach(m => {
        const latest = getLatestModuleVersion(m);
        result.set(latest.getName(), m);
    });
    return result;
}

/**
 * Builds a mapping of maintainers from the registry.
 * 
 * @param {!Registry} registry
 * @returns {!Map<string,!Maintainer>} set of modules by name
 */
function createMaintainersMap(registry) {
    const result = new Map();
    registry.getModulesList().forEach(module => {
        module.getMetadata().getMaintainersList().forEach(maintainer => {
            if (maintainer.getGithub()) {
                result.set("@" + maintainer.getGithub(), maintainer);
            } else if (maintainer.getEmail()) {
                result.set(maintainer.getEmail(), maintainer);
            }
        });
    });
    return result;
}

/**
 * Determines the list of .
 * 
 * @param {!Registry} registry
 * @param {!Maintainer} maintainer
 * @returns {!Array<!ModuleVersion>} set of (latest) module versions that this maintainer maintains
 */
function maintainerModuleVersions(registry, maintainer) {
    const result = new Set();
    registry.getModulesList().forEach(module => {
        const metadata = module.getMetadata();
        metadata.getMaintainersList().forEach(m => {
            if (maintainer.getGithub() === m.getGithub() || maintainer.getEmail() === m.getEmail()) {
                result.add(module.getVersionsList()[0]);
            }
        });
    });
    return Array.from(result);
}

/**
 * Builds a mapping of module versions from a module.
 * 
 * @param {!Window} window
 * @param {!HTMLElement} el The element to highlight
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
async function syntaxHighlight(window, el) {
    const html = await window.codeToHtml(dom.getTextContent(el), {
        'lang': 'py',
        'theme': 'min-light',
    });
    el.innerHTML = html;
    console.log('html:', html);
    // dom.getParentElement(preEl).innerHTML = html;
}


/**
 * Builds a mapping of module versions from a module.
 * 
 * @param {!Module} module
 * @returns {!Map<string,!ModuleVersion>} set of module versions by ID
 */
function createModuleVersionMap(module) {
    const result = new Map();
    module.getVersionsList().forEach(mv => {
        result.set(mv.getVersion(), mv);
    });
    return result;
}

/**
 * @param {!Registry} registry 
 * @returns {!Array<!ModuleVersion>}
 */
function getLatestModuleVersions(registry) {
    return registry.getModulesList().map(module => {
        return module.getVersionsList()[0];
    });
}

/**
 * @param {!Module} module 
 * @returns {!ModuleVersion}
 */
function getLatestModuleVersion(module) {
    const versions = module.getVersionsList();
    return versions[0];
}

/**
 * @param {string} text
 */
function copyToClipboard(text) {
    const el = dom.createDom(dom.TagName.TEXTAREA);
    el.value = text; // Set its value to the string that you want copied
    el.setAttribute("readonly", ""); // Make it readonly to be tamper-proof
    el.style.position = "absolute";
    el.style.left = "-9999px"; // Move outside the screen to make it invisible
    document.body.appendChild(el); // Append the <textarea> element to the HTML document
    const selected =
        document.getSelection().rangeCount > 0 // Check if there is any content selected previously
            ? document.getSelection().getRangeAt(0) // Store selection if found
            : null; // Mark as false to know no selection existed before
    el.select(); // Select the <textarea> content
    document.execCommand("copy"); // Copy - only works as a result of a user action (e.g. click events)
    document.body.removeChild(el); // Remove the <textarea> element
    if (selected) {
        // If a selection existed before copying
        document.getSelection().removeAllRanges(); // Unselect everything on the HTML document
        document.getSelection().addRange(selected); // Restore the original selection
    }
}

/**
 * Handle element click event for a clippy element.
 *
 * @param {!events.Event} e
 */
function handleClippyElementClick(e) {
    const target = e.target;
    if (target instanceof HTMLElement) {
        const iEl = dom.getRequiredHTMLElementByClass("octicon", target);
        dom.classlist.add(iEl, "octicon-check");
        dom.classlist.remove(iEl, "octicon-clippy");
        setTimeout(() => {
            dom.classlist.add(iEl, "octicon-clippy");
            dom.classlist.remove(iEl, "octicon-check");
        }, 2000);
    }
}

/**
 * Utility function using traditional iteration, wrote this to workaround
 * closure compiler.
 * @param {?HTMLElement} el 
 * @param {!Array<string>} names 
 * @param {!function(?Element, string)} fn
 */
function applyAll(el, names, fn) {
    for (const n in names) {
        fn(el, n);
    }
}