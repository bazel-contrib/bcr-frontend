goog.module("bcrfrontend.syntax");

const asserts = goog.require("goog.asserts");
const arrays = goog.require("goog.array");
const dom = goog.require("goog.dom");

/**
 * @param {!Document} ownerDocument
 * @returns {string}
 */
function getEffectiveColorMode(ownerDocument) {
	const colorMode =
		ownerDocument.documentElement.getAttribute("data-color-mode");

	if (colorMode === "auto") {
		// Check system preference
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	}

	return colorMode; // 'light' or 'dark'
}

/**
 * @param {!Element} preEl The element to highlight, typically PRE
 * @suppress {reportUnknownTypes, missingSourcesWarnings}
 */
async function highlight(preEl) {
	const codeEl = preEl.firstElementChild || preEl;
	const lang = codeEl.getAttribute("lang") || "py";
	const lineNumbers = codeEl.hasAttribute("linenumbers") || true; // TODO(pcj): why is this not working?  (seems to always be beneficial tho)
	const text = codeEl.textContent;
	const theme =
		"github-" +
		getEffectiveColorMode(asserts.assertObject(preEl.ownerDocument));
	const html = await dom.getWindow()["codeToHtml"](text, {
		lang: lang,
		theme: theme,
		lineNumbers: lineNumbers,
	});
	preEl.outerHTML = html;
	dom.dataset.set(preEl, "highlighted", lang);
}
exports.highlight = highlight;

/**
 * @param {!Element} rootEl
 */
function highlightAll(rootEl) {
	const className = goog.getCssName("shiki");
	const preEls = dom.findElements(rootEl, (el) =>
		el.classList.contains(className),
	);
	arrays.forEach(preEls, highlight);
}
exports.highlightAll = highlightAll;
