/** @fileoverview Timeline for local Bazel JSON trace profiles. */
goog.module("bcrfrontend.CommandProfile");

const { createDom } = goog.require("goog.dom");
const DomHelper = goog.requireType("goog.dom.DomHelper");
const FileDropHandler = goog.require("goog.events.FileDropHandler");
const { BrowserEvent } = goog.requireType("goog.events");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { gzipDecode } = goog.require("bcrfrontend.common");
const { commandProfile } = goog.require("soy.bcrfrontend.commandProfile");

const MAX_BYTES = 128 * 1024 * 1024;
const ROW_HEIGHT = 30;
const COLORS = [
	"#3277c6",
	"#23866b",
	"#a36db9",
	"#a9642b",
	"#b65071",
	"#467b95",
];

/** @typedef {!Object<string, *>} */
let Record;

/** @typedef {{name: string, category: string, start: number, end: number, args: *, value: ?number}} */
let TraceEvent;

/** @typedef {{name: string, counter: boolean, events: !Array<!TraceEvent>, ends: !Array<number>, low: number, high: number}} */
let Track;

/** @typedef {{start: number, end: number, count: number, tracks: !Array<!Track>}} */
let Profile;

/** @typedef {{track: !Track, event: !TraceEvent, left: number, right: number, top: number}} */
let Mark;

/**
 * @param {*} data
 * @return {!Profile}
 */
function readProfile(data) {
	const document = /** @type {?Record} */ (data);
	if (!Array.isArray(document?.["traceEvents"]))
		throw new Error("This file does not contain Bazel JSON trace events.");
	const events = /** @type {!Array<!Record>} */ (document["traceEvents"]);
	/** @type {!Map<string, string>} */
	const names = new Map();
	for (const entry of events) {
		if (entry?.["ph"] !== "M" || entry["name"] !== "thread_name") continue;
		const args = /** @type {?Record} */ (entry["args"]);
		if (typeof args?.["name"] === "string")
			names.set(
				String(entry["pid"]) + ":" + String(entry["tid"]),
				String(args["name"]),
			);
	}

	/** @type {!Map<string, !Track>} */
	const tracks = new Map();
	/** @type {number} */
	let start = Infinity;
	/** @type {number} */
	let end = -Infinity;
	let count = 0;
	/**
	 * @param {string} key
	 * @param {string} label
	 * @param {!TraceEvent} event
	 */
	const add = (key, label, event) => {
		let track = tracks.get(key);
		if (!track) {
			track = {
				name: label,
				counter: event.value !== null,
				events: [],
				ends: [],
				low: Infinity,
				high: -Infinity,
			};
			tracks.set(key, track);
		}
		track.events.push(event);
		if (event.value !== null) {
			track.low = Math.min(track.low, event.value);
			track.high = Math.max(track.high, event.value);
		}
		start = Math.min(start, event.start);
		end = Math.max(end, event.end);
		count++;
	};

	for (const entry of events) {
		if (
			!entry ||
			typeof entry["ts"] !== "number" ||
			!Number.isFinite(entry["ts"])
		)
			continue;
		const phase = String(entry["ph"]);
		const name = String(entry["name"] || "Unnamed event");
		const at = Number(entry["ts"]);
		const thread = String(entry["pid"]) + ":" + String(entry["tid"]);
		const event = {
			name,
			category: String(entry["cat"] || ""),
			start: at,
			end: at,
			args: entry["args"],
			value: null,
		};
		if (phase === "C") {
			const values = /** @type {?Record} */ (entry["args"]);
			for (const series of Object.keys(values || {})) {
				const value = values?.[series];
				if (typeof value !== "number" || !Number.isFinite(value)) continue;
				const label = name === series ? name : name + " · " + series;
				add("counter:" + thread + ":" + label, label, {
					name,
					start: at,
					end: at,
					category: event.category,
					args: event.args,
					value,
				});
			}
		} else if (["X", "I", "i"].includes(phase)) {
			const duration =
				typeof entry["dur"] === "number"
					? Math.max(0, Number(entry["dur"]))
					: 0;
			event.end = phase === "X" ? at + duration : at;
			if (Number.isFinite(event.end))
				add(
					thread,
					names.get(thread) || "Thread " + String(entry["tid"] ?? "—"),
					event,
				);
		}
	}
	if (!count) throw new Error("The profile has no supported timed events.");
	/** @type {!Array<!Track>} */
	const ordered = Array.from(tracks.values());
	/** @type {function(!Track):number} */
	const priority = (track) =>
		track.name === "Main Thread"
			? 0
			: track.name === "Critical Path"
				? 1
				: track.counter
					? 2
					: 3;
	ordered.sort(
		(a, b) =>
			priority(a) - priority(b) ||
			a.name.localeCompare(b.name, undefined, { numeric: true }),
	);
	for (const track of ordered) indexTrack(track);
	return { tracks: ordered, start, end: Math.max(start + 1, end), count };
}

/** @param {!Track} track */
function indexTrack(track) {
	track.events.sort((a, b) => a.start - b.start || b.end - a.end);
	let end = -Infinity;
	track.ends = track.events.map((event) => (end = Math.max(end, event.end)));
}

/**
 * @param {!Array<number>} ends
 * @param {number} start
 * @return {number}
 */
function firstVisible(ends, start) {
	let lo = 0;
	let hi = ends.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (ends[mid] < start) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * @param {number} micros
 * @return {string}
 */
function timeText(micros) {
	if (micros >= 1e6)
		return (
			(micros / 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 }) +
			" s"
		);
	if (micros >= 1e3)
		return (
			(micros / 1e3).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
			" ms"
		);
	return Math.round(micros) + " µs";
}

/**
 * @param {string} text
 * @return {string}
 */
function color(text) {
	let hash = 0;
	for (let index = 0; index < text.length; index++)
		hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
	return COLORS[hash % COLORS.length];
}

class CommandProfile extends Component {
	/** @param {?DomHelper=} dom */
	constructor(dom) {
		super(dom);
		/** @private {?Profile} */
		this.profile_ = null;
		/** @private {!Array<!Track>} */
		this.tracks_ = [];
		/** @private {!Array<!Mark>} */
		this.marks_ = [];
		/** @private {!Array<{track: !Track, event: !TraceEvent}>} */
		this.longest_ = [];
		/** @private {?TraceEvent} */
		this.selected_ = null;
		this.generation_ = 0;
		this.zoom_ = 1;
		this.frame_ = 0;
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(commandProfile));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const handler = this.getHandler();
		const content = this.field_("drop").parentElement;
		const file = /** @type {!HTMLInputElement} */ (this.field_("file"));
		const drop = new FileDropHandler(/** @type {!Element} */ (content), true);
		this.registerDisposable(drop);
		for (const key of /** @type {!Array<string>} */ (["choose", "replace"]))
			handler.listen(this.field_(key), "click", () => file.click());
		handler.listen(file, "change", () => {
			const selected = file.files?.[0];
			file.value = "";
			if (selected) void this.load_(selected);
		});
		handler.listen(content, "dragenter", (/** !BrowserEvent */ event) => {
			const drag = /** @type {!DragEvent} */ (event.getBrowserEvent());
			if (drag.dataTransfer?.types.includes("Files"))
				content.classList.add("is-dragging");
		});
		handler.listen(content, "dragleave", (/** !BrowserEvent */ event) => {
			if (!content.contains(/** @type {?Node} */ (event.relatedTarget)))
				content.classList.remove("is-dragging");
		});
		handler.listen(
			drop,
			FileDropHandler.EventType.DROP,
			(/** !BrowserEvent */ event) => {
				content.classList.remove("is-dragging");
				const drag = /** @type {!DragEvent} */ (event.getBrowserEvent());
				const selected = drag.dataTransfer?.files[0];
				if (selected) void this.load_(selected);
			},
		);
		handler.listen(this.field_("search"), "input", () => this.filter_());
		handler.listen(this.field_("position"), "input", () => this.schedule_());
		handler.listen(this.field_("viewport"), "scroll", () => this.schedule_());
		handler.listen(window, "resize", () => this.schedule_());
		handler.listen(this.field_("zoom-in"), "click", () => this.zoomBy_(2));
		handler.listen(this.field_("zoom-out"), "click", () => this.zoomBy_(0.5));
		handler.listen(this.field_("reset"), "click", () => this.zoomBy_(0));
		handler.listen(this.field_("events"), "change", () => {
			const input = /** @type {!HTMLSelectElement} */ (this.field_("events"));
			const selected = this.longest_[Number(input.value)];
			if (input.value && selected)
				this.showEvent_(selected.track, selected.event);
		});
		handler.listen(
			this.field_("canvas"),
			"click",
			(/** !BrowserEvent */ event) => {
				const rect = this.field_("canvas").getBoundingClientRect();
				const x = event.clientX - rect.left;
				const y = event.clientY - rect.top;
				for (let index = this.marks_.length - 1; index >= 0; index--) {
					const mark = this.marks_[index];
					if (
						x >= mark.left &&
						x <= mark.right &&
						y >= mark.top &&
						y < mark.top + ROW_HEIGHT
					) {
						this.showEvent_(mark.track, mark.event);
						break;
					}
				}
			},
		);
	}

	/** @override */
	exitDocument() {
		this.generation_++;
		cancelAnimationFrame(this.frame_);
		this.frame_ = 0;
		super.exitDocument();
	}

	/**
	 * @private
	 * @param {string} name
	 * @return {!HTMLElement}
	 */
	field_(name) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector('[data-profile="' + name + '"]')
		);
	}

	/**
	 * @private
	 * @param {!File} file
	 */
	async load_(file) {
		const generation = ++this.generation_;
		const status = this.field_("status");
		status.textContent = "Reading " + file.name + "…";
		status.classList.remove("color-fg-danger");
		try {
			if (file.size > MAX_BYTES)
				throw new Error("Choose a profile smaller than 128 MiB.");
			let bytes = new Uint8Array(await file.arrayBuffer());
			if (bytes[0] === 0x1f && bytes[1] === 0x8b)
				bytes = await gzipDecode(bytes, MAX_BYTES);
			if (generation !== this.generation_) return;
			const profile = readProfile(JSON.parse(new TextDecoder().decode(bytes)));
			this.profile_ = profile;
			this.zoom_ = 1;
			/** @type {!HTMLInputElement} */ (this.field_("position")).value = "0";
			/** @type {!HTMLInputElement} */ (this.field_("search")).value = "";
			status.textContent =
				file.name +
				" · " +
				timeText(profile.end - profile.start) +
				" · " +
				profile.count.toLocaleString() +
				" events · " +
				profile.tracks.length +
				" tracks";
			this.field_("drop").hidden = true;
			this.field_("viewer").hidden = false;
			this.filter_();
		} catch (/** @type {*} */ error) {
			if (generation !== this.generation_) return;
			status.textContent =
				"Could not open " +
				file.name +
				". " +
				(error instanceof Error
					? error.message
					: "Choose a Bazel JSON trace profile.");
			status.classList.add("color-fg-danger");
		}
	}

	/** @private */
	filter_() {
		if (!this.profile_) return;
		const search = /** @type {!HTMLInputElement} */ (this.field_("search"));
		const query = search.value.trim().toLowerCase();
		this.tracks_ = [];
		this.longest_ = [];
		for (const original of this.profile_.tracks) {
			let track = original;
			if (query && !original.name.toLowerCase().includes(query)) {
				const events = original.events.filter(
					(event) =>
						event.name.toLowerCase().includes(query) ||
						event.category.toLowerCase().includes(query),
				);
				if (!events.length) continue;
				track = {
					name: original.name,
					counter: original.counter,
					low: original.low,
					high: original.high,
					events,
					ends: [],
				};
				indexTrack(track);
			}
			this.tracks_.push(track);
			if (track.counter) continue;
			const longest = track.events
				.filter((event) => event.end > event.start)
				.sort((a, b) => b.end - b.start - (a.end - a.start))
				.slice(0, 25);
			for (const event of longest) this.longest_.push({ track, event });
		}
		this.longest_.sort(
			(a, b) => b.event.end - b.event.start - (a.event.end - a.event.start),
		);
		this.longest_.length = Math.min(this.longest_.length, 25);
		const picker = /** @type {!HTMLSelectElement} */ (this.field_("events"));
		picker.replaceChildren(
			createDom("option", { "value": "" }, "Select an event"),
		);
		this.longest_.forEach(({ event }, index) =>
			picker.add(
				/** @type {!HTMLOptionElement} */ (
					createDom(
						"option",
						{ "value": String(index) },
						timeText(event.end - event.start) + " · " + event.name,
					)
				),
			),
		);
		picker.disabled = !this.longest_.length;
		this.selected_ = null;
		this.field_("detail").hidden = true;
		this.field_("viewport").scrollTop = 0;
		this.field_("empty").hidden = this.tracks_.length > 0;
		this.field_("timeline").hidden = !this.tracks_.length;
		this.field_("space").style.height = this.tracks_.length * ROW_HEIGHT + "px";
		this.schedule_();
	}

	/** @private @param {number} factor */
	zoomBy_(factor) {
		const position = /** @type {!HTMLInputElement} */ (this.field_("position"));
		const oldSpan = 1 / this.zoom_;
		const center =
			(Number(position.value) / 1000) * (1 - oldSpan) + oldSpan / 2;
		this.zoom_ = factor ? Math.max(1, Math.min(this.zoom_ * factor, 1024)) : 1;
		const span = 1 / this.zoom_;
		const next = this.zoom_ > 1 ? (center - span / 2) / (1 - span) : 0;
		position.value = String(Math.round(1000 * Math.min(1, Math.max(0, next))));
		this.schedule_();
	}

	/** @private */
	schedule_() {
		if (this.frame_) return;
		this.frame_ = requestAnimationFrame(() => {
			this.frame_ = 0;
			this.draw_();
		});
	}

	/** @private */
	draw_() {
		const profile = this.profile_;
		if (!profile || !this.tracks_.length) return;
		const viewport = this.field_("viewport");
		const width = viewport.clientWidth;
		const height = Math.min(
			viewport.clientHeight,
			this.tracks_.length * ROW_HEIGHT,
		);
		if (!width || !height) return;
		const canvas = /** @type {!HTMLCanvasElement} */ (this.field_("canvas"));
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(height * ratio);
		canvas.style.width = width + "px";
		canvas.style.height = height + "px";
		canvas.style.top = viewport.scrollTop + "px";
		const context = /** @type {?CanvasRenderingContext2D} */ (
			canvas.getContext("2d")
		);
		if (!context) return;
		context.scale(ratio, ratio);
		const style = window.getComputedStyle(canvas);
		const grid = style.getPropertyValue("--profile-grid").trim();
		const text = style.getPropertyValue("--profile-text").trim();
		const background = style.getPropertyValue("--profile-stripe").trim();
		const labelWidth = Math.min(190, Math.floor(width * 0.37));
		const plotWidth = width - labelWidth;
		const position = /** @type {!HTMLInputElement} */ (this.field_("position"));
		const total = profile.end - profile.start;
		const span = total / this.zoom_;
		const start =
			profile.start + (Number(position.value) / 1000) * (total - span);
		this.field_("position-control").hidden = this.zoom_ === 1;
		/** @type {!HTMLButtonElement} */ (this.field_("zoom-out")).disabled =
			this.zoom_ === 1;
		/** @type {!HTMLButtonElement} */ (this.field_("zoom-in")).disabled =
			this.zoom_ === 1024;
		const ticks = this.field_("scale");
		ticks.style.paddingLeft = labelWidth + "px";
		ticks.replaceChildren(
			createDom("span", null, timeText(start - profile.start)),
			createDom("span", null, timeText(start + span / 2 - profile.start)),
			createDom("span", null, timeText(start + span - profile.start)),
		);
		this.marks_ = [];
		const first = Math.floor(viewport.scrollTop / ROW_HEIGHT);
		for (let index = first; index < this.tracks_.length; index++) {
			const top = index * ROW_HEIGHT - viewport.scrollTop;
			if (top >= height) break;
			const track = this.tracks_[index];
			context.fillStyle = background;
			if (index % 2 === 0) context.fillRect(0, top, width, ROW_HEIGHT);
			context.fillStyle = grid;
			context.fillRect(labelWidth, top, 1, ROW_HEIGHT);
			context.fillRect(labelWidth + plotWidth / 2, top, 1, ROW_HEIGHT);
			context.fillRect(0, top + ROW_HEIGHT - 1, width, 1);
			context.font = "12px system-ui, sans-serif";
			context.textBaseline = "middle";
			context.fillStyle = text;
			context.save();
			context.beginPath();
			context.rect(7, top, labelWidth - 13, ROW_HEIGHT);
			context.clip();
			context.fillText(track.name, 7, top + ROW_HEIGHT / 2);
			context.restore();
			this.drawTrack_(context, track, top, labelWidth, plotWidth, start, span);
		}
	}

	/**
	 * @private
	 * @param {!CanvasRenderingContext2D} context
	 * @param {!Track} track
	 * @param {number} top
	 * @param {number} labelWidth
	 * @param {number} width
	 * @param {number} start
	 * @param {number} span
	 */
	drawTrack_(context, track, top, labelWidth, width, start, span) {
		const first = firstVisible(track.ends, start);
		context.save();
		context.beginPath();
		context.rect(labelWidth, top, width, ROW_HEIGHT);
		context.clip();
		const counterColor = color(track.name);
		let previous = false;
		if (track.counter) {
			context.beginPath();
			context.fillStyle = counterColor;
		}
		for (
			let index = track.counter ? Math.max(0, first - 1) : first;
			index < track.events.length;
			index++
		) {
			const event = track.events[index];
			if (!track.counter && event.end < start) continue;
			const x = labelWidth + ((event.start - start) / span) * width;
			if (event.start > start + span && (!track.counter || !previous)) break;
			const left = Math.max(labelWidth, x);
			const end = labelWidth + ((event.end - start) / span) * width;
			const pixels = Math.max(2, Math.min(labelWidth + width, end) - left);
			if (track.counter) {
				const scale = track.high - track.low || 1;
				const y =
					top +
					ROW_HEIGHT -
					5 -
					((Number(event.value) - track.low) / scale) * (ROW_HEIGHT - 10);
				if (previous) context.lineTo(x, y);
				else context.moveTo(x, y);
				previous = true;
				if (x >= labelWidth && x <= labelWidth + width)
					context.fillRect(x - 1, y - 1, 2, 2);
				if (event.start > start + span) break;
			} else {
				context.fillStyle = color(event.category || event.name);
				context.globalAlpha = this.selected_ === event ? 1 : 0.82;
				context.fillRect(left, top + 6, pixels, ROW_HEIGHT - 12);
				if (pixels > 72) {
					context.fillStyle = "#fff";
					context.fillText(
						event.name,
						left + 4,
						top + ROW_HEIGHT / 2,
						pixels - 8,
					);
				}
			}
			if (x >= labelWidth || !track.counter)
				this.marks_.push({
					track,
					event,
					left: track.counter ? x - 4 : left,
					right: track.counter ? x + 4 : left + pixels,
					top,
				});
		}
		if (track.counter) {
			context.strokeStyle = counterColor;
			context.stroke();
		}
		context.restore();
	}

	/**
	 * @private
	 * @param {!Track} track
	 * @param {!TraceEvent} event
	 */
	showEvent_(track, event) {
		if (!this.profile_) return;
		this.selected_ = event;
		this.field_("title").textContent = event.name;
		this.field_("timing").textContent =
			track.name +
			(event.category ? " · " + event.category : "") +
			" · At " +
			timeText(event.start - this.profile_.start) +
			(event.value === null
				? " · " + timeText(event.end - event.start)
				: " · " + event.value);
		const args = this.field_("args");
		args.hidden = !event.args;
		args.textContent = event.args ? JSON.stringify(event.args, null, 2) : "";
		this.field_("detail").hidden = false;
		this.schedule_();
	}
}

exports = CommandProfile;
