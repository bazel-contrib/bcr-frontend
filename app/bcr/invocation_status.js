/** @fileoverview Display the collection state and outcome of an invocation. */
goog.module("bcrfrontend.invocationStatus");

const dom = goog.require("goog.dom");
const soy = goog.require("goog.soy");
const { InvocationFailure, InvocationProgress, invocationFailure } =
	goog.require("bcrfrontend.invocationEvents");
const { invocationResultGlyph } = goog.require("soy.bcrfrontend.tools");

/** @typedef {{label: string, kind: string, color: string, title: string}} */
let InvocationStatus;

/**
 * @param {string} label
 * @param {string} kind
 * @param {?number=} code
 * @return {!InvocationStatus}
 */
function invocationStatus(label, kind, code = null) {
	let color = "color-fg-muted";
	switch (kind) {
		case "success":
			color = "color-fg-success";
			break;
		case "failure":
		case "tests":
			color = "color-fg-danger";
			break;
		case "interrupted":
		case "input":
		case "empty":
		case "warning":
			color = "color-fg-attention";
			break;
		case "infrastructure":
			color = "color-fg-done";
			break;
		case "running":
			color = "color-fg-attention";
			break;
	}
	return {
		label,
		kind,
		color,
		title: code === null ? label : label + " (" + code + ")",
	};
}

/**
 * @param {string} name
 * @param {?number} code
 * @return {!InvocationStatus}
 */
function invocationExitStatus(name, code) {
	let kind = code === 0 ? "success" : "failure";
	switch (name) {
		case "SUCCESS":
			kind = "success";
			break;
		case "INTERRUPTED":
			kind = "interrupted";
			break;
		case "COMMAND_LINE_ERROR":
		case "PARSING_FAILURE":
			kind = "input";
			break;
		case "TESTS_FAILED":
			kind = "tests";
			break;
		case "NO_TESTS_FOUND":
			kind = "empty";
			break;
		case "PARTIAL_ANALYSIS_FAILURE":
		case "LOCK_HELD_NOBLOCK_FOR_LOCK":
			kind = "warning";
			break;
		case "REMOTE_ENVIRONMENTAL_ERROR":
		case "LOCAL_ENVIRONMENTAL_ERROR":
		case "REMOTE_ERROR":
		case "OOM_ERROR":
		case "BLAZE_INTERNAL_ERROR":
		case "PUBLISH_ERROR":
		case "REMOTE_CACHE_EVICTED":
		case "PERSISTENT_BUILD_EVENT_SERVICE_UPLOAD_ERROR":
		case "EXTERNAL_DEPS_ERROR":
			kind = "infrastructure";
			break;
	}
	return invocationStatus(
		name || (code === 0 ? "Succeeded" : "Failed"),
		kind,
		code,
	);
}

/**
 * @param {?Object<string, *>} summary
 * @return {?InvocationStatus}
 */
function storedExitStatus(summary) {
	const result = /** @type {?Object<string, *>} */ (
		summary?.["result"] || null
	);
	const name = String(result?.["exitCodeName"] || "");
	const code = result?.["exitCode"];
	return name || typeof code === "number"
		? invocationExitStatus(name, typeof code === "number" ? code : null)
		: null;
}

/**
 * @param {?InvocationStatus} result
 * @return {!InvocationStatus}
 */
function incompleteStatus(result) {
	const status = invocationStatus("Incomplete", "warning");
	status.title =
		"Incomplete build event stream" +
		(result ? " · Build result: " + result.title : "");
	return status;
}

/**
 * @param {!InvocationProgress} invocation
 * @param {?InvocationFailure=} failure
 * @return {?InvocationStatus}
 */
function replayResultStatus(
	invocation,
	failure = invocationFailure(invocation),
) {
	const finished = invocation.finished?.getFinished();
	const exit = finished?.getExitCode();
	if (exit) return invocationExitStatus(exit.getName(), exit.getCode());
	if (failure) return invocationStatus("Failed", "failure");
	if (finished) return invocationStatus("Finished", "neutral");
	if (invocation.last || invocation.file)
		return invocationStatus("Incomplete", "warning");
	return null;
}

/**
 * @param {!InvocationStatus} status
 * @return {!Element}
 */
function renderInvocationStatusIcon(status) {
	return dom.createDom(
		"span",
		{
			"class": "bes-invocation-status-icon " + status.color,
			"role": "img",
			"aria-label": status.label,
			"title": status.title,
		},
		soy.renderAsElement(invocationResultGlyph, { kind: status.kind }),
	);
}

exports.InvocationStatus = InvocationStatus;
exports.invocationStatus = invocationStatus;
exports.invocationExitStatus = invocationExitStatus;
exports.storedExitStatus = storedExitStatus;
exports.incompleteStatus = incompleteStatus;
exports.replayResultStatus = replayResultStatus;
exports.renderInvocationStatusIcon = renderInvocationStatusIcon;
