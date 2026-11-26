/** @fileoverview Animates scheduler events for a single worker pool. */
goog.module("bcrfrontend.remoteExecutionTimeline");

const { createDom, removeChildren } = goog.require("goog.dom");

/** @typedef {!Object<string, *>} */
let Record;
/** @typedef {{element: !HTMLElement, rect: !DOMRect, lane: string}} */
let CardPosition;

const QUEUED = "OPERATION_STATE_QUEUED";
const LEASED = "OPERATION_STATE_LEASED";
const RUNNING = "OPERATION_STATE_RUNNING";
const COMPLETED = "OPERATION_STATE_COMPLETED";

/**

 * @param {*} value

 * @return {number}

 */
function timestamp(value) {
	return Date.parse(String(value || "")) || 0;
}

/**

 * @param {number} seconds

 * @return {string}

 */
function duration(seconds) {
	const whole = Math.max(0, Math.floor(seconds));
	return whole < 60 ? whole + "s" : Math.floor(whole / 60) + "m " + (whole % 60) + "s";
}

/**

 * @param {!Record} operation

 * @return {string}

 */
function operationState(operation) {
	switch (operation["state"]) {
		case QUEUED: return "Queued";
		case LEASED: return "Leased";
		case RUNNING: return "Running";
		case COMPLETED:
			if (operation["cachedResult"]) return "Cache hit";
			if (operation["executionCode"] === "CANCELLED") return "Cancelled";
			return operation["executionCode"] === "OK" && !Number(operation["exitCode"])
				? "Succeeded"
				: "Failed";
		default: return "Pending";
	}
}

/**

 * @param {number} ms

 * @return {!Promise<void>}

 */
function delay(ms) {
	return new Promise((/** function():void */ resolve) => {
		setTimeout(resolve, ms);
	});
}

class PoolTimeline {
	/**
	 * @param {!HTMLElement} host
	 * @param {function(string, !AbortSignal): !Promise<!Record>} read
	 * @param {function(string, string): string} operationURL
	 * @param {function(string, string): string} workerURL
	 */
	constructor(host, read, operationURL, workerURL) {
		this.host_ = host;
		this.read_ = read;
		this.operationURL_ = operationURL;
		this.workerURL_ = workerURL;
		this.content_ = createDom("div", "rex-timeline-lanes");
		this.flights_ = createDom("div", {"class": "rex-timeline-flights", "aria-hidden": "true"});
		this.status_ = createDom("p", "text-small color-fg-muted mb-3");
		host.append(
			createDom("h2", "h4 mb-1", "Live scheduling"),
			this.status_,
			this.content_,
			this.flights_,
		);
		this.pool_ = "";
		this.queued_ = 0;
		/** @private {?AbortController} */
		this.connection_ = null;
		/** @private {!Map<string, !Record>} */
		this.workers_ = new Map();
		/** @private {!Map<string, !Record>} */
		this.operations_ = new Map();
		this.clock_ = 0;
		this.motion_ = window.matchMedia("(prefers-reduced-motion: reduce)");
	}

	/** @param {string} pool */
	open(pool) {
		if (pool === this.pool_ && this.connection_) return;
		this.close();
		this.pool_ = pool;
		this.host_.hidden = false;
		this.status_.textContent = "Loading activity…";
		const connection = new AbortController();
		this.connection_ = connection;
		void this.watch_(pool, connection.signal);
		this.clock_ = setInterval(() => this.tick_(), 1000);
	}

	close() {
		this.connection_?.abort();
		this.connection_ = null;
		this.pool_ = "";
		this.workers_.clear();
		this.operations_.clear();
		this.queued_ = 0;
		clearInterval(this.clock_);
		removeChildren(this.content_);
		removeChildren(this.flights_);
		this.host_.hidden = true;
	}

	/**
	 * @private
	 * @param {string} pool
	 * @param {!AbortSignal} signal
	 */
	async watch_(pool, signal) {
		const path = "/pools/" + encodeURIComponent(pool) + "/timeline";
		let cursor = "";
		while (!signal.aborted) {
			try {
				const packet = await this.read_(path + (cursor ? "?after=" + cursor : ""), signal);
				if (signal.aborted) return;
				cursor = String(packet["cursor"]);
				this.status_.textContent = "Live";
				if (packet["snapshot"]) {
					this.workers_.clear();
					this.operations_.clear();
					for (const worker of /** @type {!Array<!Record>} */ (packet["workers"] || []))
						this.workers_.set(String(worker["workerId"]), worker);
					for (const operation of /** @type {!Array<!Record>} */ (packet["operations"] || []))
						this.operations_.set(String(operation["operationName"]), operation);
					const counts = /** @type {!Record} */ (packet["pool"]);
					this.queued_ = Number(counts["queuedOperations"] || 0);
					this.render_(false);
				} else {
					await this.play_(/** @type {!Array<!Record>} */ (packet["events"] || []), signal);
					if (this.queued_ > 0) {
						const operations = /** @type {!Array<!Record>} */ (Array.from(this.operations_.values()));
						if (!operations.some((operation) => operation["state"] === QUEUED)) cursor = "";
					}
				}
			} catch (/** @type {*} */ error) {
				if (signal.aborted) return;
				this.status_.textContent = "Live activity paused. Reconnecting…";
				await delay(1500);
			}
		}
	}

	/**
	 * @private
	 * @param {!Array<!Record>} events
	 * @param {!AbortSignal} signal
	 */
	async play_(events, signal) {
		const updates = events.filter((event) => event["worker"] || event["operation"] || event["pool"]);
		// Keep the view near real time when replaying a burst or returning to the tab.
		const animate = !this.motion_.matches && !document.hidden;
		const transitions = updates.filter((event) => event["worker"] || event["operation"]).length;
		const group = animate ? Math.max(1, Math.ceil(transitions / 8)) : Infinity;
		let steps = 0;
		let changed = false;
		for (const event of updates) {
			if (signal.aborted) return;
			const operation = /** @type {?Record} */ (event["operation"] || null);
			const worker = /** @type {?Record} */ (event["worker"] || null);
			if (operation) {
				const id = String(operation["operationName"]);
				const previous = this.operations_.get(id);
				if (previous?.["state"] !== QUEUED && operation["state"] === QUEUED) this.queued_++;
				if (previous?.["state"] === QUEUED && operation["state"] !== QUEUED) this.queued_--;
				this.operations_.set(id, operation);
			}
			if (worker) this.workers_.set(String(worker["workerId"]), worker);
			const pool = /** @type {?Record} */ (event["pool"] || null);
			if (pool) this.queued_ = Number(pool["queuedOperations"] || 0);
			if (operation || worker) steps++;
			changed = true;
			if (steps >= group) {
				this.render_(animate);
				changed = false;
				steps = 0;
				await delay(210);
			}
		}
		if (changed && !signal.aborted) this.render_(animate);
	}

	/**
	 * @private
	 * @param {!Record} operation
	 * @param {string} lane
	 * @return {!HTMLElement}
	 */
	card_(operation, lane) {
		const resource = String(operation["operationName"]);
		const id = resource.replace(/^operations\//, "");
		const digest = /** @type {?Record} */ (operation["actionDigest"] || null);
		const hash = String(digest?.["hash"] || id).slice(0, 8);
		const state = operationState(operation);
		const start = timestamp(operation["startedAt"]);
		const end = timestamp(operation["finishedAt"]);
		return /** @type {!HTMLElement} */ (createDom("a", {
			"class": "rex-timeline-card",
			"href": this.operationURL_(this.pool_, id),
			"data-timeline-operation": resource,
			"data-timeline-lane": lane,
			"data-timeline-state": state.toLowerCase().replace(/ /g, "-"),
			"aria-label": hash + ", " + state,
			"title": hash + " · " + state,
		}, createDom("code", "", hash), createDom("span", {
			"data-timeline-start": state === "Running" && start ? String(start) : "",
		}, end && start ? duration((end - start) / 1000) : state)));
	}

	/**

	 * @private

	 * @return {!Map<string, !CardPosition>}

	 */
	positions_() {
		/** @type {!Map<string, !CardPosition>} */
		const positions = new Map();
		for (const node of this.content_.querySelectorAll("[data-timeline-operation]")) {
			const element = /** @type {!HTMLElement} */ (node);
			positions.set(String(element.getAttribute("data-timeline-operation")), {
				element,
				rect: element.getBoundingClientRect(),
				lane: String(element.getAttribute("data-timeline-lane")),
			});
		}
		return positions;
	}

	/**

	 * @private

	 * @param {boolean} animate

	 */
	render_(animate) {
		const focused = document.activeElement?.getAttribute("data-timeline-operation");
		const before = animate ? this.positions_() : null;
		const operations = /** @type {!Array<!Record>} */ ([...this.operations_.values()]);
		const queued = operations.filter((op) => op["state"] === QUEUED)
			.sort((a, b) => timestamp(a["queuedAt"]) - timestamp(b["queuedAt"]));
		const finished = operations.filter((op) => op["state"] === COMPLETED)
			.sort((a, b) => timestamp(b["finishedAt"]) - timestamp(a["finishedAt"]));
		for (const op of finished.slice(36)) this.operations_.delete(String(op["operationName"]));
		if (queued.length > 256) {
			for (const op of queued.splice(128, queued.length - 256))
				this.operations_.delete(String(op["operationName"]));
		}
		const queue = createDom("div", "rex-timeline-track rex-timeline-queue");
		if (queued.length > 10) {
			for (const op of queued.slice(0, 5)) queue.append(this.card_(op, "queue"));
			queue.append(createDom("span", "text-small color-fg-muted", "…"));
			for (const op of queued.slice(-5)) queue.append(this.card_(op, "queue"));
		} else {
			for (const op of queued) queue.append(this.card_(op, "queue"));
		}
		if (!queued.length) queue.append(createDom("span", "text-small color-fg-muted", this.queued_ ? "Waiting for the next visible assignment" : "No actions queued"));

		const rows = createDom("div", "rex-timeline-workers");
		const active = operations.filter((op) => op["state"] === RUNNING || op["state"] === LEASED);
		this.workers_.forEach((worker, id) => {
			const name = String(worker["displayName"] || id);
			const state = String(worker["state"] || "").replace(/^WORKER_STATE_/, "").toLowerCase();
			const label = createDom("div", "rex-timeline-worker-label",
				createDom("a", {"href": this.workerURL_(this.pool_, id), "title": id}, name),
				createDom("span", "text-small color-fg-muted", state));
			const track = createDom("div", "rex-timeline-track rex-timeline-worker-track");
			for (const op of finished.filter((op) => op["workerId"] === id).slice(0, 4).reverse()) {
				const elapsed = timestamp(op["finishedAt"]) - timestamp(op["startedAt"]);
				if (elapsed > 0) track.append(createDom("span", {
					"class": "rex-timeline-history",
					"title": operationState(op) + " · " + duration(elapsed / 1000),
				}, duration(elapsed / 1000)));
			}
			const assigned = active.filter((op) => op["workerId"] === id);
			for (const op of assigned) track.append(this.card_(op, "worker:" + id));
			if (!assigned.length) track.append(createDom("span", "text-small color-fg-muted", state === "online" ? "Idle" : ""));
			rows.append(createDom("div", "rex-timeline-worker", label, track));
		});
		if (!this.workers_.size) rows.append(createDom("p", "text-small color-fg-muted mb-0", "No workers connected"));

		const completed = createDom("div", "rex-timeline-track rex-timeline-completed");
		for (const op of finished.slice(0, 12)) completed.append(this.card_(op, "completed"));
		if (!finished.length) completed.append(createDom("span", "text-small color-fg-muted", "No completed actions yet"));
		removeChildren(this.content_);
		this.content_.append(
			createDom("section", {"aria-label": "Queued actions"}, createDom("h3", "h5 mb-2", "Queued · " + Math.max(this.queued_, queued.length)), queue),
			createDom("section", {"aria-label": "Worker lanes"}, createDom("h3", "h5 mb-2", "Workers"), rows),
			createDom("section", {"aria-label": "Completed actions"}, createDom("h3", "h5 mb-2", "Completed"), completed),
		);
		this.tick_();
		if (!animate && !focused) return;
		const after = this.positions_();
		if (focused) after.get(focused)?.element.focus({preventScroll: true});
		if (before) {
			after.forEach((item, id) => this.animate_(before.get(id), item));
		}
	}

	/** @private */
	tick_() {
		const now = Date.now();
		for (const element of this.content_.querySelectorAll("[data-timeline-start]")) {
			const start = Number(element.getAttribute("data-timeline-start"));
			if (start > 0) element.textContent = duration((now - start) / 1000) + " running";
		}
	}

	/**
	 * @private
	 * @param {(!CardPosition|undefined)} from
	 * @param {!CardPosition} to
	 */
	animate_(from, to) {
		if (to.element === document.activeElement) return;
		const x = from ? from.rect.left - to.rect.left : to.lane === "queue" ? 36 : to.lane === "completed" ? -36 : 0;
		const y = from ? from.rect.top - to.rect.top : 0;
		if (!x && !y && from) return;
		const frames = [
			{transform: "translate(" + x + "px," + y + "px)", opacity: from ? 1 : 0.3},
			{transform: "translate(0,0)", opacity: 1},
		];
		const timing = {duration: 190, easing: "ease-out"};
		if (!from || from.lane === to.lane) {
			to.element.animate(frames, timing);
			return;
		}
		const host = this.host_.getBoundingClientRect();
		const ghost = /** @type {!HTMLElement} */ (to.element.cloneNode(true));
		ghost.removeAttribute("href");
		ghost.removeAttribute("data-timeline-operation");
		ghost.style.left = (to.rect.left - host.left) + "px";
		ghost.style.top = (to.rect.top - host.top) + "px";
		ghost.style.width = to.rect.width + "px";
		this.flights_.append(ghost);
		to.element.style.visibility = "hidden";
		const animation = ghost.animate(frames, timing);
		animation.onfinish = () => {
			ghost.remove();
			to.element.style.visibility = "";
		};
	}
}

exports.PoolTimeline = PoolTimeline;
