/**
 * @fileoverview Common top-level shared interfaces and utils.
 */
goog.module("bcrfrontend.common");

const InputHandler = goog.require("goog.ui.ac.InputHandler");
const Keyboard = goog.require("stack.ui.Keyboard");
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
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

	/**
	 * Returns the registry proto loaded at startup, before symbols are decorated.
	 * Synchronous: components rendering during the initial route can read
	 * registry-wide metadata (e.g. the BCR submodule URL/commit) without
	 * awaiting the symbols-load promise.
	 * @returns {!Registry}
	 */
	getRegistry() {}

	/**
	 * Returns a promise that resolves when symbols are loaded and decorated.
	 * @returns {!Promise<*>}
	 */
	getRegistryWithSymbols() {}

	/**
	 * Returns a promise that resolves when packages (BUILD-file extraction) are
	 * loaded and decorated.
	 * @returns {!Promise<*>}
	 */
	getRegistryWithPackages() {}

	/**
	 * Returns a promise that resolves to a Map<urlKey, Array<TargetRef>>
	 * indexing every loaded callable found in the registry-wide packages.pb.
	 * The urlKey is the slash-form load coordinate (e.g.
	 * "@rules_go/go/def.bzl/go_binary") used by the /targets Trie router.
	 * @returns {!Promise<*>}
	 */
	getRuleUsageIndex() {}

	/**
	 * Returns a promise that resolves to the lazily-fetched BazelFlagDb.
	 * Memoized; the underlying network fetch happens at most once.
	 * @returns {!Promise<*>}
	 */
	getBazelFlagDb() {}

	/**
	 * Returns the registry-data refresh poller. Settings UI reads/writes
	 * its mode; the app listens to its CHANGE event to reveal the header
	 * indicator and (in Auto mode) schedule a reload.
	 * @returns {*}
	 */
	getRefreshController() {}
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
 * load: (!function():!Promise<void>|undefined),
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

/**
 * Decompress gzip data using DecompressionStream API.
 * @param {!Uint8Array} gzipData
 * @returns {!Promise<!Uint8Array>}
 * @suppress {reportUnknownTypes, missingProperties, checkTypes}
 */
async function gzipDecode(gzipData) {
	const decompressor = new DecompressionStream("gzip");
	const input = new ReadableStream({
		/** @param {!ReadableStreamDefaultController} controller */
		start(controller) {
			controller.enqueue(gzipData);
			controller.close();
		},
	});
	const output = input.pipeThrough(decompressor);
	const reader = output.getReader();
	const chunks = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
	const decompressed = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		decompressed.set(chunk, offset);
		offset += chunk.length;
	}
	return decompressed;
}
exports.gzipDecode = gzipDecode;
