/** @fileoverview Viewer for Bazel query's binary target dependency graph. */
goog.module("bcrfrontend.Query");

const QueryResult = goog.require("proto.blaze_query.QueryResult");
const Target = goog.requireType("proto.blaze_query.Target");
const DomHelper = goog.requireType("goog.dom.DomHelper");
const { createDom } = goog.require("goog.dom");
const FileDropHandler = goog.require("goog.events.FileDropHandler");
const { BrowserEvent } = goog.requireType("goog.events");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { NODE_WIDTH, NODE_HEIGHT, topologicalRanks, placeRanks } = goog.require(
	"bcrfrontend.rankedGraph",
);
const { query } = goog.require("soy.bcrfrontend.query");

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_MATCHES = 200;
const PALETTE = ["#3284cf", "#2a906c", "#9272cb", "#bc7439", "#bd657c"];

/** @typedef {{label: string, kind: string, location: string, labels: !Array<string>, edges: !Array<number>, x: number, y: number, color: string}} */
let QueryNode;
/** @typedef {{nodes: !Array<!QueryNode>, edgeCount: number, width: number, height: number}} */
let Graph;

/**
 * @param {!Target} target
 * @return {?QueryNode}
 */
function readTarget(target) {
	const node = {
		label: "",
		kind: "",
		location: "",
		labels: [],
		edges: [],
		x: 0,
		y: 0,
		color: "",
	};
	const rule = target.getRule();
	const source = target.getSourceFile();
	const output = target.getGeneratedFile();
	const group = target.getPackageGroup();
	const environments = target.getEnvironmentGroup();
	if (rule) {
		node.label = rule.getName();
		node.kind = rule.getRuleClass();
		node.location = rule.getLocation();
		node.labels = rule.getRuleInputList();
	} else if (source) {
		node.label = source.getName();
		node.kind = "Source file";
		node.location = source.getLocation();
	} else if (output) {
		node.label = output.getName();
		node.kind = "Generated file";
		node.location = output.getLocation();
		node.labels = [output.getGeneratingRule()];
	} else if (group) {
		node.label = group.getName();
		node.kind = "Package group";
		node.labels = group.getIncludedPackageGroupList();
	} else if (environments) {
		node.label = environments.getName();
		node.kind = "Environment group";
		node.labels = environments.getEnvironmentList();
	}
	if (!node.label) return null;
	let hash = 0;
	for (let i = 0; i < node.kind.length; i++)
		hash = (31 * hash + node.kind.charCodeAt(i)) >>> 0;
	node.color = PALETTE[hash % PALETTE.length];
	return node;
}

/**
 * Draw edges from a target to its prerequisites. Only connect labels
 * materialized in the result, since a query can deliberately exclude targets.
 * @param {!QueryResult} result
 * @param {boolean=} includeSources
 * @return {!Graph}
 */
function buildGraph(result, includeSources = true) {
	/** @type {!Array<!QueryNode>} */
	const nodes = [];
	/** @type {!Map<string, number>} */
	const indices = new Map();
	let hasHiddenSources = false;
	for (const target of result.getTargetList()) {
		const node = readTarget(target);
		if (!node || indices.has(node.label)) continue;
		if (!includeSources && node.kind === "Source file") {
			hasHiddenSources = true;
			continue;
		}
		indices.set(node.label, nodes.length);
		nodes.push(node);
	}
	if (!nodes.length && !hasHiddenSources)
		throw new Error("The query result contains no targets.");
	/** @type {!Array<number>} */
	const incoming = nodes.map(() => 0);
	let edgeCount = 0;
	for (const node of nodes) {
		for (const label of new Set(node.labels)) {
			const index = indices.get(label);
			if (index === undefined || nodes[index] === node) continue;
			node.edges.push(index);
			incoming[index]++;
			edgeCount++;
		}
	}
	const ranks = topologicalRanks(
		incoming,
		nodes.map((node) => node.edges),
	);
	if (!ranks)
		throw new Error(
			"The result contains a dependency cycle and cannot be ranked.",
		);
	const { positions, width, height } = placeRanks(ranks);
	nodes.forEach((node, index) => {
		node.x = positions[index].x;
		node.y = positions[index].y;
	});
	return { nodes, width, height, edgeCount };
}

class Query extends Component {
	/** @param {?DomHelper=} helper */
	constructor(helper) {
		super(helper);
		/** @private {?Graph} */
		this.graph_ = null;
		/** @private {?QueryResult} */
		this.result_ = null;
		this.filename_ = "";
		this.selected_ = -1;
		this.generation_ = 0;
		this.x_ = 0;
		this.y_ = 0;
		this.scale_ = 1;
		this.needsFit_ = false;
		this.frame_ = 0;
		/** @private {?ResizeObserver} */
		this.resize_ = null;
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(query));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const handler = this.getHandler();
		const content = this.field_("content");
		const input = /** @type {!HTMLInputElement} */ (this.field_("file"));
		const drop = new FileDropHandler(content, true);
		this.registerDisposable(drop);
		handler.listen(this.field_("choose"), "click", () => input.click());
		handler.listen(this.field_("replace"), "click", () => input.click());
		handler.listen(input, "change", () => {
			const selected = input.files?.[0];
			input.value = "";
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
				const file = drag.dataTransfer?.files[0];
				if (file) void this.load_(file);
			},
		);
		handler.listen(this.field_("include-sources"), "change", () => {
			if (!this.result_) return;
			const label = this.graph_?.nodes[this.selected_]?.label || "";
			this.showGraph_(buildGraph(this.result_, this.includeSources_()), label);
		});
		handler.listen(this.field_("search"), "input", () => this.updateMatches_());
		handler.listen(this.field_("matches"), "change", () => {
			const value = /** @type {!HTMLSelectElement} */ (this.field_("matches"))
				.value;
			if (value) this.select_(Number(value), true);
		});
		handler.listen(
			this.field_("dependencies"),
			"click",
			(/** !BrowserEvent */ event) => {
				const target = /** @type {!Element} */ (event.target).closest(
					"[data-query-target]",
				);
				if (target)
					this.select_(Number(target.getAttribute("data-query-target")), true);
			},
		);
		handler.listen(this.field_("fit"), "click", () => this.fit_());
		handler.listen(this.field_("zoom-in"), "click", () => this.zoom_(1.25));
		handler.listen(this.field_("zoom-out"), "click", () => this.zoom_(0.8));
		const dialog = /** @type {!HTMLDialogElement} */ (this.field_("dialog"));
		handler.listen(this.field_("fullscreen"), "click", () =>
			this.setFullscreen_(!dialog.open),
		);
		handler.listen(dialog, "cancel", (/** !BrowserEvent */ event) => {
			event.preventDefault();
			this.setFullscreen_(false);
		});
		const canvas = this.canvas_();
		this.listenCanvas_(canvas);
		this.resize_ = new ResizeObserver(() => this.schedule_());
		this.resize_.observe(canvas);
	}

	/** @override */
	hide() {
		this.setFullscreen_(false, false);
		super.hide();
	}

	/** @override */
	exitDocument() {
		this.setFullscreen_(false, false);
		this.generation_++;
		cancelAnimationFrame(this.frame_);
		this.frame_ = 0;
		this.resize_?.disconnect();
		this.resize_ = null;
		super.exitDocument();
	}

	/** @private @return {!HTMLCanvasElement} */
	canvas_() {
		return /** @type {!HTMLCanvasElement} */ (this.field_("canvas"));
	}

	/**
	 * @private
	 * @param {string} key
	 * @return {!HTMLElement}
	 */
	field_(key) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector('[data-query="' + key + '"]')
		);
	}

	/** @private @param {!File} file */
	async load_(file) {
		const generation = ++this.generation_;
		const status = this.field_("status");
		status.textContent = "Reading " + file.name + "…";
		status.classList.remove("color-fg-danger");
		try {
			if (file.size > MAX_FILE_BYTES)
				throw new Error("Choose a query protobuf smaller than 256 MiB.");
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (generation !== this.generation_) return;
			let result;
			try {
				result = QueryResult.deserializeBinary(bytes);
			} catch (_error) {
				throw new Error(
					"Choose a binary file exported by bazel query --output=proto.",
				);
			}
			const graph = buildGraph(result, this.includeSources_());
			this.result_ = result;
			this.filename_ = file.name;
			/** @type {!HTMLInputElement} */ (this.field_("search")).value = "";
			this.field_("drop").hidden = true;
			this.field_("viewer").hidden = false;
			this.showGraph_(graph, "");
		} catch (/** @type {*} */ error) {
			if (generation !== this.generation_) return;
			status.textContent =
				"Could not open " +
				file.name +
				". " +
				(error instanceof Error
					? error.message
					: "Choose a Bazel query protobuf.");
			status.classList.add("color-fg-danger");
		}
	}

	/** @private @return {boolean} */
	includeSources_() {
		return /** @type {!HTMLInputElement} */ (this.field_("include-sources"))
			.checked;
	}

	/**
	 * @private
	 * @param {!Graph} graph
	 * @param {string} selected
	 */
	showGraph_(graph, selected) {
		this.graph_ = graph;
		this.selected_ = -1;
		this.field_("detail").hidden = true;
		this.field_("canvas").hidden = !graph.nodes.length;
		this.field_("empty").hidden = graph.nodes.length > 0;
		const status = this.field_("status");
		status.classList.remove("color-fg-danger");
		status.textContent =
			this.filename_ +
			" · " +
			graph.nodes.length.toLocaleString() +
			" targets · " +
			graph.edgeCount.toLocaleString() +
			" dependency edges";
		this.updateMatches_();
		if (selected) {
			const index = graph.nodes.findIndex((node) => node.label === selected);
			if (index >= 0) this.select_(index);
		}
		this.fit_();
	}

	/** @private */
	updateMatches_() {
		if (!this.graph_) return;
		const term = /** @type {!HTMLInputElement} */ (this.field_("search")).value
			.trim()
			.toLowerCase();
		const select = /** @type {!HTMLSelectElement} */ (this.field_("matches"));
		let count = 0;
		select.replaceChildren(
			createDom("option", { "value": "" }, "Select a target"),
		);
		for (let i = 0; i < this.graph_.nodes.length; i++) {
			const node = this.graph_.nodes[i];
			if (
				!node.label.toLowerCase().includes(term) &&
				!node.kind.toLowerCase().includes(term)
			)
				continue;
			if (count++ >= MAX_MATCHES) break;
			select.add(
				/** @type {!HTMLOptionElement} */ (
					createDom("option", { "value": String(i) }, node.label)
				),
			);
		}
		select.disabled = count === 0;
		if (!count) select.options[0].textContent = "No matching targets";
		else if (count > MAX_MATCHES)
			select.options[0].textContent = "First 200 matches";
	}

	/**
	 * @private
	 * @param {number} index
	 * @param {boolean=} center
	 */
	select_(index, center = false) {
		const node = this.graph_?.nodes[index];
		if (!node || !this.graph_) return;
		this.selected_ = index;
		this.field_("detail").hidden = false;
		this.field_("label").textContent = node.label;
		this.field_("location").textContent =
			node.kind + (node.location ? " · " + node.location : "");
		const dependencies = this.field_("dependencies");
		dependencies.replaceChildren(
			createDom(
				"h3",
				"text-small text-bold",
				"Dependencies in this query (" + node.edges.length + ")",
			),
		);
		if (node.edges.length) {
			const list = createDom("ul", "query-dependencies");
			for (const edge of node.edges) {
				list.appendChild(
					createDom(
						"li",
						null,
						createDom(
							"button",
							{
								"class": "btn-link text-small text-left",
								"type": "button",
								"data-query-target": String(edge),
							},
							this.graph_.nodes[edge].label,
						),
					),
				);
			}
			dependencies.appendChild(list);
		}
		if (center) {
			const canvas = this.canvas_();
			this.scale_ = Math.max(0.85, this.scale_);
			this.x_ = canvas.clientWidth / 2 - node.x * this.scale_;
			this.y_ = canvas.clientHeight / 2 - node.y * this.scale_;
		}
		this.schedule_();
	}

	/** @private */
	fit_() {
		const graph = this.graph_;
		if (!graph?.nodes.length) return;
		const canvas = this.canvas_();
		this.needsFit_ = !canvas.clientWidth || !canvas.clientHeight;
		if (this.needsFit_) return;
		this.scale_ = Math.min(
			1.1,
			canvas.clientWidth / graph.width,
			canvas.clientHeight / graph.height,
		);
		this.x_ = (canvas.clientWidth - graph.width * this.scale_) / 2;
		this.y_ = (canvas.clientHeight - graph.height * this.scale_) / 2;
		this.schedule_();
	}

	/**
	 * @private
	 * @param {boolean} open
	 * @param {boolean=} focus
	 */
	setFullscreen_(open, focus = true) {
		const dialog = /** @type {!HTMLDialogElement} */ (this.field_("dialog"));
		if (dialog.open === open) return;
		const content = this.field_("content");
		const button = this.field_("fullscreen");
		const canvas = this.canvas_();
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		content.classList.toggle("PageLayout-content", !open);
		if (open) {
			dialog.appendChild(content);
			dialog.showModal();
		} else {
			dialog.before(content);
			dialog.close();
		}
		button.textContent = open ? "Exit full screen" : "Full screen";
		if (focus) button.focus({ preventScroll: true });
		this.x_ += (canvas.clientWidth - width) / 2;
		this.y_ += (canvas.clientHeight - height) / 2;
		this.schedule_();
	}

	/**
	 * @private
	 * @param {number} factor
	 * @param {number=} x
	 * @param {number=} y
	 */
	zoom_(
		factor,
		x = this.canvas_().clientWidth / 2,
		y = this.canvas_().clientHeight / 2,
	) {
		const next = Math.max(
			Math.min(0.04, this.scale_),
			Math.min(3, this.scale_ * factor),
		);
		const ratio = next / this.scale_;
		this.x_ = x - (x - this.x_) * ratio;
		this.y_ = y - (y - this.y_) * ratio;
		this.scale_ = next;
		this.schedule_();
	}

	/** @private @param {!HTMLCanvasElement} canvas */
	listenCanvas_(canvas) {
		const handler = this.getHandler();
		/** @type {!Map<number, {x: number, y: number}>} */
		const pointers = new Map();
		/** @type {boolean} */
		let moved = false;
		handler.listen(canvas, "wheel", (/** !BrowserEvent */ event) => {
			const wheel = /** @type {!WheelEvent} */ (event.getBrowserEvent());
			if (!wheel.deltaY) return;
			event.preventDefault();
			const units =
				wheel.deltaMode === 1
					? 16
					: wheel.deltaMode === 2
						? canvas.clientHeight
						: 1;
			const delta = Math.max(-200, Math.min(200, wheel.deltaY * units));
			this.zoom_(
				Math.exp(-delta * (wheel.ctrlKey ? 0.01 : 0.0025)),
				wheel.offsetX,
				wheel.offsetY,
			);
		});
		handler.listen(canvas, "pointerdown", (/** !BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			if (pointer.button !== 0 || pointers.size >= 2) return;
			if (pointers.size && pointer.pointerType !== "touch") return;
			canvas.setPointerCapture(pointer.pointerId);
			moved = pointers.size > 0;
			pointers.set(pointer.pointerId, {
				x: pointer.clientX,
				y: pointer.clientY,
			});
		});
		handler.listen(canvas, "pointermove", (/** !BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			const point = pointers.get(pointer.pointerId);
			if (!point) return;
			const dx = pointer.clientX - point.x;
			const dy = pointer.clientY - point.y;
			if (!moved && Math.hypot(dx, dy) < 4) return;
			moved = true;
			if (pointers.size === 2) {
				for (const [id, other] of pointers) {
					if (id === pointer.pointerId) continue;
					const before = Math.hypot(point.x - other.x, point.y - other.y);
					const after = Math.hypot(
						pointer.clientX - other.x,
						pointer.clientY - other.y,
					);
					const rect = canvas.getBoundingClientRect();
					this.x_ += dx / 2;
					this.y_ += dy / 2;
					if (before >= 1 && after >= 1)
						this.zoom_(
							after / before,
							(pointer.clientX + other.x) / 2 - rect.left,
							(pointer.clientY + other.y) / 2 - rect.top,
						);
				}
			} else {
				this.x_ += dx;
				this.y_ += dy;
			}
			point.x = pointer.clientX;
			point.y = pointer.clientY;
			this.schedule_();
		});
		handler.listen(canvas, "pointerup", (/** !BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			if (!pointers.has(pointer.pointerId)) return;
			pointers.delete(pointer.pointerId);
			if (moved || !this.graph_) return;
			const x = (pointer.offsetX - this.x_) / this.scale_;
			const y = (pointer.offsetY - this.y_) / this.scale_;
			this.select_(
				this.graph_.nodes.findIndex(
					(node) =>
						Math.abs(x - node.x) <= NODE_WIDTH / 2 &&
						Math.abs(y - node.y) <= NODE_HEIGHT / 2,
				),
			);
		});
		handler.listen(
			canvas,
			["pointercancel", "lostpointercapture"],
			(/** !BrowserEvent */ event) => {
				const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
				pointers.delete(pointer.pointerId);
			},
		);
		handler.listen(canvas, "keydown", (/** !BrowserEvent */ event) => {
			if (event.altKey || event.ctrlKey || event.metaKey) return;
			switch (event.key) {
				case "ArrowLeft":
					this.x_ += 48;
					break;
				case "ArrowRight":
					this.x_ -= 48;
					break;
				case "ArrowUp":
					this.y_ += 48;
					break;
				case "ArrowDown":
					this.y_ -= 48;
					break;
				case "+":
				case "=":
					this.zoom_(1.25);
					break;
				case "-":
					this.zoom_(0.8);
					break;
				default:
					return;
			}
			event.preventDefault();
			this.schedule_();
		});
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
		const graph = this.graph_;
		const canvas = this.canvas_();
		if (!graph || !canvas.clientWidth || !canvas.clientHeight) return;
		if (this.needsFit_) this.fit_();
		const context = /** @type {?CanvasRenderingContext2D} */ (
			canvas.getContext("2d")
		);
		if (!context) return;
		const ratio = window.devicePixelRatio || 1;
		const width = Math.round(canvas.clientWidth * ratio);
		const height = Math.round(canvas.clientHeight * ratio);
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, width, height);
		context.setTransform(
			this.scale_ * ratio,
			0,
			0,
			this.scale_ * ratio,
			this.x_ * ratio,
			this.y_ * ratio,
		);
		const style = getComputedStyle(canvas);
		const border = style.getPropertyValue("--action-query-border");
		const accent = style.getPropertyValue("--action-query-accent");
		const background = style.getPropertyValue("--action-query-node");
		const muted = style.getPropertyValue("--action-query-muted");
		const text = style.color;
		const left = -this.x_ / this.scale_;
		const top = -this.y_ / this.scale_;
		const right = left + canvas.clientWidth / this.scale_;
		const bottom = top + canvas.clientHeight / this.scale_;
		context.lineWidth = Math.max(1, 1 / this.scale_);
		graph.nodes.forEach((node, index) => {
			const x = node.x + NODE_WIDTH / 2;
			for (const edge of node.edges) {
				const to = graph.nodes[edge];
				const end = to.x - NODE_WIDTH / 2;
				if (
					end < left ||
					x > right ||
					Math.max(node.y, to.y) < top ||
					Math.min(node.y, to.y) > bottom
				)
					continue;
				const middle = (x + end) / 2;
				context.strokeStyle =
					index === this.selected_ || edge === this.selected_ ? accent : border;
				context.beginPath();
				context.moveTo(x, node.y);
				context.bezierCurveTo(middle, node.y, middle, to.y, end, to.y);
				context.stroke();
				if (this.scale_ >= 0.2) {
					context.fillStyle = context.strokeStyle;
					context.beginPath();
					context.moveTo(end, to.y);
					context.lineTo(end - 8, to.y - 4);
					context.lineTo(end - 8, to.y + 4);
					context.fill();
				}
			}
		});
		graph.nodes.forEach((node, index) => {
			const x = node.x - NODE_WIDTH / 2;
			const y = node.y - NODE_HEIGHT / 2;
			if (
				x + NODE_WIDTH < left ||
				x > right ||
				y + NODE_HEIGHT < top ||
				y > bottom
			)
				return;
			context.fillStyle = background;
			context.fillRect(x, y, NODE_WIDTH, NODE_HEIGHT);
			context.strokeStyle = index === this.selected_ ? accent : border;
			context.strokeRect(x, y, NODE_WIDTH, NODE_HEIGHT);
			context.fillStyle = node.color;
			context.fillRect(x, y, 4, NODE_HEIGHT);
			context.save();
			context.beginPath();
			context.rect(x + 10, y, NODE_WIDTH - 20, NODE_HEIGHT);
			context.clip();
			context.fillStyle = text;
			context.font = "600 14px system-ui";
			context.fillText(node.label, x + 10, y + 20);
			if (this.scale_ >= 0.35) {
				context.fillStyle = muted;
				context.font = "12px system-ui";
				context.fillText(node.kind, x + 10, y + 38);
			}
			context.restore();
		});
	}
}

exports = Query;
