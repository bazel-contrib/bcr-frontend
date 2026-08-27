/**
 * @fileoverview Browser-based Bazel tools and Build Event Protocol viewer.
 */
goog.module("bcrfrontend.tools");

const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const BuildEventId = goog.require("proto.build_event_stream.BuildEventId");
const BuildMetrics = goog.require("proto.build_event_stream.BuildMetrics");
const BuildToolLogs = goog.require("proto.build_event_stream.BuildToolLogs");
const BesFile = goog.require("proto.build_event_stream.File");
const Timestamp = goog.require("proto.google.protobuf.Timestamp");
const FileDropHandler = goog.require("goog.events.FileDropHandler");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { getApplication } = goog.require("bcrfrontend.common");
const {
	eventStatusIcon,
	invocationViewer,
	timelinePlayIcon,
	toolsCatalog,
	toolsSelect,
} = goog.require("soy.bcrfrontend.tools");

const MAX_FILE_BYTES = 256 * 1024 * 1024;

/** @const {!Array<string>} */
const TEST_STATUS_NAMES = [
	"No status", "Passed", "Flaky", "Timed out", "Failed", "Incomplete",
	"Remote failure", "Failed to build", "Stopped before testing",
];

/** @const {!Array<string>} */
const ABORT_REASON_NAMES = [
	"Unknown", "User interrupted", "Timed out", "Remote environment failure",
	"Internal error", "Loading failure", "Analysis failure", "Skipped", "", "",
	"Incomplete", "Out of memory",
];

/** @const {!Array<string>} */
const TEST_SIZE_NAMES = ["Unknown", "Small", "Medium", "Large", "Enormous"];

const CSS_CHOOSE_FILE = goog.getCssName("choose-file");
const CSS_DROP_ZONE = goog.getCssName("drop-zone");
const CSS_FILE_INPUT = goog.getCssName("file-input");
const CSS_RESULTS = goog.getCssName("results");
const CSS_STATUS = goog.getCssName("status");
const CSS_SUMMARY = goog.getCssName("summary");

/**
 * Decode a stream of varint-length-delimited protobuf messages.
 *
 * @param {!Uint8Array} bytes
 * @param {function(!Uint8Array):*} deserialize
 * @return {!Array<*>}
 */
function decodeDelimitedMessages(bytes, deserialize) {
	const messages = [];
	let offset = 0;
	while (offset < bytes.length) {
		let length = 0;
		let shift = 0;
		let byte = 0;
		do {
			if (offset >= bytes.length) {
				throw new Error("Truncated message length at byte " + offset);
			}
			byte = bytes[offset++];
			if (shift >= 35 || (shift === 28 && (byte & 0xf0) !== 0)) {
				throw new Error("Message length is too large at byte " + offset);
			}
			length += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while ((byte & 0x80) !== 0);

		if (length === 0) {
			throw new Error("Empty protobuf message at byte " + offset);
		}
		if (length > bytes.length - offset) {
			throw new Error(
				"Truncated protobuf message at byte " +
					offset +
					": expected " +
					length +
					" bytes, found " +
					(bytes.length - offset),
			);
		}
		const end = offset + length;
		try {
			messages.push(deserialize(bytes.subarray(offset, end)));
		} catch (_error) {
			throw new Error(
				"Invalid protobuf message at byte " +
					offset +
					".",
			);
		}
		offset = end;
	}
	return messages;
}

/**
 * @param {number} payloadCase
 * @return {string}
 */
function payloadCaseName(payloadCase) {
	switch (payloadCase) {
		case BuildEvent.PayloadCase.PROGRESS: return "Build progress";
		case BuildEvent.PayloadCase.ABORTED: return "Aborted";
		case BuildEvent.PayloadCase.STARTED: return "Build started";
		case BuildEvent.PayloadCase.UNSTRUCTURED_COMMAND_LINE: return "Original command line";
		case BuildEvent.PayloadCase.STRUCTURED_COMMAND_LINE: return "Structured command line";
		case BuildEvent.PayloadCase.OPTIONS_PARSED: return "Options parsed";
		case BuildEvent.PayloadCase.WORKSPACE_STATUS: return "Workspace status";
		case BuildEvent.PayloadCase.FETCH: return "External fetch";
		case BuildEvent.PayloadCase.CONFIGURATION: return "Build configuration";
		case BuildEvent.PayloadCase.EXPANDED: return "Target pattern expanded";
		case BuildEvent.PayloadCase.CONFIGURED: return "Target configured";
		case BuildEvent.PayloadCase.ACTION: return "Action completed";
		case BuildEvent.PayloadCase.NAMED_SET_OF_FILES: return "Artifact set";
		case BuildEvent.PayloadCase.COMPLETED: return "Target completed";
		case BuildEvent.PayloadCase.TEST_RESULT: return "Test result";
		case BuildEvent.PayloadCase.TEST_PROGRESS: return "Test progress";
		case BuildEvent.PayloadCase.TEST_SUMMARY: return "Test summary";
		case BuildEvent.PayloadCase.TARGET_SUMMARY: return "Target summary";
		case BuildEvent.PayloadCase.FINISHED: return "Build finished";
		case BuildEvent.PayloadCase.BUILD_TOOL_LOGS: return "Build tool logs";
		case BuildEvent.PayloadCase.BUILD_METRICS: return "Build metrics";
		case BuildEvent.PayloadCase.WORKSPACE_INFO: return "Workspace configuration";
		case BuildEvent.PayloadCase.BUILD_METADATA: return "Build metadata";
		case BuildEvent.PayloadCase.CONVENIENCE_SYMLINKS_IDENTIFIED: return "Convenience symlinks";
		case BuildEvent.PayloadCase.EXEC_REQUEST: return "Execution request";
	}
	return "Unknown event";
}

/**
 * Event palette reused from stackb/bezel's ColorBrewer-based BES palette.
 * @param {number} payloadCase
 * @return {string}
 */
function payloadCaseColor(payloadCase) {
	switch (payloadCase) {
		case BuildEvent.PayloadCase.PROGRESS: return "rgb(23, 178, 2)";
		case BuildEvent.PayloadCase.ABORTED: return "rgb(255, 127, 0)";
		case BuildEvent.PayloadCase.STARTED: return "rgb(166, 206, 227)";
		case BuildEvent.PayloadCase.UNSTRUCTURED_COMMAND_LINE:
		case BuildEvent.PayloadCase.STRUCTURED_COMMAND_LINE: return "rgb(177, 89, 40)";
		case BuildEvent.PayloadCase.OPTIONS_PARSED: return "rgb(178, 223, 138)";
		case BuildEvent.PayloadCase.WORKSPACE_STATUS:
		case BuildEvent.PayloadCase.WORKSPACE_INFO: return "rgb(31, 120, 180)";
		case BuildEvent.PayloadCase.CONFIGURED: return "rgb(251, 154, 153)";
		case BuildEvent.PayloadCase.NAMED_SET_OF_FILES:
		case BuildEvent.PayloadCase.FETCH: return "rgb(255, 127, 0)";
		case BuildEvent.PayloadCase.ACTION: return "rgb(227, 26, 28)";
		case BuildEvent.PayloadCase.TEST_RESULT:
		case BuildEvent.PayloadCase.TEST_PROGRESS:
		case BuildEvent.PayloadCase.TEST_SUMMARY: return "rgb(255, 255, 153)";
		case BuildEvent.PayloadCase.FINISHED: return "rgb(106, 61, 154)";
		case BuildEvent.PayloadCase.BUILD_METRICS:
		case BuildEvent.PayloadCase.BUILD_METADATA: return "rgb(25, 25, 25)";
		case BuildEvent.PayloadCase.BUILD_TOOL_LOGS: return "rgb(166, 206, 227)";
		default: return "rgb(202, 178, 214)";
	}
}

/**
 * @param {number} payloadCase
 * @return {string}
 */
function payloadCaseTextColor(payloadCase) {
	switch (payloadCase) {
		case BuildEvent.PayloadCase.ACTION:
		case BuildEvent.PayloadCase.BUILD_METRICS:
		case BuildEvent.PayloadCase.BUILD_METADATA:
		case BuildEvent.PayloadCase.FINISHED:
		case BuildEvent.PayloadCase.WORKSPACE_STATUS:
		case BuildEvent.PayloadCase.WORKSPACE_INFO:
			return "#ffffff";
		default:
			return "#111111";
	}
}

/**
 * @param {!BuildEvent} event
 * @return {?boolean}
 */
function eventOutcome(event) {
	switch (event.getPayloadCase()) {
		case BuildEvent.PayloadCase.ABORTED:
			return false;
		case BuildEvent.PayloadCase.FETCH: {
			const payload = event.getFetch();
			return payload ? payload.getSuccess() : null;
		}
		case BuildEvent.PayloadCase.ACTION: {
			const payload = event.getAction();
			return payload ? payload.getSuccess() : null;
		}
		case BuildEvent.PayloadCase.COMPLETED: {
			const payload = event.getCompleted();
			return payload ? payload.getSuccess() : null;
		}
		case BuildEvent.PayloadCase.TEST_RESULT: {
			const payload = event.getTestResult();
			if (!payload || payload.getStatus() === 0) return null;
			return payload.getStatus() === 1 || payload.getStatus() === 2;
		}
		case BuildEvent.PayloadCase.TEST_SUMMARY: {
			const payload = event.getTestSummary();
			if (!payload || payload.getOverallStatus() === 0) return null;
			return payload.getOverallStatus() === 1 || payload.getOverallStatus() === 2;
		}
		case BuildEvent.PayloadCase.TARGET_SUMMARY: {
			const payload = event.getTargetSummary();
			if (!payload) return null;
			const testStatus = payload.getOverallTestStatus();
			return payload.getOverallBuildSuccess() &&
				(testStatus === 0 || testStatus === 1 || testStatus === 2);
		}
		case BuildEvent.PayloadCase.FINISHED: {
			const payload = event.getFinished();
			const exit = payload ? payload.getExitCode() : null;
			return exit ? exit.getCode() === 0 : null;
		}
		default:
			return null;
	}
}

/**
 * @param {?Timestamp} timestamp
 * @return {?number}
 */
function timestampMillis(timestamp) {
	if (!timestamp) return null;
	const seconds = Number(timestamp.getSeconds());
	const nanos = timestamp.getNanos();
	return seconds * 1000 + Math.floor(nanos / 1000000);
}

/**
 * @param {!BuildEvent} event
 * @return {?number}
 */
function eventTimestampMillis(event) {
	switch (event.getPayloadCase()) {
		case BuildEvent.PayloadCase.STARTED: {
			const payload = event.getStarted();
			return payload ? timestampMillis(payload.getStartTime()) : null;
		}
		case BuildEvent.PayloadCase.ACTION: {
			const payload = event.getAction();
			return payload ? timestampMillis(payload.getStartTime()) : null;
		}
		case BuildEvent.PayloadCase.TEST_RESULT: {
			const payload = event.getTestResult();
			return payload ? timestampMillis(payload.getTestAttemptStart()) : null;
		}
		case BuildEvent.PayloadCase.TEST_SUMMARY: {
			const payload = event.getTestSummary();
			return payload ? timestampMillis(payload.getFirstStartTime()) : null;
		}
		case BuildEvent.PayloadCase.FINISHED: {
			const payload = event.getFinished();
			return payload ? timestampMillis(payload.getFinishTime()) : null;
		}
		default:
			return null;
	}
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
 * @param {number} status
 * @return {string}
 */
function testStatusName(status) {
	return TEST_STATUS_NAMES[status] ||
		"Unknown (" + status + ")";
}

/**
 * @param {number} reason
 * @return {string}
 */
function abortReasonName(reason) {
	return ABORT_REASON_NAMES[reason] || "Unknown (" + reason + ")";
}

/**
 * @param {number} size
 * @return {string}
 */
function testSizeName(size) {
	return TEST_SIZE_NAMES[size] ||
		"Unknown (" + size + ")";
}

/**
 * @param {!BesFile} file
 * @return {string}
 */
function fileSummary(file) {
	const pathParts = file.getPathPrefixList().slice();
	if (file.getName()) pathParts.push(file.getName());
	const path = pathParts.join("/");
	const location = file.getUri() || file.getSymlinkTargetPath();
	const parts = [path || file.getName() || "Unnamed file"];
	if (location) parts.push(location);
	if (Number(file.getLength())) parts.push(formatBytes(Number(file.getLength())));
	return parts.join(" · ");
}

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
	"#000000", "#cd3131", "#0dbc79", "#e5e510",
	"#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
	"#666666", "#f14c4c", "#23d18b", "#f5f543",
	"#3b8eea", "#d670d6", "#29b8db", "#ffffff",
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
	return "rgb(" + ansiCubeChannel(red) + ", " + ansiCubeChannel(green) +
		", " + ansiCubeChannel(blue) + ")";
}

/**
 * @param {number} component
 * @return {number}
 */
function ansiCubeChannel(component) {
	return component === 0 ? 0 : 55 + component * 40;
}

/**
 * Render terminal SGR sequences without interpreting the text as markup.
 * Unsupported ANSI control sequences are ignored.
 * @param {string} value
 * @return {!HTMLElement}
 */
function renderTerminalText(value) {
	const root = /** @type {!HTMLElement} */ (document.createElement("div"));
	let foreground = "";
	let background = "";
	let bold = false;
	let dim = false;
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
			} else if ((code === 38 || code === 48) && codes[i + 1] === 5 &&
				codes[i + 2] !== undefined) {
				const color = ansi256Color(codes[i + 2]);
				if (code === 38) foreground = color;
				else background = color;
				i += 2;
			} else if ((code === 38 || code === 48) && codes[i + 1] === 2 &&
				codes[i + 4] !== undefined) {
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
	return root;
}

/**
 * @param {*} value
 * @return {string}
 */
function formatJson(value) {
	return JSON.stringify(
		value,
		(_key, item) => {
			if (typeof item === "string" && item.length > 10000) {
				return item.slice(0, 10000) + "…";
			}
			return item;
		},
		2,
	);
}

/**
 * @param {string} name
 * @return {string}
 */
function metricLabel(name) {
	const label = name
		.replace(/List$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ");
	return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

/**
 * @param {*} value
 * @param {string} path
 * @param {!Array<!Array<string>>} rows
 */
function flattenMetricRows(value, path, rows) {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const itemPath = path ? path + " #" + (i + 1) : "Entry #" + (i + 1);
			flattenMetricRows(value[i], itemPath, rows);
		}
		return;
	}
	if (value !== null && typeof value === "object") {
		const object = /** @type {!Object<string, *>} */ (value);
		for (const key of Object.keys(object)) {
			const child = object[key];
			if (child === undefined || child === null ||
				(Array.isArray(child) && child.length === 0)) {
				continue;
			}
			const childPath = path ? path + " · " + metricLabel(key) : metricLabel(key);
			flattenMetricRows(child, childPath, rows);
		}
		return;
	}
	rows.push([path, String(value)]);
}

/**
 * @param {*} metric
 * @return {!HTMLElement}
 */
function createMetricTable(metric) {
	/** @type {!Array<!Array<string>>} */
	const rows = [];
	flattenMetricRows(metric, "", rows);
	const table = /** @type {!HTMLElement} */ (document.createElement("table"));
	table.className = "bes-metrics-table width-full text-small";
	const head = document.createElement("thead");
	const headRow = document.createElement("tr");
	/** @type {!Array<string>} */
	const headings = ["Metric", "Value"];
	for (const heading of headings) {
		const cell = document.createElement("th");
		cell.className = "text-left color-fg-muted";
		cell.textContent = heading;
		headRow.appendChild(cell);
	}
	head.appendChild(headRow);
	table.appendChild(head);
	const body = document.createElement("tbody");
	for (const row of rows) {
		const tableRow = document.createElement("tr");
		const name = document.createElement("td");
		name.textContent = row[0] || "Value";
		const value = document.createElement("td");
		value.className = "text-mono";
		value.textContent = row[1];
		tableRow.appendChild(name);
		tableRow.appendChild(value);
		body.appendChild(tableRow);
	}
	table.appendChild(body);
	return table;
}

/** @typedef {{timeMillis: number, startMillis: number, action: string}} */
let CriticalPathItem;

/** @typedef {{timeMillis: number, items: !Array<!CriticalPathItem>}} */
let CriticalPath;

/**
 * Parse Bazel's human-readable critical path build tool log.
 * @param {string} content
 * @return {!CriticalPath}
 */
function parseCriticalPath(content) {
	let timeMillis = 0;
	let currentStartMillis = 0;
	/** @type {!Array<!CriticalPathItem>} */
	const items = [];
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		if (!line.startsWith("Critical Path: ")) continue;
		const seconds = parseFloat(line.slice(15).replace(/,/g, ""));
		if (Number.isFinite(seconds)) timeMillis = Math.round(seconds * 1000);
		break;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		/** @type {?Array<string>} */
		const match = /^\s*([\d,.]+)s action '(.+)'$/.exec(lines[i]);
		if (!match) continue;
		const itemMillis = Math.round(Number(match[1].replace(/,/g, "")) * 1000);
		if (!itemMillis) continue;
		items.push({
			timeMillis: itemMillis,
			startMillis: currentStartMillis,
			action: match[2],
		});
		currentStartMillis += itemMillis;
	}
	if (!timeMillis) timeMillis = currentStartMillis;
	return { timeMillis, items };
}

/**
 * @param {!BuildEvent} event
 * @return {string}
 */
function eventIdSummary(event) {
	const id = event.getId();
	if (!id) return "No event ID";
	switch (id.getIdCase()) {
		case BuildEventId.IdCase.STARTED: return "Build started";
		case BuildEventId.IdCase.BUILD_FINISHED: return "Build finished";
		case BuildEventId.IdCase.UNSTRUCTURED_COMMAND_LINE: return "Original command line";
		case BuildEventId.IdCase.WORKSPACE_STATUS: return "Workspace status";
		case BuildEventId.IdCase.OPTIONS_PARSED: return "Options parsed";
		case BuildEventId.IdCase.BUILD_TOOL_LOGS: return "Build tool logs";
		case BuildEventId.IdCase.BUILD_METRICS: return "Build metrics";
		case BuildEventId.IdCase.WORKSPACE: return "Workspace configuration";
		case BuildEventId.IdCase.BUILD_METADATA: return "Build metadata";
		case BuildEventId.IdCase.CONVENIENCE_SYMLINKS_IDENTIFIED:
			return "Convenience symlinks";
		case BuildEventId.IdCase.EXEC_REQUEST: return "Execution request";
		case BuildEventId.IdCase.UNKNOWN: {
			const value = id.getUnknown();
			return value ? value.getDetails() || "Unknown event" : "Unknown event";
		}
		case BuildEventId.IdCase.PROGRESS: {
			const value = id.getProgress();
			return value ? "Progress #" + value.getOpaqueCount() : "Build progress";
		}
		case BuildEventId.IdCase.STRUCTURED_COMMAND_LINE: {
			const value = id.getStructuredCommandLine();
			return value
				? "Command line: " + value.getCommandLineLabel()
				: "Structured command line";
		}
		case BuildEventId.IdCase.FETCH: {
			const value = id.getFetch();
			return value ? "Fetch: " + value.getUrl() : "External fetch";
		}
		case BuildEventId.IdCase.CONFIGURATION: {
			const value = id.getConfiguration();
			return value ? "Configuration: " + value.getId() : "Build configuration";
		}
		case BuildEventId.IdCase.TARGET_CONFIGURED: {
			const value = id.getTargetConfigured();
			return value ? "Configured target: " + value.getLabel() : "Target configured";
		}
		case BuildEventId.IdCase.PATTERN:
		case BuildEventId.IdCase.PATTERN_SKIPPED: {
			const value =
				id.getIdCase() === BuildEventId.IdCase.PATTERN
					? id.getPattern()
					: id.getPatternSkipped();
			return value
				? "Target pattern: " + value.getPatternList().join(", ")
				: "Target pattern";
		}
		case BuildEventId.IdCase.NAMED_SET: {
			const value = id.getNamedSet();
			return value ? "Artifact set: " + value.getId() : "Artifact set";
		}
		case BuildEventId.IdCase.TARGET_COMPLETED: {
			const value = id.getTargetCompleted();
			return value ? "Completed target: " + value.getLabel() : "Target completed";
		}
		case BuildEventId.IdCase.ACTION_COMPLETED: {
			const value = id.getActionCompleted();
			return value
				? "Action: " + (value.getPrimaryOutput() || value.getLabel())
				: "Action completed";
		}
		case BuildEventId.IdCase.TEST_RESULT: {
			const value = id.getTestResult();
			return value ? "Test result: " + value.getLabel() : "Test result";
		}
		case BuildEventId.IdCase.TEST_PROGRESS: {
			const value = id.getTestProgress();
			return value ? "Test progress: " + value.getLabel() : "Test progress";
		}
		case BuildEventId.IdCase.TEST_SUMMARY: {
			const value = id.getTestSummary();
			return value ? "Test summary: " + value.getLabel() : "Test summary";
		}
		case BuildEventId.IdCase.TARGET_SUMMARY: {
			const value = id.getTargetSummary();
			return value ? "Target summary: " + value.getLabel() : "Target summary";
		}
		case BuildEventId.IdCase.UNCONFIGURED_LABEL: {
			const value = id.getUnconfiguredLabel();
			return value ? "Unconfigured label: " + value.getLabel() : "Unconfigured label";
		}
		case BuildEventId.IdCase.CONFIGURED_LABEL: {
			const value = id.getConfiguredLabel();
			return value ? "Configured label: " + value.getLabel() : "Configured label";
		}
	}
	return "Unknown event ID";
}

class ToolsSelect extends ContentSelect {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(toolsSelect));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select("catalog", route.add("catalog"));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === "catalog") {
			this.addTab(name, new ToolsCatalogComponent(this.dom_));
			this.select(name, route);
			return;
		}
		if (name === "invocation") {
			this.addTab(name, new BuildEventViewerComponent(this.dom_));
			this.select(name, route);
			return;
		}
		super.selectFail(name, route);
	}
}
exports.ToolsSelect = ToolsSelect;

class ToolsCatalogComponent extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(toolsCatalog));
	}
}

class BuildEventViewerComponent extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);

		/** @private @type {!Array<!BuildEvent>} */
		this.events_ = [];
		/** @private @type {string} */
		this.fileName_ = "";
		/** @private @type {number} */
		this.fileSize_ = 0;
		/** @private @type {number} */
		this.selectedIndex_ = 0;
		/** @private @type {?number} */
		this.buildStartMillis_ = null;
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(invocationViewer));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const dropZone = this.getElement_(CSS_DROP_ZONE);
		const summary = this.getElement_(CSS_SUMMARY);
		const choose = this.getElement_(CSS_CHOOSE_FILE);
		const input = /** @type {!HTMLInputElement} */ (
			this.getElement_(CSS_FILE_INPUT)
		);

		const fileDropHandler = new FileDropHandler(dropZone, true);
		this.registerDisposable(fileDropHandler);
		this.getHandler().listen(
			fileDropHandler,
			FileDropHandler.EventType.DROP,
			this.handleDrop_,
		);
		this.getHandler().listen(choose, events.EventType.CLICK, () => input.click());
		this.getHandler().listen(
			summary,
			events.EventType.KEYDOWN,
			this.handleDropZoneKeyDown_,
		);
		this.getHandler().listen(input, events.EventType.CHANGE, () => {
			if (input.files && input.files.length) {
				const file = input.files[0];
				input.value = "";
				this.loadFile_(file);
			}
		});
		this.getHandler().listen(dropZone, events.EventType.DRAGENTER, () =>
			dropZone.classList.add("is-dragging"),
		);
		this.getHandler().listen(dropZone, events.EventType.DRAGLEAVE, () =>
			dropZone.classList.remove("is-dragging"),
		);
	}

	/**
	 * @private
	 * @param {!events.BrowserEvent} e
	 */
	handleDrop_(e) {
		this.getElement_(CSS_DROP_ZONE).classList.remove("is-dragging");
		const transfer = /** @type {!DragEvent} */ (
			e.getBrowserEvent()
		).dataTransfer;
		if (transfer && transfer.files && transfer.files.length) {
			this.loadFile_(transfer.files[0]);
		}
	}

	/**
	 * @private
	 * @param {!events.BrowserEvent} e
	 */
	handleDropZoneKeyDown_(e) {
		const key = /** @type {!KeyboardEvent} */ (e.getBrowserEvent()).key;
		if (key === "Enter" || key === " ") {
			e.preventDefault();
			/** @type {!HTMLInputElement} */ (this.getElement_(CSS_FILE_INPUT)).click();
		}
	}

	/**
	 * @private
	 * @param {!File} file
	 */
	async loadFile_(file) {
		const status = this.getElement_(CSS_STATUS);
		if (file.size > MAX_FILE_BYTES) {
			status.textContent =
				"File is too large. The current limit is " +
				formatBytes(MAX_FILE_BYTES) +
				".";
			status.className = "mt-3 flash flash-error " + goog.getCssName("status");
			return;
		}
		status.textContent = "Reading " + file.name + "…";
		status.className = "sr-only " + goog.getCssName("status");
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (this.isDisposed()) return;
			this.events_ = /** @type {!Array<!BuildEvent>} */ (
				decodeDelimitedMessages(bytes, (message) =>
					BuildEvent.deserializeBinary(message),
				)
			);
			if (!this.events_.length) throw new Error("The file contains no events.");
			this.fileName_ = file.name;
			this.fileSize_ = file.size;
			this.selectedIndex_ = 0;
			this.buildStartMillis_ = null;
			for (const event of this.events_) {
				if (event.getPayloadCase() === BuildEvent.PayloadCase.STARTED) {
					this.buildStartMillis_ = eventTimestampMillis(event);
					break;
				}
			}
			status.textContent = "";
			status.className = goog.getCssName("status");
			this.renderResults_();
			getApplication(this).toastSuccess(
				"Loaded " + this.events_.length + " events from " + file.name + ".",
			);
		} catch (_error) {
			status.textContent =
				"Could not read this build event file. The file may be truncated or invalid.";
			status.className = "mt-3 flash flash-error " + goog.getCssName("status");
		}
	}

	/** @private */
	renderResults_() {
		const root = this.getElement_(CSS_RESULTS);
		const summary = this.getElement_(CSS_SUMMARY);
		dom.removeChildren(root);
		dom.removeChildren(summary);
		summary.appendChild(this.createSummary_());
		root.appendChild(this.createTimeline_());
	}

	/**
	 * @private
	 * @return {!HTMLElement}
	 */
	createTimeline_() {
		const section = /** @type {!HTMLElement} */ (
			document.createElement("section")
		);
		section.className = "mb-3 bes-player";
		const legend = document.createElement("div");
		legend.className = "bes-event-type-filters d-flex flex-wrap ml-3";
		/** @type {!Map<number,number>} */
		const counts = new Map();
		for (const event of this.events_) {
			const payloadCase = event.getPayloadCase();
			counts.set(payloadCase, (counts.get(payloadCase) || 0) + 1);
		}
		/** @type {!Array<number>} */
		const payloadCases = [];
		for (const payloadCase of counts.keys()) payloadCases.push(payloadCase);
		/** @type {!Set<number>} */
		const selectedTypes = new Set();
		/** @type {!Map<number,!HTMLButtonElement>} */
		const typeButtons = new Map();
		for (const payloadCase of payloadCases) {
			const eventType = payloadCaseName(payloadCase);
			const button = /** @type {!HTMLButtonElement} */ (
				document.createElement("button")
			);
			button.type = "button";
			button.className = "bes-event-type-filter";
			button.style.backgroundColor = payloadCaseColor(payloadCase);
			button.style.color = payloadCaseTextColor(payloadCase);
			button.textContent = String(counts.get(payloadCase));
			button.title = eventType;
			button.setAttribute("aria-label", eventType + ": " + counts.get(payloadCase));
			button.setAttribute("aria-pressed", "false");
			legend.appendChild(button);
			typeButtons.set(payloadCase, button);
		}
		const clear = /** @type {!HTMLButtonElement} */ (
			document.createElement("button")
		);
		clear.type = "button";
		clear.className = "btn btn-sm ml-3 d-none";
		clear.textContent = "Clear filter";

		const body = document.createElement("div");
		const navigation = document.createElement("div");
		navigation.className = "d-flex flex-items-center mt-2";
		const previous = /** @type {!HTMLButtonElement} */ (
			document.createElement("button")
		);
		previous.type = "button";
		previous.className = "btn";
		previous.title = "Previous event";
		previous.setAttribute("aria-label", "Previous event");
		const previousIcon = soy.renderAsElement(timelinePlayIcon);
		previousIcon.classList.add("bes-player-previous-icon");
		previous.appendChild(previousIcon);
		const next = /** @type {!HTMLButtonElement} */ (
			document.createElement("button")
		);
		next.type = "button";
		next.className = "btn ml-3";
		next.title = "Next event";
		next.setAttribute("aria-label", "Next event");
		next.appendChild(soy.renderAsElement(timelinePlayIcon));
		const track = document.createElement("div");
		track.className = "bes-player-track";
		const canvas = /** @type {!HTMLCanvasElement} */ (
			document.createElement("canvas")
		);
		canvas.className = "bes-player-canvas";
		canvas.width = 1200;
		canvas.height = 28;
		canvas.setAttribute("aria-hidden", "true");
		const seek = /** @type {!HTMLInputElement} */ (
			document.createElement("input")
		);
		seek.type = "range";
		seek.className = "bes-player-seek";
		seek.min = "0";
		seek.max = String(Math.max(0, this.events_.length - 1));
		seek.step = "1";
		seek.value = String(this.selectedIndex_);
		seek.setAttribute("aria-label", "Selected build event");
		track.appendChild(canvas);
		track.appendChild(seek);
		const time = document.createElement("code");
		time.className = "bes-player-time flex-auto text-right";
		body.appendChild(track);
		navigation.appendChild(previous);
		navigation.appendChild(legend);
		navigation.appendChild(clear);
		navigation.appendChild(time);
		navigation.appendChild(next);
		body.appendChild(navigation);
		const detail = document.createElement("div");
		detail.className = "bes-player-detail mt-3";
		body.appendChild(detail);
		section.appendChild(body);

		const context = /** @type {?CanvasRenderingContext2D} */ (
			canvas.getContext("2d")
		);
		/** @type {!Array<!BuildEvent>} */
		let visibleEvents = this.events_.slice();

		/** @type {function():void} */
		const draw = () => {
			if (!context) return;
			context.clearRect(0, 0, canvas.width, canvas.height);
			const width = canvas.width / visibleEvents.length;
			for (let i = 0; i < visibleEvents.length; i++) {
				context.fillStyle = payloadCaseColor(visibleEvents[i].getPayloadCase());
				context.fillRect(i * width, 0, Math.max(1, width), canvas.height);
			}
		};

		/** @type {function(number):void} */
		const select = (index) => {
			this.selectedIndex_ = Math.max(
				0,
				Math.min(visibleEvents.length - 1, index),
			);
			seek.value = String(this.selectedIndex_);
			previous.disabled = this.selectedIndex_ === 0;
			next.disabled = this.selectedIndex_ === visibleEvents.length - 1;
			const event = visibleEvents[this.selectedIndex_];
			const eventTime = eventTimestampMillis(event);
			time.textContent =
				eventTime != null && this.buildStartMillis_ != null
					? formatElapsed(eventTime - this.buildStartMillis_) +
						" · event " +
						(this.selectedIndex_ + 1) +
						" / " +
						visibleEvents.length
					: "Time not reported · event " +
						(this.selectedIndex_ + 1) +
						" / " +
						visibleEvents.length;
			dom.removeChildren(detail);
			detail.appendChild(this.createSelectedEventDetail_(event));
		};
		/** @type {function():void} */
		const applyTypeFilter = () => {
			const current = visibleEvents[this.selectedIndex_];
			visibleEvents = selectedTypes.size
				? this.events_.filter((event) => selectedTypes.has(event.getPayloadCase()))
				: this.events_.slice();
			seek.max = String(Math.max(0, visibleEvents.length - 1));
			const retainedIndex = current ? visibleEvents.indexOf(current) : -1;
			this.selectedIndex_ = retainedIndex >= 0 ? retainedIndex : 0;
			clear.classList.toggle("d-none", selectedTypes.size === 0);
			for (const payloadCase of payloadCases) {
				const button = typeButtons.get(payloadCase);
				if (!button) continue;
				const selected = selectedTypes.has(payloadCase);
				button.classList.toggle("selected", selected);
				button.setAttribute("aria-pressed", selected ? "true" : "false");
			}
			draw();
			select(this.selectedIndex_);
		};
		for (const payloadCase of payloadCases) {
			const button = typeButtons.get(payloadCase);
			if (!button) continue;
			this.getHandler().listen(button, events.EventType.CLICK, () => {
				if (selectedTypes.has(payloadCase)) selectedTypes.delete(payloadCase);
				else selectedTypes.add(payloadCase);
				applyTypeFilter();
			});
		}
		this.getHandler().listen(clear, events.EventType.CLICK, () => {
			selectedTypes.clear();
			applyTypeFilter();
		});
		this.getHandler().listen(seek, events.EventType.INPUT, () =>
			select(Number(seek.value)),
		);
		this.getHandler().listen(previous, events.EventType.CLICK, () =>
			select(this.selectedIndex_ - 1),
		);
		this.getHandler().listen(next, events.EventType.CLICK, () =>
			select(this.selectedIndex_ + 1),
		);
		this.getHandler().listen(
			canvas,
			events.EventType.CLICK,
			(/** !events.BrowserEvent */ e) => {
				const browserEvent = /** @type {!MouseEvent} */ (
					e.getBrowserEvent()
				);
				const bounds = canvas.getBoundingClientRect();
				const fraction = (browserEvent.clientX - bounds.left) / bounds.width;
				select(Math.floor(fraction * visibleEvents.length));
			},
		);
		draw();
		select(this.selectedIndex_);
		return section;
	}

	/**
	 * @private
	 * @param {!BuildEvent} event
	 * @return {!HTMLElement}
	 */
	createSelectedEventDetail_(event) {
		const root = document.createElement("div");
		const heading = document.createElement("div");
		heading.className = "d-flex flex-items-center mb-2";
		const swatch = document.createElement("span");
		swatch.className = "bes-event-swatch mr-2";
		swatch.style.backgroundColor = payloadCaseColor(event.getPayloadCase());
		const title = document.createElement("h3");
		title.className = "h4 m-0";
		title.textContent = payloadCaseName(event.getPayloadCase());
		heading.appendChild(swatch);
		heading.appendChild(title);
		const outcome = eventOutcome(event);
		if (outcome !== null) {
			const statusIcon = soy.renderAsElement(eventStatusIcon, {
				success: outcome,
			});
			statusIcon.classList.add("ml-2");
			heading.appendChild(statusIcon);
		}
		root.appendChild(heading);
		const values = this.selectedEventValues_(event);
		const grid = document.createElement("div");
		grid.className = "bes-summary-grid";
		for (const label in values) {
			const key = document.createElement("div");
			key.className = "text-bold color-fg-muted";
			key.textContent = label;
			const value = document.createElement("div");
			value.className = "bes-detail-value";
			if (event.getPayloadCase() === BuildEvent.PayloadCase.PROGRESS &&
				(label === "Standard output" || label === "Standard error")) {
				value.classList.add("text-mono", "text-small");
				value.appendChild(renderTerminalText(values[label]));
			} else {
				value.textContent = values[label];
			}
			grid.appendChild(key);
			grid.appendChild(value);
		}
		root.appendChild(grid);
		if (event.getPayloadCase() === BuildEvent.PayloadCase.BUILD_METRICS) {
			const metrics = event.getBuildMetrics();
			if (metrics) root.appendChild(this.createBuildMetricsDetail_(metrics));
		}
		if (event.getPayloadCase() === BuildEvent.PayloadCase.BUILD_TOOL_LOGS) {
			const logs = event.getBuildToolLogs();
			if (logs) {
				const criticalPath = this.createCriticalPathDetail_(logs);
				if (criticalPath) root.appendChild(criticalPath);
			}
		}
		const raw = document.createElement("details");
		raw.className = "mt-3";
		const summary = document.createElement("summary");
		summary.textContent = "Raw event data";
		raw.appendChild(summary);
		const pre = document.createElement("pre");
		pre.className = "bes-event-json mt-2 p-3";
		pre.textContent = formatJson(BuildEvent.toObject(false, event));
		raw.appendChild(pre);
		root.appendChild(raw);
		return /** @type {!HTMLElement} */ (root);
	}

	/**
	 * @private
	 * @param {!BuildMetrics} metrics
	 * @return {!HTMLElement}
	 */
	createBuildMetricsDetail_(metrics) {
		const root = /** @type {!HTMLElement} */ (document.createElement("div"));
		root.className = "mt-3";
		const object = /** @type {!Object<string, *>} */ (
			BuildMetrics.toObject(false, metrics)
		);
		for (const key of Object.keys(object)) {
			const metric = object[key];
			if (metric === undefined || metric === null ||
				(Array.isArray(metric) && metric.length === 0)) {
				continue;
			}
			const section = /** @type {!HTMLDetailsElement} */ (
				document.createElement("details")
			);
			section.className = "Box mb-2";
			section.open = true;
			const summary = document.createElement("summary");
			summary.className = "Box-header text-bold";
			summary.textContent = metricLabel(key);
			section.appendChild(summary);
			const body = document.createElement("div");
			body.className = "Box-body p-0 overflow-auto";
			body.appendChild(createMetricTable(metric));
			section.appendChild(body);
			root.appendChild(section);
		}
		return root;
	}

	/**
	 * @private
	 * @param {!BuildToolLogs} logs
	 * @return {?HTMLElement}
	 */
	createCriticalPathDetail_(logs) {
		for (const log of logs.getLogList()) {
			if (log.getName().toLowerCase() !== "critical path") continue;
			const bytes = /** @type {!Uint8Array} */ (log.getContents_asU8());
			if (!bytes.length) continue;
			const content = new TextDecoder().decode(bytes);
			const criticalPath = parseCriticalPath(content);
			const root = /** @type {!HTMLElement} */ (document.createElement("section"));
			root.className = "Box mt-3";
			const header = document.createElement("div");
			header.className = "Box-header d-flex flex-items-center";
			const title = document.createElement("h4");
			title.className = "Box-title flex-auto";
			title.textContent = "Critical path";
			const total = document.createElement("span");
			total.className = "text-mono text-small";
			total.textContent = formatElapsed(criticalPath.timeMillis);
			header.appendChild(title);
			header.appendChild(total);
			root.appendChild(header);
			const body = document.createElement("div");
			body.className = "Box-body p-0 overflow-auto";
			const table = document.createElement("table");
			table.className = "bes-critical-path-table width-full text-small";
			for (let i = 0; i < criticalPath.items.length; i++) {
				const item = criticalPath.items[i];
				const row = document.createElement("tr");
				const number = document.createElement("td");
				number.className = "color-fg-muted text-mono text-right";
				number.textContent = String(i + 1);
				const duration = document.createElement("td");
				duration.className = "text-mono text-right text-bold";
				duration.textContent = formatElapsed(item.timeMillis);
				const percent = document.createElement("td");
				percent.className = "text-mono text-right color-fg-muted";
				const ratio = criticalPath.timeMillis > 0
					? item.timeMillis / criticalPath.timeMillis : 0;
				percent.textContent = (ratio * 100).toFixed(2) + "%";
				const action = document.createElement("td");
				action.className = "bes-critical-path-action";
				const label = document.createElement("div");
				label.className = "text-mono text-small mb-1";
				label.textContent = item.action;
				const track = document.createElement("div");
				track.className = "bes-critical-path-track";
				const bar = document.createElement("div");
				bar.className = "bes-critical-path-bar";
				bar.style.marginLeft = criticalPath.timeMillis > 0
					? (item.startMillis / criticalPath.timeMillis * 100) + "%" : "0";
				bar.style.width = Math.max(0.2, ratio * 100) + "%";
				track.appendChild(bar);
				action.appendChild(label);
				action.appendChild(track);
				row.appendChild(number);
				row.appendChild(duration);
				row.appendChild(percent);
				row.appendChild(action);
				table.appendChild(row);
			}
			body.appendChild(table);
			root.appendChild(body);
			const raw = document.createElement("details");
			raw.className = "Box-footer";
			const summary = document.createElement("summary");
			summary.textContent = "Critical path log";
			raw.appendChild(summary);
			const pre = document.createElement("pre");
			pre.className = "bes-event-json mt-2 p-3 text-small";
			pre.textContent = content;
			raw.appendChild(pre);
			root.appendChild(raw);
			return root;
		}
		return null;
	}

	/**
	 * @private
	 * @param {!BuildEvent} event
	 * @return {!Object<string,string>}
	 */
	selectedEventValues_(event) {
		/** @type {!Object<string,string>} */
		const values = {
			"Event ID": eventIdSummary(event),
			"Announced children": String(event.getChildrenList().length),
		};
		switch (event.getPayloadCase()) {
			case BuildEvent.PayloadCase.STARTED: {
				const payload = event.getStarted();
				if (!payload) break;
				values["Invocation ID"] = payload.getUuid();
				values["Command"] = payload.getCommand();
				values["Bazel version"] = payload.getBuildToolVersion();
				values["Started"] = formatTimestamp(payload.getStartTime());
				values["Working directory"] = payload.getWorkingDirectory();
				values["Workspace"] = payload.getWorkspaceDirectory();
				values["Server PID"] = String(payload.getServerPid());
				values["User"] = payload.getUser();
				values["Host"] = payload.getHost();
				if (payload.getOptionsDescription()) {
					values["Options"] = payload.getOptionsDescription();
				}
				break;
			}
			case BuildEvent.PayloadCase.PROGRESS: {
				const payload = event.getProgress();
				if (!payload) break;
				values["Standard output"] =
					formatTerminalText(payload.getStdout()) || "None";
				values["Standard error"] =
					formatTerminalText(payload.getStderr()) || "None";
				break;
			}
			case BuildEvent.PayloadCase.ABORTED: {
				const payload = event.getAborted();
				if (!payload) break;
				values["Reason"] = abortReasonName(payload.getReason());
				values["Description"] = payload.getDescription();
				break;
			}
			case BuildEvent.PayloadCase.UNSTRUCTURED_COMMAND_LINE: {
				const payload = event.getUnstructuredCommandLine();
				if (!payload) break;
				values["Arguments"] = payload.getArgsList().join(" ");
				values["Argument count"] = String(payload.getArgsList().length);
				break;
			}
			case BuildEvent.PayloadCase.STRUCTURED_COMMAND_LINE: {
				const payload = event.getStructuredCommandLine();
				if (!payload) break;
				values["Label"] = payload.getCommandLineLabel();
				values["Sections"] = String(payload.getSectionsList().length);
				/** @type {!Array<string>} */
				const command = [];
				for (const section of payload.getSectionsList()) {
					const chunks = section.getChunkList();
					if (chunks) command.push(...chunks.getChunkList());
					const options = section.getOptionList();
					if (options) {
						for (const option of options.getOptionList()) {
							command.push(option.getCombinedForm());
						}
					}
				}
				values["Command line"] = command.join(" ");
				break;
			}
			case BuildEvent.PayloadCase.OPTIONS_PARSED: {
				const payload = event.getOptionsParsed();
				if (!payload) break;
				values["Startup options"] = payload.getStartupOptionsList().join(" ");
				values["Explicit startup options"] =
					payload.getExplicitStartupOptionsList().join(" ") || "None";
				values["Command line"] = payload.getCmdLineList().join(" ");
				values["Explicit command options"] =
					payload.getExplicitCmdLineList().join(" ") || "None";
				values["Tool tag"] = payload.getToolTag() || "None";
				break;
			}
			case BuildEvent.PayloadCase.WORKSPACE_STATUS: {
				const payload = event.getWorkspaceStatus();
				if (!payload) break;
				/** @type {!Array<string>} */
				const items = [];
				for (const item of payload.getItemList()) {
					items.push(item.getKey() + "=" + item.getValue());
				}
				values["Items"] = items.join("\n") || "None";
				values["Item count"] = String(items.length);
				break;
			}
			case BuildEvent.PayloadCase.FETCH: {
				const payload = event.getFetch();
				if (!payload) break;
				const id = event.getId();
				const fetchId = id ? id.getFetch() : null;
				if (fetchId) values["URL"] = fetchId.getUrl();
				values["Success"] = payload.getSuccess() ? "Yes" : "No";
				break;
			}
			case BuildEvent.PayloadCase.CONFIGURATION: {
				const payload = event.getConfiguration();
				if (!payload) break;
				values["Mnemonic"] = payload.getMnemonic();
				values["Platform"] = payload.getPlatformName();
				values["CPU"] = payload.getCpu();
				values["Tool configuration"] = payload.getIsTool() ? "Yes" : "No";
				values["Make variables"] = String(payload.getMakeVariableMap().getLength());
				break;
			}
			case BuildEvent.PayloadCase.EXPANDED: {
				const payload = event.getExpanded();
				if (!payload) break;
				values["Test suite expansions"] =
					String(payload.getTestSuiteExpansionsList().length);
				values["Expanded children"] = String(event.getChildrenList().length);
				break;
			}
			case BuildEvent.PayloadCase.CONFIGURED: {
				const payload = event.getConfigured();
				if (!payload) break;
				values["Target kind"] = payload.getTargetKind();
				values["Test size"] = testSizeName(payload.getTestSize());
				values["Tags"] = payload.getTagList().join(", ") || "None";
				values["Configurations"] = String(event.getChildrenList().length);
				break;
			}
			case BuildEvent.PayloadCase.ACTION: {
				const payload = event.getAction();
				if (!payload) break;
				values["Mnemonic"] = payload.getType();
				values["Success"] = payload.getSuccess() ? "Yes" : "No";
				values["Exit code"] = String(payload.getExitCode());
				values["Command"] = payload.getCommandLineList().join(" ");
				values["Started"] = formatTimestamp(payload.getStartTime());
				values["Finished"] = formatTimestamp(payload.getEndTime());
				const stdout = payload.getStdout();
				if (stdout) values["Standard output"] = fileSummary(stdout);
				const stderr = payload.getStderr();
				if (stderr) values["Standard error"] = fileSummary(stderr);
				const output = payload.getPrimaryOutput();
				if (output) values["Primary output"] = fileSummary(output);
				values["Strategy details"] = String(payload.getStrategyDetailsList().length);
				break;
			}
			case BuildEvent.PayloadCase.NAMED_SET_OF_FILES: {
				const payload = event.getNamedSetOfFiles();
				if (!payload) break;
				values["Files"] = payload.getFilesList().map(fileSummary).join("\n") || "None";
				values["File count"] = String(payload.getFilesList().length);
				values["Referenced sets"] = String(payload.getFileSetsList().length);
				break;
			}
			case BuildEvent.PayloadCase.COMPLETED: {
				const payload = event.getCompleted();
				if (!payload) break;
				values["Success"] = payload.getSuccess() ? "Yes" : "No";
				values["Output groups"] = payload.getOutputGroupList()
					.map((group) => group.getName() + (group.getIncomplete() ? " (incomplete)" : ""))
					.join(", ") || "None";
				values["Important outputs"] = String(payload.getImportantOutputList().length);
				values["Directory outputs"] = String(payload.getDirectoryOutputList().length);
				values["Tags"] = payload.getTagList().join(", ") || "None";
				const timeout = payload.getTestTimeout();
				if (timeout) {
					values["Test timeout"] =
						formatDuration(timeout.getSeconds(), timeout.getNanos());
				}
				break;
			}
			case BuildEvent.PayloadCase.TEST_RESULT: {
				const payload = event.getTestResult();
				if (!payload) break;
				values["Status"] = testStatusName(payload.getStatus());
				values["Status details"] = payload.getStatusDetails() || "None";
				values["Cached locally"] = payload.getCachedLocally() ? "Yes" : "No";
				values["Started"] = formatTimestamp(payload.getTestAttemptStart());
				const duration = payload.getTestAttemptDuration();
				if (duration) {
					values["Duration"] =
						formatDuration(duration.getSeconds(), duration.getNanos());
				}
				values["Outputs"] = payload.getTestActionOutputList()
					.map(fileSummary).join("\n") || "None";
				values["Warnings"] = payload.getWarningList().join("\n") || "None";
				const execution = payload.getExecutionInfo();
				if (execution) {
					values["Strategy"] = execution.getStrategy() || "Not reported";
					values["Remote cache hit"] = execution.getCachedRemotely() ? "Yes" : "No";
					values["Exit code"] = String(execution.getExitCode());
					values["Execution host"] = execution.getHostname() || "Not reported";
				}
				break;
			}
			case BuildEvent.PayloadCase.TEST_PROGRESS: {
				const payload = event.getTestProgress();
				if (!payload) break;
				values["URI"] = payload.getUri();
				break;
			}
			case BuildEvent.PayloadCase.TEST_SUMMARY: {
				const payload = event.getTestSummary();
				if (!payload) break;
				values["Status"] = testStatusName(payload.getOverallStatus());
				values["Runs"] = String(payload.getRunCount());
				values["Total attempts"] = String(payload.getTotalRunCount());
				values["Attempts per shard"] = String(payload.getAttemptCount());
				values["Shards"] = String(payload.getShardCount());
				values["Cached actions"] = String(payload.getTotalNumCached());
				values["First started"] = formatTimestamp(payload.getFirstStartTime());
				values["Last stopped"] = formatTimestamp(payload.getLastStopTime());
				const duration = payload.getTotalRunDuration();
				if (duration) {
					values["Total duration"] =
						formatDuration(duration.getSeconds(), duration.getNanos());
				}
				values["Passed logs"] = String(payload.getPassedList().length);
				values["Failed logs"] = String(payload.getFailedList().length);
				break;
			}
			case BuildEvent.PayloadCase.TARGET_SUMMARY: {
				const payload = event.getTargetSummary();
				if (!payload) break;
				values["Build success"] = payload.getOverallBuildSuccess() ? "Yes" : "No";
				values["Test status"] = testStatusName(payload.getOverallTestStatus());
				break;
			}
			case BuildEvent.PayloadCase.FINISHED: {
				const payload = event.getFinished();
				if (!payload) break;
				const exit = payload.getExitCode();
				values["Result"] = exit
					? exit.getName() + " (" + exit.getCode() + ")"
					: "Finished";
				values["Finished"] = formatTimestamp(payload.getFinishTime());
				break;
			}
			case BuildEvent.PayloadCase.BUILD_TOOL_LOGS: {
				const payload = event.getBuildToolLogs();
				if (!payload) break;
				values["Logs"] = payload.getLogList().map(fileSummary).join("\n") || "None";
				values["Log count"] = String(payload.getLogList().length);
				break;
			}
			case BuildEvent.PayloadCase.BUILD_METRICS: {
				const payload = event.getBuildMetrics();
				if (!payload) break;
				const object = /** @type {!Object<string, *>} */ (
					BuildMetrics.toObject(false, payload)
				);
				let count = 0;
				for (const key of Object.keys(object)) {
					const metric = object[key];
					if (metric !== undefined && metric !== null &&
						(!Array.isArray(metric) || metric.length)) count++;
				}
				values["Metric categories"] = String(count);
				break;
			}
			case BuildEvent.PayloadCase.WORKSPACE_INFO: {
				const payload = event.getWorkspaceInfo();
				if (!payload) break;
				values["Local execution root"] = payload.getLocalExecRoot();
				break;
			}
			case BuildEvent.PayloadCase.BUILD_METADATA: {
				const payload = event.getBuildMetadata();
				if (!payload) break;
				/** @type {!Array<string>} */
				const metadata = [];
				payload.getMetadataMap().forEach(
					(/** string */ value, /** string */ key) =>
						metadata.push(key + "=" + value),
				);
				values["Metadata"] = metadata.join("\n") || "None";
				values["Entry count"] = String(metadata.length);
				break;
			}
			case BuildEvent.PayloadCase.CONVENIENCE_SYMLINKS_IDENTIFIED: {
				const payload = event.getConvenienceSymlinksIdentified();
				if (!payload) break;
				/** @type {!Array<string>} */
				const symlinks = [];
				for (const symlink of payload.getConvenienceSymlinksList()) {
					const action = symlink.getAction() === 1 ? "Create" :
						symlink.getAction() === 2 ? "Delete" : "Unknown";
					symlinks.push(action + " " + symlink.getPath() +
						(symlink.getTarget() ? " → " + symlink.getTarget() : ""));
				}
				values["Symlinks"] = symlinks.join("\n") || "None";
				values["Symlink count"] = String(symlinks.length);
				break;
			}
			case BuildEvent.PayloadCase.EXEC_REQUEST: {
				const payload = event.getExecRequest();
				if (!payload) break;
				const decoder = new TextDecoder();
				values["Working directory"] = decoder.decode(
					/** @type {!Uint8Array} */ (payload.getWorkingDirectory_asU8()),
				);
				/** @type {!Array<string>} */
				const argv = [];
				for (const argument of payload.getArgvList_asU8()) {
					argv.push(decoder.decode(/** @type {!Uint8Array} */ (argument)));
				}
				values["Arguments"] = argv.join(" ");
				values["Environment variables"] =
					String(payload.getEnvironmentVariableList().length);
				values["Variables cleared"] =
					String(payload.getEnvironmentVariableToClearList().length);
				values["Execute"] = payload.getShouldExec() ? "Yes" : "No";
				break;
			}
		}
		return values;
	}

	/**
	 * @private
	 * @return {!HTMLElement}
	 */
	createSummary_() {
		const section = /** @type {!HTMLElement} */ (
			document.createElement("div")
		);
		section.className = "bes-summary-grid";
		/** @type {!Object<string,string>} */
		const values = {
			File: this.fileName_ + " (" + formatBytes(this.fileSize_) + ")",
			Events: String(this.events_.length),
		};
		/** @type {!Set<string>} */
		const targets = new Set();
		let command = "";
		/** @type {?boolean} */
		let buildOutcome = null;
		for (const event of this.events_) {
			if (event.hasStarted()) {
				const started = event.getStarted();
				command = started.getCommand();
				values["Invocation ID"] = started.getUuid() || "Not reported";
				values["Bazel version"] =
					started.getBuildToolVersion() || "Not reported";
			}
			if (event.getPayloadCase() === BuildEvent.PayloadCase.EXPANDED) {
				const id = event.getId();
				const pattern = id ? id.getPattern() : null;
				if (pattern) {
					for (const target of pattern.getPatternList()) targets.add(target);
				}
				const skipped = id ? id.getPatternSkipped() : null;
				if (skipped) {
					for (const target of skipped.getPatternList()) targets.add(target);
				}
			}
			if (event.hasFinished()) {
				const exit = event.getFinished().getExitCode();
				values["Result"] = exit
					? exit.getName() + " (" + exit.getCode() + ")"
					: "Finished";
				buildOutcome = exit ? exit.getCode() === 0 : null;
			}
		}
		const targetList = targets.size ? Array.from(targets).join(" ") : "";
		values["Command"] = (command + " " + targetList).trim() || "Not reported";
		for (const label in values) {
			const key = document.createElement("div");
			key.className = "text-bold color-fg-muted";
			key.textContent = label;
			const value = document.createElement("div");
			if (label === "Result" && buildOutcome !== null) {
				value.className = "d-flex flex-items-center";
				value.appendChild(soy.renderAsElement(eventStatusIcon, {
					success: buildOutcome,
				}));
				const text = document.createElement("span");
				text.className = "ml-2";
				text.textContent = values[label];
				value.appendChild(text);
			} else {
				value.textContent = values[label];
			}
			section.appendChild(key);
			section.appendChild(value);
		}
		return section;
	}

	/**
	 * @private
	 * @param {string} cssName
	 * @return {!HTMLElement}
	 */
	getElement_(cssName) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector("." + cssName)
		);
	}
}

/**
 * @param {number} bytes
 * @return {string}
 */
function formatBytes(bytes) {
	if (bytes < 1024) return bytes + " B";
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
	return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

exports.decodeDelimitedMessages = decodeDelimitedMessages;
exports.formatTerminalText = formatTerminalText;
exports.parseCriticalPath = parseCriticalPath;
exports.renderTerminalText = renderTerminalText;
