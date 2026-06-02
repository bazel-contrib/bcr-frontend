/**
 * @fileoverview RefreshController polls a tiny manifest.pb.gz at the
 * release root and emits a CHANGE event when the deployed bundle has
 * changed since boot — either a BCR data refresh (commit_sha advances)
 * or a code redeploy (any asset hash differs).
 */
goog.module("bcrfrontend.refresh");

const EventTarget = goog.require("goog.events.EventTarget");
const RegistryManifest = goog.require(
	"proto.build.stack.bazel.registry.v1.RegistryManifest",
);
const { gzipDecode } = goog.require("bcrfrontend.common");

/** @enum {string} */
const RefreshMode = {
	OFF: "off",
	NOTIFY: "notify",
	AUTO: "auto",
};
exports.RefreshMode = RefreshMode;

/** @enum {string} */
const ChangeKind = {
	NONE: "none",
	DATA: "data",
	CODE: "code",
	BOTH: "both",
};
exports.ChangeKind = ChangeKind;

/** Event type dispatched on the controller when a refresh is detected. */
const EVENT_CHANGE = "refresh.change";
exports.EVENT_CHANGE = EVENT_CHANGE;

const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Scans the document for content-hashed assets and returns a snapshot
 * keyed by un-hashed basename (matching the manifest's keys). Reads
 * `<script src>`, `<link href>`, and `<meta name="bcr:*-url" content>`
 * so that eagerly-loaded code AND meta-referenced lazy assets are both
 * covered.
 *
 * @return {!Object<string, string>}
 */
function collectBootAssetHashes() {
	/** @type {!Object<string, string>} */
	const out = {};
	const add = (/** @type {string} */ url) => {
		if (!url) return;
		// Strip leading slash + any query string.
		const path = url.replace(/^\/+/, "").split("?")[0];
		if (!path || path.indexOf("/") >= 0) return;
		const original = unhashFilename(path);
		if (original !== path) {
			out[original] = path;
		}
	};
	for (const el of document.querySelectorAll("script[src]")) {
		add(el.getAttribute("src") || "");
	}
	for (const el of document.querySelectorAll("link[href]")) {
		add(el.getAttribute("href") || "");
	}
	for (const el of document.querySelectorAll('meta[name^="bcr:"]')) {
		add(el.getAttribute("content") || "");
	}
	return out;
}
exports.collectBootAssetHashes = collectBootAssetHashes;

/**
 * Strips the 8+-char hex content hash that releasecompiler inserts
 * before the first extension. `bcr.abcd1234.js` → `bcr.js`. Returns
 * the input unchanged if no hash is present.
 *
 * @param {string} name
 * @return {string}
 */
function unhashFilename(name) {
	const m = name.match(/^([^.]+)\.([a-f0-9]{6,})\.(.+)$/);
	if (!m) return name;
	return `${m[1]}.${m[3]}`;
}

/**
 * Holds the boot snapshot + polling state. The OFF / NOTIFY / AUTO
 * distinction is handled here only to the extent of starting/stopping
 * the timer for OFF; AUTO vs NOTIFY only affects the consumer's
 * reaction to the CHANGE event.
 */
class RefreshController extends EventTarget {
	/**
	 * @param {{
	 *   manifestUrl: ?string,
	 *   bootCommitSha: string,
	 *   bootAssetHashes: !Object<string, string>,
	 * }} opts
	 */
	constructor(opts) {
		super();

		/** @private @const @type {?string} */
		this.manifestUrl_ = opts.manifestUrl || null;

		/** @private @const @type {string} */
		this.bootCommitSha_ = opts.bootCommitSha;

		/** @private @const @type {!Object<string, string>} */
		this.bootAssetHashes_ = opts.bootAssetHashes;

		/** @private @type {string} */
		this.mode_ = RefreshMode.OFF;

		/** @private @type {?number} */
		this.timerId_ = null;

		/** @private @type {string} */
		this.latestChangeKind_ = ChangeKind.NONE;

		/** @private @const */
		this.visibilityHandler_ = () => {
			if (document.visibilityState === "visible") {
				if (this.mode_ !== RefreshMode.OFF) {
					this.pollNow();
					this.restartTimer_();
				}
			} else {
				this.stopTimer_();
			}
		};
		document.addEventListener("visibilitychange", this.visibilityHandler_);
	}

	/** @return {string} */
	getMode() {
		return this.mode_;
	}

	/** @return {string} */
	getLatestChangeKind() {
		return this.latestChangeKind_;
	}

	/**
	 * Enable / disable polling. Idempotent; safe to call repeatedly.
	 * @param {string} mode
	 */
	setMode(mode) {
		if (
			mode !== RefreshMode.OFF &&
			mode !== RefreshMode.NOTIFY &&
			mode !== RefreshMode.AUTO
		) {
			return;
		}
		this.mode_ = mode;
		if (mode === RefreshMode.OFF || !this.manifestUrl_) {
			this.stopTimer_();
			return;
		}
		this.restartTimer_();
	}

	/**
	 * Triggers an immediate poll regardless of the timer phase. Used on
	 * tab-visibility-becomes-visible.
	 * @return {!Promise<void>}
	 */
	async pollNow() {
		if (!this.manifestUrl_) return;
		try {
			const url = this.manifestUrl_ + "?t=" + Date.now();
			const res = await fetch(url, { cache: "no-store" });
			if (!res.ok) return;
			const gz = new Uint8Array(await res.arrayBuffer());
			const raw = await gzipDecode(gz);
			const manifest = RegistryManifest.deserializeBinary(raw);
			const kind = this.diff_(manifest);
			if (kind === ChangeKind.NONE) return;
			if (kind === this.latestChangeKind_) return;
			this.latestChangeKind_ = kind;
			this.dispatchEvent({ type: EVENT_CHANGE, kind, manifest });
		} catch (/** @type {*} */ e) {
			// Network blip / CORS / parse error: skip silently. The next
			// tick will retry.
		}
	}

	/**
	 * @private
	 * @param {!RegistryManifest} manifest
	 * @return {string}
	 */
	diff_(manifest) {
		const dataChanged =
			!!this.bootCommitSha_ &&
			manifest.getCommitSha() !== "" &&
			manifest.getCommitSha() !== this.bootCommitSha_;
		let codeChanged = false;
		const map = manifest.getAssetHashesMap();
		for (const original in this.bootAssetHashes_) {
			const bootHashed = this.bootAssetHashes_[original];
			const liveHashed = map.get(original);
			if (liveHashed && liveHashed !== bootHashed) {
				codeChanged = true;
				break;
			}
		}
		if (dataChanged && codeChanged) return ChangeKind.BOTH;
		if (dataChanged) return ChangeKind.DATA;
		if (codeChanged) return ChangeKind.CODE;
		return ChangeKind.NONE;
	}

	/** @private */
	restartTimer_() {
		this.stopTimer_();
		this.timerId_ = window.setInterval(() => {
			this.pollNow();
		}, POLL_INTERVAL_MS);
	}

	/** @private */
	stopTimer_() {
		if (this.timerId_ !== null) {
			window.clearInterval(this.timerId_);
			this.timerId_ = null;
		}
	}

	/** @override */
	disposeInternal() {
		this.stopTimer_();
		document.removeEventListener("visibilitychange", this.visibilityHandler_);
		super.disposeInternal();
	}
}
exports.RefreshController = RefreshController;
