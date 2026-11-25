goog.module("bcrfrontend.invocationTransport");

const { commitSha } = goog.require("bcrfrontend.uiVersion");

/** @typedef {function(string, string, number=, number=):void} */
let EventCallback;

/** @typedef {function(string, boolean, boolean=):void} */
let StatusCallback;

/** @typedef {{list: function(string=): !Promise<!Object<string, *>>,
 *     listGroups: function(): !Promise<!Object<string, *>>,
 *     listGroup: function(string, string=): !Promise<!Object<string, *>>,
 *     groupMetrics: function(string, number=): !Promise<!Object<string, *>>,
 *     get: function(string): !Promise<!Object<string, *>>,
 *     watch: function(string, function():string, !EventCallback, !StatusCallback):void,
 *     close: function():void}} */
let InvocationBackend;

/** @typedef {function(string):!Object<string, *>} */
let IrohFactory;

/** @type {?Promise<!IrohFactory>} */
let irohModule = null;
let irohAttempt = 0;

/** @return {!Promise<!IrohFactory>} */
function loadIrohModule() {
	if (!irohModule) {
		irohModule = new Promise(
			(
				/** function(!IrohFactory):void */ resolve,
				/** function(*):void */ reject,
			) => {
				const script = document.createElement("script");
				script.type = "module";
				script.src =
					"/invocation_iroh.mjs?v=" +
					encodeURIComponent(commitSha) +
					"&attempt=" +
					irohAttempt++;
				script.onload = () => {
					const factory = /** @type {?IrohFactory} */ (
						window["bcrIrohInvocation"]
					);
					if (factory) resolve(factory);
					else reject(new Error("Iroh browser module did not initialize."));
					script.remove();
				};
				script.onerror = () => {
					script.remove();
					reject(new Error("Iroh browser assets are unavailable."));
				};
				document.head.appendChild(script);
			},
		).catch((error) => {
			irohModule = null;
			throw error;
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
			list: /** @type {function(string=):!Promise<!Object<string, *>>} */ (
				external["list"]
			),
			listGroups: /** @type {function():!Promise<!Object<string, *>>} */ (
				external["listGroups"]
			),
			listGroup:
				/** @type {function(string, string=):!Promise<!Object<string, *>>} */ (
					external["listGroup"]
				),
			groupMetrics:
				/** @type {function(string, number=):!Promise<!Object<string, *>>} */ (
					external["groupMetrics"]
				),
			get: /** @type {function(string):!Promise<!Object<string, *>>} */ (
				external["get"]
			),
			watch:
				/** @type {function(string, function():string, !EventCallback, !StatusCallback):void} */ (
					external["watch"]
				),
			close: /** @type {function():void} */ (external["close"]),
		};
	}
	const url = new URL(address);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(
			"Enter an HTTP or HTTPS backend URL or an Iroh viewer ticket.",
		);
	}
	const api = url.href.replace(/\/$/, "") + "/api";
	const base = api + "/invocations";
	/** @type {?EventSource} */
	let source = null;
	/**
	 * @param {string} path
	 * @return {!Promise<!Object<string, *>>}
	 */
	async function read(path) {
		const response = await fetch(api + path);
		if (!response.ok)
			throw new Error("Backend returned HTTP " + response.status);
		return /** @type {!Object<string, *>} */ (await response.json());
	}
	/**
	 * @param {string} id
	 * @param {function():string} cursor
	 * @param {!EventCallback} onEvent
	 * @param {!StatusCallback} onStatus
	 */
	function watch(id, cursor, onEvent, onStatus) {
		const stream = new EventSource(
			base + "/" + encodeURIComponent(id) + "/events?after=" + cursor(),
		);
		source = stream;
		stream.onopen = () =>
			onStatus("Connected · replaying and following " + id, true);
		stream.onerror = () => {
			const closed = stream.readyState === EventSource.CLOSED;
			onStatus(
				closed
					? "Could not open the invocation stream."
					: "Connection interrupted · reconnecting from the last event",
				false,
				closed,
			);
		};
		/** @type {string} */
		let timing = "";
		stream.addEventListener("bep-time", (event) => {
			timing = String(/** @type {!MessageEvent<string>} */ (event).data);
		});
		stream.addEventListener("bep", (event) => {
			const message = /** @type {!MessageEvent<string>} */ (event);
			const fields = timing.split(" ");
			timing = "";
			if (fields[0] === message.lastEventId) {
				onEvent(
					message.lastEventId,
					message.data,
					Number(fields[1]),
					Number(fields[2]),
				);
			} else {
				onEvent(message.lastEventId, message.data);
			}
		});
	}
	return {
		list: (/** string= */ token) =>
			read(
				"/invocations" +
					(token ? "?page_token=" + encodeURIComponent(token) : ""),
			),
		listGroups: () => read("/invocation-groups"),
		listGroup: (/** string */ name, /** string= */ token) =>
			read(
				"/invocations?group=" +
					encodeURIComponent(name) +
					(token ? "&page_token=" + encodeURIComponent(token) : ""),
			),
		groupMetrics: (/** string */ name, /** number= */ days) =>
			read(
				"/invocation-groups/" +
					encodeURIComponent(name) +
					"/metrics" +
					(days ? "?window_days=" + days : ""),
			),
		get: (/** string */ id) => read("/invocations/" + encodeURIComponent(id)),
		watch: watch,
		close: () => {
			if (source) source.close();
			source = null;
		},
	};
}

exports = { InvocationBackend, openInvocationBackend };
