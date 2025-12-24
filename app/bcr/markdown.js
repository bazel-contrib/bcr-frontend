goog.module("bcrfrontend.markdown");

const arrays = goog.require("goog.array");
const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { SafeHtml, sanitizeHtml } = goog.require(
	"google3.third_party.javascript.safevalues.index",
);
const { copyToClipboardButton } = goog.require("soy.registry");
const { highlight } = goog.require("bcrfrontend.syntax");
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
	setElementInnerHtml(el, renderDocstring(el));

	// Trim whitespace from code blocks in the rendered HTML
	const codeElements = el.querySelectorAll("pre code, code");
	for (const code of codeElements) {
		code.textContent = code.textContent.trim();
	}

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
		dom.classlist.addAll(pre, ["border", "color-bg-subtle"]);
		const button = soy.renderAsElement(copyToClipboardButton, {
			content: pre.firstChild.textContent,
		});
		button.style.position = "absolute";
		button.style.right = "4px";
		button.style.top = "4px";
		dom.classlist.addAll(button, ["float-right"]);
		dom.insertChildAt(pre, button, 0);
	}

	// Find and log non-http links for linkification
	const links = el.querySelectorAll("a[href]");
	for (const link of links) {
		const href = link.getAttribute("href");
		if (href && !href.startsWith("http://") && !href.startsWith("https://")) {
			console.log("Non-http link:", href, "text:", link.textContent);
		}
	}

	dom.dataset.set(el, "formatted", "markdown");
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
