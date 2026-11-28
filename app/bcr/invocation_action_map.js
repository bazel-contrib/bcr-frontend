/** @fileoverview Radial action dependencies for a captured invocation. */
goog.module("bcrfrontend.InvocationActionMap");

const ActionQuery = goog.require("bcrfrontend.ActionQuery");
const ExecutionLog = goog.require("bcrfrontend.ExecutionLog");
const BuildEvent = goog.requireType("proto.build_event_stream.BuildEvent");
const { InvocationProgress, eventTimestampMillis } = goog.require(
	"bcrfrontend.invocationEvents",
);
const { timestampMillis } = goog.require("bcrfrontend.invocationFormat");

const TAU = Math.PI * 2;
const RING_GAP = 70;

/** @typedef {{label: string, mnemonic: string, output: string, color: string, inputs: !Array<number>, status: string, timing: ?number, spawnStart: ?number, spawnEnd: ?number, actionStart: ?number, actionEnd: ?number}} */
let ActionNode;

/** @typedef {{label: string, action: ?ActionNode, depth: number, radius: number, angle: number, velocity: number}} */
let Mark;
/** @typedef {{action: !ActionNode, start: number, end: number, angle: number, targetAngle: number, index: number}} */
let TimedAction;
/** @typedef {{producer: !TimedAction, consumer: !TimedAction}} */
let TimedDependency;

const TIMELINE_INSET = 19;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PATH_ANGLE = -Math.PI / 2;

/**
 * @param {string} path
 * @return {string}
 */
function outputKey(path) {
	return path.replace(/^\.\//, "").replace(/^\/.*\/execroot\/[^/]+\//, "");
}

/**
 * @param {number} difference
 * @return {number}
 */
function signedAngle(difference) {
	return Math.atan2(Math.sin(difference), Math.cos(difference));
}

/**
 * @param {number} ms
 * @return {string}
 */
function timeLabel(ms) {
	return ms < 1000
		? Math.round(ms) + " ms"
		: Number((ms / 1000).toFixed(2)) + " s";
}

/**
 * Trace a dependency from the producer’s finish to the consumer’s start.
 * @param {!CanvasRenderingContext2D} ctx
 * @param {!Path2D} heads
 * @param {!TimedAction} producer
 * @param {!TimedAction} consumer
 * @param {number} scale
 */
function traceTimelineEdge(ctx, heads, producer, consumer, scale) {
	const from =
		TIMELINE_INSET + Math.max(producer.start * scale + 1, producer.end * scale);
	const to = TIMELINE_INSET + consumer.start * scale;
	const middle = (from + to) / 2;
	const ax = Math.cos(producer.angle);
	const ay = Math.sin(producer.angle);
	const bx = Math.cos(consumer.angle);
	const by = Math.sin(consumer.angle);
	const x = bx * to;
	const y = by * to;
	const gap = Math.hypot(x - ax * from, y - ay * from);
	if (gap < 3) return;
	ctx.moveTo(ax * from, ay * from);
	ctx.bezierCurveTo(ax * middle, ay * middle, bx * middle, by * middle, x, y);
	if (gap < 8) return;

	// Follow the end tangent. At equal radii, the second control point
	// coincides with the tip, so fall back to the preceding control point.
	let dx = bx * (to - middle);
	let dy = by * (to - middle);
	if (Math.hypot(dx, dy) < 0.5) {
		dx = x - ax * middle;
		dy = y - ay * middle;
	}
	const magnitude = Math.hypot(dx, dy);
	if (magnitude < 0.5) return;
	const ux = dx / magnitude;
	const uy = dy / magnitude;
	const tipX = x - ux;
	const tipY = y - uy;
	const length = Math.min(7, gap * 0.55);
	const halfWidth = length * 0.39;
	const baseX = tipX - ux * length;
	const baseY = tipY - uy * length;
	heads.moveTo(tipX, tipY);
	heads.lineTo(baseX - uy * halfWidth, baseY + ux * halfWidth);
	heads.lineTo(baseX + uy * halfWidth, baseY - ux * halfWidth);
	heads.closePath();
}

/**
 * Longest chain by measured action duration. Only chronologically compatible
 * edges can share a spoke without overlapping their action intervals.
 * @param {!Array<!TimedAction>} actions
 * @param {!Array<!TimedDependency>} dependencies
 * @return {{critical: number, previous: !Int32Array, next: !Int32Array}}
 */
function timelinePaths(actions, dependencies) {
	/** @type {!Array<!Array<number>>} */
	const consumers = actions.map(() => []);
	for (const { producer, consumer } of dependencies) {
		if (producer.index < consumer.index && producer.end <= consumer.start)
			consumers[producer.index].push(consumer.index);
	}
	/** @type {!Array<number>} */ const durations = actions.map(
		({ start, end }) => end - start,
	);
	const upstream = durations.slice();
	const downstream = durations.slice();
	const previous = new Int32Array(actions.length).fill(-1);
	const next = new Int32Array(actions.length).fill(-1);
	let critical = -1;
	for (let index = 0; index < actions.length; index++) {
		if (critical < 0 || upstream[index] >= upstream[critical]) critical = index;
		for (const child of consumers[index]) {
			const duration = upstream[index] + durations[child];
			if (duration < upstream[child]) continue;
			upstream[child] = duration;
			previous[child] = index;
		}
	}
	for (let index = actions.length - 1; index >= 0; index--) {
		for (const child of consumers[index]) {
			const duration = durations[index] + downstream[child];
			if (duration < downstream[index]) continue;
			downstream[index] = duration;
			next[index] = child;
		}
	}
	return { critical, previous, next };
}

/**
 * Settle angles while preserving the two elapsed-time radii of each action.
 * @param {!Array<!TimedAction>} actions
 * @param {!Array<!TimedDependency>} dependencies
 * @param {!Set<number>} pinned
 * @param {number} elapsed
 */
function settleTimeline(actions, dependencies, pinned, elapsed) {
	const count = actions.length;
	if (count < 2) return;
	const angles = new Float64Array(count);
	const initial = new Float64Array(count);
	const degree = new Float64Array(count);
	const force = new Float64Array(count);
	/** @type {!Array<number>} */ const order = [];
	for (const action of actions) {
		const angle = ((action.targetAngle % TAU) + TAU) % TAU;
		angles[action.index] = initial[action.index] = angle;
		order.push(action.index);
	}
	// Normalize to a reference radius so zooming never changes the layout.
	const referenceRadius = 220;
	/**
	 * @param {number} time
	 * @return {number}
	 */
	const radiusAt = (time) =>
		(TIMELINE_INSET + (time / elapsed) * referenceRadius) /
		(TIMELINE_INSET + referenceRadius);
	/** @type {!Array<{from: number, to: number, weight: number}>} */
	const springs = dependencies.map(({ producer, consumer }) => {
		const from = producer.index;
		const to = consumer.index;
		const weight = radiusAt(producer.end) * radiusAt(consumer.start);
		degree[from] += weight;
		degree[to] += weight;
		return { from, to, weight };
	});
	const iterations = Math.min(72, Math.max(12, Math.floor(180000 / count)));
	const nearTime = elapsed * 0.025;
	for (let iteration = 0; iteration < iterations; iteration++) {
		force.fill(0);
		for (const { from, to, weight } of springs) {
			// Angular derivative of squared distance between the connected tips.
			const pull = Math.sin(angles[to] - angles[from]) * weight;
			force[from] += pull;
			force[to] -= pull;
		}
		for (let index = 0; index < count; index++) {
			force[index] =
				force[index] / Math.max(0.12, degree[index]) +
				0.018 * Math.sin(initial[index] - angles[index]);
		}

		order.sort((a, b) => angles[a] - angles[b]);
		for (let i = 0; i < count; i++) {
			const a = order[i];
			for (let offset = 1; offset <= Math.min(10, count - 1); offset++) {
				const j = (i + offset) % count;
				const b = order[j];
				const gap = angles[b] - angles[a] + (j <= i ? TAU : 0);
				if (gap >= 0.27) break;
				const sharedStart = Math.max(actions[a].start, actions[b].start);
				const timeGap = sharedStart - Math.min(actions[a].end, actions[b].end);
				if (timeGap >= nearTime) continue;
				const spacing = Math.min(
					0.27,
					11 / (radiusAt(sharedStart) * referenceRadius),
				);
				const push =
					3.1 *
					Math.max(0, spacing - gap) *
					(1 - Math.max(0, timeGap) / nearTime);
				force[a] -= push;
				force[b] += push;
			}
		}

		const step = 0.23 * (1 - (0.7 * iteration) / iterations);
		for (let index = 0; index < count; index++) {
			if (pinned.has(index)) continue;
			const turn = Math.max(-0.16, Math.min(0.16, force[index] * step));
			angles[index] = (angles[index] + turn + TAU) % TAU;
		}
	}
	for (const action of actions) {
		if (!pinned.has(action.index)) action.targetAngle = angles[action.index];
	}
}

class InvocationActionMap {
	/**
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!HTMLElement} detail
	 * @param {!HTMLElement} tooltip
	 */
	constructor(canvas, detail, tooltip) {
		/** @private @const */ this.canvas_ = canvas;
		/** @private @const */ this.detail_ = detail;
		/** @private @const */ this.tooltip_ = tooltip;
		/** @private @type {?TimedAction} */ this.hovered_ = null;
		/** @private @type {!Array<!ActionNode>} */ this.nodes_ = [];
		/** @private @type {!Map<string, !Array<number>>} */ this.outputs_ =
			new Map();
		/** @private @type {!Set<string>} */ this.completedTargets_ = new Set();
		/** @private @type {!Set<string>} */ this.expanded_ = new Set();
		/** @private @type {!Array<string>} */ this.requested_ = [];
		/** @private @type {!Map<number, !Mark>} */ this.marks_ = new Map();
		/** @private @type {!Array<!Array<number>>} */ this.rings_ = [];
		/** @private @type {!Array<!Array<number>>} */ this.edges_ = [];
		/** @private */ this.historyIndex_ = 0;
		/** @private */ this.settle_ = 0;
		/** @private @type {number} */ this.remaining_ = 0;
		/** @private */ this.frame_ = 0;
		/** @private */ this.zoom_ = 1;
		/** @private */ this.panX_ = 0;
		/** @private */ this.panY_ = 0;
		/** @private */ this.dragX_ = 0;
		/** @private */ this.dragY_ = 0;
		/** @private */ this.dragging_ = false;
		/** @private */ this.panning_ = false;
		/** @private */ this.dirty_ = true;
		/** @private */ this.visible_ = false;
		/** @private */ this.full_ = false;
		/** @private @type {!Array<!TimedAction>} */ this.timeline_ = [];
		/** @private @type {!Array<!TimedDependency>} */ this.timelineEdges_ = [];
		/** @private @type {number} */ this.elapsed_ = 0;
		/** @private @type {?ActionNode} */ this.selectedAction_ = null;
		/** @private @type {?{critical: number, previous: !Int32Array, next: !Int32Array}} */ this.paths_ =
			null;
		/** @private @type {!Set<number>} */ this.path_ = new Set();
		/** @private @type {!Map<number, number>} */ this.pathLinks_ = new Map();
		/** @private */ this.rotationFrames_ = 0;

		/** @private */ this.outcome_ = "";
		/** @private */ this.loaded_ = false;
		/** @private */ this.logLoaded_ = false;
	}

	/** @return {boolean} */
	hasGraph() {
		return this.loaded_;
	}

	/** @return {boolean} */
	hasLog() {
		return this.logLoaded_;
	}

	reset() {
		this.selectedAction_ = null;
		this.paths_ = null;
		this.path_.clear();
		this.pathLinks_.clear();
		this.rotationFrames_ = 0;
		this.nodes_ = [];
		this.outputs_.clear();
		this.completedTargets_.clear();
		this.expanded_.clear();
		this.requested_ = [];
		this.historyIndex_ = 0;
		this.marks_.clear();
		this.rings_ = [];
		this.edges_ = [];
		this.dirty_ = true;
		this.full_ = false;
		this.timeline_ = [];
		this.timelineEdges_ = [];
		this.elapsed_ = 0;
		this.outcome_ = "";
		this.loaded_ = false;
		this.logLoaded_ = false;
		this.clearHover();
		this.fit();
		this.detail_.textContent = "";
	}

	/** @param {boolean} visible */
	show(visible) {
		this.visible_ = visible;
		if (visible) this.paint();
		else {
			this.clearHover();
			cancelAnimationFrame(this.frame_);
			this.frame_ = 0;
		}
	}

	/** @param {!Array<string>} targets */
	setTargets(targets) {
		this.requested_ = targets;
		this.dirty_ = true;
	}

	/** @param {!Uint8Array} bytes */
	load(bytes) {
		const { nodes, artifactPath } = ActionQuery.resolve(bytes);
		this.nodes_ = nodes.map((node, index) => {
			for (const id of node.action.getOutputIdsList()) {
				const path = outputKey(artifactPath(id));
				const matches = this.outputs_.get(path) || [];
				matches.push(index);
				this.outputs_.set(path, matches);
			}
			return {
				label: node.target,
				mnemonic: node.action.getMnemonic(),
				output: node.output,
				color: node.color,
				inputs: Array.from(node.inputs),
				status: "",
				timing: null,
				spawnStart: null,
				spawnEnd: null,
				actionStart: null,
				actionEnd: null,
			};
		});
		this.loaded_ = true;
		this.dirty_ = true;
	}

	/**
	 * @param {!File} file
	 * @param {function():boolean} current
	 * @return {!Promise<void>}
	 */
	async loadLog(file, current) {
		const actions = await ExecutionLog.readActions(file, current);
		if (!current()) return;
		for (const action of actions) {
			const match = this.match_(
				action.outputPaths,
				action.target,
				action.mnemonic,
			);
			if (match === undefined) continue;
			const node = this.nodes_[match];
			if (node.status === "Failed" && action.outcome !== "failed") continue;
			node.status =
				action.outcome === "failed"
					? "Failed"
					: action.outcome === "cache" && node.status !== "Executed"
						? "Cache hit"
						: "Executed";
			node.timing = action.duration;
			// A cache hit can carry the start timestamp of the original execution.
			const start =
				action.outcome === "cache"
					? null
					: timestampMillis(action.spawn?.getMetrics()?.getStartTime() || null);
			if (start !== null && action.duration !== null && action.duration >= 0) {
				node.spawnStart = Math.min(node.spawnStart ?? start, start);
				node.spawnEnd = Math.max(
					node.spawnEnd ?? start,
					start + action.duration,
				);
			}
		}
		this.logLoaded_ = true;
		this.dirty_ = true;
	}

	/**
	 * @private
	 * @param {!Array<string>} paths
	 * @param {string} label
	 * @param {string} mnemonic
	 * @return {number|undefined}
	 */
	match_(paths, label, mnemonic) {
		/** @type {!Set<number>} */ const candidates = new Set();
		for (const path of paths) {
			if (!path) continue;
			const matches = this.outputs_.get(outputKey(path)) || [];
			if (matches.length === 1) candidates.add(matches[0]);
			else {
				const narrowed = matches.filter((i) => {
					const node = this.nodes_[i];
					return (
						(!label || node.label === label) &&
						(!mnemonic || node.mnemonic === mnemonic)
					);
				});
				if (narrowed.length === 1) candidates.add(narrowed[0]);
			}
		}
		return candidates.size === 1 ? candidates.values().next().value : undefined;
	}

	/**
	 * @private
	 * @param {!BuildEvent} event
	 */
	observe_(event) {
		const id = event.getId();
		if (id?.getPattern()) {
			for (const child of event.getChildrenList()) {
				const label =
					child.getTargetConfigured()?.getLabel() ||
					child.getTargetCompleted()?.getLabel();
				if (label && !this.expanded_.has(label)) {
					this.expanded_.add(label);
					this.dirty_ = true;
				}
			}
		}
		const completed = id?.getTargetCompleted()?.getLabel();
		if (
			completed &&
			event.getCompleted() &&
			!this.completedTargets_.has(completed)
		) {
			this.completedTargets_.add(completed);
			this.dirty_ = true;
		}
		const action = event.getAction();
		if (!action) return;
		const actionId = id?.getActionCompleted();
		const output = action.getPrimaryOutput();
		const path = output
			? [...output.getPathPrefixList(), output.getName()]
					.filter(Boolean)
					.join("/")
			: "";
		const match = this.match_(
			[actionId?.getPrimaryOutput() || "", path],
			actionId?.getLabel() || action.getLabel(),
			action.getType(),
		);
		if (match === undefined) return;
		const node = this.nodes_[match];
		const start = timestampMillis(action.getStartTime());
		const end = timestampMillis(action.getEndTime());
		if (start !== null && end !== null && end >= start) {
			node.actionStart = start;
			node.actionEnd = end;
			this.dirty_ = true;
		}
		if (!node.status || !action.getSuccess()) {
			node.status = action.getSuccess() ? "Completed" : "Failed";
			this.dirty_ = true;
		}
	}

	/**
	 * @param {!InvocationProgress} progress
	 * @param {boolean} full
	 * @return {string}
	 */
	update(progress, full) {
		if (!this.loaded_) return "";
		for (; this.historyIndex_ < progress.history.length; this.historyIndex_++) {
			const event = progress.history[this.historyIndex_].event;
			if (event) this.observe_(event);
		}
		const finished = progress.finished?.getFinished();
		const exit = finished?.getExitCode();
		const outcome = finished
			? (exit ? exit.getCode() !== 0 : finished.hasFailureDetail())
				? "Failed"
				: "Succeeded"
			: progress.collectionState === "INVOCATION_STATE_INCOMPLETE"
				? "Incomplete"
				: progress.collectionState === "INVOCATION_STATE_COMPLETE" &&
						progress.last
					? "Ended"
					: "";
		if (outcome !== this.outcome_ || full !== this.full_) {
			this.outcome_ = outcome;
			this.full_ = full;
			this.dirty_ = true;
			if (outcome && !full) this.fit();
		}
		if (this.dirty_) {
			this.layout_();
			if (outcome && !full) this.buildTimeline_(progress);
		}
		this.paint();

		return full
			? this.nodes_.length.toLocaleString() + " analyzed actions"
			: outcome
				? outcome +
					(this.elapsed_
						? " · " +
							this.timeline_.length.toLocaleString() +
							" timed actions · " +
							timeLabel(this.elapsed_) +
							" elapsed"
						: "")
				: this.remaining_.toLocaleString() +
					" of " +
					this.nodes_.length.toLocaleString() +
					" actions visible";
	}

	/**
	 * @private
	 * @param {!InvocationProgress} progress
	 */
	buildTimeline_(progress) {
		this.timeline_ = [];
		this.timelineEdges_ = [];
		this.elapsed_ = 0;
		const origin = progress.started
			? eventTimestampMillis(progress.started)
			: null;
		const finish = progress.finished
			? eventTimestampMillis(progress.finished)
			: progress.collectionEndedAt;
		if (origin === null || finish === null || finish <= origin) return;
		const elapsed = finish - origin;
		this.elapsed_ = elapsed;
		/** @type {!Map<number, !TimedAction>} */
		const timedByIndex = new Map();
		this.nodes_.forEach((action, index) => {
			const start = action.actionStart ?? action.spawnStart;
			const end = action.actionEnd ?? action.spawnEnd;
			if (start === null || end === null || end < origin || start > finish)
				return;
			const segment = {
				action,
				start: Math.max(0, start - origin),
				end: Math.min(elapsed, end - origin),
				angle: 0,
				targetAngle: 0,
				index: 0,
			};
			this.timeline_.push(segment);
			timedByIndex.set(index, segment);
		});
		this.timeline_.sort((a, b) => a.start - b.start || a.end - b.end);
		this.timeline_.forEach((segment, i) => {
			segment.index = i;
			for (const index of segment.action.inputs) {
				const producer = timedByIndex.get(index);
				if (producer) this.timelineEdges_.push({ producer, consumer: segment });
			}
		});
		this.paths_ = timelinePaths(this.timeline_, this.timelineEdges_);
		this.alignPath_(false);
	}

	/** @return {boolean} */
	hasTimeline() {
		return Boolean(this.outcome_ && !this.full_ && this.timeline_.length);
	}

	resetPath() {
		this.selectedAction_ = null;
		this.alignPath_(true);
	}

	/** @private @param {boolean} animate */
	alignPath_(animate) {
		const paths = this.paths_;
		if (!paths || paths.critical < 0) return;
		this.clearHover();
		const selected = this.timeline_.findIndex(
			(segment) => segment.action === this.selectedAction_,
		);
		const anchor = selected >= 0 ? selected : paths.critical;
		this.path_.clear();
		this.pathLinks_.clear();
		this.path_.add(anchor);
		for (
			let index = anchor;
			paths.previous[index] >= 0;
			index = paths.previous[index]
		) {
			this.path_.add(paths.previous[index]);
			this.pathLinks_.set(index, paths.previous[index]);
		}
		for (
			let index = anchor;
			paths.next[index] >= 0;
			index = paths.next[index]
		) {
			this.path_.add(paths.next[index]);
			this.pathLinks_.set(paths.next[index], index);
		}
		const rotate =
			animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const segment of this.timeline_) {
			segment.targetAngle = this.path_.has(segment.index)
				? PATH_ANGLE
				: PATH_ANGLE + (segment.index - anchor) * GOLDEN_ANGLE;
		}
		settleTimeline(
			this.timeline_,
			this.timelineEdges_,
			this.path_,
			this.elapsed_,
		);
		if (!rotate) {
			for (const segment of this.timeline_) segment.angle = segment.targetAngle;
		}
		this.rotationFrames_ = rotate ? 17 : 0;
		this.detail_.textContent = this.timelineHelp_();
		this.paint();
	}

	/** @private @return {string} */
	timelineHelp_() {
		const path = this.selectedAction_ ? "Selected path" : "Critical path";
		return (
			path +
			" at 12 o’clock. Hover for timing or click an action to align its path."
		);
	}

	/**
	 * @private
	 * @param {number} width
	 * @param {number} height
	 * @return {number}
	 */
	timelineScale_(width, height) {
		return (
			(Math.max(1, Math.min(width, height) / 2 - 30 - TIMELINE_INSET) *
				this.zoom_) /
			this.elapsed_
		);
	}

	/**
	 * @private
	 * @param {number} x
	 * @param {number} y
	 * @param {number} scale
	 * @return {?TimedAction}
	 */
	inspectTimeline_(x, y, scale) {
		let distance = 7;
		/** @type {?TimedAction} */ let nearest = null;
		for (const segment of this.timeline_) {
			const cos = Math.cos(segment.angle);
			const sin = Math.sin(segment.angle);
			const projection = x * cos + y * sin;
			const radius = Math.min(
				Math.max(TIMELINE_INSET + segment.start * scale, projection),
				Math.max(
					TIMELINE_INSET + segment.start * scale + 1,
					TIMELINE_INSET + segment.end * scale,
				),
			);
			const gap = Math.hypot(x - radius * cos, y - radius * sin);
			if (gap >= distance) continue;
			distance = gap;
			nearest = segment;
		}
		return nearest;
	}

	/**
	 * @private
	 * @param {?TimedAction} segment
	 * @param {number} x
	 * @param {number} y
	 * @param {!DOMRect} rect
	 */
	showTiming_(segment, x, y, rect) {
		if (!segment) {
			this.clearHover();
			return;
		}
		if (this.hovered_ !== segment) {
			this.hovered_ = segment;
			this.tooltip_.textContent = [
				segment.action.mnemonic,
				segment.action.label,
				segment.action.output,
				segment.action.status,
				timeLabel(segment.start) + " to " + timeLabel(segment.end),
				timeLabel(segment.end - segment.start) + " duration",
			]
				.filter(Boolean)
				.join(" · ");
			this.detail_.textContent = this.tooltip_.textContent;
			this.tooltip_.hidden = false;
			this.paint();
		}
		const width = this.tooltip_.offsetWidth;
		const height = this.tooltip_.offsetHeight;
		this.tooltip_.style.left =
			Math.max(5, Math.min(x + 12, rect.width - width - 5)) + "px";
		this.tooltip_.style.top =
			Math.max(5, y + height + 12 < rect.height ? y + 12 : y - height - 12) +
			"px";
	}

	clearHover() {
		if (!this.hovered_) return;
		this.hovered_ = null;
		this.tooltip_.hidden = true;
		this.detail_.textContent = this.timelineHelp_();
		this.paint();
	}

	/**
	 * @private
	 * @param {!CanvasRenderingContext2D} ctx
	 * @param {number} width
	 * @param {number} height
	 * @param {string} foreground
	 * @param {string} border
	 */
	drawTimeline_(ctx, width, height, foreground, border) {
		const scale = this.timelineScale_(width, height);
		ctx.save();
		ctx.font = "11px monospace";
		ctx.textAlign = "left";
		ctx.strokeStyle = border;
		ctx.fillStyle = foreground;
		ctx.setLineDash([2, 5]);
		ctx.lineWidth = 1;
		for (let i = 1; i <= 4; i++) {
			const time = (this.elapsed_ * i) / 4;
			const radius = TIMELINE_INSET + time * scale;
			ctx.beginPath();
			ctx.arc(0, 0, radius, 0, TAU);
			ctx.stroke();
			ctx.fillText(timeLabel(time), 4, -radius + 13);
		}
		ctx.setLineDash([]);
		ctx.strokeStyle = foreground;
		ctx.fillStyle = foreground;
		this.drawTimelineEdges_(ctx, scale, false);
		if (this.hovered_ || this.path_.size > 1) {
			this.drawTimelineEdges_(ctx, scale, true);
		}
		ctx.lineCap = "round";
		for (const segment of this.timeline_) {
			const a = TIMELINE_INSET + segment.start * scale;
			const b = Math.max(a + 1, TIMELINE_INSET + segment.end * scale);
			const cos = Math.cos(segment.angle);
			const sin = Math.sin(segment.angle);
			ctx.strokeStyle = segment.action.color || foreground;
			ctx.lineWidth =
				this.hovered_ === segment || this.path_.has(segment.index) ? 4 : 2;
			ctx.globalAlpha = segment.action.status === "Cache hit" ? 0.45 : 0.85;
			ctx.beginPath();
			ctx.moveTo(a * cos, a * sin);
			ctx.lineTo(b * cos, b * sin);
			ctx.stroke();
			if (segment.action.status === "Failed") {
				ctx.fillStyle = "#cf222e";
				ctx.beginPath();
				ctx.arc(b * cos, b * sin, 3, 0, TAU);
				ctx.fill();
			}
		}
		ctx.restore();
	}

	/**
	 * @private
	 * @param {!CanvasRenderingContext2D} ctx
	 * @param {number} scale
	 * @param {boolean} emphasized
	 */
	drawTimelineEdges_(ctx, scale, emphasized) {
		ctx.lineCap = "butt";
		ctx.lineWidth = emphasized ? 1.5 : 1;
		ctx.globalAlpha = emphasized ? 0.82 : 0.23;
		const heads = new Path2D();
		ctx.beginPath();
		for (const { producer, consumer } of this.timelineEdges_) {
			const active = this.pathLinks_.get(consumer.index) === producer.index;
			if (
				!emphasized ||
				active ||
				producer === this.hovered_ ||
				consumer === this.hovered_
			)
				traceTimelineEdge(ctx, heads, producer, consumer, scale);
		}
		ctx.stroke();
		ctx.fill(heads);
	}

	/** @param {!WheelEvent} event */
	wheel(event) {
		if (!this.loaded_) return;
		event.preventDefault();
		this.clearHover();
		this.zoom_ = Math.max(
			0.3,
			Math.min(24, this.zoom_ * Math.exp(-event.deltaY * 0.002)),
		);
		this.paint();
	}

	/** @param {!PointerEvent} event */
	start(event) {
		if (event.button !== 0) return;
		this.clearHover();
		this.dragging_ = true;
		this.panning_ = false;
		this.dragX_ = event.clientX;
		this.dragY_ = event.clientY;
		this.canvas_.setPointerCapture(event.pointerId);
	}

	/** @param {!PointerEvent} event */
	move(event) {
		if (this.dragging_) {
			if (
				!this.panning_ &&
				Math.hypot(event.clientX - this.dragX_, event.clientY - this.dragY_) < 4
			)
				return;
			this.panning_ = true;
			this.panX_ += event.clientX - this.dragX_;
			this.panY_ += event.clientY - this.dragY_;
			this.dragX_ = event.clientX;
			this.dragY_ = event.clientY;
			this.paint();
			return;
		}
		const rect = this.canvas_.getBoundingClientRect();
		const offsetX = event.clientX - rect.left - rect.width / 2 - this.panX_;
		const offsetY = event.clientY - rect.top - rect.height / 2 - this.panY_;
		if (this.outcome_ && !this.full_ && this.elapsed_) {
			const segment = this.inspectTimeline_(
				offsetX,
				offsetY,
				this.timelineScale_(rect.width, rect.height),
			);
			this.showTiming_(
				segment,
				event.clientX - rect.left,
				event.clientY - rect.top,
				rect,
			);
			return;
		}
		const scale = this.scale_(rect.width, rect.height);
		const x = offsetX / scale;
		const y = offsetY / scale;
		/** @type {?Mark} */ let nearest = null;
		let distance = 11;
		for (const mark of this.marks_.values()) {
			const separation = Math.hypot(
				mark.radius * Math.cos(mark.angle) - x,
				mark.radius * Math.sin(mark.angle) - y,
			);
			if (separation >= distance) continue;
			nearest = mark;
			distance = separation;
		}
		const action = nearest?.action;
		this.detail_.textContent = action
			? [
					action.mnemonic,
					action.label,
					action.output,
					action.status || "No execution record",
					action.timing === null
						? ""
						: (action.timing / 1000).toFixed(3) + " s",
				]
					.filter(Boolean)
					.join(" · ")
			: nearest?.label || "";
	}

	/** @param {!PointerEvent=} event */
	end(event) {
		const select =
			this.dragging_ && !this.panning_ && this.hasTimeline() && event;
		this.dragging_ = false;
		if (!select) return;
		const rect = this.canvas_.getBoundingClientRect();
		const segment = this.inspectTimeline_(
			select.clientX - rect.left - rect.width / 2 - this.panX_,
			select.clientY - rect.top - rect.height / 2 - this.panY_,
			this.timelineScale_(rect.width, rect.height),
		);
		if (!segment || segment.action === this.selectedAction_) return;
		this.selectedAction_ = segment.action;
		this.alignPath_(true);
	}

	fit() {
		this.clearHover();
		this.zoom_ = 1;
		this.panX_ = this.panY_ = 0;
		this.paint();
	}

	/** @private */
	layout_() {
		this.clearHover();
		this.dirty_ = false;
		this.remaining_ = 0;
		this.detail_.textContent = "";
		const previous = this.marks_;
		this.marks_ = new Map();
		this.rings_ = [];
		this.edges_ = [];
		/** @type {!Array<string>} */
		const labels = this.expanded_.size
			? Array.from(this.expanded_)
			: this.requested_;
		this.marks_.set(-1, {
			label: labels.length === 1 ? labels[0] : "Build",
			action: null,
			depth: 0,
			radius: 0,
			angle: 0,
			velocity: 0,
		});
		if (this.outcome_ && !this.full_) return;

		/** @type {!Map<string, number>} */
		const targetRoots = new Map();
		labels.forEach((label, index) => {
			targetRoots.set(label, labels.length === 1 ? -1 : -2 - index);
		});
		/** @type {!Array<number>} */ const pending = [];
		/** @type {!Map<number, !Array<number>>} */ const targetActions = new Map();
		// Top-level sinks are actions whose outputs aren't consumed by another
		// action in this graph. Attach each to its requested target when known.
		const consumed = new Set(this.nodes_.flatMap((node) => node.inputs));
		this.nodes_.forEach((action, id) => {
			if (consumed.has(id)) return;
			const root = targetRoots.get(action.label) ?? -1;
			const children = targetActions.get(root) || [];
			children.push(id);
			targetActions.set(root, children);
		});
		/**
		 * @param {number} parent
		 * @param {number} id
		 * @param {string} label
		 * @param {?ActionNode} action
		 */
		const add = (parent, id, label, action) => {
			if (this.marks_.has(id)) return;
			if (id >= 0) this.remaining_++;
			const depth = (this.marks_.get(parent)?.depth || 0) + 1;
			this.marks_.set(id, {
				label,
				action,
				depth,
				radius: 0,
				angle: previous.get(id)?.angle ?? NaN,
				velocity: 0,
			});
			const ring = this.rings_[depth - 1] || (this.rings_[depth - 1] = []);
			ring.push(id);
			pending.push(id);
		};
		targetRoots.forEach((id, label) => {
			if (id !== -1 && (this.full_ || !this.completedTargets_.has(label))) {
				add(-1, id, label, null);
				this.edges_.push([-1, id]);
			}
		});
		pending.unshift(-1);
		for (let i = 0; i < pending.length; i++) {
			const id = pending[i];
			const mark = this.marks_.get(id);
			if (
				!mark ||
				(!this.full_ &&
					this.completedTargets_.has(mark.label) &&
					id < 0 &&
					labels.length === 1)
			)
				continue;
			/** @type {!Array<number>} */
			const children = mark.action?.inputs || targetActions.get(id) || [];
			for (const child of children) {
				const action = this.nodes_[child];
				if (!this.full_ && action.status) continue;
				add(id, child, action.label, action);
				this.edges_.push([id, child]);
			}
		}
		let radius = 0;
		for (const ring of this.rings_) {
			radius = Math.max(radius + RING_GAP, (ring.length * 23) / TAU);
			ring.forEach((id, index) => {
				const mark = /** @type {!Mark} */ (this.marks_.get(id));
				mark.radius = radius;
				if (!Number.isFinite(mark.angle))
					mark.angle = (index * TAU) / ring.length - Math.PI / 2;
			});
		}
		this.settle_ = 42;
	}

	/** @private */
	step_() {
		for (const [parent, dep] of this.edges_) {
			if (parent === -1) continue;
			const a = /** @type {!Mark} */ (this.marks_.get(parent));
			const b = /** @type {!Mark} */ (this.marks_.get(dep));
			const force = signedAngle(a.angle - b.angle) * 0.012;
			b.velocity += force;
			a.velocity -= force * 0.3;
		}
		for (const ring of this.rings_) {
			if (ring.length < 2) continue;
			/** @type {!Array<!Mark>} */
			const marks = ring.map(
				(id) => /** @type {!Mark} */ (this.marks_.get(id)),
			);
			marks.sort((a, b) => a.angle - b.angle);
			const space = TAU / marks.length;
			marks.forEach((a, i) => {
				const b = marks[(i + 1) % marks.length];
				const gap = (i === marks.length - 1 ? TAU : 0) + b.angle - a.angle;
				const repel = Math.max(0, space * 0.86 - gap) * 0.19;
				a.velocity -= repel;
				b.velocity += repel;
			});
		}
		for (const mark of this.marks_.values()) {
			if (!mark.depth) continue;
			mark.angle =
				(mark.angle + Math.max(-0.2, Math.min(0.2, mark.velocity)) + TAU) % TAU;
			mark.velocity *= 0.65;
		}
	}

	/**
	 * @private
	 * @param {number} width
	 * @param {number} height
	 * @return {number}
	 */
	scale_(width, height) {
		const last = this.rings_[this.rings_.length - 1];
		const radius = last ? this.marks_.get(last[0])?.radius || 0 : 0;
		return (
			this.zoom_ * Math.min(1, Math.min(width, height) / (radius * 2 + 75))
		);
	}

	paint() {
		if (!this.visible_ || !this.loaded_ || this.frame_) return;
		this.frame_ = requestAnimationFrame(() => {
			this.frame_ = 0;
			if (this.settle_ > 0) {
				this.step_();
				this.settle_--;
			}
			if (this.hasTimeline() && this.rotationFrames_ > 0) {
				this.rotationFrames_--;
				for (const segment of this.timeline_) {
					segment.angle = this.rotationFrames_
						? segment.angle +
							signedAngle(segment.targetAngle - segment.angle) * 0.22
						: segment.targetAngle;
				}
			}
			this.draw_();
			if (this.settle_ > 0 || (this.hasTimeline() && this.rotationFrames_ > 0))
				this.paint();
		});
	}

	/** @private */
	draw_() {
		const { width, height } = this.canvas_.getBoundingClientRect();
		const ctx = /** @type {?CanvasRenderingContext2D} */ (
			this.canvas_.getContext("2d")
		);
		if (!ctx || !width || !height) return;
		const dpr = window.devicePixelRatio || 1;
		if (this.canvas_.width !== Math.round(width * dpr))
			this.canvas_.width = Math.round(width * dpr);
		if (this.canvas_.height !== Math.round(height * dpr))
			this.canvas_.height = Math.round(height * dpr);
		const styles = getComputedStyle(this.canvas_);
		const fg = styles.color;
		const border =
			styles.getPropertyValue("--borderColor-default").trim() || "#8c959f";
		const scale = this.scale_(width, height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.translate(width / 2 + this.panX_, height / 2 + this.panY_);
		if (
			this.outcome_ &&
			!this.full_ &&
			this.elapsed_ &&
			this.timeline_.length
		) {
			this.drawTimeline_(ctx, width, height, fg, border);
		}
		/**
		 * @param {!Mark} mark
		 * @return {!Array<number>}
		 */
		const position = (mark) => [
			mark.radius * Math.cos(mark.angle) * scale,
			mark.radius * Math.sin(mark.angle) * scale,
		];
		ctx.lineWidth = 1;
		ctx.strokeStyle = border;
		ctx.beginPath();
		for (const [parent, child] of this.edges_) {
			const a = position(/** @type {!Mark} */ (this.marks_.get(parent)));
			const b = position(/** @type {!Mark} */ (this.marks_.get(child)));
			ctx.moveTo(a[0], a[1]);
			ctx.lineTo(b[0], b[1]);
		}
		ctx.stroke();
		this.marks_.forEach((mark, id) => {
			const [x, y] = position(mark);
			if (
				Math.abs(x + this.panX_) > width / 2 + 20 ||
				Math.abs(y + this.panY_) > height / 2 + 20
			)
				return;
			const action = mark.action;
			ctx.fillStyle = action?.color || "#0969da";
			if (id === -1 && this.outcome_)
				ctx.fillStyle =
					this.outcome_ === "Succeeded"
						? "#1a7f37"
						: this.outcome_ === "Failed"
							? "#cf222e"
							: "#9a6700";
			if (action?.status === "Failed") ctx.fillStyle = "#cf222e";
			ctx.globalAlpha = action?.status === "Cache hit" ? 0.45 : 1;
			ctx.beginPath();
			ctx.arc(
				x,
				y,
				id === -1 ? 11 : action ? Math.max(2, Math.min(7, 6 * scale)) : 6,
				0,
				TAU,
			);
			ctx.fill();
			ctx.globalAlpha = 1;
			if (id < 0 || scale >= 0.9) {
				ctx.fillStyle = fg;
				ctx.font = id === -1 ? "bold 13px monospace" : "11px monospace";
				ctx.textAlign = "center";
				ctx.fillText(
					action?.mnemonic || mark.label,
					x,
					y + (id === -1 ? 28 : 20),
					Math.max(65, width - 28),
				);
			}
		});
	}
}

exports = InvocationActionMap;
