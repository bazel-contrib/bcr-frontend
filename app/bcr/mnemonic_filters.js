goog.module("bcrfrontend.mnemonicFilters");

const dom = goog.require("goog.dom");
const { mnemonicColor } = goog.require("bcrfrontend.actionColors");

/**
 * @param {!HTMLElement} list
 * @param {!Array<string>} entries
 */
function renderMnemonicFilters(list, entries) {
	/** @type {!Map<string, number>} */
	const counts = new Map();
	for (const mnemonic of entries) {
		counts.set(mnemonic, (counts.get(mnemonic) || 0) + 1);
	}
	dom.removeChildren(list);
	/** @type {!Array<string>} */
	const mnemonics = Array.from(counts.keys());
	mnemonics.sort(
		(a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b),
	);
	for (const mnemonic of mnemonics) {
		const input = dom.createDom("input", {
			"type": "checkbox",
			"value": mnemonic,
		});
		input.checked = true;
		const swatch = dom.createDom("span", {
			"class": "action-query-swatch",
			"aria-hidden": "true",
		});
		if (mnemonic) swatch.style.backgroundColor = mnemonicColor(mnemonic);
		const name = dom.createDom("span", null, mnemonic || "(No mnemonic)");
		const count = dom.createDom(
			"span",
			"color-fg-muted",
			(counts.get(mnemonic) || 0).toLocaleString(),
		);
		list.appendChild(
			dom.createDom(
				"label",
				"tool-mnemonic text-small",
				input,
				swatch,
				name,
				count,
			),
		);
	}
	list.scrollTop = 0;
}

exports.renderMnemonicFilters = renderMnemonicFilters;
