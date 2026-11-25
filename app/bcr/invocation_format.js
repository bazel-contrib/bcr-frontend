/** @fileoverview Format values from Bazel invocation data. */
goog.module("bcrfrontend.invocationFormat");

const Timestamp = goog.require("proto.google.protobuf.Timestamp");

/**
 * @param {number} millis
 * @return {?number}
 */
function validDateMillis(millis) {
	return Number.isFinite(millis) && Math.abs(millis) <= 8640000000000000
		? millis
		: null;
}

/**
 * @param {?Timestamp} timestamp
 * @return {?number}
 */
function timestampMillis(timestamp) {
	if (!timestamp) return null;
	const seconds = Number(timestamp.getSeconds());
	const nanos = timestamp.getNanos();
	return validDateMillis(seconds * 1000 + Math.floor(nanos / 1000000));
}

/**
 * @param {number} millis
 * @return {string}
 */
function formatElapsed(millis) {
	const totalSeconds = Math.max(0, millis) / 1000;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	return minutes + ":" + seconds.toFixed(3).padStart(6, "0");
}

/**
 * @param {?Timestamp} timestamp
 * @return {string}
 */
function formatTimestamp(timestamp) {
	const millis = timestampMillis(timestamp);
	return millis === null ? "Not reported" : new Date(millis).toISOString();
}

/**
 * @param {number|string} seconds
 * @param {number} nanos
 * @return {string}
 */
function formatDuration(seconds, nanos) {
	return formatElapsed(Number(seconds) * 1000 + Math.floor(nanos / 1000000));
}

/**
 * @param {number} bytes
 * @return {string}
 */
function formatBytes(bytes) {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
	if (bytes < 1024 ** 3) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
	return (bytes / 1024 ** 3).toFixed(1) + " GiB";
}

/**
 * @param {number} numerator
 * @param {number} denominator
 * @return {string}
 */
function groupRate(numerator, denominator) {
	return denominator ? ((100 * numerator) / denominator).toFixed(1) + "%" : "—";
}

/**
 * @param {?Object<string, *>} summary
 * @param {string} field
 * @return {?number}
 */
function summaryTime(summary, field) {
	const value = Date.parse(String(summary?.[field] || ""));
	return Number.isFinite(value) ? value : null;
}

exports.timestampMillis = timestampMillis;
exports.validDateMillis = validDateMillis;
exports.formatElapsed = formatElapsed;
exports.formatTimestamp = formatTimestamp;
exports.formatDuration = formatDuration;
exports.formatBytes = formatBytes;
exports.groupRate = groupRate;
exports.summaryTime = summaryTime;
