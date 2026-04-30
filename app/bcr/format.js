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
 * Format a duration as a short relative string ("2 days ago", "3 hours ago").
 * Unlike formatRelativePast, this never includes the full date.
 *
 * @param {string|undefined} value The datetime string
 * @returns {string}
 */
function formatRelativeShort(value) {
	if (!value) {
		return "";
	}
	const diff = Date.now() - new Date(value).getTime();
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return days === 1 ? "yesterday" : days + " days ago";
	if (hours > 0) return hours === 1 ? "1 hour ago" : hours + " hours ago";
	if (minutes > 0)
		return minutes === 1 ? "1 minute ago" : minutes + " minutes ago";
	return "just now";
}
exports.formatRelativeShort = formatRelativeShort;

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
