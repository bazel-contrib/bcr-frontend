/** @fileoverview Render and search Bazel terminal output. */
goog.module("bcrfrontend.invocationTerminal");

const dom = goog.require("goog.dom");

/** @const {number} */
const TERMINAL_LIMIT = 64 * 1024;

/**
 * Convert terminal redraw line endings into displayable lines.
 * @param {string} value
 * @return {string}
 */
function formatTerminalText(value) {
	return value
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const redraws = line.split("\r");
			return redraws[redraws.length - 1];
		})
		.join("\n");
}

/** @const {!Array<string>} */
const ANSI_COLORS = [
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#ffffff",
];

/**
 * @param {number} index
 * @return {string}
 */
function ansi256Color(index) {
	index = Math.max(0, Math.min(255, index));
	if (index < 16) return ANSI_COLORS[index];
	if (index >= 232) {
		const gray = 8 + (index - 232) * 10;
		return "rgb(" + gray + ", " + gray + ", " + gray + ")";
	}
	const value = index - 16;
	const red = Math.floor(value / 36);
	const green = Math.floor((value % 36) / 6);
	const blue = value % 6;
	return (
		"rgb(" +
		ansiCubeChannel(red) +
		", " +
		ansiCubeChannel(green) +
		", " +
		ansiCubeChannel(blue) +
		")"
	);
}

/**
 * @param {number} component
 * @return {number}
 */
function ansiCubeChannel(component) {
	return component === 0 ? 0 : 55 + component * 40;
}

/** @typedef {{foreground: string, background: string, bold: boolean, dim: boolean}} */
let TerminalStyle;

/** @return {!TerminalStyle} */
function defaultTerminalStyle() {
	return { foreground: "", background: "", bold: false, dim: false };
}

/**
 * Render terminal SGR sequences without interpreting the text as markup.
 * Unsupported ANSI control sequences are ignored.
 * @param {string} value
 * @param {!TerminalStyle=} style
 * @return {!HTMLElement}
 */
function renderTerminalText(value, style = defaultTerminalStyle()) {
	const root = /** @type {!HTMLElement} */ (document.createElement("div"));
	let { foreground, background, bold, dim } = style;
	let offset = 0;
	/**
	 * @param {string} text
	 */
	function appendText(text) {
		if (!text) return;
		if (!foreground && !background && !bold && !dim) {
			root.appendChild(document.createTextNode(text));
			return;
		}
		const span = document.createElement("span");
		span.textContent = text;
		if (foreground) span.style.color = foreground;
		if (background) span.style.backgroundColor = background;
		if (bold) span.style.fontWeight = "bold";
		if (dim) span.style.opacity = "0.7";
		root.appendChild(span);
	}
	while (offset < value.length) {
		const escape = value.indexOf("\x1b", offset);
		if (escape < 0) break;
		appendText(value.slice(offset, escape));
		if (value.charAt(escape + 1) !== "[") {
			if (value.charAt(escape + 1) === "]") {
				const bell = value.indexOf("\x07", escape + 2);
				const stringTerminator = value.indexOf("\x1b\\", escape + 2);
				if (bell >= 0 && (stringTerminator < 0 || bell < stringTerminator)) {
					offset = bell + 1;
				} else if (stringTerminator >= 0) {
					offset = stringTerminator + 2;
				} else {
					offset = value.length;
				}
			} else {
				offset = Math.min(value.length, escape + 2);
			}
			continue;
		}
		let finalIndex = escape + 2;
		while (finalIndex < value.length) {
			const character = value.charCodeAt(finalIndex);
			if (character >= 0x40 && character <= 0x7e) break;
			finalIndex++;
		}
		if (finalIndex >= value.length) {
			offset = value.length;
			break;
		}
		offset = finalIndex + 1;
		if (value.charAt(finalIndex) !== "m") continue;
		const parameters = value.slice(escape + 2, finalIndex);
		/** @type {!Array<number>} */
		const codes = [];
		if (!parameters) {
			codes.push(0);
		} else {
			for (const parameter of parameters.split(";")) {
				codes.push(Number(parameter));
			}
		}
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 0) {
				foreground = "";
				background = "";
				bold = false;
				dim = false;
			} else if (code === 1) {
				bold = true;
			} else if (code === 2) {
				dim = true;
			} else if (code === 22) {
				bold = false;
				dim = false;
			} else if (code >= 30 && code <= 37) {
				foreground = ANSI_COLORS[code - 30];
			} else if (code >= 90 && code <= 97) {
				foreground = ANSI_COLORS[code - 90 + 8];
			} else if (code === 39) {
				foreground = "";
			} else if (code >= 40 && code <= 47) {
				background = ANSI_COLORS[code - 40];
			} else if (code >= 100 && code <= 107) {
				background = ANSI_COLORS[code - 100 + 8];
			} else if (code === 49) {
				background = "";
			} else if (
				(code === 38 || code === 48) &&
				codes[i + 1] === 5 &&
				codes[i + 2] !== undefined
			) {
				const color = ansi256Color(codes[i + 2]);
				if (code === 38) foreground = color;
				else background = color;
				i += 2;
			} else if (
				(code === 38 || code === 48) &&
				codes[i + 1] === 2 &&
				codes[i + 4] !== undefined
			) {
				const red = Math.max(0, Math.min(255, codes[i + 2]));
				const green = Math.max(0, Math.min(255, codes[i + 3]));
				const blue = Math.max(0, Math.min(255, codes[i + 4]));
				const color = "rgb(" + red + ", " + green + ", " + blue + ")";
				if (code === 38) foreground = color;
				else background = color;
				i += 4;
			}
		}
	}
	appendText(value.slice(offset));
	Object.assign(style, { foreground, background, bold, dim });
	return root;
}

/** @typedef {{start: number, end: number, number: number}} */
let TerminalMatch;

const TERMINAL_SEARCH_HIGHLIGHT = "bes-terminal-match";

/** @return {?Map<string, !Highlight>} */
function terminalHighlights() {
	// HighlightRegistry is map-like, but the Closure externs omit its set/delete methods.
	const registry = /** @type {?Object} */ (window.CSS?.highlights || null);
	return /** @type {?Map<string, !Highlight>} */ (registry);
}

class InvocationTerminal {
	/** @param {!HTMLElement} root */
	constructor(root) {
		this.root = root;
		this.tail_ = document.createElement("span");
		/** @private @type {number} */
		this.cursor_ = 0;
		/** @private @type {string} */
		this.partial_ = "";
		/** @private @type {!TerminalStyle} */
		this.style_ = defaultTerminalStyle();
		/** @private */ this.query_ = "";
		/** @private */ this.matchOffset_ = -1;
		this.reset();
	}

	reset() {
		this.clearHighlight();
		this.query_ = "";
		this.matchOffset_ = -1;
		this.cursor_ = 0;
		this.partial_ = "";
		this.style_ = defaultTerminalStyle();
		this.root.scrollTop = 0;
		dom.removeChildren(this.root);
		this.tail_.textContent = "No build output received.";
		this.root.appendChild(this.tail_);
	}

	/**
	 * @param {!Array<string>} chunks
	 * @return {boolean} Whether the terminal content changed.
	 */
	update(chunks) {
		if (this.cursor_ === chunks.length) return false;
		const follow =
			this.cursor_ === 0 ||
			this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight <=
				8;
		let pending = this.partial_;
		while (this.cursor_ < chunks.length) {
			pending += chunks[this.cursor_++];
			if (pending.length >= TERMINAL_LIMIT)
				pending = this.appendLines_(pending);
		}
		this.partial_ = this.appendLines_(pending);
		dom.removeChildren(this.tail_);
		const style = /** @type {!TerminalStyle} */ (
			Object.assign(defaultTerminalStyle(), this.style_)
		);
		const lastLine = renderTerminalText(
			formatTerminalText(this.partial_),
			style,
		);
		while (lastLine.firstChild) this.tail_.appendChild(lastLine.firstChild);
		if (follow) this.root.scrollTop = this.root.scrollHeight;
		return true;
	}

	clearHighlight() {
		terminalHighlights()?.delete(TERMINAL_SEARCH_HIGHLIGHT);
	}

	/**
	 * @param {string} query
	 * @param {number=} direction
	 * @param {boolean=} reveal
	 * @return {string} A summary of the current match.
	 */
	search(query, direction = 0, reveal = true) {
		this.clearHighlight();
		if (query !== this.query_) {
			this.query_ = query;
			this.matchOffset_ = -1;
			direction = 0;
		}
		if (!query) return "";
		if (!this.cursor_) return "No matches";
		const text = this.root.textContent || "";
		const pattern = new RegExp(
			query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			"giu",
		);
		/** @type {?TerminalMatch} */ let first = null;
		/** @type {?TerminalMatch} */ let last = null;
		/** @type {?TerminalMatch} */ let active = null;
		let count = 0;
		for (const result of text.matchAll(pattern)) {
			const start = Number(result.index);
			const match = { start, end: start + result[0].length, number: ++count };
			if (!first) first = match;
			last = match;
			if (
				direction < 0
					? start < this.matchOffset_
					: !active && start >= this.matchOffset_ + (direction > 0 ? 1 : 0)
			)
				active = match;
		}
		active = active || (direction < 0 ? last : first);
		if (!active) {
			this.matchOffset_ = -1;
			return "No matches";
		}
		this.matchOffset_ = active.start;
		this.highlightMatch_(active.start, active.end, reveal);
		return active.number.toLocaleString() + " of " + count.toLocaleString();
	}

	/**
	 * @private
	 * @param {number} start
	 * @param {number} end
	 * @param {boolean} reveal
	 */
	highlightMatch_(start, end, reveal) {
		const range = /** @type {!Range} */ (document.createRange());
		const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
		let offset = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const next = offset + (node.nodeValue || "").length;
			if (offset <= start && start < next) range.setStart(node, start - offset);
			if (end <= next) {
				range.setEnd(node, end - offset);
				break;
			}
			offset = next;
		}
		// A document selection can steal focus from the search input as the user types.
		if (typeof Highlight === "function")
			terminalHighlights()?.set(
				TERMINAL_SEARCH_HIGHLIGHT,
				new Highlight(range),
			);
		if (reveal) {
			const match = range.getBoundingClientRect();
			const viewport = this.root.getBoundingClientRect();
			this.root.scrollTop +=
				match.top - viewport.top - (this.root.clientHeight - match.height) / 2;
		}
	}

	/**
	 * @private
	 * @param {string} text
	 * @return {string}
	 */
	appendLines_(text) {
		const end = text.lastIndexOf("\n") + 1;
		if (end === 0) return text;
		const rendered = renderTerminalText(
			formatTerminalText(text.slice(0, end)),
			this.style_,
		);
		const batch = document.createDocumentFragment();
		while (rendered.firstChild) batch.appendChild(rendered.firstChild);
		this.root.insertBefore(batch, this.tail_);
		return text.slice(end);
	}
}

exports.formatTerminalText = formatTerminalText;
exports.renderTerminalText = renderTerminalText;
exports.InvocationTerminal = InvocationTerminal;
exports.TERMINAL_LIMIT = TERMINAL_LIMIT;
