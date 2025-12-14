/**
 * @fileoverview DocumentationSearchHandler for autocomplete search of documentation symbols (rules, functions, providers, etc).
 */
goog.module("centrl.documentation_search");

const asserts = goog.require("goog.asserts");
const AutoComplete = goog.require("goog.ui.ac.AutoComplete");
const AutoCompleteMatcher = goog.require("dossier.AutoCompleteMatcher");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const EventTarget = goog.require("goog.events.EventTarget");
const InputHandler = goog.require("goog.ui.ac.InputHandler");
const Renderer = goog.require("goog.ui.ac.Renderer");
const soy = goog.require("goog.soy");
const { Application, DefaultSearchHandlerName, SearchProvider } = goog.require("centrl.common");
const { Searchable } = goog.requireType("centrl.common");
const { symbolSearchRow } = goog.require('soy.centrl.app');
const FileInfo = goog.require("proto.build.stack.bazel.bzlmod.v1.FileInfo");
const Registry = goog.require("proto.build.stack.bazel.bzlmod.v1.Registry");
const SymbolInfo = goog.require("proto.build.stack.bazel.bzlmod.v1.SymbolInfo");
const SymbolType = goog.require('proto.build.stack.bazel.bzlmod.v1.SymbolType');

/** @typedef {{file: !FileInfo, sym: !SymbolInfo, moduleVersion: string}} */
let FileSymbol;


/**
 * Provider implementation that handles autocompletion of documentation symbols.
 *
 * @implements {Searchable}
 */
class DocumentationSearchHandler extends EventTarget {
    /**
     * Construct a new DocumentationSearchHandler
     * @param {!Registry} registry The bazel central registry
     */
    constructor(registry) {
        super();

        /** @private @const */
        this.registry_ = registry;

        /** @private @const @type {!Map<string, string>} */
        this.links_ = new Map();

        /** @private @const @type {!Map<string, !FileSymbol>} */
        this.symbols_ = new Map();

        /** @private @const @type {!SymbolRowRenderer} */
        this.rowRenderer_ = new SymbolRowRenderer(this.symbols_);

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

        // Index all symbols from documentation
        this.indexSymbols_();
    }

    /**
     * Index all symbols from the documentation across all modules in the registry.
     * @private
     */
    indexSymbols_() {
        for (const module of this.registry_.getModulesList()) {
            const moduleName = module.getName();

            for (const version of module.getVersionsList()) {
                const versionStr = version.getVersion();
                const moduleVersion = `${moduleName}@${versionStr}`;
                const source = version.getSource();

                if (!source) {
                    continue;
                }

                const docs = source.getDocumentation();
                if (!docs) {
                    continue;
                }

                for (const file of docs.getFileList()) {
                    // Skip files with errors
                    if (file.getError()) {
                        continue;
                    }

                    // Skip private/internal files
                    if (!isPublicFile(file)) {
                        continue;
                    }

                    const label = file.getLabel();
                    const pkg = label?.getPkg() || '';
                    const name = label?.getName() || '';
                    const filePath = pkg ? `${pkg}/${name}` : name;

                    for (const sym of file.getSymbolList()) {
                        const symType = sym.getType();
                        // Skip LOAD (9) and VALUE (10) symbols from search
                        if (symType === SymbolType.SYMBOL_TYPE_LOAD_STMT || symType === SymbolType.SYMBOL_TYPE_VALUE) {
                            continue;
                        }

                        const symName = sym.getName();
                        const key = `${symName} (${moduleVersion}:${filePath})`;

                        this.symbols_.set(key, { file, sym, moduleVersion });
                        this.links_.set(key, `modules/${moduleName}/${versionStr}/docs/${filePath}/${symName}`);
                    }
                }
            }
        }
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
            name: 'symbol',
            desc: `Search ${this.symbols_.size} symbols in documentation`,
            incremental: false,
            inputHandler: this.inputHandler_,
            onsubmit: goog.bind(this.handleSearchOnSubmit, this),
            keyCode: events.KeyCodes.PERIOD,
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
     * Create the autocomplete widget.
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
     * Add all of the symbols to the search box.
     */
    addAllSymbols() {
        this.createAutoComplete(Array.from(this.symbols_.keys()));
    }
}
exports.DocumentationSearchHandler = DocumentationSearchHandler;

class SymbolRowRenderer {
    /**
     * @param {!Map<string, !FileSymbol>} symbols
     * */
    constructor(symbols) {
        /** @private @const */
        this.symbols_ = symbols;
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

        const fileSymbol = this.symbols_.get(key);
        if (fileSymbol) {
            this.renderSymbol(fileSymbol, entry, val, row);
        } else {
            dom.append(row, dom.createTextNode(val));
        }
    }

    /**
     * @param {!FileSymbol} fileSymbol
     * @param {!{data:string}} entry
     * @param {string} val
     * @param {!Element} row
     */
    renderSymbol(fileSymbol, entry, val, row) {
        const { file, sym } = fileSymbol;
        const label = file.getLabel();

        const el = soy.renderAsElement(symbolSearchRow, {
            sym,
            label: label || undefined,
            description: sym.getDescription(),
        });

        // Add a dataset entry on the element for testing
        dom.dataset.set(el, "cy", entry.data);
        dom.append(row, el);
    }
}

/**
 * Returns true if the file should be included in public documentation.
 * Filters out files in /private/ or /internal/ directories.
 * @param {!FileInfo} file
 * @return {boolean}
 */
function isPublicFile(file) {
    const label = file.getLabel();
    if (!label) {
        return true;
    }
    const pkg = label.getPkg() || '';
    const name = label.getName() || '';
    const path = pkg ? `${pkg}/${name}` : name;
    return !path.includes('/private/') && !path.includes('/internal/');
}
