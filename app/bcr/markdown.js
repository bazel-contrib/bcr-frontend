goog.module("bcrfrontend.markdown");

const arrays = goog.require("goog.array");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { SafeHtml, sanitizeHtml } = goog.require(
	"google3.third_party.javascript.safevalues.index",
);
const { copyToClipboardButton } = goog.require("soy.registry");
const {
	octiconAlert16,
	octiconInfo16,
	octiconLightBulb16,
	octiconReport16,
	octiconStop16,
} = goog.require("octicons");
const { getEffectiveColorMode, highlight } = goog.require(
	"bcrfrontend.syntax",
);
const { setElementInnerHtml } = goog.require(
	"google3.third_party.javascript.safevalues.dom.elements.element",
);

const FORMAT_MARKDOWN = true;

/**
 * Component that automatically formats markdown content on render
 */
class MarkdownComponent extends Component {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/** @override */
	enterDocument() {
		super.enterDocument();

		formatMarkdownAll(this.getElementStrict());
	}
}

/**
 * Formats all markdown elements within a root element
 * @param {!Element} rootEl
 */
function formatMarkdownAll(rootEl) {
	if (FORMAT_MARKDOWN) {
		const divEls = dom.findElements(rootEl, (el) =>
			dom.classlist.contains(el, goog.getCssName("marked")),
		);
		arrays.forEach(divEls, formatMarkdown);
	}
}

/**
 * renders a docstring as SafeHtml.
 *
 * @param {!Element} el The element to convert
 * @returns {!SafeHtml} The safe html object
 */
function renderDocstring(el) {
	const text = el.textContent;
	const htmlText = parseMarkdownToHTML(text);
	return sanitizeHtml(htmlText);
}

/**
 * formats a docstring, either as HTML or markdown.
 *
 * @param {!Element} el The element to convert
 */
async function formatMarkdown(el) {
	const mermaidSources = parseMermaidSources(el.textContent);
	setElementInnerHtml(el, renderDocstring(el));

	// Trim whitespace from code blocks in the rendered HTML
	const codeElements = el.querySelectorAll("pre code, code");
	for (const code of codeElements) {
		code.textContent = code.textContent.trim();
	}

	formatAlerts(el);

	// Swap ```mermaid blocks for placeholders before syntax highlighting.
	// Blocks are matched by source text since the sanitizer may strip the
	// language class that marked emits.
	const mermaidEls = [];
	if (mermaidSources.size) {
		for (const pre of el.querySelectorAll("pre")) {
			const source = pre.textContent;
			if (mermaidSources.has(source)) {
				const div = dom.createDom("div", { "class": "mermaid mb-2" }, source);
				dom.replaceNode(div, pre);
				mermaidEls.push(div);
			}
		}
	}
	const mermaidDone = renderMermaid(mermaidEls);

	// Syntax highlight code blocks that have <pre><code> structure
	let preElements = el.querySelectorAll("pre");
	for (const pre of preElements) {
		if (pre.firstElementChild && pre.firstElementChild.tagName === "CODE") {
			if (!pre.firstElementChild.hasAttribute("lang")) {
				pre.firstElementChild.setAttribute("lang", "py");
			}
		} else {
			pre.setAttribute("lang", "py");
		}
		await highlight(pre);
	}

	preElements = el.querySelectorAll("pre");
	for (const pre of preElements) {
		pre.style.position = "relative";
		dom.classlist.addAll(pre, ["border", "color-bg-subtle", "mb-2"]);
		const button = soy.renderAsElement(copyToClipboardButton, {
			content: pre.firstChild.textContent,
		});
		button.style.position = "absolute";
		button.style.right = "4px";
		button.style.top = "4px";
		dom.classlist.addAll(button, ["float-right"]);
		dom.insertChildAt(pre, button, 0);
	}

	await mermaidDone;
	dom.dataset.set(el, "formatted", "markdown");
}

/**
 * Matches a GitHub alert marker such as "[!NOTE]" at the start of a
 * blockquote. The marker must be alone on its line.
 */
const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i;

/**
 * Converts GitHub alert blockquotes ("> [!NOTE]", "> [!TIP]", ...) into
 * markdown-alert divs, matching how github.com renders them.
 *
 * @param {!Element} el The rendered markdown root
 */
function formatAlerts(el) {
	for (const quote of el.querySelectorAll("blockquote")) {
		const para = quote.firstElementChild;
		if (!para || para.tagName !== "P") {
			continue;
		}
		const first = para.firstChild;
		if (!first || first.nodeType !== Node.TEXT_NODE) {
			continue;
		}
		const match = ALERT_MARKER.exec(first.textContent);
		if (!match) {
			continue;
		}
		const kind = match[1].toLowerCase();

		// Strip the marker, plus the <br> left behind when the marker line
		// ends with a hard break ("[!NOTE]  ").
		first.textContent = first.textContent.slice(match[0].length);
		if (!first.textContent) {
			const next = first.nextSibling;
			dom.removeNode(first);
			if (next && next.nodeName === "BR") {
				dom.removeNode(next);
			}
		}
		if (!para.textContent.trim() && !para.firstElementChild) {
			dom.removeNode(para);
		}

		const title = dom.createDom(
			"p",
			{ "class": "markdown-alert-title" },
			renderAlertIcon(kind),
			kind.charAt(0).toUpperCase() + kind.slice(1),
		);
		const alert = dom.createDom(
			"div",
			{ "class": `markdown-alert markdown-alert-${kind}` },
			title,
		);
		while (quote.firstChild) {
			alert.appendChild(quote.firstChild);
		}
		dom.replaceNode(alert, quote);
	}
}

/**
 * Renders the octicon github.com uses for an alert kind.
 *
 * @param {string} kind One of note, tip, important, warning, caution
 * @returns {!Element}
 */
function renderAlertIcon(kind) {
	switch (kind) {
		case "tip":
			return soy.renderAsElement(octiconLightBulb16, {});
		case "important":
			return soy.renderAsElement(octiconReport16, {});
		case "warning":
			return soy.renderAsElement(octiconAlert16, {});
		case "caution":
			return soy.renderAsElement(octiconStop16, {});
		default:
			return soy.renderAsElement(octiconInfo16, {});
	}
}

/**
 * Returns the trimmed source of every ```mermaid fenced block in the text.
 *
 * @param {string} text The markdown text
 * @returns {!Set<string>}
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
function parseMermaidSources(text) {
	const sources = new Set();
	const marked = window["marked"];
	marked["walkTokens"](marked["lexer"](text), (token) => {
		if (token["type"] === "code" && token["lang"] === "mermaid") {
			sources.add(String(token["text"]).trim());
		}
	});
	return sources;
}

/**
 * Renders mermaid placeholder elements into SVG diagrams. On failure the
 * diagram source is left in place as plain text.
 *
 * @param {!Array<!Element>} els The placeholder elements
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
async function renderMermaid(els) {
	if (!els.length) {
		return;
	}
	try {
		const mermaid = await window["loadMermaid"]();
		const colorMode = getEffectiveColorMode(
			/** @type {!Document} */ (els[0].ownerDocument),
		);
		mermaid["initialize"]({
			"startOnLoad": false,
			"securityLevel": "strict",
			"theme": colorMode === "dark" ? "dark" : "default",
		});
		await mermaid["run"]({ "nodes": els });
	} catch (e) {
		console.warn("mermaid render failed", e);
	}
}

/**
 * formats the innner text of an element as markdown using 'marked'.
 *
 * @param {string} text The text to convert
 * @returns {string} text formatted text
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
function parseMarkdownToHTML(text) {
	return window["marked"]["parse"](text);
}

exports = { MarkdownComponent, formatMarkdownAll };
