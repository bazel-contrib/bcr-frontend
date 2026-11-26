/** @fileoverview Aggregate and per-instance telemetry for the Bazel remote cache. */
goog.module("bcrfrontend.remoteCache");

const { BrowserEvent } = goog.requireType("goog.events");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { Route } = goog.requireType("stack.ui");
const { formatBytes } = goog.require("bcrfrontend.invocationFormat");
const {
	ToolSetting,
	toolSetting,
	cacheStatusURL,
	readToolSetting,
	writeToolSetting,
} = goog.require("bcrfrontend.toolSettings");
const { remoteCache } = goog.require("soy.bcrfrontend.tools");

/** @typedef {{at: number, uploaded: number, downloaded: number}} */
let Sample;
/** @typedef {{at: number, upload: number, download: number}} */
let Rate;

const WINDOW_SECONDS = 120;
const POLL_MS = 2000;

class RemoteCacheComponent extends Component {
	/** @param {?goog.dom.DomHelper=} dom */
	constructor(dom) {
		super(dom);
		/** @private {?AbortController} */
		this.request_ = null;
		/** @private {?Sample} */
		this.previous_ = null;
		/** @private {!Array<!Rate>} */
		this.rates_ = [];
		this.started_ = "";
		this.timer_ = 0;
		/** @private {?Object<string, *>} */
		this.snapshot_ = null;
		this.instanceChoices_ = "";
		this.selectedInstance_ = "";
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(remoteCache));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		this.getHandler().listen(
			this.field_("connect"),
			"submit",
			(/** !BrowserEvent */ event) => {
				event.preventDefault();
				this.connect_();
			},
		);
		this.getHandler().listen(this.field_("instance"), "change", () => {
			if (this.snapshot_) this.renderSnapshot_(this.snapshot_);
		});
	}

	/** @override @param {!Route} route */
	goHere(route) {
		super.goHere(route);
		if (
			!this.request_ &&
			(readToolSetting(ToolSetting.REMOTE_CACHE_STATUS) ||
				readToolSetting(ToolSetting.REMOTE_CACHE_CONNECTED))
		)
			this.connect_();
	}

	/** @override */
	hide() {
		this.stop_();
		this.status_("Disconnected", "", "Connect to resume live updates.");
		super.hide();
	}

	/** @override */
	exitDocument() {
		this.stop_();
		super.exitDocument();
	}

	/** @private */
	stop_() {
		clearTimeout(this.timer_);
		this.request_?.abort();
		this.request_ = null;
		this.previous_ = null;
		this.rates_ = [];
		this.started_ = "";
		this.snapshot_ = null;
	}

	/**
	 * @private
	 * @param {string} name
	 * @return {!HTMLElement}
	 */
	field_(name) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector('[data-cache="' + name + '"]')
		);
	}

	/**
	 * @private
	 * @param {string} label
	 * @param {string} color
	 * @param {string} detail
	 */
	status_(label, color, detail) {
		const state = this.field_("state");
		state.className = "Label " + color;
		if (state.textContent !== label) state.textContent = label;
		this.field_("detail").textContent = detail;
	}

	/** @private */
	connect_() {
		this.stop_();
		this.field_("dashboard").hidden = true;
		this.field_("empty").hidden = false;
		this.field_("empty").textContent = "Waiting for the cache server…";
		try {
			const url = cacheStatusURL(toolSetting(ToolSetting.REMOTE_CACHE_STATUS));
			this.status_("Connecting", "Label--accent", new URL(url).origin);
			void this.poll_(url);
		} catch (/** @type {*} */ error) {
			this.field_("empty").textContent =
				"Enter a cache status API URL and connect.";
			this.status_(
				"Connection failed",
				"Label--danger",
				error instanceof Error ? error.message : "Invalid status API URL.",
			);
		}
	}

	/**
	 * @private
	 * @param {string} url
	 */
	async poll_(url) {
		const request = new AbortController();
		this.request_ = request;
		const timeout = setTimeout(() => request.abort(), 7000);
		try {
			const response = await fetch(url, {
				signal: request.signal,
				cache: "no-store",
				credentials: "omit",
			});
			if (!response.ok)
				throw new Error(
					"Cache status API returned HTTP " + response.status + ".",
				);
			const snapshot = /** @type {!Object<string, *>} */ (
				await response.json()
			);
			if (this.request_ !== request) return;
			if (
				!snapshot["startedAt"] ||
				!Number.isFinite(Date.parse(String(snapshot["sampledAt"]))) ||
				!snapshot["storage"]
			)
				throw new Error("The endpoint did not return a cache status snapshot.");
			this.renderSnapshot_(snapshot);
			if (!readToolSetting(ToolSetting.REMOTE_CACHE_CONNECTED))
				writeToolSetting(ToolSetting.REMOTE_CACHE_CONNECTED, "1");
			const time = new Date(String(snapshot["sampledAt"])).toLocaleTimeString();
			this.status_("Connected", "Label--success", "Last updated " + time);
		} catch (/** @type {*} */ error) {
			if (this.request_ !== request) return;
			this.previous_ = null;
			this.rates_ = [];
			this.status_(
				"Reconnecting",
				"Label--attention",
				request.signal.aborted
					? "The status check timed out. Retrying…"
					: (error instanceof Error
							? error.message
							: "The status check failed.") + " Retrying…",
			);
			this.field_("empty").textContent =
				"Cache status is unavailable. Retrying…";
		} finally {
			clearTimeout(timeout);
			if (this.request_ === request)
				this.timer_ = setTimeout(() => this.poll_(url), POLL_MS);
		}
	}

	/**
	 * @private
	 * @param {string} key
	 * @param {string} value
	 * @param {string=} detail
	 */
	stat_(key, value, detail = "") {
		this.field_(key).textContent = value;
		this.field_(key + "-detail").textContent = detail;
	}

	/**
	 * @private
	 * @param {!Object<string, *>} snapshot
	 */
	renderSnapshot_(snapshot) {
		this.snapshot_ = snapshot;
		const selection = /** @type {!HTMLSelectElement} */ (this.field_("instance"));
		const instances = /** @type {!Array<!Object<string, *>>} */ (snapshot["instances"] || []);
		const names = /** @type {!Array<string>} */ (instances.map((instance) => String(instance["name"])));
		const choices = JSON.stringify(names);
		if (choices !== this.instanceChoices_) {
			const previous = selection.value;
			selection.options.length = 1;
			for (const name of names) {
				const option = /** @type {!HTMLOptionElement} */ (document.createElement("option"));
				option.value = "instance:" + name;
				option.textContent = name || "Default instance";
				selection.add(option);
			}
			selection.value = previous;
			if (selection.selectedIndex < 0) selection.selectedIndex = 0;
			this.instanceChoices_ = choices;
		}
		if (this.started_ !== snapshot["startedAt"] || this.selectedInstance_ !== selection.value) {
			this.previous_ = null;
			this.rates_ = [];
			this.started_ = String(snapshot["startedAt"]);
			this.selectedInstance_ = selection.value;
		}
		const traffic = instances.find((instance) => "instance:" + String(instance["name"]) === selection.value) || snapshot;
		const sample = {
			at: Date.parse(String(snapshot["sampledAt"])) / 1000,
			uploaded: Number(traffic["uploadedBytes"]),
			downloaded: Number(traffic["downloadedBytes"]),
		};
		const previous = this.previous_;
		this.previous_ = sample;
		const elapsed = previous ? sample.at - previous.at : 0;
		const rate =
			previous && elapsed > 0
				? {
						at: sample.at,
						upload: (sample.uploaded - previous.uploaded) / elapsed,
						download: (sample.downloaded - previous.downloaded) / elapsed,
					}
				: null;
		this.stat_(
			"upload",
			rate ? formatBytes(rate.upload) + "/s" : "—",
			formatBytes(sample.uploaded) + " since startup",
		);
		this.stat_(
			"download",
			rate ? formatBytes(rate.download) + "/s" : "—",
			formatBytes(sample.downloaded) + " since startup",
		);
		const uploads = Number(traffic["activeUploads"]);
		const downloads = Number(traffic["activeDownloads"]);
		this.stat_(
			"transfers",
			String(uploads + downloads),
			uploads + " uploading · " + downloads + " downloading",
		);
		this.stat_(
			"connections",
			String(snapshot["connections"]),
			"Open gRPC connections across all instances",
		);
		const hits = Number(traffic["actionHits"]);
		const misses = Number(traffic["actionMisses"]);
		const errors = Number(traffic["actionErrors"]);
		this.stat_(
			"hit-rate",
			hits + misses ? ((hits * 100) / (hits + misses)).toFixed(1) + "%" : "—",
			hits + " hits · " + misses + " misses · " + errors + " errors",
		);
		if (rate) this.rates_.push(rate);
		this.rates_ = this.rates_.filter(
			(point) => point.at >= sample.at - WINDOW_SECONDS,
		);
		this.renderChart_(sample.at);
		this.renderStorage_(
			/** @type {!Object<string, *>} */ (snapshot["storage"]),
		);
		this.field_("dashboard").hidden = false;
		this.field_("empty").hidden = true;
	}

	/**
	 * @private
	 * @param {number} now
	 */
	renderChart_(now) {
		let max = 1;
		for (const point of this.rates_)
			max = Math.max(max, point.upload, point.download);
		const step = Math.pow(10, Math.floor(Math.log10(max)));
		const scale = Math.ceil(max / step) * step;
		this.field_("chart-max").textContent = this.rates_.length
			? formatBytes(scale) + "/s"
			: "—";
		this.field_("chart-mid").textContent = this.rates_.length
			? formatBytes(scale / 2) + "/s"
			: "—";
		const seriesNames = /** @type {!Array<string>} */ (["upload", "download"]);
		for (const series of seriesNames) {
			const points = this.rates_.map((point) => {
				const x = WINDOW_SECONDS - (now - point.at);
				const value = series === "upload" ? point.upload : point.download;
				return x.toFixed(2) + "," + (99 - (98 * value) / scale).toFixed(2);
			});
			this.field_("chart-" + series).setAttribute("points", points.join(" "));
		}
	}

	/**
	 * @private
	 * @param {!Object<string, *>} storage
	 */
	renderStorage_(storage) {
		const summary = this.field_("storage-summary");
		const progress = /** @type {!HTMLProgressElement} */ (
			this.field_("storage-progress")
		);
		const bounded = storage["mode"] === "bounded";
		progress.hidden = !bounded;
		if (bounded) {
			progress.max = Number(storage["limitBytes"]);
			progress.value = Number(storage["usedBytes"]);
			summary.textContent =
				formatBytes(progress.value) +
				" used of " +
				formatBytes(progress.max) +
				" cache budget";
		} else {
			summary.textContent =
				storage["mode"] === "proxy"
					? "Storage is managed by the upstream cache."
					: "Local cache has no configured disk budget.";
		}
		const available = storage["filesystemFreeBytes"];
		this.stat_(
			"disk-free",
			available == null ? "—" : formatBytes(Number(available)),
		);
		this.stat_(
			"reserved",
			bounded ? formatBytes(Number(storage["reservedBytes"])) : "—",
		);
		this.stat_(
			"evicted",
			bounded ? formatBytes(Number(storage["evictedBytes"])) : "—",
			bounded ? String(storage["evictedEntries"]) + " entries" : "",
		);
	}
}

exports.RemoteCacheComponent = RemoteCacheComponent;
