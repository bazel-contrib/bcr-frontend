goog.module("bcrfrontend.format");

const relative = goog.require("goog.date.relative");

/**
 * Format a duration in human-readable relative format ("2 hours ago")
 *
 * @param {string|undefined} value The datetime string
 * @returns {string}
 */
function formatRelativePast(value) {
	if (!value) {
		return "";
	}
	return relative.getPastDateString(new Date(value));
}
exports.formatRelativePast = formatRelativePast;

/**
 * Format date as YYYY-MM-DD
 * @param {string|number} value
 * @return {string}
 */
function formatDate(value) {
	if (!value) {
		return "";
	}
	const d = new Date(value);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}
exports.formatDate = formatDate;
