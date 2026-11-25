/** @fileoverview Spawn timing rows for compact Bazel execution logs. */
goog.module("bcrfrontend.executionLogMetrics");

const Duration = goog.requireType("proto.google.protobuf.Duration");
const ExecLogEntry = goog.requireType("proto.tools.protos.ExecLogEntry");
const dom = goog.require("goog.dom");

/** @typedef {{color: string, label: string, value: number}} */
let TimingPhase;

/**
 * @typedef {{
 *   spawn: !ExecLogEntry.Spawn, start: ?number, recordedStart: ?number, total: ?number,
 * }}
 */
let SpawnTiming;

/**
 * @typedef {{
 *   rows: !Array<!SpawnTiming>, extent: number, unknownStart: number,
 *   skippedCacheStarts: number, recordedSpan: ?number, farthest: ?SpawnTiming,
 * }}
 */
let SpawnTimeline;

/**
 * @param {?Duration|undefined} duration
 * @return {?number}
 */
function millis(duration) {
	if (!duration) return null;
	const value = duration.getSeconds() * 1000 + duration.getNanos() / 1000000;
	return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * This order is a breakdown of the recorded durations. In particular, network
 * and setup can cover activity at several points during the spawn.
 * @param {?ExecLogEntry.Spawn} spawn
 * @return {!Array<!TimingPhase>}
 */
function timingPhases(spawn) {
	const metrics = spawn?.getMetrics();
	return [
		{
			color: "#9b74de",
			label: "Parse",
			value: millis(metrics?.getParseTime()) || 0,
		},
		{
			color: "#008f89",
			label: "Upload",
			value: millis(metrics?.getUploadTime()) || 0,
		},
		{
			color: "#3585dd",
			label: "Network",
			value: millis(metrics?.getNetworkTime()) || 0,
		},
		{
			color: "#d4a32b",
			label: "Queue",
			value: millis(metrics?.getQueueTime()) || 0,
		},
		{
			color: "#db7b36",
			label: "Setup",
			value: millis(metrics?.getSetupTime()) || 0,
		},
		{
			color: "#4aa45b",
			label: "Execution",
			value: millis(metrics?.getExecutionWallTime()) || 0,
		},
		{
			color: "#c263ae",
			label: "Process outputs",
			value: millis(metrics?.getProcessOutputsTime()) || 0,
		},
		{
			color: "#43a9c0",
			label: "Fetch",
			value: millis(metrics?.getFetchTime()) || 0,
		},
		{
			color: "#db615f",
			label: "Retry",
			value: millis(metrics?.getRetryTime()) || 0,
		},
		{ color: "", label: "Other", value: 0 },
	];
}

/**
 * @param {!Array<!ExecLogEntry.Spawn>} spawns
 * @return {!SpawnTimeline}
 */
function buildSpawnTimeline(spawns) {
	/** @type {!Array<!SpawnTiming>} */
	const rows = [];
	let origin = Infinity;
	let unknownStart = 0;
	let skippedCacheStarts = 0;
	for (const spawn of spawns) {
		const metrics = spawn.getMetrics();
		const timestamp = metrics?.getStartTime();
		const value = timestamp
			? timestamp.getSeconds() * 1000 + timestamp.getNanos() / 1000000
			: 0;
		const recordedStart = value > 0 && value <= 8.64e15 ? value : null;
		// Bazel can attach the original worker execution timestamp to a cache
		// hit. Its duration measures the current lookup and fetch.
		const start = spawn.getCacheHit() ? null : recordedStart;
		if (recordedStart !== null && start === null) skippedCacheStarts++;
		if (start === null) unknownStart++;
		else origin = Math.min(origin, start);
		rows.push({
			spawn,
			start,
			recordedStart,
			total: millis(metrics?.getTotalTime()),
		});
	}
	let extent = 0;
	/** @type {?number} */
	let recordedSpan = null;
	/** @type {?SpawnTiming} */
	let farthest = null;
	for (const row of rows) {
		if (row.start !== null) {
			row.start -= origin;
			const end = row.start + (row.total || 0);
			if (recordedSpan === null || end > recordedSpan) {
				recordedSpan = end;
				farthest = row;
			}
		}
		extent = Math.max(extent, (row.start || 0) + (row.total || 0));
	}
	rows.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
	return {
		rows,
		extent,
		unknownStart,
		skippedCacheStarts,
		recordedSpan,
		farthest,
	};
}

/**
 * @param {number} millis
 * @return {string}
 */
function formatTime(millis) {
	const value = Math.abs(millis);
	if (value < 1000)
		return (
			millis.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " ms"
		);
	if (value < 120000)
		return (
			(millis / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
			" s"
		);
	return (
		(millis / 60000).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
		" min"
	);
}

/** @param {!HTMLElement} list */
function renderTimingLegend(list) {
	for (const phase of timingPhases(null)) {
		list.appendChild(
			dom.createDom(
				"li",
				"d-flex flex-items-center",
				dom.createDom("span", {
					"class": "execution-log-metrics-swatch",
					"style": phase.color ? "background-color:" + phase.color : "",
					"aria-hidden": "true",
				}),
				phase.label,
			),
		);
	}
}

const RULER_HEIGHT = 29;
const LANE_HEIGHT = 24;
const LEFT_PAD = 12;
const RIGHT_PAD = 12;

/**
 * @param {!SpawnTiming} row
 * @return {string}
 */
function spawnName(row) {
	const name = row.spawn.getMnemonic() || "Spawn";
	const target = row.spawn.getTargetLabel();
	return target ? name + " · " + target : name;
}

/**
 * @param {!SpawnTiming} row
 * @return {{phases: !Array<!TimingPhase>, width: number, scaled: boolean}}
 */
function phaseBreakdown(row) {
	const phases = timingPhases(row.spawn);
	let reported = 0;
	for (const phase of phases) reported += phase.value;
	const total = row.total || 0;
	phases[phases.length - 1].value = Math.max(0, total - reported);
	return {
		phases,
		width: Math.max(total, reported),
		scaled: row.total !== null && reported > total,
	};
}

/**
 * @param {!SpawnTiming} row
 * @return {string}
 */
function describeSpawn(row) {
	const breakdown = phaseBreakdown(row);
	const fields = [
		spawnName(row),
		row.start === null
			? "Start unavailable for this invocation"
			: "Start " + formatTime(row.start),
		row.total === null
			? "Wall time unavailable"
			: "Wall time " + formatTime(row.total),
	];
	if (row.recordedStart !== null) {
		const label =
			row.start === null ? "Cached execution started " : "Recorded start ";
		fields.push(label + new Date(row.recordedStart).toISOString());
	}
	for (const phase of breakdown.phases) {
		if (phase.value > 0)
			fields.push(phase.label + " " + formatTime(phase.value));
	}
	if (breakdown.scaled) fields.push("Phase widths scaled to fit wall time");
	return fields.join(" · ");
}

/**
 * @param {number} span
 * @param {number} width
 * @return {number}
 */
function tickStep(span, width) {
	const estimate = span / Math.max(2, Math.floor(width / 90));
	const power = 10 ** Math.floor(Math.log10(estimate));
	const ratio = estimate / power;
	return power * (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 5 ? 5 : 10);
}

class SpawnWaterfall {
	/**
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!HTMLElement} viewport
	 * @param {!HTMLElement} readout
	 */
	constructor(canvas, viewport, readout) {
		/** @private @const */
		this.canvas_ = canvas;
		/** @private @const */
		this.viewport_ = viewport;
		/** @private @const */
		this.readout_ = readout;
		/** @private {?SpawnTimeline} */
		this.timeline_ = null;
		/** @private {number} */
		this.extent_ = 1;
		/** @private {number} */
		this.span_ = 1;
		/** @private {number} */
		this.offset_ = 0;
		/** @private {number} */
		this.selected_ = -1;
		/** @private {number} */
		this.hover_ = -1;
		/** @private {number} */
		this.frame_ = 0;
		/** @private {?{id: number, x: number, dragged: boolean}} */
		this.pointer_ = null;
	}

	/**
	 * @param {?SpawnTimeline} timeline
	 * @param {number} extent
	 */
	setTimeline(timeline, extent) {
		if (this.timeline_ === timeline && this.extent_ === extent) {
			this.draw();
			return;
		}
		this.timeline_ = timeline;
		this.extent_ = extent;
		this.viewport_.style.setProperty(
			"--waterfall-content-height",
			RULER_HEIGHT + this.bandCount_() * LANE_HEIGHT + "px",
		);
		this.viewport_.scrollTop = 0;
		this.selected_ = -1;
		this.clearHover();
		this.readout_.hidden = true;
		this.readout_.textContent = "";
		this.fit();
	}

	fit() {
		this.span_ = this.extent_;
		this.offset_ = 0;
		this.draw();
	}

	/**
	 * @param {number} factor
	 * @param {number=} anchor
	 */
	zoom(factor, anchor = 0.5) {
		const position = Math.max(0, Math.min(anchor, 1));
		const next = Math.min(
			this.extent_,
			Math.max(Math.min(0.05, this.extent_), this.span_ / factor),
		);
		const pivot = this.offset_ + this.span_ * position;
		this.span_ = next;
		this.setOffset_(pivot - next * position);
	}

	/**
	 * @param {!WheelEvent} event
	 * @return {boolean}
	 */
	wheel(event) {
		if (event.ctrlKey || event.metaKey) {
			const ratio = (event.offsetX - LEFT_PAD) / this.plotWidth_();
			this.zoom(event.deltaY < 0 ? 1.25 : 0.8, ratio);
		} else if (
			event.shiftKey ||
			Math.abs(event.deltaX) > Math.abs(event.deltaY)
		) {
			const delta = event.deltaX || event.deltaY;
			this.setOffset_(this.offset_ + (delta * this.span_) / this.plotWidth_());
		} else {
			return false;
		}
		return true;
	}

	/** @param {!PointerEvent} event */
	start(event) {
		if (event.button !== 0 || this.pointer_ || event.offsetY < RULER_HEIGHT)
			return;
		this.canvas_.setPointerCapture(event.pointerId);
		this.pointer_ = { id: event.pointerId, x: event.clientX, dragged: false };
	}

	/** @param {!PointerEvent} event */
	move(event) {
		const pointer = this.pointer_;
		if (pointer && pointer.id === event.pointerId) {
			const delta = event.clientX - pointer.x;
			if (!pointer.dragged && Math.abs(delta) < 4) return;
			pointer.dragged = true;
			pointer.x = event.clientX;
			this.clearHover();
			this.setOffset_(this.offset_ - (delta * this.span_) / this.plotWidth_());
			return;
		}
		const row = this.bandAt_(event.offsetY);
		if (this.hover_ === row) return;
		this.hover_ = row;
		const spawn = this.rowAt_(row);
		this.canvas_.title = spawn ? describeSpawn(spawn) : "";
		this.draw();
	}

	/** @param {!PointerEvent} event */
	end(event) {
		const pointer = this.pointer_;
		if (!pointer || pointer.id !== event.pointerId) return;
		this.pointer_ = null;
		if (!pointer.dragged && event.type === "pointerup")
			this.select_(this.bandAt_(event.offsetY), false);
	}

	clearHover() {
		this.hover_ = -1;
		this.canvas_.title = "";
		this.draw();
	}

	/**
	 * @param {string} key
	 * @return {boolean}
	 */
	key(key) {
		if (!this.bandCount_()) return false;
		const perPage = Math.max(
			1,
			Math.floor((this.canvas_.clientHeight - RULER_HEIGHT) / LANE_HEIGHT),
		);
		switch (key) {
			case "ArrowUp":
				this.moveSelection_(-1);
				break;
			case "ArrowDown":
				this.moveSelection_(1);
				break;
			case "PageUp":
				this.moveSelection_(-perPage);
				break;
			case "PageDown":
				this.moveSelection_(perPage);
				break;
			case "ArrowLeft":
				this.setOffset_(this.offset_ - this.span_ / 5);
				break;
			case "ArrowRight":
				this.setOffset_(this.offset_ + this.span_ / 5);
				break;
			case "+":
			case "=":
				this.zoom(1.5);
				break;
			case "-":
				this.zoom(1 / 1.5);
				break;
			default:
				return false;
		}
		return true;
	}

	dispose() {
		cancelAnimationFrame(this.frame_);
		this.frame_ = 0;
		this.pointer_ = null;
	}

	draw() {
		if (this.frame_) return;
		this.frame_ = requestAnimationFrame(() => {
			this.frame_ = 0;
			this.paint_();
		});
	}

	/**
	 * @private
	 * @return {number}
	 */
	bandCount_() {
		const timeline = this.timeline_;
		return timeline
			? timeline.rows.length + (timeline.unknownStart ? 1 : 0)
			: 0;
	}

	/**
	 * @private
	 * @return {number}
	 */
	divider_() {
		const timeline = this.timeline_;
		return timeline?.unknownStart
			? timeline.rows.length - timeline.unknownStart
			: -1;
	}

	/**
	 * @private
	 * @param {number} band
	 * @return {?SpawnTiming}
	 */
	rowAt_(band) {
		const divider = this.divider_();
		if (band < 0 || band === divider) return null;
		const index = divider >= 0 && band > divider ? band - 1 : band;
		return this.timeline_?.rows[index] || null;
	}

	/**
	 * @private
	 * @param {number} y
	 * @return {number}
	 */
	bandAt_(y) {
		return y < RULER_HEIGHT
			? -1
			: Math.floor((this.viewport_.scrollTop + y - RULER_HEIGHT) / LANE_HEIGHT);
	}

	/**
	 * @private
	 * @return {number}
	 */
	plotWidth_() {
		return Math.max(1, this.canvas_.clientWidth - LEFT_PAD - RIGHT_PAD);
	}

	/**
	 * @private
	 * @param {number} offset
	 */
	setOffset_(offset) {
		this.offset_ = Math.max(0, Math.min(this.extent_ - this.span_, offset));
		this.draw();
	}

	/**
	 * @private
	 * @param {number} delta
	 */
	moveSelection_(delta) {
		const total = this.bandCount_();
		let band =
			this.selected_ < 0
				? Math.floor(this.viewport_.scrollTop / LANE_HEIGHT)
				: Math.max(0, Math.min(total - 1, this.selected_ + delta));
		if (band === this.divider_()) {
			band += delta < 0 && band > 0 ? -1 : 1;
		}
		this.select_(band, true);
	}

	/**
	 * @private
	 * @param {number} band
	 * @param {boolean} reveal
	 */
	select_(band, reveal) {
		const row = this.rowAt_(band);
		if (!row) return;
		this.selected_ = band;
		this.readout_.textContent = describeSpawn(row);
		this.readout_.hidden = false;
		if (reveal) {
			const top = band * LANE_HEIGHT;
			const lower =
				this.viewport_.scrollTop + this.canvas_.clientHeight - RULER_HEIGHT;
			if (top < this.viewport_.scrollTop) this.viewport_.scrollTop = top;
			else if (top + LANE_HEIGHT > lower) {
				this.viewport_.scrollTop += top + LANE_HEIGHT - lower;
			}
		}
		this.draw();
	}

	/** @private */
	paint_() {
		const canvas = this.canvas_;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		const ctx = /** @type {?CanvasRenderingContext2D} */ (
			canvas.getContext("2d")
		);
		if (!ctx || !width || !height) return;
		const ratio = window.devicePixelRatio || 1;
		const pixelsWide = Math.round(width * ratio);
		const pixelsHigh = Math.round(height * ratio);
		if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
		if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		const style = getComputedStyle(canvas);
		const paper = style.getPropertyValue("--waterfall-paper").trim();
		const ruler = style.getPropertyValue("--waterfall-ruler").trim();
		const line = style.getPropertyValue("--waterfall-line").trim();
		const muted = style.getPropertyValue("--waterfall-muted").trim();
		const accent = style.getPropertyValue("--waterfall-highlight").trim();
		ctx.fillStyle = paper;
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = ruler;
		ctx.fillRect(0, 0, width, RULER_HEIGHT);
		const plotWidth = this.plotWidth_();
		const factor = plotWidth / this.span_;
		const step = tickStep(this.span_, plotWidth);
		const firstTick = Math.ceil(this.offset_ / step) * step;
		const lastTick = this.offset_ + this.span_;
		ctx.font = "11px " + style.fontFamily;
		ctx.fillStyle = line;
		ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
		for (let tick = firstTick; tick <= lastTick + step * 1e-8; tick += step) {
			const x = LEFT_PAD + (tick - this.offset_) * factor;
			ctx.fillStyle = line;
			ctx.fillRect(
				Math.round(x),
				RULER_HEIGHT - 7,
				1,
				height - RULER_HEIGHT + 7,
			);
			ctx.fillStyle = muted;
			const label = formatTime(tick);
			ctx.fillText(
				label,
				Math.min(x + 3, width - ctx.measureText(label).width - 3),
				16,
			);
		}
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, RULER_HEIGHT, width, Math.max(0, height - RULER_HEIGHT));
		ctx.clip();
		const scroll = this.viewport_.scrollTop;
		const first = Math.floor(scroll / LANE_HEIGHT);
		const last = Math.min(
			this.bandCount_(),
			first + Math.ceil(height / LANE_HEIGHT) + 1,
		);
		const divider = this.divider_();
		for (let band = first; band < last; band++) {
			const y = RULER_HEIGHT + band * LANE_HEIGHT - scroll;
			if (band === divider) {
				ctx.fillStyle = ruler;
				ctx.fillRect(0, y, width, LANE_HEIGHT);
				ctx.fillStyle = muted;
				ctx.fillText(
					"Start time unavailable · duration only",
					LEFT_PAD,
					y + 16,
				);
				continue;
			}
			const row = this.rowAt_(band);
			if (!row) continue;
			if (band === this.selected_ || band === this.hover_) {
				ctx.fillStyle = accent;
				ctx.fillRect(0, y, width, LANE_HEIGHT);
			}
			const x = LEFT_PAD + ((row.start || 0) - this.offset_) * factor;
			const barWidth = (row.total || 0) * factor;
			if (x + barWidth < LEFT_PAD || x > width - RIGHT_PAD) continue;
			if (row.total === null || row.total === 0) {
				ctx.fillStyle = muted;
				ctx.fillRect(Math.max(LEFT_PAD, x), y + 9, 1, 7);
			} else {
				const breakdown = phaseBreakdown(row);
				let position = x;
				for (const phase of breakdown.phases) {
					if (!phase.value) continue;
					const next = position + (barWidth * phase.value) / breakdown.width;
					const start = Math.max(LEFT_PAD, position);
					const end = Math.min(width - RIGHT_PAD, next);
					if (end > start) {
						ctx.fillStyle = phase.color || muted;
						ctx.globalAlpha = row.start === null ? 0.55 : 0.85;
						ctx.fillRect(start, y + 7, end - start, 10);
					}
					position = next;
				}
				ctx.globalAlpha = 1;
				if (barWidth < 1) {
					ctx.fillStyle =
						breakdown.phases.find((phase) => phase.value > 0)?.color || muted;
					ctx.fillRect(Math.max(LEFT_PAD, x), y + 7, 1, 10);
				}
			}
			const labelX = Math.min(
				Math.max(LEFT_PAD, x) + 4,
				width - Math.min(165, width / 2),
			);
			ctx.fillStyle = style.color;
			ctx.globalAlpha = 0.76;
			ctx.fillText(
				spawnName(row),
				labelX,
				y + 16,
				Math.min(430, width - labelX - 5),
			);
			ctx.globalAlpha = 1;
		}
		ctx.restore();
	}
}

/**
 * @param {!SpawnTimeline} timeline
 * @return {string}
 */
function timingExtentDetails(timeline) {
	const first = timeline.rows[0];
	const last = timeline.farthest;
	if (
		!first ||
		first.start === null ||
		first.recordedStart === null ||
		!last ||
		last.start === null
	)
		return "";
	const start =
		"First plotted start: " +
		spawnName(first) +
		" at " +
		new Date(first.recordedStart).toISOString();
	const end =
		"Farthest plotted end: " +
		spawnName(last) +
		" at +" +
		formatTime(last.start + (last.total || 0));
	return start + "\n" + end;
}

exports = {
	SpawnTimeline,
	SpawnWaterfall,
	buildSpawnTimeline,
	formatTime,
	renderTimingLegend,
	timingExtentDetails,
};
