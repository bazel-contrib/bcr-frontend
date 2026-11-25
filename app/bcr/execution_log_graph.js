/** @fileoverview Canvas for execution log dependency graphs. */
goog.module("bcrfrontend.executionLogGraph");

/**
 * @typedef {{color: string, cached: boolean, failed: boolean, duration: ?number}}
 */
let GraphSide;

/**
 * @typedef {{
 *   label: string, unchanged: boolean, a: ?GraphSide, b: ?GraphSide,
 *   inputs: !Set<number>, x: number, y: number, radius: number,
 * }}
 */
let GraphNode;

/**
 * Lay out weakly connected components separately. Assign dependency ranks
 * within each component, then place any cycles in the remaining column.
 * @param {!Array<!GraphNode>} nodes
 * @return {{width: number, height: number}}
 */
function layout(nodes) {
	/** @type {!Array<!Array<number>>} */
	const consumers = Array.from({length: nodes.length}, () => []);
	const pending = new Int32Array(nodes.length);
	const ranks = new Int32Array(nodes.length);
	nodes.forEach((node, id) => {
		pending[id] = node.inputs.size;
		for (const producer of node.inputs) consumers[producer].push(id);
		const time = Math.max(node.a?.duration || 0, node.b?.duration || 0);
		node.radius = Math.max(6, Math.min(25, 2 * Math.cbrt(time)));
	});
	const visited = new Uint8Array(nodes.length);
	let left = 24;
	let top = 24;
	let rowBottom = top;
	let width = 0;
	for (let start = 0; start < nodes.length; start++) {
		if (visited[start]) continue;
		/** @type {!Array<number>} */
		const component = [start];
		const discover = (/** number */ id) => {
			if (visited[id]) return;
			visited[id] = 1;
			component.push(id);
		};
		visited[start] = 1;
		for (let i = 0; i < component.length; i++) {
			const id = component[i];
			nodes[id].inputs.forEach(discover);
			consumers[id].forEach(discover);
		}
		const queue = component.filter((id) => pending[id] === 0);
		let lastRank = 0;
		for (let i = 0; i < queue.length; i++) {
			const id = queue[i];
			lastRank = Math.max(lastRank, ranks[id]);
			for (const consumer of consumers[id]) {
				ranks[consumer] = Math.max(ranks[consumer], ranks[id] + 1);
				if (--pending[consumer] === 0) queue.push(consumer);
			}
		}
		/** @type {!Map<number, !Array<number>>} */
		const columns = new Map();
		let maxRows = 0;
		for (const id of component) {
			const rank = pending[id] ? lastRank + 1 : ranks[id];
			const entries = columns.get(rank) || [];
			entries.push(id);
			columns.set(rank, entries);
			maxRows = Math.max(maxRows, entries.length);
		}
		const rowLimit = Math.max(8, Math.ceil(Math.sqrt(maxRows)));
		let columnCount = 0;
		for (const entries of columns.values()) columnCount += Math.ceil(entries.length / rowLimit);
		if (left > 24 && left + columnCount * 142 > 1150) {
			left = 24;
			top = rowBottom + 30;
		}
		/** @type {!Array<number>} */
		const columnKeys = Array.from(columns.keys());
		columnKeys.sort((a, b) => a - b);
		let x = left + 68;
		for (const rank of columnKeys) {
			const entries = /** @type {!Array<number>} */ (columns.get(rank));
			for (let i = 0; i < entries.length; i++) {
				const node = nodes[entries[i]];
				node.x = x + Math.floor(i / rowLimit) * 142;
				node.y = top + 30 + i % rowLimit * 76;
				rowBottom = Math.max(rowBottom, node.y + 42);
			}
			x += Math.ceil(entries.length / rowLimit) * 142;
		}
		left += columnCount * 142 + 18;
		width = Math.max(width, left);
	}
	return {width, height: rowBottom + 24};
}

class ExecutionLogGraph {
	/**
	 * @param {!HTMLCanvasElement} canvas
	 * @param {function(number):void} onSelect
	 */
	constructor(canvas, onSelect) {
		/** @private @const */
		this.canvas_ = canvas;
		/** @private @const */
		this.onSelect_ = onSelect;
		/** @private {!Array<!GraphNode>} */
		this.nodes_ = [];
		/** @private */
		this.width_ = 1;
		/** @private */
		this.height_ = 1;
		/** @private */
		this.x_ = 0;
		/** @private */
		this.y_ = 0;
		/** @private */
		this.scale_ = 1;
		/** @private */
		this.selected_ = -1;
		/** @private */
		this.frame_ = 0;
		/** @private {?{id:number, x:number, y:number, moved:boolean}} */
		this.pointer_ = null;
	}

	/** @param {!Array<!GraphNode>} nodes */
	setNodes(nodes) {
		this.nodes_ = nodes;
		const bounds = layout(nodes);
		this.width_ = bounds.width || 1;
		this.height_ = bounds.height || 1;
		this.selected_ = -1;
		this.fit();
	}

	fit() {
		const canvas = this.canvas_;
		if (!canvas.clientWidth || !canvas.clientHeight) return;
		this.scale_ = Math.min(1, canvas.clientWidth / this.width_, canvas.clientHeight / this.height_);
		this.x_ = (canvas.clientWidth - this.width_ * this.scale_) / 2;
		this.y_ = (canvas.clientHeight - this.height_ * this.scale_) / 2;
		this.draw();
	}

	/** @param {number} index */
	highlight(index) {
		this.selected_ = index;
		this.draw();
	}

	/** @param {!WheelEvent} event */
	wheel(event) {
		const next = Math.max(Math.min(0.01, this.scale_), Math.min(4, this.scale_ * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
		const ratio = next / this.scale_;
		this.x_ = event.offsetX - (event.offsetX - this.x_) * ratio;
		this.y_ = event.offsetY - (event.offsetY - this.y_) * ratio;
		this.scale_ = next;
		this.draw();
	}

	/** @param {!PointerEvent} event */
	start(event) {
		if (event.button !== 0 || this.pointer_) return;
		this.canvas_.setPointerCapture(event.pointerId);
		this.pointer_ = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
	}

	/** @param {!PointerEvent} event */
	move(event) {
		const pointer = this.pointer_;
		if (!pointer || pointer.id !== event.pointerId) return;
		const dx = event.clientX - pointer.x;
		const dy = event.clientY - pointer.y;
		if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
		pointer.moved = true;
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		this.x_ += dx;
		this.y_ += dy;
		this.draw();
	}

	/** @param {!PointerEvent} event */
	end(event) {
		const pointer = this.pointer_;
		if (!pointer || pointer.id !== event.pointerId) return;
		this.pointer_ = null;
		if (pointer.moved || event.type !== "pointerup") return;
		const x = (event.offsetX - this.x_) / this.scale_;
		const y = (event.offsetY - this.y_) / this.scale_;
		const index = this.nodes_.findIndex((node) =>
			Math.hypot(node.x - x, node.y - y) <= Math.max(node.radius, 5 / this.scale_));
		if (index >= 0) this.onSelect_(index);
	}

	/**
	 * @param {string} key
	 * @return {boolean}
	 */
	key(key) {
		if (!this.nodes_.length) return false;
		switch (key) {
			case "ArrowLeft": this.x_ += 48; break;
			case "ArrowRight": this.x_ -= 48; break;
			case "ArrowUp": this.y_ += 48; break;
			case "ArrowDown": this.y_ -= 48; break;
			case "PageUp":
			case "PageDown": {
				const last = this.nodes_.length - 1;
				const index = key === "PageDown" ? Math.min(last, this.selected_ + 1) :
					this.selected_ < 0 ? last : Math.max(0, this.selected_ - 1);
				const node = this.nodes_[index];
				this.scale_ = Math.max(this.scale_, 0.65);
				this.x_ = this.canvas_.clientWidth / 2 - node.x * this.scale_;
				this.y_ = this.canvas_.clientHeight / 2 - node.y * this.scale_;
				this.onSelect_(index);
				break;
			}
			default: return false;
		}
		this.draw();
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

	/** @private */
	paint_() {
		const canvas = this.canvas_;
		const ctx = /** @type {?CanvasRenderingContext2D} */ (canvas.getContext("2d"));
		if (!ctx || !canvas.clientWidth || !canvas.clientHeight) return;
		const ratio = window.devicePixelRatio || 1;
		const width = Math.round(canvas.clientWidth * ratio);
		const height = Math.round(canvas.clientHeight * ratio);
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const scale = this.scale_;
		ctx.setTransform(scale * ratio, 0, 0, scale * ratio, this.x_ * ratio, this.y_ * ratio);
		const style = getComputedStyle(canvas);
		const muted = style.getPropertyValue("--action-query-muted").trim();
		const border = style.getPropertyValue("--action-query-border").trim();
		const accent = style.getPropertyValue("--action-query-accent").trim();
		const background = style.getPropertyValue("--action-query-node").trim();
		const danger = style.getPropertyValue("--execution-log-error").trim();
		const left = -this.x_ / scale;
		const top = -this.y_ / scale;
		const right = left + canvas.clientWidth / scale;
		const bottom = top + canvas.clientHeight / scale;
		this.nodes_.forEach((to, index) => {
			for (const producer of to.inputs) {
				const from = this.nodes_[producer];
				if (Math.max(from.x, to.x) < left || Math.min(from.x, to.x) > right ||
					Math.max(from.y, to.y) < top || Math.min(from.y, to.y) > bottom) continue;
				const dx = to.x - from.x;
				const dy = to.y - from.y;
				const distance = Math.hypot(dx, dy);
				if (!distance) continue;
				const ux = dx / distance;
				const uy = dy / distance;
				const x = to.x - ux * to.radius;
				const y = to.y - uy * to.radius;
				const color = index === this.selected_ || producer === this.selected_ ? accent : border;
				ctx.strokeStyle = color;
				ctx.lineWidth = Math.max(1, .65 / scale);
				ctx.beginPath();
				ctx.moveTo(from.x + ux * from.radius, from.y + uy * from.radius);
				ctx.lineTo(x, y);
				ctx.stroke();
				if (scale < .18) continue;
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.moveTo(x, y);
				ctx.lineTo(x - ux * 7 + uy * 3, y - uy * 7 - ux * 3);
				ctx.lineTo(x - ux * 7 - uy * 3, y - uy * 7 + ux * 3);
				ctx.fill();
			}
		});
		this.nodes_.forEach((node, index) => {
			const {x, y, radius} = node;
			if (x + 65 < left || x - 65 > right || y + 45 < top || y - radius > bottom) return;
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, 2 * Math.PI);
			ctx.fillStyle = background;
			ctx.fill();
			/** @type {!Array<?GraphSide>} */
			const sides = [node.a, node.b];
			for (let i = 0; i < sides.length; i++) {
				const side = sides[i];
				if (!side) continue;
				const split = node.a && node.b;
				const angle = i === 0 ? Math.PI / 2 : -Math.PI / 2;
				ctx.beginPath();
				ctx.arc(x, y, radius, split ? angle : 0, split ? angle + Math.PI : 2 * Math.PI);
				ctx.closePath();
				ctx.fillStyle = node.unchanged ? muted : side.color || muted;
				ctx.globalAlpha = node.unchanged ? .25 : side.cached ? .38 : 1;
				ctx.fill();
			}
			ctx.globalAlpha = 1;
			if (node.a?.failed || node.b?.failed || index === this.selected_) {
				ctx.beginPath();
				ctx.arc(x, y, radius, 0, 2 * Math.PI);
				ctx.strokeStyle = node.a?.failed || node.b?.failed ? danger : accent;
				ctx.lineWidth = Math.max(2, 1.2 / scale);
				ctx.stroke();
			}
			if (scale < .36) return;
			ctx.textAlign = "center";
			ctx.font = "12px " + style.fontFamily;
			ctx.fillStyle = node.unchanged ? muted : style.color;
			ctx.fillText(node.label, x, y + radius + 15, 128);
		});
	}
}

exports = {ExecutionLogGraph, GraphNode, GraphSide};
