/** @fileoverview Lay out, draw, and navigate the build event frontier. */
goog.module("bcrfrontend.invocationFrontier");

const BuildEventId = goog.require("proto.build_event_stream.BuildEventId");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const { FrontierMark, InvocationProgress, buildEventIdSummary } = goog.require("bcrfrontend.invocationEvents");

const FRONTIER_COLUMN_WIDTH = 36;

const FRONTIER_ROW_HEIGHT = 20;

const FRONTIER_INSET = 10;

const FRONTIER_EXPECTED_WIDTH = 220;

const FRONTIER_EXPECTED_HEIGHT = 52;

const FRONTIER_MAX_FLIGHTS = 24;

const FRONTIER_FLIGHT_LANES = 8;

/**
 * @param {?BuildEventId} id
 * @return {{type: string, detail: string}}
 */
function expectedFrontierLabel(id) {
	const progress = id?.getProgress();
	if (progress) return {type: "Progress", detail: "#" + progress.getOpaqueCount()};
	const action = id?.getActionCompleted();
	if (action) {
		const output = action.getPrimaryOutput().split("/").pop() || "";
		return {type: "Action", detail: [action.getLabel(), output].filter(Boolean).join(" · ")};
	}
	const summary = buildEventIdSummary(id);
	const separator = summary.indexOf(": ");
	return separator < 0 ? {type: summary, detail: ""}
		: {type: summary.slice(0, separator), detail: summary.slice(separator + 2)};
}

/**
 * @param {!FrontierMark} mark
 * @param {number} now
 * @return {?number}
 */
function frontierWait(mark, now) {
	return mark.announcedAt === null ? null : Math.max(0, Math.floor((now - mark.announcedAt) / 1000));
}

/**
 * @param {number} seconds
 * @return {string}
 */
function formatFrontierWait(seconds) {
	return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

/**
 * @param {!CanvasRenderingContext2D} context
 * @param {string} label
 * @param {number} width
 * @return {string}
 */
function fitFrontierLabel(context, label, width) {
	if (context.measureText(label).width <= width) return label;
	let first = 0;
	let end = label.length;
	while (first < end) {
		const mid = Math.ceil((first + end) / 2);
		if (context.measureText(label.slice(0, mid) + "…").width <= width) first = mid;
		else end = mid - 1;
	}
	return label.slice(0, first) + "…";
}

/** @typedef {{column: number, row: number}} */
let FrontierCell;

/** @typedef {{columns: !Array<!Array<?FrontierMark>>, cells: !Map<!FrontierMark, !FrontierCell>,
 *    parents: !Map<!FrontierMark, !Array<!FrontierMark>>,
 *    children: !Map<!FrontierMark, !Array<!FrontierMark>>,
 *    departures: !Map<!FrontierMark, !FrontierCell>,
 *    suppressed: !Set<!FrontierMark>,
 *    bodyRows: number}} */
let FrontierLayout;

/**
 * @param {!FrontierMark} mark
 * @return {boolean}
 */
function isFrontierBackbone(mark) {
	const type = mark.id?.getIdCase();
	return type === BuildEventId.IdCase.STARTED || type === BuildEventId.IdCase.PROGRESS ||
		type === BuildEventId.IdCase.BUILD_FINISHED;
}

/**
 * Layer the received graph by its longest path from a root, with roots on the
 * right. Each shared child gets one cell regardless of how many parents
 * announced it.
 * @param {!InvocationProgress} progress
 * @param {number=} start
 * @return {!FrontierLayout}
 */
function layoutFrontier(progress, start = progress.history.length) {
	const history = progress.history;
	/** @type {!Array<!FrontierMark>} */
	const pending = Array.from(progress.pending.values());
	/** @type {!Set<!FrontierMark>} */
	const removed = new Set();
	/** @type {!Set<!FrontierMark>} */
	const suppressed = new Set();
	/** @param {!FrontierMark} mark */
	const removeFromFrontier = (mark) => {
		const artifactSet = mark.id?.getIdCase() === BuildEventId.IdCase.NAMED_SET || mark.event?.hasNamedSetOfFiles();
		if (!artifactSet && !mark.event?.hasAction()) return;
		removed.add(mark);
		if (artifactSet) suppressed.add(mark);
		const directParents = /** @type {!Array<!FrontierMark>} */ (mark.parents);
		for (const parent of directParents) {
			if (!parent.event?.hasProgress()) continue;
			removed.add(parent);
			if (artifactSet) suppressed.add(parent);
		}
	};
	history.forEach(removeFromFrontier);
	pending.forEach(removeFromFrontier);
	/** @type {!Array<number>} */
	const depth = history.map(() => 0);
	/** @type {!Array<number>} */
	const remaining = history.map((mark) =>
		mark.parents.filter((/** !FrontierMark */ parent) => parent.event !== null).length);
	/** @type {!Array<!FrontierMark>} */
	const ready = history.filter((mark) => !remaining[mark.index]);
	for (let i = 0; i < ready.length; i++) {
		const parent = ready[i];
		const children = /** @type {!Array<!FrontierMark>} */ (parent.children);
		for (const child of children) {
			if (!child.event) continue;
			depth[child.index] = Math.max(depth[child.index], depth[parent.index] + 1);
			if (--remaining[child.index] === 0) ready.push(child);
		}
	}

	/** @type {!Array<!Array<!FrontierMark>>} */
	const layers = [];
	for (const mark of history) {
		if (mark === progress.last && !removed.has(mark)) continue;
		const rank = depth[mark.index];
		if (!layers[rank]) layers[rank] = [];
		layers[rank].push(mark);
	}

	// Keep siblings together and put a shared child near its earliest parent.
	/** @type {!Map<!FrontierMark, number>} */
	const rowsByMark = new Map();
	for (const layer of layers) {
		if (!layer) continue;
		/** @type {!Map<!FrontierMark, number>} */
		const preferred = new Map();
		for (const mark of layer) {
			let row = Infinity;
			const parents = /** @type {!Array<!FrontierMark>} */ (mark.parents);
			for (const parent of parents) {
				row = Math.min(row, rowsByMark.get(parent) ?? Infinity);
			}
			preferred.set(mark, row);
		}
		layer.sort((a, b) => {
			const left = preferred.get(a) ?? Infinity;
			const right = preferred.get(b) ?? Infinity;
			return left === right ? a.index - b.index : left - right;
		});
		layer.forEach((mark, row) => rowsByMark.set(mark, row));
	}

	/** @type {!Array<!Array<?FrontierMark>>} */
	const columns = [];
	/** @type {!Array<!FrontierMark>} */
	const expected = pending.filter((mark) => !suppressed.has(mark));
	expected.sort((a, b) => {
		const left = a.announcedAt ?? Infinity;
		const right = b.announcedAt ?? Infinity;
		return left === right ? 0 : left - right;
	});
	columns.push(expected);
	if (progress.last && !removed.has(progress.last)) {
		columns.push(isFrontierBackbone(progress.last) ? [progress.last] : [null, progress.last]);
	}
	/** @type {!Map<!FrontierMark, !FrontierCell>} */
	const departures = new Map();
	for (let i = layers.length - 1; i >= 0; i--) {
		if (!layers[i]) continue;
		/** @type {!Array<!FrontierMark>} */
		const backbone = [];
		/** @type {!Array<!FrontierMark>} */
		const branches = [];
		/** @type {!Array<{mark: !FrontierMark, row: number}>} */
		const leaving = [];
		let branchRow = 1;
		for (const mark of layers[i]) {
			if (!removed.has(mark)) {
				if (isFrontierBackbone(mark)) backbone.push(mark);
				else {
					branches.push(mark);
					branchRow++;
				}
			} else if (mark.index >= start && !suppressed.has(mark)) {
				leaving.push({mark, row: isFrontierBackbone(mark) ? 0 : branchRow++});
			}
		}
		// Parallel progress events get their own column so none spill into a branch row.
		for (let j = backbone.length - 1; j > 0; j--) columns.push([backbone[j]]);
		const column = columns.length;
		for (const departure of leaving) {
			departures.set(departure.mark, {column, row: departure.row});
		}
		if (branches.length || backbone.length) columns.push([backbone[0] || null, ...branches]);
	}
	/** @type {!Map<!FrontierMark, !FrontierCell>} */
	const cells = new Map();
	let bodyRows = 0;
	columns.forEach((marks, column) => {
		if (column > 0) bodyRows = Math.max(bodyRows, marks.length);
		marks.forEach((mark, row) => {
			if (mark) cells.set(mark, {column, row});
		});
	});

	// Keep dependencies reachable through excised marks without changing the stored events.
	/** @type {!Map<!FrontierMark, !Array<!FrontierMark>>} */
	const parents = new Map();
	/** @type {!Map<!FrontierMark, !Array<!FrontierMark>>} */
	const children = new Map();
	const projected = /** @type {!Array<!FrontierMark>} */ (ready.concat(expected));
	for (const mark of projected) {
		/** @type {!Set<!FrontierMark>} */
		const upstream = new Set();
		const directParents = /** @type {!Array<!FrontierMark>} */ (mark.parents);
		for (const parent of directParents) {
			if (removed.has(parent)) {
				const ancestors = parents.get(parent);
				if (ancestors) for (const ancestor of ancestors) upstream.add(ancestor);
			} else if (cells.has(parent)) upstream.add(parent);
		}
		/** @type {!Array<!FrontierMark>} */
		const connected = Array.from(upstream);
		parents.set(mark, connected);
		if (removed.has(mark)) continue;
		for (const parent of connected) {
			let next = children.get(parent);
			if (!next) {
				next = [];
				children.set(parent, next);
			}
			next.push(mark);
		}
	}
	return {columns, cells, parents, children, departures, suppressed, bodyRows};
}

/** @typedef {{index: number, success: boolean, mnemonic: string, path: string, color: string}} */
let FrontierActionReading;

/** @typedef {{x: number, y: number}} */
let FrontierPoint;

/**
 * The lateral spread peaks mid-flight and converges at the reader.
 * @param {!FrontierPoint} origin
 * @param {!FrontierPoint} target
 * @param {number} lane
 * @return {!Array<!Keyframe>}
 */
function frontierFlightFrames(origin, target, lane) {
	/** @type {!Array<!Keyframe>} */
	const frames = [];
	/**
	 * @param {number} x
	 * @param {number} y
	 * @param {number} offset
	 * @param {number} opacity
	 */
	const step = (x, y, offset, opacity) => frames.push({
		offset, opacity,
		transform: "translate(" + x + "px," + y + "px)",
	});
	step(origin.x, origin.y, 0, 1);
	step(origin.x + 3, origin.y - 2, 0.045, 1);
	step(origin.x - 4, origin.y + 1, 0.09, 1);
	step(origin.x, origin.y, 0.14, 1);
	const arc = (lane - (FRONTIER_FLIGHT_LANES - 1) / 2) * 12;
	for (let i = 1; i <= 8; i++) {
		const t = i / 8;
		const x = target.x + (origin.x - target.x) * (1 - t) ** (1.35 + lane * 0.025);
		const y = origin.y + (target.y - origin.y) * t ** 2 + arc * 4 * t * (1 - t);
		step(x, Math.max(4, Math.min(target.y, y)), 0.14 + 0.86 * t, i === 8 ? 0 : 1);
	}
	return frames;
}

class FrontierActionReaders {
	/**
	 * @param {!HTMLElement} layer
	 * @param {!HTMLElement} reader
	 */
	constructor(layer, reader) {
		this.layer_ = layer;
		this.reader_ = reader;
		this.reducedMotion_ = window.matchMedia("(prefers-reduced-motion: reduce)");
		/** @private */ this.latest_ = -1;
		/** @private */ this.nextFlight_ = 0;
		/** @private @const {!Map<!Animation, {particle: !HTMLElement, reading: ?FrontierActionReading}>} */
		this.flights_ = new Map();
	}

	reset() {
		this.finish();
		this.latest_ = -1;
		this.nextFlight_ = 0;
		this.write_("—", "", "", "", true);
	}

	finish() {
		for (const [animation, flight] of this.flights_) {
			animation.cancel();
			flight.particle.remove();
			if (flight.reading) this.read_(flight.reading);
		}
		this.flights_.clear();
	}

	/** @private @return {boolean} */
	canAnimate_() {
		return !this.reducedMotion_.matches && !document.hidden &&
			typeof this.layer_.animate === "function" && this.flights_.size < FRONTIER_MAX_FLIGHTS;
	}

	/**
	 * @param {!Array<!FrontierMark>} history
	 * @param {number} start
	 * @param {function(!FrontierMark):?FrontierPoint} origin
	 */
	update(history, start, origin) {
		if (start >= history.length) return;
		/** @type {?FrontierActionReading} */
		let direct = null;
		for (let index = start; index < history.length; index++) {
			const mark = history[index];
			const action = mark.event?.getAction();
			if (!action) continue;
			const file = action.getPrimaryOutput();
			const path = mark.id?.getActionCompleted()?.getPrimaryOutput() ||
				(file ? [...file.getPathPrefixList(), file.getName()].filter(Boolean).join("/") : "");
			/** @type {!FrontierActionReading} */
			const reading = {index, success: action.getSuccess(), mnemonic: action.getType() || "Unspecified",
				path, color: mark.color};
			const source = this.canAnimate_() ? origin(mark) : null;
			if (source) this.launch_(reading, source);
			else direct = reading;
		}
		if (direct) this.read_(direct);
	}

	/**
	 * @private
	 * @param {!FrontierActionReading} reading
	 */
	read_(reading) {
		if (reading.index < this.latest_) return;
		this.latest_ = reading.index;
		const path = reading.path.replace(/\\/g, "/").replace(/^.*?bazel-out\/[^/]+\/(?:bin|genfiles)\//, "");
		const parts = path.split("/").filter(Boolean);
		const compact = parts.length > 3 ? "…/" + parts.slice(-3).join("/") : parts.join("/");
		this.write_(reading.mnemonic, compact || "No primary output", reading.path, reading.color, reading.success);
	}

	/**
	 * @private
	 * @param {string} mnemonic
	 * @param {string} path
	 * @param {string} fullPath
	 * @param {string} color
	 * @param {boolean} success
	 */
	write_(mnemonic, path, fullPath, color, success) {
		const row = this.reader_;
		row.classList.toggle("is-failed", !success);
		row.setAttribute("aria-label", color ? (success ? "Last successful action" : "Last failed action") : "Last completed action");
		const dot = /** @type {?HTMLElement} */ (row.querySelector(".bes-frontier-reader-dot"));
		const name = /** @type {?HTMLElement} */ (row.querySelector(".bes-frontier-reader-mnemonic"));
		const output = /** @type {?HTMLElement} */ (row.querySelector(".bes-frontier-reader-output"));
		if (dot) dot.style.backgroundColor = color;
		if (name) {
			name.textContent = mnemonic;
			name.title = mnemonic;
		}
		if (output) {
			output.textContent = path;
			output.title = fullPath;
		}
	}

	/**
	 * @private
	 * @param {!FrontierActionReading} reading
	 * @param {!FrontierPoint} origin
	 */
	launch_(reading, origin) {
		const gate = this.reader_.parentElement?.querySelector(reading.success
			? ".bes-frontier-arrival-success" : ".bes-frontier-arrival-failed");
		if (!gate) {
			this.read_(reading);
			return;
		}
		const bounds = this.layer_.getBoundingClientRect();
		const target = gate.getBoundingClientRect();
		const end = {x: target.left - bounds.left + target.width / 2,
			y: target.top - bounds.top + target.height / 2};
		const lane = this.nextFlight_ % FRONTIER_FLIGHT_LANES;
		const stagger = lane * 12 + Math.floor(this.nextFlight_ / FRONTIER_FLIGHT_LANES) * 55;
		this.nextFlight_ = (this.nextFlight_ + 1) % FRONTIER_MAX_FLIGHTS;
		const distance = Math.hypot(end.x - origin.x, end.y - origin.y);
		this.animate_(reading.color, frontierFlightFrames(origin, end, lane),
			Math.min(950, 575 + distance / 3) + lane * 20, reading, stagger);
	}

	/**
	 * @param {!FrontierPoint} origin
	 * @param {string} color
	 */
	fadeProgress(origin, color) {
		if (!this.canAnimate_()) return;
		const position = "translate(" + origin.x + "px," + origin.y + "px)";
		this.animate_(color, [
			{transform: position, opacity: 1},
			{transform: position + " scale(1.35)", opacity: 0.7},
			{transform: position + " scale(0)", opacity: 0},
		], 300, null);
	}

	/**
	 * @private
	 * @param {string} color
	 * @param {!Array<!Keyframe>} frames
	 * @param {number} duration
	 * @param {?FrontierActionReading} reading
	 * @param {number=} delay
	 */
	animate_(color, frames, duration, reading, delay = 0) {
		const particle = /** @type {!HTMLElement} */ (dom.createDom("span", reading
			? "bes-frontier-particle" : "bes-frontier-particle is-progress"));
		particle.style.color = color;
		particle.style.backgroundColor = color;
		this.layer_.appendChild(particle);
		const animation = particle.animate(frames, {duration, delay, fill: "both"});
		this.flights_.set(animation, {particle, reading});
		animation.onfinish = () => {
			if (!this.flights_.delete(animation)) return;
			particle.remove();
			if (reading) this.read_(reading);
		};
	}
}

class InvocationFrontier {
	/**
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!HTMLElement} scroll
	 * @param {!HTMLElement} spacer
	 * @param {!FrontierActionReaders} readers
	 * @param {function(!FrontierMark):void} inspect
	 */
	constructor(canvas, scroll, spacer, readers, inspect) {
		this.canvas = canvas;
		this.scroll = scroll;
		this.spacer = spacer;
		this.readers_ = readers;
		this.inspect = inspect;
		/** @private @type {?InvocationProgress} */
		this.progress_ = null;
		/** @private @type {!FrontierLayout} */
		this.layout_ = {columns: [[]], cells: new Map(), parents: new Map(),
			children: new Map(), departures: new Map(), suppressed: new Set(), bodyRows: 0};
		/** @private @type {?FrontierMark} */
		this.selected_ = null;
		/** @private */ this.received_ = 0;
		/** @private */ this.clock_ = 0;
	}

	/**
	 * @param {!InvocationProgress} progress
	 * @return {number} The count of expected events shown in the frontier.
	 */
	update(progress) {
		let start = this.received_;
		/** @type {?FrontierLayout} */
		let previous = this.layout_;
		if (this.progress_ !== progress) {
			start = 0;
			previous = null;
			this.readers_.reset();
			this.selected_ = null;
			this.scroll.scrollTop = 0;
			this.scroll.scrollLeft = 0;
			this.canvas.title = "";
		} else if (this.received_ === progress.history.length) {
			if (progress.collectionEnded()) {
				this.stopClock();
				this.draw();
				if (this.selected_) this.inspect(this.selected_);
			}
			return this.layout_.columns[0].length;
		}
		this.progress_ = progress;
		this.received_ = progress.history.length;
		this.layout_ = layoutFrontier(progress, start);
		this.draw(start, previous);
		if (this.selected_) {
			this.inspect(this.selected_);
			if (!this.layout_.cells.has(this.selected_)) this.selected_ = null;
		}
		const running = !progress.collectionEnded() && this.layout_.columns[0].some((mark) => mark && mark.announcedAt !== null);
		if (running && !this.clock_) {
			this.clock_ = setInterval(() => {
				this.draw();
				if (this.selected_ && !this.selected_.event) this.inspect(this.selected_);
			}, 1000);
		} else if (!running) {
			this.stopClock();
		}
		return this.layout_.columns[0].length;
	}

	stop() {
		this.stopClock();
		this.readers_.finish();
	}

	stopClock() {
		clearInterval(this.clock_);
		this.clock_ = 0;
	}

	/**
	 * @private
	 * @param {number} column
	 * @param {number} row
	 * @return {?FrontierMark}
	 */
	markAt_(column, row) {
		return this.layout_.columns[column]?.[row] || null;
	}

	/** @private @return {number} */
	expectedWidth_() {
		return this.layout_.columns[0].length
			? Math.min(FRONTIER_EXPECTED_WIDTH, Math.floor(this.scroll.clientWidth * 0.58))
			: 0;
	}

	/**
	 * @param {number=} firstNewMark
	 * @param {?FrontierLayout=} previous
	 */
	draw(firstNewMark = this.received_, previous = null) {
		const width = this.scroll.clientWidth;
		const height = this.scroll.clientHeight;
		const context = /** @type {?CanvasRenderingContext2D} */ (this.canvas.getContext("2d"));
		const progress = this.progress_;
		if (!width || !height || !context) {
			if (progress) this.readers_.update(progress.history, firstNewMark, () => null);
			return;
		}
		const {columns, cells, parents, children, departures, suppressed, bodyRows} = this.layout_;
		const expectedColumn = columns[0];
		const band = this.expectedWidth_();
		const bodyLeft = band + FRONTIER_INSET;
		const contentWidth = bodyLeft + (columns.length - 1) * FRONTIER_COLUMN_WIDTH + FRONTIER_INSET;
		const contentHeight = 2 * FRONTIER_INSET + Math.max(bodyRows * FRONTIER_ROW_HEIGHT,
			expectedColumn.length * FRONTIER_EXPECTED_HEIGHT);
		this.spacer.style.width = Math.max(width, contentWidth) + "px";
		this.spacer.style.height = Math.max(0, contentHeight - height) + "px";
		const scale = window.devicePixelRatio || 1;
		if (this.canvas.width !== Math.round(width * scale) || this.canvas.height !== Math.round(height * scale)) {
			this.canvas.width = Math.round(width * scale);
			this.canvas.height = Math.round(height * scale);
		}
		this.canvas.style.height = height + "px";
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, width, height);

		const top = this.scroll.scrollTop;
		const left = this.scroll.scrollLeft;
		const firstRow = Math.max(0, Math.floor((top - FRONTIER_INSET) / FRONTIER_ROW_HEIGHT));
		const endRow = Math.ceil((top + height - FRONTIER_INSET) / FRONTIER_ROW_HEIGHT);
		const firstColumn = 1 + Math.max(0, Math.floor((left + band - bodyLeft) / FRONTIER_COLUMN_WIDTH));
		const endColumn = Math.min(columns.length, 1 + Math.ceil((left + width - bodyLeft) / FRONTIER_COLUMN_WIDTH));
		/** @type {function(!FrontierCell):number} */
		const x = (cell) => cell.column === 0 ? band :
			bodyLeft + (cell.column - 0.5) * FRONTIER_COLUMN_WIDTH - left;
		/** @type {function(!FrontierCell):number} */
		const y = (cell) => FRONTIER_INSET + (cell.row + 0.5) *
			(cell.column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT) - top;

		/** @type {!Array<?FrontierMark>} */
		const expected = expectedColumn.slice(
			Math.max(0, Math.floor((top - FRONTIER_INSET) / FRONTIER_EXPECTED_HEIGHT)),
			Math.ceil((top + height - FRONTIER_INSET) / FRONTIER_EXPECTED_HEIGHT),
		);
		/** @type {!Array<!FrontierMark>} */
		const visible = [];
		for (let column = firstColumn; column < endColumn; column++) {
			const marks = columns[column];
			const end = Math.min(endRow, marks.length);
			for (let row = firstRow; row < end; row++) {
				const mark = marks[row];
				if (mark) visible.push(mark);
			}
		}
		/** @type {!Set<!FrontierMark>} */
		const visibleMarks = new Set(visible);
		for (const mark of expected) {
			if (mark) visibleMarks.add(mark);
		}
		const selected = this.selected_;
		const canvasStyle = getComputedStyle(this.canvas);
		const foreground = canvasStyle.color;
		const primary = new Path2D();
		const shared = new Path2D();
		const highlighted = new Path2D();
		/** @type {function(!FrontierMark, !FrontierMark):void} */
		const addEdge = (parent, child) => {
			const from = cells.get(parent);
			const to = cells.get(child);
			if (!from || !to) return;
			const active = selected === parent || selected === child;
			const fromX = x(from);
			const toX = x(to);
			const path = active ? highlighted : parents.get(child)?.[0] === parent ? primary : shared;
			const sourceY = y(from);
			const targetY = y(to);
			const midpoint = (fromX + toX) / 2;
			path.moveTo(fromX, sourceY);
			path.bezierCurveTo(midpoint, sourceY, midpoint, targetY, toX, targetY);
		};
		for (const mark of visibleMarks) {
			for (const child of children.get(mark) || []) addEdge(mark, child);
			for (const parent of parents.get(mark) || []) {
				if (!visibleMarks.has(parent)) addEdge(parent, mark);
			}
		}
		/** @type {function(!FrontierMark):void} */
		const paintMark = (mark) => {
			const cell = cells.get(mark);
			if (!cell) return;
			const mx = x(cell);
			const my = y(cell);
			context.strokeStyle = foreground;
			context.globalAlpha = 0.6;
			context.fillStyle = mark.color;
			context.strokeRect(mx - 4, my - 4, 8, 8);
			context.globalAlpha = 1;
			context.fillRect(mx - 3.5, my - 3.5, 7, 7);
			if (mark === selected) context.strokeRect(mx - 6, my - 6, 12, 12);
		};

		context.save();
		context.beginPath();
		context.rect(band, 0, width - band, height);
		context.clip();
		context.strokeStyle = foreground;
		context.globalAlpha = 0.35;
		context.stroke(primary);
		context.globalAlpha = 0.24;
		context.setLineDash([2, 3]);
		context.stroke(shared);
		context.setLineDash([]);
		context.globalAlpha = 0.85;
		context.stroke(highlighted);
		for (const mark of visible) paintMark(mark);
		context.restore();
		if (band) {
			const now = this.progress_?.frontierNow() ?? 0;
			context.fillStyle = foreground;
			context.globalAlpha = 0.2;
			context.fillRect(band - 1, 0, 1, height);
			context.textBaseline = "top";
			for (const mark of expected) {
				if (!mark) continue;
				const cell = cells.get(mark);
				if (!cell) continue;
				const center = y(cell);
				const start = FRONTIER_INSET;
				const cardWidth = band - start - 8;
				const cardTop = center - 22;
				context.fillStyle = foreground;
				context.globalAlpha = mark === selected ? 0.16 : 0.06;
				context.fillRect(start, cardTop, cardWidth, 44);
				context.strokeStyle = mark === selected ? foreground : mark.color;
				context.globalAlpha = mark === selected ? 1 : 0.55;
				context.strokeRect(start + 0.5, cardTop + 0.5, cardWidth - 1, 43);
				context.globalAlpha = 0.35;
				context.strokeStyle = foreground;
				context.beginPath();
				context.moveTo(start + cardWidth, center);
				context.lineTo(band, center);
				context.stroke();

				const label = expectedFrontierLabel(mark.id);
				const age = frontierWait(mark, now);
				const timer = age === null ? "—" : formatFrontierWait(age);
				context.fillStyle = foreground;
				context.globalAlpha = 1;
				context.font = "12px monospace";
				context.textAlign = "right";
				context.fillText(timer, start + cardWidth - 8, cardTop + 6);
				const timerWidth = context.measureText(timer).width;
				context.textAlign = "left";
				context.font = "600 12px " + canvasStyle.fontFamily;
				context.fillText(fitFrontierLabel(context, label.type, cardWidth - timerWidth - 24), start + 8, cardTop + 6);
				context.font = "12px " + canvasStyle.fontFamily;
				context.globalAlpha = 0.8;
				context.fillText(fitFrontierLabel(context, label.detail, cardWidth - 16), start + 8, cardTop + 24);
			}
			context.globalAlpha = 1;
		}
		if (progress) this.readers_.update(progress.history, firstNewMark, (mark) => {
			const cell = departures.get(mark);
			if (!cell) return null;
			const mx = x(cell);
			const my = y(cell);
			return mx >= band && mx < width && my >= 0 && my < height ? {x: mx, y: my} : null;
		});
		if (previous) {
			const oldBand = previous.columns[0].length
				? Math.min(FRONTIER_EXPECTED_WIDTH, Math.floor(width * 0.58)) : 0;
			previous.cells.forEach((cell, mark) => {
				if (cell.column === 0 || cells.has(mark) || suppressed.has(mark) || !mark.event?.hasProgress()) return;
				const mx = oldBand + FRONTIER_INSET + (cell.column - 0.5) * FRONTIER_COLUMN_WIDTH - left;
				const my = y(cell);
				if (mx >= oldBand && mx < width && my >= 0 && my < height) this.readers_.fadeProgress({x: mx, y: my}, mark.color);
			});
		}
		departures.forEach((cell, mark) => {
			if (!mark.event?.hasProgress() || previous?.cells.has(mark)) return;
			const mx = x(cell);
			const my = y(cell);
			if (mx >= band && mx < width && my >= 0 && my < height) this.readers_.fadeProgress({x: mx, y: my}, mark.color);
		});
	}

	/**
	 * @param {!MouseEvent} event
	 * @return {?FrontierMark}
	 */
	pick(event) {
		const bounds = this.canvas.getBoundingClientRect();
		const x = event.clientX - bounds.left;
		const y = event.clientY - bounds.top;
		const band = this.expectedWidth_();
		const expected = x < band;
		const column = expected ? 0 : 1 + Math.floor((x + this.scroll.scrollLeft - band - FRONTIER_INSET) /
			FRONTIER_COLUMN_WIDTH);
		if (!expected && column < 1) return null;
		const row = Math.floor((y + this.scroll.scrollTop - FRONTIER_INSET) /
			(expected ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT));
		return this.markAt_(column, row);
	}

	/** @param {!FrontierMark} mark */
	select(mark) {
		this.selected_ = mark;
		this.inspect(mark);
		this.draw();
	}

	/** @param {!KeyboardEvent} event */
	navigate(event) {
		const key = event.key;
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
		event.preventDefault();
		const current = this.selected_ && this.layout_.cells.get(this.selected_);
		let mark = this.markAt_(0, 0) || this.markAt_(1, 0) || this.markAt_(1, 1);
		if (key === "End") {
			const root = this.progress_?.history[0];
			const lastColumn = this.layout_.columns.length - 1;
			mark = root && this.layout_.cells.has(root) ? root
				: this.markAt_(lastColumn, 0) || this.markAt_(lastColumn, 1) || mark;
		} else if (current && key !== "Home") {
			let {column, row} = current;
			switch (key) {
				case "ArrowLeft": column--; break;
				case "ArrowRight": column++; break;
				case "ArrowUp": row--; break;
				case "ArrowDown": row++; break;
			}
			if (column !== current.column && this.layout_.columns[column]) {
				const previousHeight = current.column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT;
				const nextHeight = column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT;
				row = Math.min(Math.floor((row + 0.5) * previousHeight / nextHeight),
					this.layout_.columns[column].length - 1);
			}
			mark = this.markAt_(column, row);
			if (!mark && column !== current.column && row === 0) mark = this.markAt_(column, 1);
		}
		if (!mark) return;
		const cell = this.layout_.cells.get(mark);
		if (!cell) return;
		const band = this.expectedWidth_();
		if (key === "Home") this.scroll.scrollLeft = 0;
		if (cell.column > 0) {
			const left = band + FRONTIER_INSET + (cell.column - 1) * FRONTIER_COLUMN_WIDTH;
			if (left < this.scroll.scrollLeft + band) this.scroll.scrollLeft = left - band;
			else if (left + FRONTIER_COLUMN_WIDTH > this.scroll.scrollLeft + this.scroll.clientWidth) {
				this.scroll.scrollLeft = left + FRONTIER_COLUMN_WIDTH - this.scroll.clientWidth;
			}
		}
		const rowHeight = cell.column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT;
		const top = FRONTIER_INSET + cell.row * rowHeight;
		if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
		else if (top + rowHeight > this.scroll.scrollTop + this.scroll.clientHeight) {
			this.scroll.scrollTop = top + rowHeight - this.scroll.clientHeight;
		}
		this.select(mark);
	}
}

/**
 * @param {!FrontierMark} mark
 * @return {string}
 */
function frontierMarkLabel(mark) {
	const action = mark.event && mark.event.getAction();
	const mnemonic = action && action.getType();
	const label = buildEventIdSummary(mark.id);
	return (mnemonic ? mnemonic + " · " : "") + label;
}

exports.expectedFrontierLabel = expectedFrontierLabel;
exports.frontierWait = frontierWait;
exports.formatFrontierWait = formatFrontierWait;
exports.layoutFrontier = layoutFrontier;
exports.frontierFlightFrames = frontierFlightFrames;
exports.FrontierActionReaders = FrontierActionReaders;
exports.InvocationFrontier = InvocationFrontier;
exports.frontierMarkLabel = frontierMarkLabel;
