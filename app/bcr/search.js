/**
 * @fileoverview SearchComponent widget for controlling the top navigation bar's search box.
 */
goog.module("bcrfrontend.search");

const asserts = goog.require("goog.asserts");
const AutoComplete = goog.require("goog.ui.ac.AutoComplete");
const events = goog.require("goog.events");
const EventTarget = goog.require("goog.events.EventTarget");
const ListenableKey = goog.require("goog.events.ListenableKey");
const Renderer = goog.require("goog.ui.ac.Renderer");
const {
	Application,
	DefaultSearchHandlerName,
	SearchableSelect,
	SearchProvider,
} = goog.require("bcrfrontend.common");
const { Searchable } = goog.requireType("bcrfrontend.common");
const { Component } = goog.require("stack.ui");

/**
 * Widget for controlling the top navigation bar search box.
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
		 * @private @const @type {!Map<string,!SearchProvider>} */
		this.providers_ = new Map();

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
	}

	/**
	 * @param {!events.Event} e the event to respond to.
	 * @private
	 * @suppress {reportUnknownTypes}
	 */
	handleInputFocus(e) {
		setTimeout(() => {
			document.execCommand("selectall", null, false);
		}, 50);

		this.dispatchEvent(events.EventType.FOCUS);
	}

	/**
	 * @param {!events.Event} e the event to respond to.
	 * @private
	 */
	handleFormSubmit(e) {
		e.preventDefault();
		e.stopPropagation();

		// If the AC dropdown has a highlighted row, commit it. selectHilited
		// asks the InputHandler to selectRow(highlightedRow), which fires
		// AC's UPDATE event with the row data; our handleAcUpdate then runs
		// submit(row) → provider.onsubmit → setLocation.
		const ac = this.getCurrentAutoComplete_();
		if (ac && ac.hasHighlight()) {
			ac.selectHilited();
			return;
		}
		// No highlight: pressing Enter is a no-op. For full-text filtering
		// the user should use the page-level search input on /modules or
		// /docs.
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
	 * @param {{type:string,row:string,index:number}} e the event to respond to.
	 *
	 */
	handleAcUpdate(e) {
		if (e.row) {
			this.submit(e.row);
		}
		if (e.type === "update" || !e.row) {
			this.blurAndClear();
		}
	}

	/**
	 * Search up through the component tree and find searchable components.
	 *
	 * @param {?Component} c
	 */
	findSearchProviders(c) {
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
		this.providers_.set(provider.name, provider);
	}

	/**
	 * @param {string} name
	 */
	setCurrentSearchProviderByName(name) {
		const provider = this.providers_.get(name);
		if (provider) {
			this.setCurrentProvider(provider);
		} else {
		}
	}

	/**
	 * Set the given provider to the current/active one.
	 * @param {?SearchProvider|undefined} provider
	 */
	setCurrentProvider(provider) {
		if (!provider) {
			return;
		}
		if (provider === this.currentProvider_) {
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
			const ac = inputHandler.getAutoComplete();
			if (ac && this.acListenerKey_) {
				ac.unlistenByKey(asserts.assertObject(this.acListenerKey_));
				this.acListenerKey_ = null;
			}
			inputHandler.detachInputs(this.inputEl_);
		}

		this.currentProvider_ = null;
	}

	/**
	 * @param {!SearchProvider} provider
	 */
	async attachProvider(provider) {
		// Call load if provider has it
		if (provider.load) {
			await provider.load();
		}

		if (this.didAttachProviderInputHandler(provider)) {
			return;
		}
		if (this.didAttachProviderOnChange(provider)) {
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
	didAttachProviderInputHandler(provider) {
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

		// Listen to UPDATE events directly on the AC so navigation works
		// regardless of input-focus timing. Closure InputHandler's keydown
		// handler calls ac.selectHilited() on Enter, which dispatches UPDATE
		// with the selected row data; we route that to provider.onsubmit
		// in handleAcUpdate.
		if (this.acListenerKey_) {
			ac.unlistenByKey(asserts.assertObject(this.acListenerKey_));
			this.acListenerKey_ = null;
		}
		this.acListenerKey_ = ac.listen(
			AutoComplete.EventType.UPDATE,
			this.handleAcUpdate,
			false,
			this,
		);

		this.enableInput(provider);

		return true;
	}

	/**
	 * @param {!SearchProvider} provider
	 * @returns {boolean}
	 */
	didAttachProviderOnChange(provider) {
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
		this.currentProviderName_ = provider.name;
	}

	/**
	 * Returns the current provider's AutoComplete instance, or null.
	 * @return {?AutoComplete}
	 * @private
	 */
	getCurrentAutoComplete_() {
		if (!this.currentProvider_ || !this.currentProvider_.inputHandler) {
			return null;
		}
		return this.currentProvider_.inputHandler.getAutoComplete() || null;
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

	/**
	 * @return {string} The current value of the search input.
	 */
	getValue() {
		return this.inputEl_.value || "";
	}

	/**
	 * Override the input's placeholder text. Callers use this to reflect
	 * UI state (e.g. search scope) that doesn't naturally fit the
	 * provider's static `desc` field.
	 * @param {string} text
	 */
	setPlaceholder(text) {
		this.inputEl_.placeholder = text;
	}
}
exports.SearchComponent = SearchComponent;
