/**
 * @fileoverview UnifiedSearchHandler — single search provider that ranks
 * modules and symbols together against one in-memory index, with a
 * pill-style scope filter (all/modules/symbols).
 */
goog.module("bcrfrontend.unified_search");

const AutoComplete = goog.require("goog.ui.ac.AutoComplete");
const AutoCompleteMatcher = goog.require("dossier.AutoCompleteMatcher");
const Module = goog.requireType("proto.build.stack.bazel.registry.v1.Module");
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const Renderer = goog.require("goog.ui.ac.Renderer");
const SymbolType = goog.require("proto.build.stack.bazel.symbol.v1.SymbolType");
const InputHandler = goog.require("goog.ui.ac.InputHandler");
const EventTarget = goog.require("goog.events.EventTarget");
const asserts = goog.require("goog.asserts");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const File = goog.requireType("proto.build.stack.bazel.symbol.v1.File");
const Symbol_ = goog.requireType("proto.build.stack.bazel.symbol.v1.Symbol");
const { Application, SearchProvider } = goog.requireType("bcrfrontend.common");
const { Searchable } = goog.requireType("bcrfrontend.common");
const { moduleSearchRow, symbolSearchRow } = goog.require(
	"soy.bcrfrontend.app",
);
const { sanitizeLanguageName } = goog.require("bcrfrontend.language");

/** @typedef {{file: !File, sym: !Symbol_, moduleVersion: string}} */
let FileSymbol;

/**
 * @typedef {{kind: string, module: (!Module|undefined), fileSymbol: (!FileSymbol|undefined)}}
 */
let Entry;

/** @const */
const SCOPE_ALL = "all";
/** @const */
const SCOPE_MODULES = "modules";
/** @const */
const SCOPE_SYMBOLS = "symbols";

exports.SCOPE_ALL = SCOPE_ALL;
exports.SCOPE_MODULES = SCOPE_MODULES;
exports.SCOPE_SYMBOLS = SCOPE_SYMBOLS;

/**
 * Single provider that indexes both modules and symbols.
 *
 * @implements {Searchable}
 */
class UnifiedSearchHandler extends EventTarget {
	/**
	 * @param {!Registry} registry
	 * @param {!Promise<!Registry>} registryWithSymbols
	 */
	constructor(registry, registryWithSymbols) {
		super();

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Promise<!Registry>} */
		this.registryWithSymbols_ = registryWithSymbols;

		/** @private @const @type {!Map<string, !Entry>} */
		this.entries_ = new Map();

		/** @private @const @type {!Map<string, string>} */
		this.links_ = new Map();

		/** @private @const @type {!Array<string>} */
		this.moduleKeys_ = [];

		/** @private @const @type {!Array<string>} */
		this.symbolKeys_ = [];

		/** @private @type {string} */
		this.scope_ = SCOPE_ALL;

		/** @private @type {boolean} */
		this.modulesLoaded_ = false;

		/** @private @type {boolean} */
		this.symbolsRequested_ = false;

		/** @private @const @type {!UnifiedRowRenderer} */
		this.rowRenderer_ = new UnifiedRowRenderer(this.entries_);

		/** @private @const @type {!Renderer} */
		this.renderer_ = new Renderer(null, {
			renderRow: goog.bind(this.rowRenderer_.renderRow, this.rowRenderer_),
		});
		this.renderer_.setAutoPosition(true);
		this.renderer_.setShowScrollbarsIfTooLarge(true);
		this.renderer_.setUseStandardHighlighting(true);

		/** @private @const @type {!InputHandler} */
		this.inputHandler_ = new InputHandler(null, null, false);

		/** @private @type {?AutoComplete} */
		this.ac_ = null;

		/** @private @type {!SearchProvider} */
		this.provider_ = {
			name: "all",
			desc: "Search modules and symbols",
			incremental: false,
			inputHandler: this.inputHandler_,
			onsubmit: goog.bind(this.handleSearchOnSubmit, this),
			keyCode: events.KeyCodes.SLASH,
			load: goog.bind(this.load, this),
		};
	}

	/**
	 * @override
	 * @return {!SearchProvider}
	 */
	getSearchProvider() {
		return this.provider_;
	}

	/** @return {string} */
	getScope() {
		return this.scope_;
	}

	/**
	 * Returns a placeholder string appropriate for the given scope, using
	 * live counts when available. Used by the host (app.js) to update the
	 * input placeholder as the user toggles pills.
	 * @param {string} scope
	 * @return {string}
	 */
	placeholderForScope(scope) {
		const mods = this.moduleKeys_.length;
		const syms = this.symbolKeys_.length;
		if (scope === SCOPE_MODULES) {
			return mods ? `Search ${mods} modules...` : "Search modules...";
		}
		if (scope === SCOPE_SYMBOLS) {
			return syms ? `Search ${syms} symbols...` : "Search symbols...";
		}
		if (mods && syms) {
			return `Search ${mods} modules and ${syms} symbols...`;
		}
		if (mods) {
			return `Search ${mods} modules and symbols...`;
		}
		return "Search modules and symbols...";
	}

	/**
	 * @param {string} scope
	 */
	setScope(scope) {
		if (
			scope !== SCOPE_ALL &&
			scope !== SCOPE_MODULES &&
			scope !== SCOPE_SYMBOLS
		) {
			return;
		}
		this.scope_ = scope;
	}

	/**
	 * Returns the active keys slice for the current scope. Read by the
	 * ScopedMatcher on every match request, so swapping scope or appending
	 * symbols is reflected immediately with no AC rebuild.
	 * @return {!Array<string>}
	 */
	getActiveKeys() {
		if (this.scope_ === SCOPE_MODULES) {
			return this.moduleKeys_;
		}
		if (this.scope_ === SCOPE_SYMBOLS) {
			return this.symbolKeys_;
		}
		return this.moduleKeys_.concat(this.symbolKeys_);
	}

	/**
	 * Synchronously indexes modules and creates the AC the first time it's
	 * called. The symbols.pb.gz promise is kicked off but NOT awaited —
	 * load() resolves as soon as modules are searchable so SearchComponent
	 * can attach the input handler immediately. The ScopedMatcher picks
	 * up symbols later without any AC rebuild.
	 * @return {!Promise<void>}
	 */
	async load() {
		if (!this.modulesLoaded_) {
			this.addModules_(this.registry_.getModulesList());
			this.modulesLoaded_ = true;
		}
		if (!this.ac_) {
			this.createAutoComplete_();
		}
		if (!this.symbolsRequested_) {
			this.symbolsRequested_ = true;
			// Fire-and-forget. The ScopedMatcher will see the appended symbol
			// keys on the next match request.
			this.registryWithSymbols_.then((registry) => {
				this.indexSymbols_(registry);
				this.provider_.desc = `Search ${this.moduleKeys_.length} modules and ${this.symbolKeys_.length} symbols`;
			});
		}
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

	/** @private */
	createAutoComplete_() {
		const matcher = new ScopedMatcher(this);
		const ac = (this.ac_ = new AutoComplete(
			matcher,
			this.renderer_,
			this.inputHandler_,
		));
		ac.setMaxMatches(15);
		this.inputHandler_.attachAutoComplete(ac);
	}

	/** @private */
	disposeAutoComplete_() {
		this.inputHandler_.attachAutoComplete(null);
		if (this.ac_) {
			this.ac_.dispose();
			this.ac_ = null;
		}
	}

	/** @override */
	disposeInternal() {
		this.disposeAutoComplete_();
		this.inputHandler_.dispose();
		this.renderer_.dispose();
		super.disposeInternal();
	}

	/**
	 * @private
	 * @param {!Array<!Module>} modules
	 */
	addModules_(modules) {
		for (const module of modules) {
			const name = module.getName();
			this.entries_.set(name, {
				kind: "module",
				module,
				fileSymbol: undefined,
			});
			this.links_.set(name, `modules/${name}`);
			this.moduleKeys_.push(name);
		}
	}

	/**
	 * @private
	 * @param {!Registry} registry
	 */
	indexSymbols_(registry) {
		for (const module of registry.getModulesList()) {
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
					if (file.getError()) {
						continue;
					}
					if (!isPublicFile(file)) {
						continue;
					}
					const label = file.getLabel();
					const pkg = label?.getPkg() || "";
					const name = label?.getName() || "";
					const filePath = pkg ? `${pkg}/${name}` : name;
					for (const sym of file.getSymbolList()) {
						const symType = sym.getType();
						if (
							symType === SymbolType.SYMBOL_TYPE_LOAD_STMT ||
							symType === SymbolType.SYMBOL_TYPE_VALUE
						) {
							continue;
						}
						const symName = sym.getName();
						// Versions iterated newest-first; first-seen wins so the link
						// points at the latest version exposing the symbol.
						const key = `${symName} (${moduleName}:${filePath})`;
						if (this.entries_.has(key)) {
							continue;
						}
						this.entries_.set(key, {
							kind: "symbol",
							module: undefined,
							fileSymbol: { file, sym, moduleVersion },
						});
						this.links_.set(
							key,
							`modules/${moduleName}/${versionStr}/docs/${filePath}/${symName}`,
						);
						this.symbolKeys_.push(key);
					}
				}
			}
		}
	}
}
exports.UnifiedSearchHandler = UnifiedSearchHandler;

/**
 * Matcher wrapper that reads the active key slice from the handler on
 * every request — so scope changes and late-arriving symbols take effect
 * without recreating the surrounding AutoComplete (which would orphan
 * SearchComponent's UPDATE listener).
 */
class ScopedMatcher {
	/** @param {!UnifiedSearchHandler} handler */
	constructor(handler) {
		/** @private @const */
		this.handler_ = handler;
	}

	/**
	 * @param {string} token
	 * @param {number} max
	 * @param {function(string, !Array<string>)} callback
	 */
	requestMatchingRows(token, max, callback) {
		const inner = new AutoCompleteMatcher(this.handler_.getActiveKeys());
		inner.requestMatchingRows(token, max, callback);
	}
}

/**
 * AC row renderer that dispatches per-entry to moduleSearchRow or
 * symbolSearchRow.
 */
class UnifiedRowRenderer {
	/** @param {!Map<string, !Entry>} entries */
	constructor(entries) {
		/** @private @const */
		this.entries_ = entries;
	}

	/**
	 * @param {!{data:string}} entry
	 * @param {string} val
	 * @param {!Element} row
	 */
	renderRow(entry, val, row) {
		const key = asserts.assertString(entry.data);
		const e = this.entries_.get(key);
		if (!e) {
			dom.append(row, dom.createTextNode(val));
			return;
		}
		if (e.kind === "module" && e.module) {
			const module = e.module;
			const el = soy.renderAsElement(moduleSearchRow, {
				module,
				lang: sanitizeLanguageName(
					module.getRepositoryMetadata()?.getPrimaryLanguage() || "",
				),
				description: module.getRepositoryMetadata()?.getDescription(),
				kind: "Module",
			});
			dom.append(row, el);
		} else if (e.kind === "symbol" && e.fileSymbol) {
			const { file, sym } = e.fileSymbol;
			const label = file.getLabel();
			const el = soy.renderAsElement(symbolSearchRow, {
				sym,
				label: label || undefined,
				description: sym.getDescription(),
				kind: "Symbol",
			});
			dom.dataset.set(el, "cy", entry.data);
			dom.append(row, el);
		}
	}
}

/**
 * @param {!File} file
 * @return {boolean}
 */
function isPublicFile(file) {
	const label = file.getLabel();
	if (!label) {
		return true;
	}
	const pkg = label.getPkg() || "";
	const name = label.getName() || "";
	const path = pkg ? `${pkg}/${name}` : name;
	return !path.includes("/private/") && !path.includes("/internal/");
}
