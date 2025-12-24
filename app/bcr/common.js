/**
 * @fileoverview Common top-level shared interfaces and utils.
 */
goog.module("bcrfrontend.common");

const InputHandler = goog.require("goog.ui.ac.InputHandler");
const Keyboard = goog.require("stack.ui.Keyboard");
const Select = goog.require("stack.ui.Select");
const dom = goog.require("goog.dom");
const { Component } = goog.require("stack.ui");
const { MVS } = goog.require("bcrfrontend.mvs");

/**
 * Interface that defines the minimum API methods we need on the root object.
 *
 * @interface
 */
class Application {
	/**
	 * Returns a set of named flags.  This is a way to pass in compile-time global
	 * constants into goog.modules.
	 * @returns {!Map<string,string>}
	 */
	getOptions() {}

	/**
	 * Returns the cached mvs data.
	 * @returns {!MVS}
	 */
	getMvs() {}

	/**
	 * @param {!Array<string>} path
	 */
	setLocation(path) {}

	/**
	 * @returns {!Keyboard}
	 */
	getKbd() {}

	/**
	 * @param {string} _msg
	 */
	notifyError(_msg) {}
}
exports.Application = Application;

/**
 * @param {!Component} component
 * @return {!Application}
 */
function getApplication(component) {
	return /** @type {!Application} */ (component.getApp());
}
exports.getApplication = getApplication;

/**
 * @typedef {{
 * name: string,
 * desc: string,
 * incremental: boolean,
 * onsubmit: (function(!Application,string):undefined|null),
 * inputHandler: (!InputHandler|null),
 * keyCode: (number|undefined),
 * }}
 */
var SearchProvider;
exports.SearchProvider = SearchProvider;

/**
 * Interface for a component that provides an inputhandler for an autocomplete.
 *
 * @interface
 */
class Searchable {
	/**
	 * Get the metadata about this search input.
	 * @return {!SearchProvider}
	 */
	getSearchProvider() {}
}
exports.Searchable = Searchable;

/**
 * An abstract base for class that has inputhandler/autocomplete capability.
 * Used as a base class to facilitate 'instanceof' comparison.
 *
 * @abstract
 * @implements {Searchable}
 */
class SearchableSelect extends Select {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}
}
exports.SearchableSelect = SearchableSelect;

exports.DefaultSearchHandlerName = "All";
