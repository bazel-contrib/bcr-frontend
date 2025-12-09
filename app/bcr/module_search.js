/**
 * @fileoverview ModuleSearchHandler for autocomplete search of Module objects.
 */
goog.module("centrl.module_search");

const asserts = goog.require("goog.asserts");
const AutoComplete = goog.require("goog.ui.ac.AutoComplete");
const AutoCompleteMatcher = goog.require("dossier.AutoCompleteMatcher");
const dom = goog.require("goog.dom");
const EventTarget = goog.require("goog.events.EventTarget");
const InputHandler = goog.require("goog.ui.ac.InputHandler");
const Module = goog.require("proto.build.stack.bazel.bzlmod.v1.Module");
const Registry = goog.require("proto.build.stack.bazel.bzlmod.v1.Registry");
const Renderer = goog.require("goog.ui.ac.Renderer");
const soy = goog.require("goog.soy");
const { Application, DefaultSearchHandlerName, Searchable, SearchProvider } = goog.require("centrl.common");
const { moduleSearchRow } = goog.require('soy.centrl.app');


/**
 * Provider implementation that handles autocompletion of Module instances.
 *
 * @implements {Searchable}
 */
class ModuleSearchHandler extends EventTarget {
    /**
     * Construct a new ModuleSearchHandler
     * @param {!Registry} registry
     */
    constructor(registry) {
        super();

        /** @private @const */
        this.registry_ = registry;

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
            name: 'modules',
            desc: `Search ${this.modules_.size} modules in registry`,
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
        const key = asserts.assertString(entry.data);

        const module = this.modules_.get(key);
        if (module) {
            this.renderModule(module, entry, val, row);
        } else {
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
        let el = soy.renderAsElement(moduleSearchRow, {
            module,
            lang: sanitizeLanguageName(module.getRepositoryMetadata()?.getPrimaryLanguage()),
            description: module.getRepositoryMetadata()?.getDescription(),
        });
        dom.append(row, el);
    }
}

/**
 * Sanitize a language name for use as a CSS identifier
 * Matches the logic in pkg/css/identifier.go SanitizeIdentifier
 * @param {string|undefined} name
 * @return {string}
 */
function sanitizeLanguageName(name) {
    if (!name) {
        return '';
    }
    // Replace spaces and special characters
    let sanitized = name
        .replace(/ /g, '-')
        .replace(/\+/g, 'plus')
        .replace(/#/g, 'sharp');

    // Remove any remaining invalid characters (keep only alphanumeric, hyphen, underscore)
    sanitized = sanitized.replace(/[^a-zA-Z0-9\-_]/g, '');

    return sanitized;
}
