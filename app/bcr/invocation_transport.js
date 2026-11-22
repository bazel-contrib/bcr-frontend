goog.module("bcrfrontend.invocationTransport");

/** @typedef {function(string, string):void} */
let EventCallback;

/** @typedef {function(string, boolean, boolean=):void} */
let StatusCallback;

/** @typedef {{list: function(): !Promise<!Object<string, *>>,
 *     get: function(string): !Promise<!Object<string, *>>,
 *     watch: function(string, function():string, !EventCallback, !StatusCallback):void,
 *     close: function():void}} */
let InvocationBackend;

/** @typedef {function(string):!Object<string, *>} */
let IrohFactory;

/** @type {?Promise<!IrohFactory>} */
let irohModule = null;

/** @return {!Promise<!IrohFactory>} */
function loadIrohModule() {
	if (!irohModule) {
		irohModule = new Promise((/** function(!IrohFactory):void */ resolve, /** function(*):void */ reject) => {
			const script = document.createElement("script");
			script.type = "module";
			script.src = "/invocation_iroh.mjs";
			script.onload = () => {
				const factory = /** @type {?IrohFactory} */ (window["bcrIrohInvocation"]);
				if (factory) resolve(factory);
				else reject(new Error("Iroh browser module did not initialize."));
			};
			script.onerror = () => reject(new Error("Iroh browser assets are unavailable."));
			document.head.appendChild(script);
		});
	}
	return irohModule;
}

/**
 * @param {string} address
 * @return {!Promise<!InvocationBackend>}
 */
async function openInvocationBackend(address) {
	if (address.startsWith("bcr-iroh-v1:")) {
		const factory = /** @type {!IrohFactory} */ (await loadIrohModule());
		const external = factory(address);
		return {
			list: /** @type {function():!Promise<!Object<string, *>>} */ (external["list"]),
			get: /** @type {function(string):!Promise<!Object<string, *>>} */ (external["get"]),
			watch: /** @type {function(string, function():string, !EventCallback, !StatusCallback):void} */ (external["watch"]),
			close: /** @type {function():void} */ (external["close"]),
		};
	}
	const url = new URL(address);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Enter an HTTP or HTTPS backend URL or an Iroh viewer ticket.");
	}
	const base = url.href.replace(/\/$/, "") + "/api/invocations";
	/** @type {?EventSource} */
	let source = null;
	/**
	 * @param {string} path
	 * @return {!Promise<!Object<string, *>>}
	 */
	async function read(path) {
		const response = await fetch(base + path);
		if (!response.ok) throw new Error("Backend returned HTTP " + response.status);
		return /** @type {!Object<string, *>} */ (await response.json());
	}
	/**
	 * @param {string} id
	 * @param {function():string} cursor
	 * @param {!EventCallback} onEvent
	 * @param {!StatusCallback} onStatus
	 */
	function watch(id, cursor, onEvent, onStatus) {
		const stream = new EventSource(base + "/" + encodeURIComponent(id) + "/events?after=" + cursor());
		source = stream;
		stream.onopen = () => onStatus("Connected · replaying and following " + id, true);
		stream.onerror = () => {
			const closed = stream.readyState === EventSource.CLOSED;
			onStatus(closed ? "Could not open the invocation stream."
				: "Connection interrupted · reconnecting from the last event", false, closed);
		};
		stream.addEventListener("bep", (event) => {
			const message = /** @type {!MessageEvent<string>} */ (event);
			onEvent(message.lastEventId, message.data);
		});
	}
	return {
		list: () => read(""),
		get: (/** string */ id) => read("/" + encodeURIComponent(id)),
		watch: watch,
		close: () => {
			if (source) source.close();
			source = null;
		},
	};
}

exports = {InvocationBackend, openInvocationBackend};
