/**
 * @fileoverview Viewer for Bazel's binary aquery action graph.
 */
goog.module("bcrfrontend.ActionQuery");

const Action = goog.requireType("proto.analysis.Action");
const ActionGraphContainer = goog.require("proto.analysis.ActionGraphContainer");
const PathFragment = goog.requireType("proto.analysis.PathFragment");
const dom = goog.require("goog.dom");
const events = goog.requireType("goog.events");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { actionQuery } = goog.require("soy.bcrfrontend.actionQuery");
const { mnemonicColor } = goog.require("bcrfrontend.actionColors");
const { renderMnemonicFilters } = goog.require("bcrfrontend.mnemonicFilters");

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const NODE_WIDTH = 186;
const NODE_HEIGHT = 50;
const DOT_RADIUS = 6;
const COLUMN_GAP = 62;
const ROW_GAP = 20;
const PADDING = 24;
const TITLE_SCALE = 0.35;
const DETAILS_SCALE = 0.5;
const SUBGRAPH_INSET = 20;
const MAX_SUBGRAPH_HEIGHT = 2048;

/** @typedef {{x: number, y: number, scale: number, maxScale: number}} */
let GraphViewport;

/**
 * @typedef {{
 *   actionCount: number,
 *   mnemonics: !Map<string, number>,
 *   colors: !Map<string, number>,
 * }}
 */
let PackageSummary;

/**
 * @typedef {{
 *   action: !Action,
 *   packageInfo: ?PackageSummary,
 *   color: string,
 *   compact: boolean,
 *   target: string,
 *   output: string,
 *   inputs: !Set<number>,
 *   consumers: !Array<number>,
 *   rank: number,
 *   x: number,
 *   y: number,
 * }}
 */
let ActionNode;

/**
 * @typedef {{
 *   nodes: !Array<!ActionNode>,
 *   edgeCount: number,
 *   packageView: boolean,
 *   forceDirected: boolean,
 *   width: number,
 *   height: number,
 *   artifactPath: function(number):string,
 * }}
 */
let ActionGraph;

/**
 * Resolve artifact and depset IDs to producer/consumer edges. A query may omit
 * the producers of some inputs. Those inputs contribute no edges.
 *
 * @param {!ActionGraphContainer} container
 * @return {?ActionGraph}
 */
function layoutActionGraph(container) {
	/** @type {!Map<number, string>} */
	const labels = new Map();
	for (const target of container.getTargetsList()) labels.set(target.getId(), target.getLabel());
	/** @type {!Map<number, number>} */
	const artifacts = new Map();
	for (const artifact of container.getArtifactsList()) artifacts.set(artifact.getId(), artifact.getPathFragmentId());
	/** @type {!Map<number, !PathFragment>} */
	const fragments = new Map();
	for (const fragment of container.getPathFragmentsList()) fragments.set(fragment.getId(), fragment);
	/** @type {!Array<!ActionNode>} */
	const nodes = container.getActionsList().map((action) => ({
		action,
		packageInfo: null,
		color: action.getMnemonic() ? mnemonicColor(action.getMnemonic()) : "",
		compact: false,
		target: labels.get(action.getTargetId()) || "",
		output: "",
		inputs: new Set(),
		consumers: [],
		rank: 0,
		x: 0,
		y: 0,
	}));

	/** @type {!Map<number, !Array<number>>} */
	const producers = new Map();
	nodes.forEach(({action}, index) => {
		for (const id of action.getOutputIdsList()) {
			const owners = producers.get(id) || [];
			owners.push(index);
			producers.set(id, owners);
		}
	});
	/** @type {!Map<number, {transitive: !Array<number>, producers: !Array<number>}>} */
	const depsets = new Map();
	for (const depset of container.getDepSetOfFilesList()) {
		depsets.set(depset.getId(), {
			transitive: depset.getTransitiveDepSetIdsList(),
			producers: depset.getDirectArtifactIdsList().flatMap((id) => producers.get(id) || []),
		});
	}

	nodes.forEach((node, index) => {
		const pending = node.action.getInputDepSetIdsList().slice();
		const seen = new Set();
		while (pending.length) {
			const id = /** @type {number} */ (pending.pop());
			if (seen.has(id)) continue;
			seen.add(id);
			const depset = depsets.get(id);
			if (!depset) continue;
			for (const producer of depset.producers) node.inputs.add(producer);
			for (const child of depset.transitive) pending.push(child);
		}
		node.inputs.delete(index);
		for (const producer of node.inputs) nodes[producer].consumers.push(index);
	});

	/**
	 * @param {number} artifactId
	 * @return {string}
	 */
	const artifactPath = (artifactId) => {
		const segments = [];
		const seen = new Set();
		let id = artifacts.get(artifactId);
		while (id && !seen.has(id)) {
			const fragment = fragments.get(id);
			if (!fragment) break;
			seen.add(id);
			segments.push(fragment.getLabel());
			id = fragment.getParentId();
		}
		return segments.length ? segments.reverse().join("/") : "Artifact " + artifactId;
	};

	for (const node of nodes) {
		const primary = node.action.getPrimaryOutputId();
		if (primary) node.output = artifactPath(primary);
	}
	return positionActionNodes(nodes, artifactPath);
}

/**
 * @param {!Array<number>} remaining
 * @param {!Array<!Array<number>>} consumers
 * @return {?Array<number>}
 */
function topologicalRanks(remaining, consumers) {
	/** @type {!Array<number>} */
	const ranks = Array.from({length: remaining.length}, () => 0);
	/** @type {!Array<number>} */
	const ready = [];
	for (let i = 0; i < remaining.length; i++) {
		if (remaining[i] === 0) ready.push(i);
	}
	for (let i = 0; i < ready.length; i++) {
		const producer = ready[i];
		for (const index of consumers[producer]) {
			ranks[index] = Math.max(ranks[index], ranks[producer] + 1);
			if (--remaining[index] === 0) ready.push(index);
		}
	}
	return ready.length === remaining.length ? ranks : null;
}

/**
 * @param {!Array<!ActionNode>} nodes
 * @param {function(number):string} artifactPath
 * @param {boolean=} packageView
 * @return {?ActionGraph}
 */
function positionActionNodes(nodes, artifactPath, packageView = false) {
	/** @type {!Array<number>} */
	const indegrees = nodes.map((node) => node.inputs.size);
	let edgeCount = 0;
	for (const count of indegrees) edgeCount += count;
	const ranks = topologicalRanks(indegrees, nodes.map((node) => node.consumers)) ||
		(packageView ? rankPackageComponents(nodes) : null);
	if (!ranks) return null;
	/** @type {!Array<!Array<!ActionNode>>} */
	const layers = [];
	let maxLayerSize = 0;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		node.rank = ranks[i];
		const layer = layers[node.rank] ?? (layers[node.rank] = []);
		layer.push(node);
		maxLayerSize = Math.max(maxLayerSize, layer.length);
	}
	// Wrap wide layers into several columns, preserving the order of layers.
	const rowLimit = Math.max(8, Math.ceil(Math.sqrt(
		maxLayerSize * (NODE_WIDTH + COLUMN_GAP) / (NODE_HEIGHT + ROW_GAP),
	)));
	/** @type {number} */
	let columnLeft = PADDING;
	let height = 0;
	for (const layer of layers) {
		for (let start = 0; start < layer.length; start += rowLimit) {
			const column = layer.slice(start, start + rowLimit);
			const columnWidth = column.every((node) => node.compact) ? DOT_RADIUS * 2 : NODE_WIDTH;
			let rowTop = PADDING;
			for (const node of column) {
				const rowHeight = node.compact ? DOT_RADIUS * 2 : NODE_HEIGHT;
				node.x = columnLeft + columnWidth / 2;
				node.y = rowTop + rowHeight / 2;
				rowTop += rowHeight + ROW_GAP;
			}
			columnLeft += columnWidth + COLUMN_GAP;
			height = Math.max(height, rowTop - ROW_GAP + PADDING);
		}
	}
	const width = nodes.length ? columnLeft - COLUMN_GAP + PADDING : 0;
	for (const node of nodes) node.x = width - node.x;
	return {nodes, edgeCount, width, height, artifactPath, packageView: !!packageView, forceDirected: false};
}

/**
 * Build a ranked graph of the selected node (at index zero) and its direct connections.
 * @param {!ActionGraph} graph
 * @param {number} selected
 * @return {?ActionGraph}
 */
function selectionGraph(graph, selected) {
	const node = graph.nodes[selected];
	/** @type {!Array<number>} */
	const indices = Array.from(new Set([selected, ...node.inputs, ...node.consumers]));
	/** @type {!Array<!ActionNode>} */
	const nodes = indices.map((index) => ({...graph.nodes[index], inputs: new Set(), consumers: []}));
	for (let i = 1; i < indices.length; i++) {
		if (node.inputs.has(indices[i])) {
			nodes[i].consumers.push(0);
			nodes[0].inputs.add(i);
		}
		if (graph.nodes[indices[i]].inputs.has(selected)) {
			nodes[0].consumers.push(i);
			nodes[i].inputs.add(0);
		}
	}
	return positionActionNodes(nodes, graph.artifactPath, graph.packageView);
}

/**
 * Spring attraction follows dependencies. Nearby spatial cells approximate
 * repulsion so each pass scales with the nodes and edges, including dense graphs.
 * @param {!ActionGraph} graph
 * @param {function():boolean} current
 * @return {!Promise<?ActionGraph>}
 */
async function forceLayout(graph, current) {
	const count = graph.nodes.length;
	if (count < 2) return graph;
	const stepX = NODE_WIDTH + 32;
	const stepY = NODE_HEIGHT + 32;
	const columns = Math.max(2, Math.ceil(Math.sqrt(count * stepY / stepX)));
	const rows = Math.ceil(count / columns);
	const stride = Math.ceil(columns / 2) + 4;
	const x = new Float64Array(count);
	const y = new Float64Array(count);
	const vx = new Float64Array(count);
	const vy = new Float64Array(count);
	const fx = new Float64Array(count);
	const fy = new Float64Array(count);
	const degree = graph.nodes.map((node) => Math.max(1, node.inputs.size + node.consumers.length));

	// Seed with connected actions close to one another, with reproducible offsets.
	const seen = new Uint8Array(count);
	/** @type {!Array<number>} */
	const order = [];
	const enqueue = (/** number */ neighbor) => {
		if (seen[neighbor]) return;
		seen[neighbor] = 1;
		order.push(neighbor);
	};
	for (let i = 0; i < count; i++) {
		if (seen[i]) continue;
		seen[i] = 1;
		let position = order.length;
		order.push(i);
		for (; position < order.length; position++) {
			const node = graph.nodes[order[position]];
			node.inputs.forEach(enqueue);
			node.consumers.forEach(enqueue);
		}
	}
	order.forEach((index, slot) => {
		x[index] = slot % columns + 0.18 * Math.sin(index * 2.4);
		y[index] = Math.floor(slot / columns) + 0.18 * Math.cos(index * 2.4);
	});

	const passes = Math.max(8, Math.min(72, Math.floor(650000 / (count + graph.edgeCount))));
	let sliceStart = performance.now();
	for (let pass = 0; pass < passes; pass++) {
		/** @type {!Map<number, {x: number, y: number, count: number}>} */
		const cells = new Map();
		for (let i = 0; i < count; i++) {
			const key = Math.floor((x[i] + 2) / 2) + stride * Math.floor((y[i] + 2) / 2);
			const cell = cells.get(key) || {x: 0, y: 0, count: 0};
			cell.x += x[i];
			cell.y += y[i];
			cell.count++;
			cells.set(key, cell);
			fx[i] = ((columns - 1) / 2 - x[i]) * 0.006;
			fy[i] = ((rows - 1) / 2 - y[i]) * 0.006;
		}
		for (let i = 0; i < count; i++) {
			const key = Math.floor((x[i] + 2) / 2) + stride * Math.floor((y[i] + 2) / 2);
			for (let row = -1; row <= 1; row++) {
				for (let col = -1; col <= 1; col++) {
					const cell = cells.get(key + row * stride + col);
					if (!cell) continue;
					const self = row === 0 && col === 0 ? 1 : 0;
					const neighbors = cell.count - self;
					if (!neighbors) continue;
					const dx = (x[i] * cell.count - cell.x) / neighbors;
					const dy = (y[i] * cell.count - cell.y) / neighbors;
					const distance = Math.max(0.12, Math.hypot(dx, dy));
					const repulsion = 0.16 * Math.min(neighbors, 6) * Math.max(0, 1.65 - distance) / distance;
					fx[i] += dx * repulsion;
					fy[i] += dy * repulsion;
				}
			}
			for (const j of graph.nodes[i].consumers) {
				const dx = x[j] - x[i];
				const dy = y[j] - y[i];
				const distance = Math.max(0.12, Math.hypot(dx, dy));
				const spring = 0.28 * (distance - 1.3) / (distance * Math.sqrt(Math.max(degree[i], degree[j])));
				fx[i] += dx * spring;
				fy[i] += dy * spring;
				fx[j] -= dx * spring;
				fy[j] -= dy * spring;
			}
		}
		const cooling = 0.1 + 0.4 * (1 - pass / passes);
		for (let i = 0; i < count; i++) {
			vx[i] = Math.max(-cooling, Math.min(cooling, (vx[i] + fx[i]) * 0.58));
			vy[i] = Math.max(-cooling, Math.min(cooling, (vy[i] + fy[i]) * 0.58));
			x[i] = Math.max(-1, Math.min(columns, x[i] + vx[i]));
			y[i] = Math.max(-1, Math.min(rows, y[i] + vy[i]));
		}
		if (performance.now() - sliceStart >= 10) {
			await new Promise((/** function(number):void */ resolve) => requestAnimationFrame(resolve));
			if (!current()) return null;
			sliceStart = performance.now();
		}
	}

	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	// Give every card its own slot near the simulated position. A small offset
	// preserves the shape of the simulation while keeping the card bounds clear.
	/** @type {!Set<number>} */
	const occupied = new Set();
	const reach = 8;
	const slotStride = columns + 2 * reach + 2;
	/** @type {!Array<!ActionNode>} */
	const nodes = [];
	for (let i = 0; i < count; i++) {
		const node = graph.nodes[i];
		const centerX = Math.round(x[i]);
		const centerY = Math.round(y[i]);
		let slotX = i % columns;
		let slotY = rows + reach + 1 + Math.floor(i / columns);
		let best = Infinity;
		for (let radius = 0; radius <= reach && best === Infinity; radius++) {
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
					const col = centerX + dx;
					const row = centerY + dy;
					if (occupied.has(col + row * slotStride)) continue;
					const distance = (col - x[i]) ** 2 + (row - y[i]) ** 2;
					if (distance >= best) continue;
					best = distance;
					slotX = col;
					slotY = row;
				}
			}
		}
		occupied.add(slotX + slotY * slotStride);
		const cx = slotX * stepX + Math.max(-10, Math.min(10, (x[i] - slotX) * stepX));
		const cy = slotY * stepY + Math.max(-10, Math.min(10, (y[i] - slotY) * stepY));
		const halfWidth = node.compact ? DOT_RADIUS : NODE_WIDTH / 2;
		const halfHeight = node.compact ? DOT_RADIUS : NODE_HEIGHT / 2;
		left = Math.min(left, cx - halfWidth);
		top = Math.min(top, cy - halfHeight);
		right = Math.max(right, cx + halfWidth);
		bottom = Math.max(bottom, cy + halfHeight);
		nodes.push(/** @type {!ActionNode} */ ({...node, x: cx, y: cy}));
		if (performance.now() - sliceStart >= 10) {
			await new Promise((/** function(number):void */ resolve) => requestAnimationFrame(resolve));
			if (!current()) return null;
			sliceStart = performance.now();
		}
	}
	for (const node of nodes) {
		node.x += PADDING - left;
		node.y += PADDING - top;
	}
	return {
		nodes,
		edgeCount: graph.edgeCount,
		packageView: graph.packageView,
		artifactPath: graph.artifactPath,
		width: right - left + 2 * PADDING,
		height: bottom - top + 2 * PADDING,
		forceDirected: true,
	};
}

/**
 * A package can both produce for and consume from another package, even when
 * the action graph is acyclic. Rank strongly connected components together.
 * @param {!Array<!ActionNode>} nodes
 * @return {!Array<number>}
 */
function rankPackageComponents(nodes) {
	const visited = new Uint8Array(nodes.length);
	/** @type {!Array<number>} */
	const finished = [];
	for (let start = 0; start < nodes.length; start++) {
		/** @type {!Array<number>} */
		const pending = [start];
		while (pending.length) {
			const node = /** @type {number} */ (pending.pop());
			if (node < 0) {
				finished.push(~node);
			} else if (!visited[node]) {
				visited[node] = 1;
				pending.push(~node);
				for (const consumer of nodes[node].consumers) pending.push(consumer);
			}
		}
	}
	const component = new Int32Array(nodes.length).fill(-1);
	let count = 0;
	for (let i = finished.length - 1; i >= 0; i--) {
		const start = finished[i];
		if (component[start] >= 0) continue;
		/** @type {!Array<number>} */
		const pending = [start];
		component[start] = count;
		while (pending.length) {
			const node = /** @type {number} */ (pending.pop());
			for (const input of nodes[node].inputs) {
				if (component[input] >= 0) continue;
				component[input] = count;
				pending.push(input);
			}
		}
		count++;
	}
	/** @type {!Array<!Set<number>>} */
	const links = Array.from({length: count}, () => new Set());
	/** @type {!Array<number>} */
	const indegrees = Array.from({length: count}, () => 0);
	nodes.forEach((node, index) => {
		const from = component[index];
		for (const consumer of node.consumers) {
			const to = component[consumer];
			if (from === to || links[from].has(to)) continue;
			links[from].add(to);
			indegrees[to]++;
		}
	});
	const ranks = /** @type {!Array<number>} */ (topologicalRanks(indegrees, links.map((link) => Array.from(link))));
	return nodes.map((_, index) => ranks[component[index]]);
}

/**
 * @param {string} target
 * @return {string}
 */
function packageLabel(target) {
	const label = /^(?:@@?[^/:]*)?\/\/[^:]*/.exec(target)?.[0];
	return label ? label.replace(/^@@?(?=\/\/)/, "") : "Unknown package";
}

/**
 * @param {!ActionGraph} graph
 * @return {!ActionGraph}
 */
function groupByPackage(graph) {
	/** @type {!Array<!ActionNode>} */
	const packages = [];
	/** @type {!Map<string, number>} */
	const indices = new Map();
	/** @type {!Array<number>} */
	const membership = graph.nodes.map((actionNode) => {
		const label = packageLabel(actionNode.target);
		let index = indices.get(label);
		if (index === undefined) {
			index = packages.length;
			indices.set(label, index);
			packages.push({
				// Keep one action for selection when returning to the Actions view.
				action: actionNode.action,
				packageInfo: {actionCount: 0, mnemonics: new Map(), colors: new Map()},
				color: "",
				compact: false,
				target: label,
				output: "",
				inputs: new Set(),
				consumers: [],
				rank: 0,
				x: 0,
				y: 0,
			});
		}
		const info = /** @type {!PackageSummary} */ (packages[index].packageInfo);
		const mnemonic = actionNode.action.getMnemonic();
		info.actionCount++;
		info.mnemonics.set(mnemonic, (info.mnemonics.get(mnemonic) || 0) + 1);
		info.colors.set(actionNode.color, (info.colors.get(actionNode.color) || 0) + 1);
		return index;
	});
	graph.nodes.forEach((node, index) => {
		const to = membership[index];
		for (const input of node.inputs) {
			const from = membership[input];
			if (from === to || packages[to].inputs.has(from)) continue;
			packages[to].inputs.add(from);
			packages[from].consumers.push(to);
		}
	});
	return /** @type {!ActionGraph} */ (positionActionNodes(packages, graph.artifactPath, true));
}

/**
 * Keep forks and joins based on the original edges, so toggling a neighboring
 * mnemonic cannot remove a branch point. Reconnect through suppressed chains.
 *
 * @param {!ActionGraph} graph
 * @param {!Set<string>} suppressed
 * @return {!ActionGraph}
 */
function suppressActions(graph, suppressed) {
	if (!suppressed.size) return graph;
	/** @type {!Array<!ActionNode>} */
	const nodes = [];
	/** @type {!Array<number>} */
	const visible = graph.nodes.map((node) => {
		const compact = suppressed.has(node.action.getMnemonic());
		if (compact && node.inputs.size <= 1 && node.consumers.length <= 1) {
			return -1;
		}
		const index = nodes.length;
		nodes.push({
			action: node.action,
			packageInfo: null,
			color: node.color,
			compact,
			target: node.target,
			output: node.output,
			inputs: new Set(),
			consumers: [],
			rank: 0,
			x: 0,
			y: 0,
		});
		return index;
	});
	graph.nodes.forEach((node, originalIndex) => {
		const consumer = visible[originalIndex];
		if (consumer === -1) return;
		for (const input of node.inputs) {
			let producer = input;
			while (producer !== -1 && visible[producer] === -1) {
				const previous = graph.nodes[producer].inputs.values().next();
				producer = previous.done ? -1 : previous.value;
			}
			if (producer !== -1) nodes[consumer].inputs.add(visible[producer]);
		}
		for (const producer of nodes[consumer].inputs) nodes[producer].consumers.push(consumer);
	});

	// Removing nodes and contracting paths in a DAG cannot introduce a cycle.
	return /** @type {!ActionGraph} */ (positionActionNodes(nodes, graph.artifactPath));
}

class ActionQuery extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
		/** @private {?ActionGraph} */
		this.graph_ = null;
		/** @private {?ActionGraph} */
		this.sourceGraph_ = null;
		/** @private */
		this.packages_ = false;
		/** @private */
		this.forceDirected_ = false;
		/** @private */
		this.layoutRevision_ = 0;
		/** @private */
		this.filename_ = "";
		/** @private @const {!Set<string>} */
		this.suppressed_ = new Set();
		/** @private {?ResizeObserver} */
		this.observer_ = null;
		/** @private {?HTMLCanvasElement} */
		this.canvas_ = null;
		/** @private {?HTMLCanvasElement} */
		this.subgraphCanvas_ = null;
		/** @private {?ActionGraph} */
		this.subgraph_ = null;
		/** @private */
		this.subgraphWidth_ = 0;
		/** @private */
		this.upload_ = 0;
		/** @private */
		this.frame_ = 0;
		/** @private */
		this.needsFit_ = false;
		/** @private */
		this.selected_ = -1;
		/** @private @const {!GraphViewport} */
		this.viewport_ = {x: 0, y: 0, scale: 1, maxScale: 3};
		/** @private @const {!GraphViewport} */
		this.subgraphViewport_ = {x: 0, y: 0, scale: 1, maxScale: 3};
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(actionQuery));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const content = this.queryElement_("action-query-content");
		const input = /** @type {!HTMLInputElement} */ (this.queryElement_("action-query-file"));
		const canvas = /** @type {!HTMLCanvasElement} */ (this.queryElement_("action-query-canvas"));
		const fullscreen = /** @type {!HTMLDialogElement} */ (this.queryElement_("action-query-fullscreen-dialog"));
		const layout = /** @type {!HTMLSelectElement} */ (this.queryElement_("action-query-layout"));
		const placement = /** @type {!HTMLSelectElement} */ (this.queryElement_("action-query-placement"));
		this.canvas_ = canvas;
		const subgraphCanvas = /** @type {!HTMLCanvasElement} */ (this.queryElement_("action-query-subgraph-canvas"));
		this.subgraphCanvas_ = subgraphCanvas;
		const handler = this.getHandler();
		handler.listen(this.queryElement_("action-query-choose"), "click", () => input.click());
		handler.listen(this.queryElement_("action-query-replace"), "click", () => input.click());
		handler.listen(layout, "change", () => {
			this.packages_ = layout.value === "packages";
			const source = this.sourceGraph_;
			if (source) this.updateGraph_(suppressActions(source, this.suppressed_));
		});
		handler.listen(placement, "change", () => {
			this.forceDirected_ = placement.value === "force-directed";
			const source = this.sourceGraph_;
			if (source) this.updateGraph_(suppressActions(source, this.suppressed_));
		});
		handler.listen(input, "change", () => {
			const file = input.files?.[0];
			input.value = "";
			if (file) this.load_(file);
		});
		handler.listen(this.queryElement_("action-query-mnemonics"), "change", (/** !events.BrowserEvent */ event) => {
			const checkbox = /** @type {!HTMLInputElement} */ (event.target);
			const source = this.sourceGraph_;
			if (!source) return;
			if (checkbox.checked) this.suppressed_.delete(checkbox.value);
			else this.suppressed_.add(checkbox.value);
			this.updateGraph_(suppressActions(source, this.suppressed_));
		});
		handler.listen(content, ["dragenter", "dragover"], (/** !events.BrowserEvent */ event) => {
			const drag = /** @type {!DragEvent} */ (event.getBrowserEvent());
			if (!drag.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			drag.dataTransfer.dropEffect = "copy";
			content.classList.add("is-dragging");
		});
		handler.listen(content, "dragleave", (/** !events.BrowserEvent */ event) => {
			if (!content.contains(/** @type {?Node} */ (event.relatedTarget))) {
				content.classList.remove("is-dragging");
			}
		});
		handler.listen(content, "drop", (/** !events.BrowserEvent */ event) => {
			const drop = /** @type {!DragEvent} */ (event.getBrowserEvent());
			content.classList.remove("is-dragging");
			if (!drop.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			const file = drop.dataTransfer.files[0];
			if (file) this.load_(file);
		});

		handler.listen(this.queryElement_("action-query-fit"), "click", () => this.fit_());
		handler.listen(this.queryElement_("action-query-zoom-in"), "click", () => this.zoom_(canvas, this.viewport_, 1.25));
		handler.listen(this.queryElement_("action-query-zoom-out"), "click", () => this.zoom_(canvas, this.viewport_, 0.8));
		handler.listen(this.queryElement_("action-query-subgraph-fit"), "click", () => this.fitSubgraph_());
		handler.listen(this.queryElement_("action-query-subgraph-zoom-in"), "click",
			() => this.zoom_(subgraphCanvas, this.subgraphViewport_, 1.25));
		handler.listen(this.queryElement_("action-query-subgraph-zoom-out"), "click",
			() => this.zoom_(subgraphCanvas, this.subgraphViewport_, 0.8));
		handler.listen(this.queryElement_("action-query-fullscreen"), "click", () => this.setFullscreen_(!fullscreen.open));
		handler.listen(fullscreen, "cancel", (/** !events.BrowserEvent */ event) => {
			event.preventDefault();
			this.setFullscreen_(false);
		});
		this.listenCanvas_(canvas, this.viewport_, (x, y) => this.pick_(x, y));
		this.listenCanvas_(subgraphCanvas, this.subgraphViewport_);
		// Handle graph navigation before the app's page-level bracket shortcuts.
		handler.listen(document, "keydown", (/** !events.BrowserEvent */ event) => {
			if ((event.key !== "[" && event.key !== "]") || event.altKey || event.ctrlKey || event.metaKey ||
				event.defaultPrevented || document.activeElement?.closest("input, textarea, select, [contenteditable]")) return;
			if (!this.stepSelection_(event.key === "]", true)) return;
			event.preventDefault();
			event.stopPropagation();
		}, true);
		this.observer_ = new ResizeObserver(() => {
			if (this.needsFit_) this.fit_();
			if (subgraphCanvas.clientWidth !== this.subgraphWidth_) this.fitSubgraph_();
			this.scheduleDraw_();
		});
		this.observer_.observe(canvas);
		this.observer_.observe(subgraphCanvas);
	}

	/**
	 * @private
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!GraphViewport} viewport
	 * @param {function(number, number):void=} pick
	 */
	listenCanvas_(canvas, viewport, pick) {
		const handler = this.getHandler();
		/** @type {?{id: number, x: number, y: number, originX: number, originY: number, moved: boolean}} */
		let drag = null;
		handler.listen(canvas, "wheel", (/** !events.BrowserEvent */ event) => {
			event.preventDefault();
			const wheel = /** @type {!WheelEvent} */ (event.getBrowserEvent());
			this.zoom_(canvas, viewport, wheel.deltaY < 0 ? 1.12 : 1 / 1.12, wheel.offsetX, wheel.offsetY);
		});
		handler.listen(canvas, "pointerdown", (/** !events.BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			if (pointer.button !== 0 || drag) return;
			canvas.setPointerCapture(pointer.pointerId);
			drag = {
				id: pointer.pointerId,
				x: pointer.clientX,
				y: pointer.clientY,
				originX: viewport.x,
				originY: viewport.y,
				moved: false,
			};
		});
		handler.listen(canvas, "pointermove", (/** !events.BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			if (!drag || drag.id !== pointer.pointerId) return;
			const dx = pointer.clientX - drag.x;
			const dy = pointer.clientY - drag.y;
			if (!drag.moved && Math.hypot(dx, dy) < 4) return;
			drag.moved = true;
			viewport.x = drag.originX + dx;
			viewport.y = drag.originY + dy;
			this.scheduleDraw_();
		});
		handler.listen(canvas, "pointerup", (/** !events.BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			if (!drag || drag.id !== pointer.pointerId) return;
			const moved = drag.moved;
			drag = null;
			if (!moved && pick) pick(pointer.offsetX, pointer.offsetY);
		});
		handler.listen(canvas, ["pointercancel", "lostpointercapture"], (/** !events.BrowserEvent */ event) => {
			const pointer = /** @type {!PointerEvent} */ (event.getBrowserEvent());
			if (drag?.id === pointer.pointerId) drag = null;
		});
		handler.listen(canvas, "keydown", (/** !events.BrowserEvent */ event) => {
			if (event.altKey || event.ctrlKey || event.metaKey) return;
			if (this.handleCanvasKey_(event.key, canvas, viewport)) event.preventDefault();
		});
	}

	/** @override */
	exitDocument() {
		this.upload_++;
		this.layoutRevision_++;
		this.setFullscreen_(false);
		this.observer_?.disconnect();
		this.observer_ = null;
		cancelAnimationFrame(this.frame_);
		this.frame_ = 0;
		this.canvas_ = null;
		this.subgraphCanvas_ = null;
		super.exitDocument();
	}

	/**
	 * @private
	 * @param {string} id
	 * @return {!HTMLElement}
	 */
	queryElement_(id) {
		return /** @type {!HTMLElement} */ (this.getElementStrict().querySelector("#" + id));
	}

	/**
	 * @private
	 * @param {boolean} open
	 */
	setFullscreen_(open) {
		const dialog = /** @type {!HTMLDialogElement} */ (this.queryElement_("action-query-fullscreen-dialog"));
		const canvas = this.canvas_;
		if (dialog.open === open || !canvas) return;

		const content = this.queryElement_("action-query-content");
		const button = this.queryElement_("action-query-fullscreen");
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
		button.focus({preventScroll: true});

		// Keep the same graph point centered when changing the viewport size.
		this.viewport_.x += (canvas.clientWidth - width) / 2;
		this.viewport_.y += (canvas.clientHeight - height) / 2;
		this.scheduleDraw_();
	}

	/**
	 * @private
	 * @param {!File} file
	 * @return {!Promise<void>}
	 */
	async load_(file) {
		const upload = ++this.upload_;
		const status = this.queryElement_("action-query-status");
		status.hidden = false;
		status.classList.remove("color-fg-danger");
		status.textContent = "Reading " + file.name + "…";
		const showError = (/** string */ message) => {
			status.classList.add("color-fg-danger");
			status.textContent = message;
		};
		if (file.size > MAX_FILE_BYTES) {
			showError("Choose a file of 256 MiB or less.");
			return;
		}

		/** @type {!ArrayBuffer} */
		let buffer;
		try {
			buffer = await file.arrayBuffer();
		} catch (_error) {
			if (upload === this.upload_) showError("Could not read " + file.name + ".");
			return;
		}
		if (upload !== this.upload_) return;

		/** @type {?ActionGraph} */
		let graph;
		try {
			const container = ActionGraphContainer.deserializeBinary(new Uint8Array(buffer));
			if (buffer.byteLength && !container.getActionsList().length && !container.getTargetsList().length &&
				!container.getArtifactsList().length && !container.getDepSetOfFilesList().length &&
				!container.getConfigurationList().length && !container.getAspectDescriptorsList().length &&
				!container.getRuleClassesList().length && !container.getPathFragmentsList().length) {
				throw new Error("No action graph fields");
			}
			graph = layoutActionGraph(container);
		} catch (_error) {
			showError("Choose a binary file from bazel aquery --output=proto.");
			return;
		}
		if (!graph) {
			showError("The action dependencies contain a cycle.");
			return;
		}

		this.sourceGraph_ = graph;
		this.filename_ = file.name;
		this.suppressed_.clear();
		this.selected_ = -1;
		renderMnemonicFilters(this.queryElement_("action-query-mnemonics"), graph.nodes.map((node) => node.action.getMnemonic()));
		this.queryElement_("action-query-filters").hidden = !graph.nodes.length;

		const count = graph.nodes.length;
		const drop = this.queryElement_("action-query-drop");
		const focusGraph = drop.contains(document.activeElement);
		if (!count) this.setFullscreen_(false);
		drop.hidden = count > 0;
		this.queryElement_("action-query-view").hidden = count === 0;
		status.hidden = count > 0;
		status.textContent = count ? "" : file.name + " contains no actions.";
		this.updateGraph_(graph);
		if (count && focusGraph) this.canvas_?.focus({preventScroll: true});
	}

	/**
	 * @private
	 * @param {!ActionGraph} actions
	 */
	updateGraph_(actions) {
		const selected = this.graph_?.nodes[this.selected_];
		const graph = this.packages_ ? groupByPackage(actions) : actions;
		this.graph_ = graph;
		const count = graph.nodes.length;
		const visible = actions.nodes.length;
		const total = this.sourceGraph_?.nodes.length ?? visible;
		const actionCount = visible === total ? visible.toLocaleString() : visible.toLocaleString() + " of " + total.toLocaleString();
		const packages = graph.packageView ? " · " + count.toLocaleString() + (count === 1 ? " package" : " packages") : "";
		this.queryElement_("action-query-summary").textContent = this.filename_ + packages + " · " + actionCount +
			(total === 1 ? " action · " : " actions · ") +
			graph.edgeCount.toLocaleString() + (graph.packageView ? " inter-package" : "") +
			(graph.edgeCount === 1 ? " dependency" : " dependencies");
		this.queryElement_("action-query-graph").hidden = count === 0;
		this.queryElement_("action-query-zoom").hidden = count === 0;
		this.queryElement_("action-query-filter-empty").hidden = count > 0;
		let index = -1;
		if (selected) {
			const label = selected.packageInfo ? selected.target : packageLabel(selected.target);
			index = graph.nodes.findIndex((node) => graph.packageView ? node.target === label : node.action === selected.action);
		}
		this.select_(index);
		this.fit_();
		void this.applyPlacement_(graph);
	}

	/**
	 * @private
	 * @param {!ActionGraph} graph
	 * @return {!Promise<void>}
	 */
	async applyPlacement_(graph) {
		const revision = ++this.layoutRevision_;
		const status = this.queryElement_("action-query-layout-status");
		status.hidden = !this.forceDirected_ || graph.nodes.length < 2;
		if (status.hidden) return;
		status.textContent = "Arranging graph…";
		/** @type {function():boolean} */
		const current = () => revision === this.layoutRevision_;
		const arranged = await forceLayout(graph, current);
		if (!arranged || !current()) return;
		this.graph_ = arranged;
		status.hidden = true;
		this.fit_();
	}

	/** @private */
	fit_() {
		const canvas = this.canvas_;
		const graph = this.graph_;
		this.needsFit_ = !!graph?.nodes.length;
		if (!this.needsFit_ || !graph || !canvas?.clientWidth || !canvas.clientHeight) return;
		this.needsFit_ = false;
		this.viewport_.scale = Math.min(1, canvas.clientWidth / graph.width, canvas.clientHeight / graph.height);
		this.viewport_.x = (canvas.clientWidth - graph.width * this.viewport_.scale) / 2;
		this.viewport_.y = (canvas.clientHeight - graph.height * this.viewport_.scale) / 2;
		this.scheduleDraw_();
	}

	/** @private */
	fitSubgraph_() {
		const canvas = this.subgraphCanvas_;
		const graph = this.subgraph_;
		if (!canvas) return;
		const width = canvas.clientWidth;
		this.subgraphWidth_ = width;
		if (!graph || width <= SUBGRAPH_INSET * 2) return;

		const selected = graph.nodes[0];
		const inSelectedColumn = (/** number */ index) => graph.nodes[index].x === selected.x;
		const sameColumn = selected.consumers.some(inSelectedColumn) || Array.from(selected.inputs).some(inSelectedColumn);
		// The layout includes fixed graph padding. Replace it with screen-space margins
		// and leave room for the bends of any edges between nodes in the same column.
		const graphWidth = graph.width - 2 * PADDING + (sameColumn ? COLUMN_GAP : 0);
		const graphHeight = graph.height - 2 * PADDING;
		const widthScale = (width - SUBGRAPH_INSET * 2) / graphWidth;
		const canvasHeight = Math.ceil(graphHeight * widthScale) + SUBGRAPH_INSET * 2 + canvas.offsetHeight - canvas.clientHeight;
		canvas.style.height = Math.min(MAX_SUBGRAPH_HEIGHT, canvasHeight) + "px";
		const height = canvas.clientHeight;
		const viewport = this.subgraphViewport_;
		viewport.scale = Math.min(widthScale, (height - SUBGRAPH_INSET * 2) / graphHeight);
		viewport.maxScale = Math.max(3, viewport.scale * 3);
		viewport.x = (width - graph.width * viewport.scale) / 2;
		viewport.y = (height - graph.height * viewport.scale) / 2;
		this.scheduleDraw_();
	}

	/**
	 * @private
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!GraphViewport} viewport
	 * @param {number} factor
	 * @param {number=} x
	 * @param {number=} y
	 */
	zoom_(canvas, viewport, factor, x, y) {
		x = x ?? canvas.clientWidth / 2;
		y = y ?? canvas.clientHeight / 2;
		const next = Math.max(Math.min(0.025, viewport.scale), Math.min(viewport.maxScale, viewport.scale * factor));
		viewport.x = x - (x - viewport.x) * next / viewport.scale;
		viewport.y = y - (y - viewport.y) * next / viewport.scale;
		viewport.scale = next;
		this.scheduleDraw_();
	}

	/**
	 * @private
	 * @param {number} x
	 * @param {number} y
	 */
	pick_(x, y) {
		const graph = this.graph_;
		if (!graph) return;
		const gx = (x - this.viewport_.x) / this.viewport_.scale;
		const gy = (y - this.viewport_.y) / this.viewport_.scale;
		const dotHitRadius = Math.max(this.dotRadius_(this.viewport_.scale), Math.min(16, 8 / this.viewport_.scale));
		this.select_(graph.nodes.findIndex((node) => {
			const dx = gx - node.x;
			const dy = gy - node.y;
			return node.compact
				? Math.hypot(dx, dy) <= dotHitRadius
				: Math.abs(dx) <= NODE_WIDTH / 2 && Math.abs(dy) <= NODE_HEIGHT / 2;
		}));
	}

	/**
	 * @private
	 * @param {string} key
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!GraphViewport} viewport
	 * @return {boolean}
	 */
	handleCanvasKey_(key, canvas, viewport) {
		if (!this.graph_?.nodes.length) return false;
		switch (key) {
			case "ArrowLeft": viewport.x += 48; break;
			case "ArrowRight": viewport.x -= 48; break;
			case "ArrowUp": viewport.y += 48; break;
			case "ArrowDown": viewport.y -= 48; break;
			case "+": this.zoom_(canvas, viewport, 1.25); break;
			case "-": this.zoom_(canvas, viewport, 0.8); break;
			case "PageUp": return this.stepSelection_(false, false);
			case "PageDown": return this.stepSelection_(true, false);
			default: return false;
		}
		this.scheduleDraw_();
		return true;
	}

	/**
	 * @private
	 * @param {boolean} forward
	 * @param {boolean} wrap
	 * @return {boolean}
	 */
	stepSelection_(forward, wrap) {
		const canvas = this.canvas_;
		const graph = this.graph_;
		if (!canvas || !graph?.nodes.length) return false;
		const count = graph.nodes.length;
		const next = this.selected_ < 0 ? (forward ? 0 : count - 1) : this.selected_ + (forward ? 1 : -1);
		const index = wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next));
		this.select_(index);
		const node = graph.nodes[index];
		const viewport = this.viewport_;
		viewport.scale = Math.max(viewport.scale, 0.75);
		viewport.x = canvas.clientWidth / 2 - node.x * viewport.scale;
		viewport.y = canvas.clientHeight / 2 - node.y * viewport.scale;
		this.scheduleDraw_();
		return true;
	}

	/**
	 * @private
	 * @param {number} index
	 */
	select_(index) {
		this.selected_ = index;
		const graph = this.graph_;
		const details = this.queryElement_("action-query-details");
		const node = graph?.nodes[index];
		this.subgraph_ = graph && node ? selectionGraph(graph, index) : null;
		this.queryElement_("action-query-subgraph").hidden = !this.subgraph_;
		this.fitSubgraph_();
		const selection = this.queryElement_("action-query-selection");
		const heading = graph?.packageView ? "Selected package" : "Selected action";
		this.queryElement_("action-query-selection-title").textContent = heading;
		selection.setAttribute("aria-label", heading);
		selection.hidden = !node;
		dom.removeChildren(details);
		const packageInfo = node?.packageInfo;
		if (node && packageInfo) {
			this.renderPackageDetails_(details, node, packageInfo);
		} else if (graph && node) {
			const action = node.action;
			const title = dom.createDom("h3", "h4 mb-1", action.getMnemonic() || "Action");
			const target = dom.createDom("div", "mb-2", node.target);
			const producers = node.inputs.size;
			const consumers = node.consumers.length;
			const counts = dom.createDom("p", "text-small color-fg-muted",
				producers + (producers === 1 ? " producer · " : " producers · ") +
				consumers + (consumers === 1 ? " consumer" : " consumers"));
			const platform = action.getExecutionPlatform();
			details.append(title, target, counts);
			if (platform) details.appendChild(dom.createDom("p", "text-small", platform));
			const outputs = action.getOutputIdsList();
			if (outputs.length) {
				details.appendChild(dom.createDom("h4", "h5", "Outputs"));
				const list = dom.createDom("ul", "pl-3 mb-2 text-small action-query-outputs");
				for (const output of outputs) list.appendChild(dom.createDom("li", null, graph.artifactPath(output)));
				details.appendChild(list);
			}
			const args = action.getArgumentsList();
			if (args.length) {
				details.appendChild(dom.createDom("h4", "h5", "Command arguments"));
				details.appendChild(dom.createDom("pre", "action-query-command", args.join("\n")));
			}
		}
		if (graph && node) {
			this.renderConnections_(details, graph, "Producers", Array.from(node.inputs));
			this.renderConnections_(details, graph, "Consumers", node.consumers);
		}
		this.scheduleDraw_();
	}

	/**
	 * @private
	 * @param {!HTMLElement} details
	 * @param {!ActionGraph} graph
	 * @param {string} title
	 * @param {!Array<number>} connections
	 */
	renderConnections_(details, graph, title, connections) {
		if (!connections.length) return;
		const list = dom.createDom("ul", "pl-3 mb-2 text-small action-query-outputs");
		for (const index of connections) {
			const node = graph.nodes[index];
			const label = [
				graph.packageView ? "" : node.action.getMnemonic(),
				node.target,
				node.output,
			].filter(Boolean).join(" · ");
			list.appendChild(dom.createDom("li", null, label || "Action " + (index + 1)));
		}
		details.append(dom.createDom("h4", "h5", title), list);
	}

	/**
	 * @private
	 * @param {!HTMLElement} details
	 * @param {!ActionNode} node
	 * @param {!PackageSummary} info
	 */
	renderPackageDetails_(details, node, info) {
		const producers = node.inputs.size;
		const consumers = node.consumers.length;
		details.append(
			dom.createDom("h3", "h4 mb-1", node.target),
			dom.createDom("p", "text-small color-fg-muted",
				info.actionCount.toLocaleString() + (info.actionCount === 1 ? " action" : " actions")),
			dom.createDom("p", "text-small color-fg-muted",
				producers.toLocaleString() + (producers === 1 ? " producer package · " : " producer packages · ") +
				consumers.toLocaleString() + (consumers === 1 ? " consumer package" : " consumer packages")),
		);
		const list = dom.createDom("ul", "list-style-none action-query-package-mix");
		/** @type {!Array<string>} */
		const mnemonics = Array.from(info.mnemonics.keys());
		mnemonics.sort((a, b) =>
			(info.mnemonics.get(b) || 0) - (info.mnemonics.get(a) || 0) || a.localeCompare(b));
		for (const mnemonic of mnemonics) {
			const count = info.mnemonics.get(mnemonic) || 0;
			const swatch = dom.createDom("span", {"class": "action-query-swatch", "aria-hidden": "true"});
			if (mnemonic) swatch.style.backgroundColor = mnemonicColor(mnemonic);
			list.appendChild(dom.createDom("li", "text-small", swatch,
				dom.createDom("span", null, mnemonic || "(No mnemonic)"),
				dom.createDom("span", "color-fg-muted", count.toLocaleString())));
		}
		details.appendChild(list);
	}

	/** @private */
	scheduleDraw_() {
		if (this.frame_) return;
		this.frame_ = requestAnimationFrame(() => {
			this.frame_ = 0;
			this.draw_();
		});
	}

	/**
	 * @private
	 * @param {number} scale
	 * @return {number}
	 */
	dotRadius_(scale) {
		return Math.max(DOT_RADIUS, Math.min(16, 3 / scale));
	}

	/** @private */
	draw_() {
		if (this.canvas_ && this.graph_) this.drawGraph_(this.canvas_, this.graph_, this.selected_, this.viewport_);
		if (this.subgraphCanvas_ && this.subgraph_) {
			this.drawGraph_(this.subgraphCanvas_, this.subgraph_, 0, this.subgraphViewport_);
		}
	}

	/**
	 * @private
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!ActionGraph} graph
	 * @param {number} selected
	 * @param {!GraphViewport} viewport
	 */
	drawGraph_(canvas, graph, selected, viewport) {
		const {scale, x: originX, y: originY} = viewport;
		if (!canvas.clientWidth || !canvas.clientHeight) return;
		const ctx = /** @type {?CanvasRenderingContext2D} */ (canvas.getContext("2d"));
		if (!ctx) return;

		const ratio = window.devicePixelRatio || 1;
		const width = Math.round(canvas.clientWidth * ratio);
		const height = Math.round(canvas.clientHeight * ratio);
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.setTransform(scale * ratio, 0, 0, scale * ratio, originX * ratio, originY * ratio);
		const style = getComputedStyle(canvas);
		const border = style.getPropertyValue("--action-query-border");
		const accent = style.getPropertyValue("--action-query-accent");
		const inverted = style.getPropertyValue("--action-query-on-accent");
		const background = style.getPropertyValue("--action-query-node");
		const muted = style.getPropertyValue("--action-query-muted");
		const left = -originX / scale;
		const right = left + canvas.clientWidth / scale;
		const top = -originY / scale;
		const bottom = top + canvas.clientHeight / scale;

		// Draw edges first so they pass behind any intervening nodes.
		const dotRadius = this.dotRadius_(scale);
		graph.nodes.forEach((from, index) => {
			for (const consumer of from.consumers) {
				const to = graph.nodes[consumer];
				const dx = to.x - from.x;
				const dy = to.y - from.y;
				const vertical = graph.forceDirected && Math.abs(dy) > Math.abs(dx) * NODE_HEIGHT / NODE_WIDTH;
				const sameColumn = !vertical && dx === 0;
				const fromSide = sameColumn ? (dy > 0 ? -1 : 1) : Math.sign(vertical ? dy : dx);
				const toSide = sameColumn ? fromSide : -fromSide;
				const halfSize = (vertical ? NODE_HEIGHT : NODE_WIDTH) / 2;
				const fromOffset = fromSide * (from.compact ? dotRadius : halfSize);
				const toOffset = toSide * (to.compact ? dotRadius : halfSize);
				const x = from.x + (vertical ? 0 : fromOffset);
				const y = from.y + (vertical ? fromOffset : 0);
				const endX = to.x + (vertical ? 0 : toOffset);
				const endY = to.y + (vertical ? toOffset : 0);
				const midX = (x + endX) / 2 + (sameColumn ? fromSide * COLUMN_GAP / 2 : 0);
				const midY = (y + endY) / 2;
				if (Math.max(x, endX, midX) < left || Math.min(x, endX, midX) > right ||
					Math.min(y, endY) > bottom || Math.max(y, endY) < top) continue;
				const color = index === selected || consumer === selected ? accent : border;
				ctx.strokeStyle = color;
				ctx.lineWidth = Math.max(1.5, 0.6 / scale);
				ctx.beginPath();
				ctx.moveTo(x, y);
				if (vertical) ctx.bezierCurveTo(x, midY, endX, midY, endX, endY);
				else ctx.bezierCurveTo(midX, y, midX, endY, endX, endY);
				ctx.stroke();
				if (scale < 0.16) continue;
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.moveTo(endX, endY);
				if (vertical) {
					ctx.lineTo(endX - 4, endY + toSide * 8);
					ctx.lineTo(endX + 4, endY + toSide * 8);
				} else {
					ctx.lineTo(endX + toSide * 8, endY - 4);
					ctx.lineTo(endX + toSide * 8, endY + 4);
				}
				ctx.fill();
			}
		});

		graph.nodes.forEach((node, index) => {
			if (node.compact) {
				if (node.x + dotRadius < left || node.x - dotRadius > right ||
					node.y + dotRadius < top || node.y - dotRadius > bottom) return;
				ctx.beginPath();
				ctx.arc(node.x, node.y, dotRadius, 0, 2 * Math.PI);
				if (index === selected) {
					ctx.strokeStyle = accent;
					ctx.lineWidth = 4 / scale;
					ctx.stroke();
				}
				// Paint the mnemonic color over the inside of the selection ring.
				ctx.fillStyle = node.color || muted;
				ctx.fill();
				return;
			}
			const x = node.x - NODE_WIDTH / 2;
			const y = node.y - NODE_HEIGHT / 2;
			if (x + NODE_WIDTH < left || x > right || y + NODE_HEIGHT < top || y > bottom) return;
			ctx.fillStyle = index === selected ? accent : background;
			ctx.fillRect(x, y, NODE_WIDTH, NODE_HEIGHT);
			ctx.strokeStyle = index === selected ? accent : border;
			ctx.lineWidth = Math.max(1, 0.8 / scale);
			ctx.strokeRect(x, y, NODE_WIDTH, NODE_HEIGHT);
			const pkg = node.packageInfo;
			if (pkg) {
				let actions = 0;
				for (const [color, count] of pkg.colors) {
					const start = actions / pkg.actionCount * NODE_WIDTH;
					actions += count;
					const end = actions / pkg.actionCount * NODE_WIDTH;
					ctx.fillStyle = color || muted;
					ctx.fillRect(x + start, y, end - start, Math.max(5, 1 / scale));
				}
			} else if (node.color) {
				ctx.fillStyle = node.color;
				ctx.fillRect(x, y, Math.min(NODE_WIDTH, Math.max(5, 1 / scale)), NODE_HEIGHT);
			}
			if (scale < TITLE_SCALE) return;
			ctx.fillStyle = index === selected ? inverted : style.color;
			ctx.font = "600 " + Math.max(14, 7 / scale) + "px " + style.fontFamily;
			const target = node.target;
			const label = target.length > 26 ? "…" + target.slice(-25) : target;
			ctx.fillText(pkg ? label : node.action.getMnemonic() || "Action", x + 10, y + (pkg ? 24 : 20), NODE_WIDTH - 20);
			if (scale < DETAILS_SCALE) return;
			ctx.fillStyle = index === selected ? inverted : muted;
			ctx.font = "12px " + style.fontFamily;
			const subtitle = pkg ? pkg.actionCount.toLocaleString() + (pkg.actionCount === 1 ? " action" : " actions") :
				node.output || target;
			ctx.fillText(subtitle.length > 26 ? "…" + subtitle.slice(-25) : subtitle, x + 10, y + 38, NODE_WIDTH - 20);
		});
	}
}

exports = ActionQuery;
