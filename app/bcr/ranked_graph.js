/** @fileoverview Shared topological ranking and graph placement. */
goog.module("bcrfrontend.rankedGraph");

const NODE_WIDTH = 186;
const NODE_HEIGHT = 50;
const DOT_RADIUS = 6;
const COLUMN_GAP = 62;
const ROW_GAP = 20;
const PADDING = 24;

/** @typedef {{rank: number, x: number, y: number, compact: boolean}} */
let Position;

/**
 * @param {!Array<number>} remaining
 * @param {!Array<!Array<number>>} consumers
 * @return {?Array<number>}
 */
function topologicalRanks(remaining, consumers) {
	/** @type {!Array<number>} */
	const ranks = Array.from({ length: remaining.length }, () => 0);
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
 * @param {!Array<number>} ranks
 * @param {!Array<boolean>=} compact
 * @return {{positions: !Array<!Position>, width: number, height: number}}
 */
function placeRanks(ranks, compact = []) {
	/** @type {!Array<!Position>} */
	const positions = [];
	/** @type {!Array<!Array<!Position>>} */
	const layers = [];
	let maxLayerSize = 0;
	for (let i = 0; i < ranks.length; i++) {
		const node = { rank: ranks[i], compact: Boolean(compact[i]), x: 0, y: 0 };
		positions.push(node);
		const layer = layers[node.rank] ?? (layers[node.rank] = []);
		layer.push(node);
		maxLayerSize = Math.max(maxLayerSize, layer.length);
	}
	// Wrap wide layers into several columns, preserving the order of layers.
	const rowLimit = Math.max(
		8,
		Math.ceil(
			Math.sqrt(
				(maxLayerSize * (NODE_WIDTH + COLUMN_GAP)) / (NODE_HEIGHT + ROW_GAP),
			),
		),
	);
	/** @type {number} */
	let columnLeft = PADDING;
	let height = 0;
	for (const layer of layers) {
		for (let start = 0; start < layer.length; start += rowLimit) {
			const column = layer.slice(start, start + rowLimit);
			const columnWidth = column.every((node) => node.compact)
				? DOT_RADIUS * 2
				: NODE_WIDTH;
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
	const width = positions.length ? columnLeft - COLUMN_GAP + PADDING : 0;
	return { positions, width, height };
}

exports = {
	NODE_WIDTH,
	NODE_HEIGHT,
	DOT_RADIUS,
	COLUMN_GAP,
	PADDING,
	topologicalRanks,
	placeRanks,
};
