/**
 * @fileoverview A class that facilitates autocompletion search for a set of
 * Module objects.
 */
goog.module("centrl.search");

const asserts = goog.require("goog.asserts");
const AutoComplete = goog.require("goog.ui.ac.AutoComplete");
const AutoCompleteMatcher = goog.require("dossier.AutoCompleteMatcher");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const EventTarget = goog.require("goog.events.EventTarget");
const InputHandler = goog.require("goog.ui.ac.InputHandler");
const ListenableKey = goog.require("goog.events.ListenableKey");
const Module = goog.require("proto.build.stack.bazel.bzlmod.v1.Module");
const Renderer = goog.require("goog.ui.ac.Renderer");
const soy = goog.require("goog.soy");
const { Application, DefaultSearchHandlerName, Searchable, SearchableSelect, SearchProvider } = goog.require("centrl.common");
const { moduleSearchRow } = goog.require('soy.centrl.app');
const { Component } = goog.require("stack.ui");


/**
 * Widget for controlling the top navigation bar's search box.
 */
class SearchComponent extends EventTarget {
    /**
     * @param {!Application} app
     * @param {!Element} formEl The form element containing the input element.
     */
    constructor(app, formEl) {
        super();

        /** @private @const */
        this.app_ = app;

        /** @const @private {!HTMLInputElement} */
        this.inputEl_ = /** @type {!HTMLInputElement} */ (
            asserts.assertElement(formEl.querySelector("input"))
        );

        events.listen(
            formEl,
            events.EventType.SUBMIT,
            this.handleFormSubmit,
            false,
            this,
        );
        events.listen(
            this.inputEl_,
            events.EventType.FOCUS,
            this.handleInputFocus,
            false,
            this,
        );
        events.listen(
            this.inputEl_,
            events.EventType.BLUR,
            this.handleInputBlur,
            false,
            this,
        );

        /**
         * A mapping from name to SearchProvider.  This is rebuilt each time
         * a new active component routing occurs.
         * @private @const @type {!Array<!SearchProvider>} */
        this.providers_ = [];

        /**
         * The current provider
         * @private @type {?SearchProvider}
         */
        this.currentProvider_ = null;

        /**
         * The current provider name
         * @private @type {string}
         */
        this.currentProviderName_ = DefaultSearchHandlerName;

        /**
         * @private @type {?ListenableKey}
         */
        this.acListenerKey_ = null;
    }

    /**
     * @param {!events.Event} e the event to respond to.
     * @private
     */
    handleInputBlur(e) {
        this.dispatchEvent(events.EventType.BLUR);

        if (!this.currentProvider_) {
            return;
        }

        const inputHandler = this.currentProvider_.inputHandler;
        if (!inputHandler) {
            return;
        }

        const ac = inputHandler.getAutoComplete();
        if (!ac) {
            return;
        }

        if (this.acListenerKey_) {
            ac.unlistenByKey(asserts.assertObject(this.acListenerKey_));
        }
    }

    /**
     * @param {!events.Event} e the event to respond to.
     * @private
     */
    handleInputFocus(e) {
        setTimeout(() => {
            document.execCommand("selectall", null, false);
        }, 50);

        this.dispatchEvent(events.EventType.FOCUS);

        if (!this.currentProvider_) {
            return;
        }

        const inputHandler = this.currentProvider_.inputHandler;
        if (!inputHandler) {
            return;
        }

        const ac = inputHandler.getAutoComplete();
        if (!ac) {
            return;
        }

        this.acListenerKey_ = ac.listenOnce(
            AutoComplete.EventType.UPDATE,
            this.handleAcUpdate,
            false,
            this,
        );
    }

    /**
     * @param {!events.Event} e the event to respond to.
     * @private
     */
    handleFormSubmit(e) {
        e.preventDefault();
        e.stopPropagation();

        setTimeout(() => {
            document.execCommand("selectall", null, false);
        }, 50);

        this.submit(this.inputEl_.value);
    }

    /**
     * @param {string} value
     */
    submit(value) {
        if (!this.currentProvider_) {
            return;
        }

        if (!this.currentProvider_.onsubmit) {
            return;
        }

        this.currentProvider_.onsubmit(this.app_, value);
    }

    /**
     * @param {{row:string,index:number}} e the event to respond to.
     *
     */
    handleAcUpdate(e) {
        if (e.row) {
            this.submit(e.row);
        }
        this.blurAndClear();
    }

    /**
     * Search up through the component tree and find searchable components.
     *
     * @param {?Component} c
     */
    findSearchProviders(c) {
        this.providers_.length = 0;

        let current = c;
        while (current) {
            if (current instanceof SearchableSelect) {
                const searchable = /** @type {!SearchableSelect} */ (current);
                this.addSearchProvider(searchable.getSearchProvider());
            }
            current = current.parent();
        }
    }

    /**
     * Rebuild the select.
     */
    rebuild() {
        this.setCurrentSearchProviderByName(this.currentProviderName_);
    }

    /**
     * Add a provider to the list of providers.
     * @param {!SearchProvider} provider
     */
    addSearchProvider(provider) {
        if (this.providers_.indexOf(provider) === -1) {
            this.providers_.push(provider);
        }
    }

    /**
     * @param {string} name
     */
    setCurrentSearchProviderByName(name) {
        this.currentProviderName_ = name;
        this.setCurrentProvider(this.providers_.find((p) => p.name === name));
    }

    /**
     * Set the given provider to the current/active one.
     * @param {?SearchProvider|undefined} provider
     */
    setCurrentProvider(provider) {
        if (provider === this.currentProvider_) {
            return;
        }
        if (!provider) {
            return;
        }
        this.detachCurrentProvider();
        this.attachProvider(provider);
    }

    /**
     * Detaches the input from the current input.
     */
    detachCurrentProvider() {
        if (!this.currentProvider_) {
            return;
        }

        const inputHandler = this.currentProvider_.inputHandler;
        if (inputHandler) {
            inputHandler.detachInputs(this.inputEl_);
        }

        this.currentProvider_ = null;
    }

    /**
     * @param {!SearchProvider} provider
     */
    attachProvider(provider) {
        if (this.attachProviderInputHandler(provider)) {
            return;
        }
        if (this.attachProviderOnChange(provider)) {
            return;
        }
        this.disableInput();
    }

    /**
     * Try and attach the provider via the InputHandler.
     * If unable return false.
     *
     * @param {!SearchProvider} provider
     * @returns {boolean}
     */
    attachProviderInputHandler(provider) {
        if (!provider.inputHandler) {
            return false;
        }
        const inputHandler = provider.inputHandler;
        const ac = inputHandler.getAutoComplete();
        if (!ac) {
            return false;
        }

        const renderer = ac.getRenderer();
        if (renderer instanceof Renderer) {
            renderer.setWidthProvider(this.inputEl_);
        }

        inputHandler.attachInputs(this.inputEl_);

        this.enableInput(provider);

        return true;
    }

    /**
     * @param {!SearchProvider} provider
     * @returns {boolean}
     */
    attachProviderOnChange(provider) {
        this.enableInput(provider);
        return true;
    }

    /**
     * Resets the input as disabled.
     */
    disableInput() {
        this.inputEl_.placeholder = "";
        this.inputEl_.disabled = true;
        this.currentProvider_ = null;
    }

    /**
     *
     * @param {!SearchProvider} provider
     */
    enableInput(provider) {
        this.inputEl_.placeholder = `${provider.desc}...`;
        this.inputEl_.disabled = false;
        this.currentProvider_ = provider;
    }

    /**
     * Focuses the search box.
     */
    focus() {
        this.inputEl_.focus();
    }

    /**
     * Focuses the search box after selecting the given provider.
     * @param {string} name
     */
    focusSearchProviderByName(name) {
        this.setCurrentSearchProviderByName(name);
        this.inputEl_.focus();
    }

    /**
     * Blurs the search box.
     */
    blur() {
        this.inputEl_.blur();
    }

    /**
     * Blurs the search box.
     */
    blurAndClear() {
        this.inputEl_.blur();
        this.inputEl_.value = "";
    }

    /**
     * @return {boolean} Whether the search box is currently focused.
     */
    isActive() {
        return this.inputEl_.ownerDocument.activeElement === this.inputEl_;
    }
}
exports.SearchComponent = SearchComponent;


/**
 * Provider implementation that handles autocompletion of Module instances.
 *
 * @implements {Searchable}
 */
class ModuleSearchHandler extends EventTarget {
    /**
     * Construct a new ModuleSearchHandler
     */
    constructor() {
        super();

        /** @private @const @type {!Map<string, string>} */
        this.links_ = new Map();

        /** @private @const @type {!Map<string, !Module>} */
        this.modules_ = new Map();

        /** @private @const @type {!ModuleRowRenderer} */
        this.rowRenderer_ = new ModuleRowRenderer(this.modules_);

        /** @private @const @type {!Renderer} */
        this.renderer_ = new Renderer(null, {
            renderRow: goog.bind(this.rowRenderer_.renderRow, this.rowRenderer_),
        });

        this.renderer_.setAutoPosition(true);
        this.renderer_.setShowScrollbarsIfTooLarge(true);
        this.renderer_.setUseStandardHighlighting(true);

        /** @private @const @type {?InputHandler} */
        this.inputHandler_ = new InputHandler(null, null, false);

        /** @private @type {?AutoComplete} */
        this.ac_ = null;
    }

    /**
     * getSearchProvider implements part of the Searchable interface.
     *
     * @override
     * @returns {!SearchProvider}
     */
    getSearchProvider() {
        /** @type {!SearchProvider} */
        const provider = {
            name: DefaultSearchHandlerName,
            desc: `Search ${this.modules_.size} modules (kbd shortcut: '/')`,
            incremental: false,
            inputHandler: this.inputHandler_,
            onsubmit: goog.bind(this.handleSearchOnSubmit, this),
        };
        return provider;
    }

    /**
     * @param {!Application} app
     * @param {string} value
     */
    handleSearchOnSubmit(app, value) {
        const href = this.links_.get(value);
        if (href) {
            app.setLocation(href.split("/"));
        }
    }

    /**
     * @param {!Array<string>} data The input data array.
     */
    createAutoComplete(data) {
        const matcher = new AutoCompleteMatcher(data);

        const ac = (this.ac_ = new AutoComplete(
            matcher,
            this.renderer_,
            this.inputHandler_,
        ));
        ac.setMaxMatches(15);

        this.inputHandler_.attachAutoComplete(ac);
        // this.renderer_.setWidthProvider(input);
    }

    /**
     * @override
     */
    disposeInternal() {
        this.disposeAutoComplete();
        this.inputHandler_.dispose();
        this.renderer_.dispose();

        super.disposeInternal();
    }

    /**
     * Dispose of the current autocomplete.
     */
    disposeAutoComplete() {
        this.inputHandler_.attachAutoComplete(null);
        if (this.ac_) {
            this.ac_.dispose();
            this.ac_ = null;
        }
    }

    // /**
    //  * @param {!events.Event} e the event to respond to.
    //  * @private
    //  */
    // onUpdate_(e) {
    //     e.preventDefault();
    //     e.stopPropagation();

    //     let uri = this.nameToHref_.get(this.inputEl_.value);
    //     if (uri) {
    //         this.dispatchEvent(new exports.SelectionEvent(uri));
    //     }

    //     // setTimeout(() => {
    //     //     document.execCommand("selectall", null, false);
    //     // }, 50);
    // }

    /**
     * Add a batch of modules to the search box.
     * 
     * @param {!Array<!Module>} modules
     */
    addModules(modules) {
        modules.forEach(module => this.addModule(module));
        this.createAutoComplete(Array.from(this.modules_.keys()));
    }

    /**
     * @param {!Module} module
     */
    addModule(module) {
        const name = module.getName();
        this.modules_.set(name, module);
        this.links_.set(name, `modules/${name}`);
    }
}
exports.ModuleSearchHandler = ModuleSearchHandler;

class ModuleRowRenderer {
    /**
     * Mapping of module versions by key (e.g. 'abseil-cpp')
     * @param {!Map<string,!Module>} modules
     * */
    constructor(modules) {
        /** @private @const */
        this.modules_ = modules;
    }

    /**
     * Callback from autocompleter.
     *
     * @param {!{data:string}} entry
     * @param {string} val
     * @param {!Element} row
     */
    renderRow(entry, val, row) {
        // console.log(`renderRow(${val})`, entry, row);
        const key = asserts.assertString(entry.data);

        const module = this.modules_.get(key);
        if (module) {
            this.renderModule(module, entry, val, row);
        } else {
            debugger;
            dom.append(row, dom.createTextNode(val));
        }
    }

    /**
     * @param {!Module} module
     * @param {!{data:string}} entry
     * @param {string} val
     * @param {!Element} row
     */
    renderModule(module, entry, val, row) {
        let el = soy.renderAsElement(moduleSearchRow, { module });
        // Add a dataset entry on the element for testing
        dom.dataset.set(el, "cy", entry.data);
        dom.append(row, el);
    }
}
