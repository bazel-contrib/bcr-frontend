goog.module("centrl.App");

const ComponentEventType = goog.require('goog.ui.Component.EventType');
const Registry = goog.require('proto.build.stack.bazel.bzlmod.v1.Registry');
const asserts = goog.require('goog.asserts');
const dataset = goog.require('goog.dom.dataset');
const dom = goog.require('goog.dom');
const events = goog.require('goog.events');
const soy = goog.require('goog.soy');
const { App, Component, Route, RouteEvent, RouteEventType } = goog.require('stack.ui');
const { Application, SearchProvider } = goog.requireType('centrl.common');
const { BodySelect } = goog.require('centrl.body');
const { DocumentationSearchHandler } = goog.require('centrl.documentation_search');
const { MVS } = goog.require('centrl.mvs');
const { ModuleSearchHandler } = goog.require('centrl.module_search');
const { SearchComponent } = goog.require('centrl.search');
const { copyToClipboard } = goog.require('centrl.clipboard');
const { registryApp, toastSuccess } = goog.require('soy.centrl.app');

/**
 * Top-level app component.
 *
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

        /** @private @type {!BodySelect} */
        this.body_ = new BodySelect(this.registry_, opt_domHelper);

        /** @const @private @type {!ModuleSearchHandler} */
        this.moduleSearchHandler_ = new ModuleSearchHandler(this.registry_);

        /** @const @private @type {!DocumentationSearchHandler} */
        this.documentationSearchHandler_ = new DocumentationSearchHandler(this.registry_);

        /** @private @type {?SearchComponent} */
        this.search_ = null;

        // Build MVS maps from this.registry_
        const { moduleVersionMap, moduleMetadataMap } = MVS.buildMaps(this.registry_);

        /** @private @const @type {!MVS} */
        this.mvs_ = new MVS(moduleVersionMap, moduleMetadataMap);
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

    /**
     * Returns the MVS instance.
     * @override
     * @return {!MVS}
     */
    getMvs() {
        return this.mvs_;
    }

    /** @override */
    createDom() {
        this.setElementInternal(soy.renderAsElement(registryApp));
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
        this.documentationSearchHandler_.addAllSymbols();

        this.search_.addSearchProvider(
            this.moduleSearchHandler_.getSearchProvider(),
        );
        this.search_.addSearchProvider(
            this.documentationSearchHandler_.getSearchProvider(),
        );

        this.search_.setCurrentSearchProviderByName('module');
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
            const inputValue = this.search_.getValue();

            switch (e.keyCode) {
                case events.KeyCodes.ESC:
                    this.blurSearchBox(e);
                    break;
                case events.KeyCodes.SLASH:
                    // If input is empty, switch to module search
                    if (inputValue.length === 0) {
                        this.focusSearchBox(e, this.moduleSearchHandler_.getSearchProvider());
                    }
                    break;
                case events.KeyCodes.PERIOD:
                    // If input is empty, switch to documentation search
                    if (inputValue.length === 0) {
                        this.focusSearchBox(e, this.documentationSearchHandler_.getSearchProvider());
                    }
                    break;
            }
            return;
        }

        // CMD-P (Mac) or CTRL-P (Windows/Linux) to focus documentation search
        if (e.keyCode === events.KeyCodes.P && (e.metaKey || e.ctrlKey)) {
            if (this.getKbd().isEnabled()) {
                this.focusSearchBox(e, this.documentationSearchHandler_.getSearchProvider());
            }
            return;
        }

        switch (e.keyCode) {
            case events.KeyCodes.SLASH:
                if (this.getKbd().isEnabled()) {
                    this.focusSearchBox(e, this.moduleSearchHandler_.getSearchProvider());
                }
                break;
            case events.KeyCodes.PERIOD:
                if (this.getKbd().isEnabled()) {
                    this.focusSearchBox(e, this.documentationSearchHandler_.getSearchProvider());
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
     * @param {?SearchProvider=} opt_searchProvider If a provider is given, set to the active one.
     */
    focusSearchBox(opt_e, opt_searchProvider) {
        if (opt_searchProvider) {
            this.search_.setCurrentProvider(opt_searchProvider);
        }
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
        const route = /** @type {!Route} */ (e.target);
        console.log('done:', route.getPath());
    }

    /**
     * @param {!events.Event} e
     */
    handleRouteProgress(e) {
        const routeEvent = /** @type {!RouteEvent} */ (e);
        // console.info(`progress: ${routeEvent.route.unmatchedPath()}`, routeEvent);
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
                    this.toastSuccess(`copied: ${clippy}`);
                    return true;
                }
                const searchprovider = dataset.get(node, "searchprovider");
                if (searchprovider) {
                    this.search_.setCurrentSearchProviderByName(searchprovider);
                    return true;
                }
                return false;
            },
            true,
        );
    }

    /**
     * Place an info toast on the page
     * @param {string} message
     * @param {number=} opt_dismiss
     */
    toastSuccess(message, opt_dismiss) {
        const toast = soy.renderAsElement(toastSuccess, { message });
        dom.append(document.body, toast);
        setTimeout(() => dom.removeNode(toast), opt_dismiss || 3000);
    }
}
exports = RegistryApp;
