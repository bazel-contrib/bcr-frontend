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

const EventHandler = goog.require("goog.events.EventHandler");
const base64 = goog.require("goog.crypt.base64");

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

/** Bezel action palette, grouped by color.
 * @const {!Array<!Array<string>>}
 */
const BEZEL_MNEMONIC_COLORS = [
	["#a05f14", "JavaIjar Javac Turbine JavacTurbine JavaSourceJar"],
	["#ed306a", "CppCompile CcStrip SolibSymlink"],
	["#f7ba13", "CppLink"],
	["#159ccf", "GoCompilePkg GoLink GoSourcesData"],
	["#4b3c72", "haskell"],
	["#094eaf", "jsonnet"],
	["#eb7b27", "kotlin"],
	["#3676fe", "objc"],
	["#295e94", "py python"],
	["#1975e1", "r"],
	["#5c0c11", "ruby SoyCompiler"],
	["#d59471", "rust Rustc"],
	["#b21931", "scala Scalac ScalaDeployJar"],
	["#7add40", "sh GZIP Genrule FileWrite TemplateExpand"],
	["#fe9b37", "swift"],
	["#236176", "ts TypeScriptCompile"],
	["#eedc49", "js Closure TestRunner"],
	["#6cae04", "Commands BazelWorkspaceStatusAction SkylarkAction Middleman PackagingSourcesManifest"],
	["#e22b9a", "SymlinkTree SourceSymlinkManifest ExecutableSymlink"],
	["#2b3c42", "docker ImageConfig ImageLayer SHA256"],
	["#8fbc2b", "android"],
	["#187405", "csharp CoreCompile"],
	["#47b2b9", "GenProtoDescriptorSet GoProtocGen ProtoCompile GenProto proto"],
	["#50a6c0", "elm"],
	["#fc4f05", "genmnemonic"],
	["#1a90f4", "filegroup toolchain"],
	["#3b5b3a", "platform"],
	["#e47182", "config"],
	["#a82273", "constraint"],
	["#000000", "alias"],
	["#2db23e", "skylark"],
	["#442b68", "css SassCompiler"],
	["#dd3531", "AngularTemplateCompile"],
];
/** @const {!Map<string,string>} */
const MNEMONIC_COLORS = new Map();
for (const entry of BEZEL_MNEMONIC_COLORS) {
	for (const name of entry[1].split(" ")) MNEMONIC_COLORS.set(name, entry[0]);
}

/**
 * @param {!BuildEvent} event
 * @return {string}
 */
function eventMarkColor(event) {
	const action = event.getAction();
	const mnemonic = action && action.getType();
	if (!mnemonic) return payloadCaseColor(event.getPayloadCase());
	const known = MNEMONIC_COLORS.get(mnemonic);
	if (known) return known;
	let hash = 0;
	for (let i = 0; i < mnemonic.length; i++) {
		hash = (Math.imul(hash, 31) + mnemonic.charCodeAt(i)) >>> 0;
	}
	return "hsl(" + (hash % 360) + ", 65%, 48%)";
}

/** Maps announced ID cases to the payload palette. Their wire numbers differ.
 * @const {!Map<number,number>}
 */
const EXPECTED_PAYLOADS = new Map([
	[BuildEventId.IdCase.PROGRESS, BuildEvent.PayloadCase.PROGRESS],
	[BuildEventId.IdCase.STARTED, BuildEvent.PayloadCase.STARTED],
	[BuildEventId.IdCase.UNSTRUCTURED_COMMAND_LINE, BuildEvent.PayloadCase.UNSTRUCTURED_COMMAND_LINE],
	[BuildEventId.IdCase.STRUCTURED_COMMAND_LINE, BuildEvent.PayloadCase.STRUCTURED_COMMAND_LINE],
	[BuildEventId.IdCase.OPTIONS_PARSED, BuildEvent.PayloadCase.OPTIONS_PARSED],
	[BuildEventId.IdCase.WORKSPACE_STATUS, BuildEvent.PayloadCase.WORKSPACE_STATUS],
	[BuildEventId.IdCase.FETCH, BuildEvent.PayloadCase.FETCH],
	[BuildEventId.IdCase.CONFIGURATION, BuildEvent.PayloadCase.CONFIGURATION],
	[BuildEventId.IdCase.PATTERN, BuildEvent.PayloadCase.EXPANDED],
	[BuildEventId.IdCase.PATTERN_SKIPPED, BuildEvent.PayloadCase.EXPANDED],
	[BuildEventId.IdCase.TARGET_CONFIGURED, BuildEvent.PayloadCase.CONFIGURED],
	[BuildEventId.IdCase.ACTION_COMPLETED, BuildEvent.PayloadCase.ACTION],
	[BuildEventId.IdCase.NAMED_SET, BuildEvent.PayloadCase.NAMED_SET_OF_FILES],
	[BuildEventId.IdCase.TARGET_COMPLETED, BuildEvent.PayloadCase.COMPLETED],
	[BuildEventId.IdCase.TEST_RESULT, BuildEvent.PayloadCase.TEST_RESULT],
	[BuildEventId.IdCase.TEST_PROGRESS, BuildEvent.PayloadCase.TEST_PROGRESS],
	[BuildEventId.IdCase.TEST_SUMMARY, BuildEvent.PayloadCase.TEST_SUMMARY],
	[BuildEventId.IdCase.TARGET_SUMMARY, BuildEvent.PayloadCase.TARGET_SUMMARY],
	[BuildEventId.IdCase.BUILD_FINISHED, BuildEvent.PayloadCase.FINISHED],
	[BuildEventId.IdCase.BUILD_TOOL_LOGS, BuildEvent.PayloadCase.BUILD_TOOL_LOGS],
	[BuildEventId.IdCase.BUILD_METRICS, BuildEvent.PayloadCase.BUILD_METRICS],
	[BuildEventId.IdCase.WORKSPACE, BuildEvent.PayloadCase.WORKSPACE_INFO],
	[BuildEventId.IdCase.BUILD_METADATA, BuildEvent.PayloadCase.BUILD_METADATA],
	[BuildEventId.IdCase.CONVENIENCE_SYMLINKS_IDENTIFIED, BuildEvent.PayloadCase.CONVENIENCE_SYMLINKS_IDENTIFIED],
	[BuildEventId.IdCase.EXEC_REQUEST, BuildEvent.PayloadCase.EXEC_REQUEST],
	[BuildEventId.IdCase.UNCONFIGURED_LABEL, BuildEvent.PayloadCase.ABORTED],
	[BuildEventId.IdCase.CONFIGURED_LABEL, BuildEvent.PayloadCase.ABORTED],
]);

/** @const {number} */
const TERMINAL_LIMIT = 64 * 1024;

/** @typedef {{id: ?BuildEventId, event: ?BuildEvent, index: number,
 *     pendingIndex: number, parents: !Array<!FrontierMark>,
 *     children: !Array<!FrontierMark>, color: string}} */
let FrontierMark;

/**
 * Key the entire ID, including configuration, shard, attempt, and primary output.
 * @param {!BuildEventId} id
 * @return {string}
 */
function frontierId(id) {
	return base64.encodeByteArray(id.serializeBinary());
}

class InvocationProgress {
	constructor() {
		/** @const {!Array<!FrontierMark>} */
		this.history = [];
		/** @const {!Map<string,!FrontierMark>} */
		this.pending = new Map();
		/** @private @const {!Map<string,!FrontierMark>} */
		this.marks_ = new Map();
		/** @type {?FrontierMark} */
		this.last = null;
		/** @type {?BuildEvent} */
		this.started = null;
		/** @type {?BuildEvent} */
		this.finished = null;
		/** @const {!Set<string>} */
		this.targets = new Set();
		/** @const {!Map<string,string>} */
		this.metadata = new Map();
		/** @type {?number} */
		this.bazelRemoteCacheHits = null;
		/** @type {?BuildMetrics} */
		this.metrics = null;
		/** @type {?BuildToolLogs} */
		this.toolLogs = null;
		/** @const {!Array<!BuildEvent>} */
		this.tests = [];
		/** @const {!Array<string>} */
		this.logChunks = [];
		this.log = "";
		this.logTruncated = false;
	}

	/**
	 * @private
	 * @param {?BuildEventId} id
	 * @return {!FrontierMark}
	 */
	mark_(id) {
		const key = id && id.getIdCase() ? frontierId(id) : null;
		const prior = key === null ? undefined : this.marks_.get(key);
		if (prior) return prior;
		const mark = {
			id,
			event: null,
			index: -1,
			pendingIndex: -1,
			parents: [],
			children: [],
			color: payloadCaseColor(id ? EXPECTED_PAYLOADS.get(id.getIdCase()) || 0 : 0),
		};
		if (key !== null) this.marks_.set(key, mark);
		return mark;
	}

	/** @param {!BuildEvent} event */
	add(event) {
		const id = event.getId() || null;
		const mark = this.mark_(id);
		if (mark.event) return;
		if (id && id.getIdCase()) this.pending.delete(frontierId(id));
		mark.event = event;
		mark.index = this.history.length;
		mark.color = eventMarkColor(event);
		this.history.push(mark);
		if (event.getLastMessage()) this.last = mark;

		// A child may be announced by several parents or already have arrived.
		const children = new Set();
		for (const childId of event.getChildrenList()) {
			if (!childId.getIdCase()) continue;
			const child = this.mark_(childId);
			if (child === mark || children.has(child)) continue;
			children.add(child);
			mark.children.push(child);
			child.parents.push(mark);
			if (!child.event) this.pending.set(frontierId(childId), child);
			if (event.hasStarted()) this.addTargetPattern_(childId);
		}
		if (id) this.addTargetPattern_(id);
		if (event.hasStarted()) this.started = event;
		if (event.hasFinished()) this.finished = event;
		const metrics = event.getBuildMetrics();
		if (metrics) this.metrics = metrics;
		const toolLogs = event.getBuildToolLogs();
		if (toolLogs) this.toolLogs = toolLogs;
		if (event.hasTestResult() || event.hasTestSummary()) this.tests.push(event);
		const actions = metrics && metrics.getActionSummary();
		if (actions) {
			const runners = actions.getRunnerCountList();
			if (runners.length) {
				this.bazelRemoteCacheHits = 0;
				for (const runner of runners) {
					if (runner.getName() === "remote cache hit") {
						this.bazelRemoteCacheHits += runner.getCount();
					}
				}
			} else if (Number(actions.getRemoteCacheHits()) > 0) {
				this.bazelRemoteCacheHits = Number(actions.getRemoteCacheHits());
			}
		}
		const progress = event.getProgress();
		if (progress) {
			// BEP recommends stderr first when both streams share a wrapper.
			const output = progress.getStderr() + progress.getStdout();
			if (output) this.logChunks.push(output);
			this.log += output;
			if (this.log.length > TERMINAL_LIMIT) {
				const cutoff = this.log.length - TERMINAL_LIMIT;
				const newline = this.log.indexOf("\n", cutoff);
				this.log = this.log.slice(newline < 0 || newline === this.log.length - 1 ? cutoff : newline + 1);
				this.logTruncated = true;
			}
		}
		const status = event.getWorkspaceStatus();
		if (status) {
			for (const item of status.getItemList()) {
				this.addMetadata_(item.getKey(), item.getValue());
			}
		}
		const metadata = event.getBuildMetadata();
		if (metadata) {
			metadata.getMetadataMap().forEach(
				(/** string */ value, /** string */ key) => this.addMetadata_(key, value),
			);
		}
	}

	/**
	 * @param {!BuildEventId} id
	 * @private
	 */
	addTargetPattern_(id) {
		const value = id.getPattern() || id.getPatternSkipped();
		if (!value) return;
		for (const pattern of value.getPatternList()) this.targets.add(pattern);
	}

	/**
	 * @param {string} key
	 * @param {string} value
	 * @private
	 */
	addMetadata_(key, value) {
		switch (key) {
			case "BUILD_USER":
			case "BUILD_HOST":
			case "REPO_URL":
			case "BRANCH_NAME":
			case "COMMIT_SHA":
			case "ROLE":
				if (value) this.metadata.set(key, value);
		}
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
			return payload ? (timestampMillis(payload.getStartTime()) ?? (Number(payload.getStartTimeMillis()) || null)) : null;
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
			return payload ? (timestampMillis(payload.getFinishTime()) ?? (Number(payload.getFinishTimeMillis()) || null)) : null;
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

/** @typedef {{foreground: string, background: string, bold: boolean, dim: boolean}} */
let TerminalStyle;

/** @return {!TerminalStyle} */
function defaultTerminalStyle() {
	return {foreground: "", background: "", bold: false, dim: false};
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
	let {foreground, background, bold, dim} = style;
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
	Object.assign(style, {foreground, background, bold, dim});
	return root;
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
		this.reset();
	}

	reset() {
		this.cursor_ = 0;
		this.partial_ = "";
		this.style_ = defaultTerminalStyle();
		this.root.scrollTop = 0;
		dom.removeChildren(this.root);
		this.tail_.textContent = "No build output received.";
		this.root.appendChild(this.tail_);
	}

	/** @param {!Array<string>} chunks */
	update(chunks) {
		if (this.cursor_ === chunks.length) return;
		const follow = this.cursor_ === 0 ||
			this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight <= 8;
		let pending = this.partial_;
		while (this.cursor_ < chunks.length) {
			pending += chunks[this.cursor_++];
			if (pending.length >= TERMINAL_LIMIT) pending = this.appendLines_(pending);
		}
		this.partial_ = this.appendLines_(pending);
		dom.removeChildren(this.tail_);
		const style = /** @type {!TerminalStyle} */ (
			Object.assign(defaultTerminalStyle(), this.style_)
		);
		const lastLine = renderTerminalText(formatTerminalText(this.partial_), style);
		while (lastLine.firstChild) this.tail_.appendChild(lastLine.firstChild);
		if (follow) this.root.scrollTop = this.root.scrollHeight;
	}

	/**
	 * @private
	 * @param {string} text
	 * @return {string}
	 */
	appendLines_(text) {
		const end = text.lastIndexOf("\n") + 1;
		if (end === 0) return text;
		const rendered = renderTerminalText(formatTerminalText(text.slice(0, end)), this.style_);
		const batch = document.createDocumentFragment();
		while (rendered.firstChild) batch.appendChild(rendered.firstChild);
		this.root.insertBefore(batch, this.tail_);
		return text.slice(end);
	}
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

/**
 * @param {!HTMLTableElement} table
 * @param {!Array<string>} labels
 */
function appendTableHeader(table, labels) {
	const head = /** @type {!HTMLTableSectionElement} */ (table.createTHead());
	const row = /** @type {!HTMLTableRowElement} */ (head.insertRow());
	for (const label of labels) {
		const heading = document.createElement("th");
		heading.scope = "col";
		heading.textContent = label;
		row.appendChild(heading);
	}
}

/**
 * @param {?BuildToolLogs} logs
 * @return {string}
 */
function criticalPathLog(logs) {
	if (!logs) return "";
	for (const file of logs.getLogList()) {
		if (file.getName().trim().toLowerCase() !== "critical path") continue;
		const bytes = /** @type {!Uint8Array} */ (file.getContents_asU8());
		if (bytes.length) return new TextDecoder().decode(bytes);
	}
	return "";
}

/**
 * @param {?BuildMetrics} metrics
 * @return {?number}
 */
function criticalPathMillis(metrics) {
	const timing = metrics && metrics.getTimingMetrics();
	const duration = timing && timing.getCriticalPathTime();
	return duration ? Number(duration.getSeconds()) * 1000 + Math.round(duration.getNanos() / 1000000) : null;
}

/**
 * @typedef {{key: string, label: string, configuration: string, summary: ?BuildEvent,
 *     attempts: !Array<!BuildEvent>}}
 */
let InvocationTest;

/**
 * @param {!Array<!BuildEvent>} events
 * @return {!Array<!InvocationTest>}
 */
function groupInvocationTests(events) {
	/** @type {!Map<string,!InvocationTest>} */
	const groups = new Map();
	for (const event of events) {
		const id = event.getId();
		if (!id) continue;
		const result = id.getTestResult();
		const summary = id.getTestSummary();
		if (!result && !summary) continue;
		const label = result ? result.getLabel() : summary.getLabel();
		const config = result ? result.getConfiguration() : summary.getConfiguration();
		const configuration = config ? config.getId() : "";
		const key = JSON.stringify([label, configuration]);
		let group = groups.get(key);
		if (!group) {
			group = {key, label, configuration, summary: null, attempts: []};
			groups.set(key, group);
		}
		if (event.hasTestSummary()) group.summary = event;
		else group.attempts.push(event);
	}
	return Array.from(groups.values());
}

/**
 * @param {number} status
 * @param {string=} fallback
 * @return {!HTMLElement}
 */
function testStatusLabel(status, fallback = "Status unavailable") {
	const badge = /** @type {!HTMLElement} */ (document.createElement("span"));
	badge.className = "Label";
	if (status === 1) badge.classList.add("Label--success");
	else if (status === 2 || status === 5 || status === 8) badge.classList.add("Label--attention");
	else if (status > 0) badge.classList.add("Label--danger");
	badge.textContent = status ? testStatusName(status) : fallback;
	return badge;
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
		const match = /^\s*([\d,.]+)s action '(.+)'\s*$/.exec(lines[i]);
		if (!match) continue;
		const itemMillis = Math.round(Number(match[1].replace(/,/g, "")) * 1000);
		if (!Number.isFinite(itemMillis)) continue;
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
	return buildEventIdSummary(event.getId() || null);
}

/**
 * @param {?BuildEventId} id
 * @return {string}
 */
function buildEventIdSummary(id) {
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

const FRONTIER_CELL_SIZE = 13;
const FRONTIER_INSET = 10;

class InvocationFrontier {
	/**
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!HTMLElement} scroll
	 * @param {!HTMLElement} spacer
	 * @param {function(!FrontierMark):void} inspect
	 */
	constructor(canvas, scroll, spacer, inspect) {
		this.canvas = canvas;
		this.scroll = scroll;
		this.spacer = spacer;
		this.inspect = inspect;
		this.progress = new InvocationProgress();
		/** @private @type {!Array<!FrontierMark>} */
		this.pending_ = [];
		/** @private @type {?FrontierMark} */
		this.selected_ = null;
		this.columns_ = 1;
	}

	/** @param {!InvocationProgress} progress */
	update(progress) {
		if (this.progress !== progress) {
			this.selected_ = null;
			this.scroll.scrollTop = 0;
			this.canvas.title = "";
		}
		this.progress = progress;
		this.pending_ = Array.from(progress.pending.values());
		this.pending_.forEach((mark, index) => { mark.pendingIndex = index; });
		this.draw();
		if (this.selected_) this.select_(this.selected_);
	}

	/**
	 * @private
	 * @return {number}
	 */
	historyRow_() {
		return Number(!!this.progress.last) + Math.ceil(this.pending_.length / this.columns_);
	}

	/**
	 * @private
	 * @param {number} column
	 * @param {number} row
	 * @return {?FrontierMark}
	 */
	markAt_(column, row) {
		if (column < 0 || column >= this.columns_ || row < 0) return null;
		const last = this.progress.last;
		if (last && row === 0) return column === 0 ? last : null;
		if (row < this.historyRow_()) {
			return this.pending_[(row - Number(!!last)) * this.columns_ + column] || null;
		}
		let index = this.progress.history.length - 1 -
			((row - this.historyRow_()) * this.columns_ + column);
		if (last && index <= last.index) index--;
		return this.progress.history[index] || null;
	}

	/**
	 * @private
	 * @param {!FrontierMark} mark
	 * @return {{column: number, row: number}}
	 */
	cell_(mark) {
		const last = this.progress.last;
		if (mark === last) return {column: 0, row: 0};
		const index = mark.event
			? this.progress.history.length - 1 - mark.index - Number(!!last && last.index > mark.index)
			: mark.pendingIndex;
		const offset = mark.event ? this.historyRow_() : Number(!!last);
		return {column: index % this.columns_, row: offset + Math.floor(index / this.columns_)};
	}

	draw() {
		const width = this.scroll.clientWidth;
		const height = this.scroll.clientHeight;
		const context = /** @type {?CanvasRenderingContext2D} */ (this.canvas.getContext("2d"));
		if (!width || !height || !context) return;
		this.columns_ = Math.max(1, Math.floor((width - 2 * FRONTIER_INSET) / FRONTIER_CELL_SIZE));
		const historyRows = Math.ceil(
			(this.progress.history.length - Number(!!this.progress.last)) / this.columns_,
		);
		const rows = this.historyRow_() + historyRows;
		this.spacer.style.height = Math.max(
			0, 2 * FRONTIER_INSET + rows * FRONTIER_CELL_SIZE - height,
		) + "px";
		const scale = window.devicePixelRatio || 1;
		if (this.canvas.width !== Math.round(width * scale) ||
			this.canvas.height !== Math.round(height * scale)) {
			this.canvas.width = Math.round(width * scale);
			this.canvas.height = Math.round(height * scale);
			this.canvas.style.height = height + "px";
		}
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, width, height);
		const top = this.scroll.scrollTop;
		const first = Math.max(0, Math.floor((top - FRONTIER_INSET) / FRONTIER_CELL_SIZE));
		const end = Math.min(rows, Math.ceil((top + height - FRONTIER_INSET) / FRONTIER_CELL_SIZE));
		/** @type {function(number):number} */
		const x = (column) => FRONTIER_INSET + (column + 0.5) * FRONTIER_CELL_SIZE;
		/** @type {function(number):number} */
		const y = (row) => FRONTIER_INSET + (row + 0.5) * FRONTIER_CELL_SIZE - top;
		const foreground = getComputedStyle(this.canvas).color;

		const selected = this.selected_;
		if (selected) {
			const origin = this.cell_(selected);
			context.beginPath();
			/** @type {!Array<!Array<!FrontierMark>>} */
			const connections = [selected.parents, selected.children];
			for (const relatives of connections) {
				for (const relative of relatives) {
					const target = this.cell_(relative);
					if (target.row < first || target.row >= end) continue;
					context.moveTo(x(origin.column), y(origin.row));
					context.lineTo(x(target.column), y(target.row));
				}
			}
			context.strokeStyle = foreground;
			context.globalAlpha = 0.35;
			context.stroke();
			context.globalAlpha = 1;
		}

		for (let row = first; row < end; row++) {
			for (let column = 0; column < this.columns_; column++) {
				const mark = this.markAt_(column, row);
				if (!mark) break;
				const left = x(column) - 3;
				const top = y(row) - 3;
				context.strokeStyle = foreground;
				context.globalAlpha = 0.55;
				context.strokeRect(left - 0.5, top - 0.5, 7, 7);
				context.globalAlpha = 1;
				if (mark.event) {
					context.fillStyle = mark.color;
					context.fillRect(left, top, 6, 6);
				} else {
					context.strokeStyle = mark.color;
					context.strokeRect(left + 0.5, top + 0.5, 5, 5);
				}
				if (mark === selected) {
					context.strokeStyle = foreground;
					context.strokeRect(left - 2.5, top - 2.5, 11, 11);
				}
			}
		}
	}

	/**
	 * @param {!MouseEvent} event
	 * @return {?FrontierMark}
	 */
	pick(event) {
		const bounds = this.canvas.getBoundingClientRect();
		return this.markAt_(
			Math.floor((event.clientX - bounds.left - FRONTIER_INSET) / FRONTIER_CELL_SIZE),
			Math.floor((event.clientY - bounds.top + this.scroll.scrollTop - FRONTIER_INSET) / FRONTIER_CELL_SIZE),
		);
	}

	/** @param {!FrontierMark} mark */
	select(mark) {
		this.select_(mark);
		this.draw();
	}

	/**
	 * @private
	 * @param {!FrontierMark} mark
	 */
	select_(mark) {
		this.selected_ = mark;
		this.inspect(mark);
	}

	/** @param {!KeyboardEvent} event */
	navigate(event) {
		const key = event.key;
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
		event.preventDefault();
		const current = this.selected_;
		let mark = this.markAt_(0, 0);
		if (key === "End") {
			mark = this.progress.history[0] || mark;
		} else if (current && key !== "Home") {
			const {column, row} = this.cell_(current);
			switch (key) {
				case "ArrowLeft": mark = this.markAt_(column - 1, row); break;
				case "ArrowRight": mark = this.markAt_(column + 1, row); break;
				case "ArrowUp": mark = this.markAt_(column, row - 1) || this.markAt_(0, row - 1); break;
				case "ArrowDown": mark = this.markAt_(column, row + 1) || this.markAt_(0, row + 1); break;
			}
		}
		if (!mark) return;
		const top = FRONTIER_INSET + this.cell_(mark).row * FRONTIER_CELL_SIZE;
		if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
		if (top + FRONTIER_CELL_SIZE > this.scroll.scrollTop + this.scroll.clientHeight) {
			this.scroll.scrollTop = top + FRONTIER_CELL_SIZE - this.scroll.clientHeight;
		}
		this.select(mark);
	}
}

/**
 * @param {!FrontierMark} mark
 * @return {string}
 */
function frontierMarkLabel(mark) {
	const action = mark.event && mark.event.getAction();
	const mnemonic = action && action.getType();
	const label = buildEventIdSummary(mark.id);
	return (mnemonic ? mnemonic + " · " : "") + label;
}

class BuildEventViewerComponent extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);

		/** @private @type {!Array<!BuildEvent>} */
		this.events_ = [];
		/** @private @type {!InvocationProgress} */
		this.progress_ = new InvocationProgress();
		/** @private @type {?InvocationFrontier} */
		this.frontier_ = null;
		/** @private @type {?ResizeObserver} */
		this.frontierObserver_ = null;
		/** @private @type {?FrontierMark} */
		this.inspected_ = null;
		/** @private @type {?BuildEvent} */
		this.inspectedEvent_ = null;
		/** @private @type {?string} */
		this.renderedLog_ = null;
		/** @private @type {?InvocationTerminal} */
		this.terminal_ = null;
		/** @private @type {number} */
		this.activeTab_ = 0;
		/** @private @type {string} */
		this.testsRenderKey_ = "";
		/** @private @type {?BuildMetrics} */
		this.renderedMetrics_ = null;
		/** @private @type {?BuildToolLogs} */
		this.renderedPathLogs_ = null;
		/** @private @type {?number} */
		this.renderedPathTime_ = null;
		/** @private @type {number} */
		this.clockTimer_ = 0;
		/** @private @type {number} */
		this.cacheTimer_ = 0;
		/** @private @type {boolean} */
		this.cacheRequestPending_ = false;
		/** @private @type {boolean} */
		this.cacheRefreshQueued_ = false;
		/** @private @type {?Object<string, *>} */
		this.cacheSummary_ = null;

		/** @private @type {?number} */
		this.clockStoppedAt_ = null;
		/** @private @type {boolean} */
		this.local_ = false;
		/** @private @type {boolean} */
		this.connected_ = false;
		/** @private @type {string} */
		this.fileName_ = "";
		/** @private @type {number} */
		this.fileSize_ = 0;
		/** @private @type {number} */
		this.selectedIndex_ = 0;
		/** @private @const {!Set<number>} */
		this.selectedTypes_ = new Set();
		/** @private @type {?number} */
		this.buildStartMillis_ = null;
		/** @private @type {?EventSource} */
		this.source_ = null;
		/** @private @type {number} */
		this.lastCursor_ = 0;
		/** @private @type {number} */
		this.renderTimer_ = 0;
		/** @private @type {number} */
		this.loadGeneration_ = 0;
		/** @private @const {!EventHandler} */
		this.resultsHandler_ = new EventHandler(this);
		this.registerDisposable(this.resultsHandler_);
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(invocationViewer));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		this.getHandler().listen(
			this.getElement_(goog.getCssName("bes-refresh")),
			events.EventType.CLICK,
			() => this.refreshRuns_(),
		);
		this.getHandler().listen(
			this.getElement_(goog.getCssName("bes-connect")),
			events.EventType.CLICK,
			() => this.connectBackend_(),
		);
		this.getHandler().listen(
			this.getElement_(goog.getCssName("bes-disconnect")),
			events.EventType.CLICK,
			() => this.disconnectBackend_(),
		);
		this.getHandler().listen(
			this.getElement_(goog.getCssName("bes-runs")),
			events.EventType.CHANGE,
			() => {
				this.backendInput_(goog.getCssName("bes-id")).value =
					/** @type {!HTMLSelectElement} */ (
						this.getElement_(goog.getCssName("bes-runs"))
					).value;
			},
		);
		this.bindTabs_();
		this.bindFrontier_();
		if (this.events_.length) this.renderTab_();
		const browser = this.getElement_(goog.getCssName("bes-browser"));
		this.getHandler().listen(browser, "toggle", () => this.renderEventBrowser_());
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
		this.getHandler().listen(choose, events.EventType.CLICK, () =>
			input.click(),
		);
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
	 * @param {string} name
	 * @return {!HTMLInputElement}
	 */
	backendInput_(name) {
		return /** @type {!HTMLInputElement} */ (this.getElement_(name));
	}

	/**
	 * @private
	 * @return {string}
	 */
	backendURL_() {
		const url = new URL(
			this.backendInput_(goog.getCssName("bes-backend")).value,
		);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("Use an HTTP or HTTPS backend URL.");
		}
		return url.href.replace(/\/$/, "");
	}

	/** @private */
	async refreshRuns_() {
		const status = this.getElement_(goog.getCssName("bes-connection"));
		status.textContent = "Loading saved runs…";
		try {
			const response = await fetch(this.backendURL_() + "/api/invocations");
			if (!response.ok)
				throw new Error("Backend returned HTTP " + response.status);
			const result =
				/** @type {!Object<string,!Array<!Object<string,string>>>} */ (
					await response.json()
				);
			if (this.isDisposed() || !this.isInDocument()) return;
			const select = /** @type {!HTMLSelectElement} */ (
				this.getElement_(goog.getCssName("bes-runs"))
			);
			while (select.options.length > 1) select.remove(1);
			// JSON field names form the HTTP API and must survive ADVANCED renaming.
			const runs = result["invocations"] || [];
			for (const run of runs) {
				const option = document.createElement("option");
				option.value = String(run["invocationId"]);
				option.textContent =
					String(run["command"] || "Bazel") + " · " + option.value;
				select.appendChild(option);
			}
			status.textContent = runs.length + " saved invocations";
		} catch (error) {
			if (!this.isDisposed())
				status.textContent =
					"Could not load runs. Check the backend URL and allowed frontend origin.";
		}
	}

	/** @private */
	connectBackend_() {
		const status = this.getElement_(goog.getCssName("bes-connection"));
		try {
			const id = this.backendInput_(goog.getCssName("bes-id")).value.trim();
			if (!id) throw new Error("Enter an invocation ID or select a saved run.");
			const url = this.backendURL_() + "/api/invocations/" + encodeURIComponent(id);
			this.stopBackend_();
			this.events_ = [];
			this.progress_ = new InvocationProgress();
			this.local_ = false;
			this.connected_ = false;
			this.clockStoppedAt_ = null;
			this.resetResults_();
			this.selectedIndex_ = 0;
			this.selectedTypes_.clear();
			this.buildStartMillis_ = null;
			this.fileName_ = id;
			this.fileSize_ = 0;
			this.lastCursor_ = 0;
			this.renderSummary_();
			this.getElement_(CSS_STATUS).textContent = "";
			const source = (this.source_ = new EventSource(url + "/events"));
			this.cacheTimer_ = setInterval(() => this.refreshCacheStats_(url), 1500);
			source.onopen = () => {
				this.connected_ = true;
				this.clockStoppedAt_ = null;
				this.renderSummary_();
				status.textContent = "Connected · replaying and following " + id;
			};
			source.onerror = () => {
				this.connected_ = false;
				this.clockStoppedAt_ = this.clockStoppedAt_ ?? Date.now();
				this.renderSummary_();
				status.textContent = source.readyState === EventSource.CLOSED
					? "Could not open the invocation stream."
					: "Connection interrupted · reconnecting from the last event";
			};
			source.addEventListener("bep", (e) => {
				const message = /** @type {!Object<string,string>} */ (e);
				const cursor = Number(message["lastEventId"]);
				if (cursor <= this.lastCursor_) return;
				try {
					const bytes = base64.decodeStringToUint8Array(message["data"]);
					const event = BuildEvent.deserializeBinary(bytes);
					this.lastCursor_ = cursor;
					this.events_.push(event);
					this.progress_.add(event);
					if (event.getLastMessage()) {
						clearInterval(this.cacheTimer_);
						this.cacheTimer_ = 0;
						this.refreshCacheStats_(url, true);
					}
					this.fileSize_ += bytes.length;
					if (event.getPayloadCase() === BuildEvent.PayloadCase.STARTED) {
						this.buildStartMillis_ = eventTimestampMillis(event);
					}
					status.textContent =
						"Following " + id + " · " + this.events_.length + " events";
					// Coalesce bursts so a build doesn't redraw the timeline on every event.
					if (!this.renderTimer_) {
						this.renderTimer_ = setTimeout(() => {
							this.renderTimer_ = 0;
							this.renderResults_();
						}, 250);
					}
				} catch (error) {
					this.disconnectBackend_();
					status.textContent = "Could not decode a backend build event.";
				}
			});
		} catch (error) {
			status.textContent =
				"Enter an invocation ID and a valid HTTP or HTTPS backend URL.";
		}
	}

	/** @private */
	disconnectBackend_() {
		const renderPending = this.renderTimer_ !== 0;
		this.stopBackend_();
		if (renderPending) this.renderResults_();
		else this.renderSummary_();
		this.getElement_(goog.getCssName("bes-connection")).textContent =
			"Disconnected";
	}

	/** @private */
	stopBackend_() {
		this.loadGeneration_++;
		clearInterval(this.cacheTimer_);
		this.cacheTimer_ = 0;
		this.cacheRequestPending_ = false;
		this.cacheRefreshQueued_ = false;
		if (this.source_) this.source_.close();
		this.source_ = null;
		this.connected_ = false;
		this.clockStoppedAt_ = this.clockStoppedAt_ ?? Date.now();
		clearInterval(this.clockTimer_);
		this.clockTimer_ = 0;
		clearTimeout(this.renderTimer_);
		this.renderTimer_ = 0;
	}

	/** @override */
	exitDocument() {
		this.stopBackend_();
		if (this.frontierObserver_) this.frontierObserver_.disconnect();
		super.exitDocument();
	}

	/** @override */
	disposeInternal() {
		this.stopBackend_();
		super.disposeInternal();
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
		if (this.getElement_(CSS_SUMMARY).getAttribute("role") === "button" &&
			(key === "Enter" || key === " ")) {
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
		if (this.source_) this.disconnectBackend_();
		const generation = ++this.loadGeneration_;
		status.textContent = "Reading " + file.name + "…";
		status.className = "sr-only " + goog.getCssName("status");
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (this.isDisposed() || generation !== this.loadGeneration_) return;
			const fileEvents = /** @type {!Array<!BuildEvent>} */ (
				decodeDelimitedMessages(bytes, (message) =>
					BuildEvent.deserializeBinary(message),
				)
			);
			if (!fileEvents.length) throw new Error("The file contains no events.");
			this.resetResults_();
			this.events_ = fileEvents;
			this.progress_ = new InvocationProgress();
			for (const event of fileEvents) this.progress_.add(event);
			this.local_ = true;
			this.fileName_ = file.name;
			this.fileSize_ = file.size;
			this.selectedIndex_ = 0;
			this.selectedTypes_.clear();
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
			if (this.isDisposed() || generation !== this.loadGeneration_) return;
			status.textContent =
				"Could not read this build event file. The file may be truncated or invalid.";
			status.className = "mt-3 flash flash-error " + goog.getCssName("status");
		}
	}

	/** @private */
	bindTabs_() {
		const tabs = this.getElement_(goog.getCssName("bes-tabs"));
		this.terminal_ = new InvocationTerminal(this.getElement_(goog.getCssName("bes-log-full")));
		const buttons = tabs.querySelectorAll("button");
		for (let i = 0; i < buttons.length; i++) {
			const button = buttons[i];
			const index = Number(i);
			this.getHandler().listen(button, events.EventType.CLICK, () => this.selectTab_(index));
			this.getHandler().listen(button, events.EventType.KEYDOWN, (/** !events.BrowserEvent */ e) => {
				const key = e.key;
				let next;
				switch (key) {
					case "ArrowLeft": next = (index + buttons.length - 1) % buttons.length; break;
					case "ArrowRight": next = (index + 1) % buttons.length; break;
					case "Home": next = 0; break;
					case "End": next = buttons.length - 1; break;
					default: return;
				}
				e.preventDefault();
				this.selectTab_(next);
				buttons[next].focus();
			});
		}
		this.getHandler().listen(this.getElement_(goog.getCssName("bes-download-log")),
			events.EventType.CLICK, () => this.downloadLog_());
	}

	/**
	 * @private
	 * @param {number} index
	 * @param {boolean=} skipRender
	 */
	selectTab_(index, skipRender = false) {
		this.activeTab_ = index;
		const tabs = this.getElement_(goog.getCssName("bes-tabs")).querySelectorAll("button");
		const panels = this.getElement_(CSS_RESULTS).querySelectorAll('[role="tabpanel"]');
		for (let i = 0; i < tabs.length; i++) {
			const active = i === index;
			tabs[i].setAttribute("aria-selected", String(active));
			tabs[i].tabIndex = active ? 0 : -1;
			/** @type {!HTMLElement} */ (panels[i]).hidden = !active;
		}
		if (!skipRender) this.renderTab_();
	}

	/** @private */
	downloadLog_() {
		const chunks = this.progress_.logChunks;
		if (!chunks.length) return;
		const blob = new Blob(chunks, {type: "text/plain;charset=utf-8"});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = this.fileName_ + ".log";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	/** @private */
	renderTab_() {
		switch (this.activeTab_) {
			case 0:
				this.renderOverview_();
				break;
			case 1:
				if (this.terminal_) this.terminal_.update(this.progress_.logChunks);
				/** @type {!HTMLButtonElement} */ (
					this.getElement_(goog.getCssName("bes-download-log"))
				).disabled = this.progress_.logChunks.length === 0;
				break;
			case 2:
				this.renderTests_();
				break;
			case 3:
				this.renderMetrics_();
				break;
		}
	}

	/** @private */
	bindFrontier_() {
		const canvas = /** @type {!HTMLCanvasElement} */ (
			this.getElement_(goog.getCssName("bes-frontier-canvas"))
		);
		const scroll = this.getElement_(goog.getCssName("bes-frontier-scroll"));
		const spacer = this.getElement_(goog.getCssName("bes-frontier-spacer"));
		const frontier = new InvocationFrontier(canvas, scroll, spacer,
			(mark) => this.inspectFrontierMark_(mark));
		this.frontier_ = frontier;
		if (this.events_.length) frontier.update(this.progress_);
		this.frontierObserver_ = new ResizeObserver(() => frontier.draw());
		this.frontierObserver_.observe(scroll);
		this.getHandler().listen(scroll, events.EventType.SCROLL, () => frontier.draw());
		this.getHandler().listen(canvas, events.EventType.CLICK, (/** !events.BrowserEvent */ e) => {
			const mark = frontier.pick(/** @type {!MouseEvent} */ (e.getBrowserEvent()));
			if (mark) frontier.select(mark);
		});
		this.getHandler().listen(canvas, events.EventType.MOUSEMOVE, (/** !events.BrowserEvent */ e) => {
			const mark = frontier.pick(/** @type {!MouseEvent} */ (e.getBrowserEvent()));
			canvas.title = mark ? frontierMarkLabel(mark) : "";
		});
		this.getHandler().listen(canvas, events.EventType.KEYDOWN, (/** !events.BrowserEvent */ e) =>
			frontier.navigate(/** @type {!KeyboardEvent} */ (e.getBrowserEvent())),
		);
	}

	/** @private */
	resetResults_() {
		this.resultsHandler_.removeAll();
		this.inspected_ = null;
		this.inspectedEvent_ = null;
		this.renderedLog_ = null;
		this.cacheSummary_ = null;
		this.testsRenderKey_ = "";
		this.renderedMetrics_ = null;
		this.renderedPathLogs_ = null;
		this.renderedPathTime_ = null;
		this.getElement_(CSS_RESULTS).classList.add("d-none");
		this.selectTab_(0, true);
		if (this.terminal_) this.terminal_.reset();
		dom.removeChildren(this.getElement_(goog.getCssName("bes-critical-path")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-tests")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-metrics")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-frontier-detail")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-browser-body")));
		this.getElement_(goog.getCssName("bes-frontier-caption")).textContent =
			"Select a mark to inspect its event and connections.";
		this.getElement_(goog.getCssName("bes-log")).scrollTop = 0;
	}

	/**
	 * @private
	 * @param {!FrontierMark} mark
	 */
	inspectFrontierMark_(mark) {
		const caption = this.getElement_(goog.getCssName("bes-frontier-caption"));
		const label = frontierMarkLabel(mark);
		const state = mark.event
			? (mark === this.progress_.last ? "Final event" : "Received")
			: this.progress_.last ? "Unreceived" : "Expected";
		const text = state + " · " + label + " · " + mark.parents.length +
			" parents · " + mark.children.length + " children";
		if (caption.textContent !== text) caption.textContent = text;
		if (this.inspected_ === mark && this.inspectedEvent_ === mark.event) return;
		this.inspected_ = mark;
		this.inspectedEvent_ = mark.event;
		const detail = this.getElement_(goog.getCssName("bes-frontier-detail"));
		dom.removeChildren(detail);
		if (mark.event) {
			detail.appendChild(this.createSelectedEventDetail_(mark.event));
		}
	}

	/** @private */
	renderResults_() {
		this.renderSummary_();
		const results = this.getElement_(CSS_RESULTS);
		if (results.classList.contains("d-none")) {
			const source = /** @type {!HTMLDetailsElement} */ (
				this.getElement_(goog.getCssName("bes-source"))
			);
			source.open = false;
			results.classList.remove("d-none");
		}
		this.renderTab_();
	}

	/** @private */
	renderOverview_() {
		this.renderOverviewCriticalPath_();
		const terminal = this.getElement_(goog.getCssName("bes-log"));
		const log = this.progress_.log;
		if (this.renderedLog_ !== log) {
			const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 8;
			dom.removeChildren(terminal);
			terminal.appendChild(renderTerminalText(formatTerminalText(log || "No build output received.")));
			if (atBottom || this.renderedLog_ === null) terminal.scrollTop = terminal.scrollHeight;
			this.renderedLog_ = log;
		}
		this.getElement_(goog.getCssName("bes-log-limit")).textContent =
			this.progress_.logTruncated ? "Showing recent output" : "";
		const pending = this.progress_.pending.size;
		const received = this.progress_.history.length + " received";
		this.getElement_(goog.getCssName("bes-frontier-count")).textContent = this.progress_.last
			? "Stream ended · " + (pending ? pending + " unreceived · " : "") + received
			: pending + " expected · " + received;
		if (this.frontier_) this.frontier_.update(this.progress_);
		this.renderCacheStats_();
		this.renderEventBrowser_();
	}

	/**
	 * @private
	 * @param {string} url
	 * @param {boolean=} finalRefresh
	 */
	async refreshCacheStats_(url, finalRefresh) {
		if (this.cacheRequestPending_) {
			this.cacheRefreshQueued_ = this.cacheRefreshQueued_ || !!finalRefresh;
			return;
		}
		this.cacheRequestPending_ = true;
		const generation = this.loadGeneration_;
		try {
			const response = await fetch(url);
			if (!response.ok || generation !== this.loadGeneration_) return;
			const summary = /** @type {!Object<string, *>} */ (await response.json());
			if (generation !== this.loadGeneration_) return;
			this.cacheSummary_ = summary;
			if (this.activeTab_ === 0 && this.events_.length) this.renderCacheStats_();
		} catch (_error) {
			// BES replay can continue independently of the summary request.
		} finally {
			if (generation === this.loadGeneration_) {
				this.cacheRequestPending_ = false;
				if (this.cacheRefreshQueued_) {
					this.cacheRefreshQueued_ = false;
					this.refreshCacheStats_(url);
				}
			}
		}
	}

	/** @private */
	renderCacheStats_() {
		const body = this.getElement_(goog.getCssName("bes-cache-stats"));
		const summary = this.cacheSummary_;
		const stored = summary && summary["bazelRemoteCacheHits"];
		const hits = stored != null ? Number(stored) : this.progress_.bazelRemoteCacheHits;
		const telemetry = /** @type {?Object<string, *>} */ (summary && summary["remoteCache"]);
		const values = /** @type {!Array<!Object<string, string>>} */ (
			(telemetry && telemetry["metrics"]) || []
		);
		/** @type {!Map<string,!Map<string,number>>} */
		const counts = new Map();
		/** @type {!Map<string,number>} */
		const traffic = new Map();
		for (const row of values) {
			const operation = String(row["operation"]);
			const result = String(row["result"]);
			let results = counts.get(operation);
			if (!results) {
				results = new Map();
				counts.set(operation, results);
			}
			results.set(result, Number(row["count"] || 0));
			traffic.set(operation, (traffic.get(operation) || 0) + Number(row["transferredBytes"] || 0));
		}
		/** @type {!Array<!Array<string>>} */
		const entries = [];
		entries.push(["Remote hits reported by Bazel", hits === null
			? (this.source_ && !this.progress_.last ? "Awaiting build metrics" : "Unavailable")
			: hits.toLocaleString()]);
		const lookup = counts.get("ac_lookup");
		if (lookup) {
			const found = lookup.get("hit") || 0;
			const missing = lookup.get("miss") || 0;
			const total = found + missing;
			const rate = total ? (100 * found / total).toFixed(1) + "% hit rate · " : "";
			entries.push(["Action cache lookups", rate + found.toLocaleString() + " hits · " +
				missing.toLocaleString() + " misses · " + (lookup.get("error") || 0).toLocaleString() + " errors"]);
		}
		/** @type {!Array<!Array<string>>} */
		const cacheRows = [
			["ac_write", "Action cache writes", "ok", "writes"],
			["cas_presence", "CAS presence checks", "hit", "present"],
			["cas_read", "CAS downloads", "hit", "downloaded"],
			["cas_write", "CAS uploads", "ok", "uploaded"],
		];
		for (const entry of cacheRows) {
			const results = counts.get(entry[0]);
			if (!results) continue;
			const parts = [(results.get(entry[2]) || 0).toLocaleString() + " " + entry[3]];
			if (entry[2] === "hit") {
				parts.push((results.get("miss") || 0).toLocaleString() + " missing");
			}
			parts.push((results.get("error") || 0).toLocaleString() + " errors");
			const bytes = traffic.get(entry[0]);
			if (bytes) parts.push(formatBytes(bytes) + " transferred");
			entries.push([entry[1], parts.join(" · ")]);
		}
		dom.removeChildren(body);
		const info = document.createElement("dl");
		info.className = "bes-invocation-metadata";
		for (const entry of entries) {
			const item = document.createElement("div");
			const term = document.createElement("dt");
			term.className = "color-fg-muted text-small";
			term.textContent = entry[0];
			const description = document.createElement("dd");
			description.textContent = entry[1];
			item.appendChild(term);
			item.appendChild(description);
			info.appendChild(item);
		}
		body.appendChild(info);
		if (!counts.size) {
			const message = document.createElement("div");
			message.className = "mt-2 color-fg-muted text-small";
			message.textContent = "No cache request telemetry available";
			body.appendChild(message);
		}
	}

	/** @private */
	renderTests_() {
		const ended = !!this.progress_.finished || !!this.progress_.last || this.local_;
		const key = this.progress_.tests.length + "/" + ended;
		if (key === this.testsRenderKey_) return;
		this.testsRenderKey_ = key;
		const body = this.getElement_(goog.getCssName("bes-tests"));
		/** @type {!Set<string>} */
		const open = new Set();
		for (const details of body.querySelectorAll("details[open]")) {
			open.add(details.getAttribute("data-test-key") || "");
		}
		dom.removeChildren(body);
		const groups = groupInvocationTests(this.progress_.tests);
		if (!groups.length) {
			body.appendChild(this.dataTabMessage_(ended ? "No test results were reported." : "Waiting for test results…"));
			return;
		}
		/** @type {!Map<number,number>} */
		const totals = new Map();
		for (const group of groups) {
			const summary = group.summary && group.summary.getTestSummary();
			const status = summary ? summary.getOverallStatus() : 0;
			totals.set(status, (totals.get(status) || 0) + 1);
		}
		const overview = document.createElement("div");
		overview.className = "bes-tests-header mb-3";
		const title = document.createElement("h2");
		title.className = "h3";
		title.textContent = "Test results";
		overview.appendChild(title);
		const counts = document.createElement("div");
		counts.className = "color-fg-muted text-small";
		/** @type {!Array<string>} */
		const parts = [];
		/** @type {!Array<number>} */
		const statuses = [];
		for (const status of totals.keys()) statuses.push(status);
		statuses.sort((a, b) => a - b);
		for (const status of statuses) {
			const description = status ? testStatusName(status).toLowerCase()
				: ended ? "without summary" : "awaiting summary";
			parts.push(totals.get(status) + " " + description);
		}
		counts.textContent = parts.join(" · ");
		overview.appendChild(counts);
		body.appendChild(overview);
		/** @type {function(!InvocationTest):number} */
		const order = (group) => {
			const summary = group.summary && group.summary.getTestSummary();
			const status = summary ? summary.getOverallStatus() : 0;
			if (status >= 3) return 0;
			if (status === 2) return 1;
			return status === 0 ? 2 : 3;
		};
		groups.sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label) ||
			a.configuration.localeCompare(b.configuration));
		for (const group of groups) {
			body.appendChild(this.createTestGroup_(group, ended, open.has(group.key)));
		}
	}

	/**
	 * @private
	 * @param {!InvocationTest} group
	 * @param {boolean} ended
	 * @param {boolean} open
	 * @return {!HTMLElement}
	 */
	createTestGroup_(group, ended, open) {
		const details = /** @type {!HTMLDetailsElement} */ (document.createElement("details"));
		details.className = "Box Box--condensed mb-2";
		details.open = open;
		details.setAttribute("data-test-key", group.key);
		const payload = group.summary && group.summary.getTestSummary();
		const summary = document.createElement("summary");
		summary.className = "Box-header";
		const name = document.createElement("span");
		name.className = "bes-test-target text-bold mr-2";
		name.textContent = group.label || "Unnamed test";
		summary.appendChild(name);
		summary.appendChild(testStatusLabel(payload ? payload.getOverallStatus() : 0,
			ended ? "Summary unavailable" : "Awaiting summary"));
		const duration = payload && payload.getTotalRunDuration();
		const meta = document.createElement("span");
		meta.className = "ml-2 text-small color-fg-muted";
		const attemptCount = payload ? payload.getTotalRunCount() || group.attempts.length : group.attempts.length;
		const parts = [attemptCount + (attemptCount === 1 ? " attempt" : " attempts")];
		if (duration) parts.push(formatDuration(duration.getSeconds(), duration.getNanos()));
		if (group.configuration) parts.push("Config " + group.configuration.slice(0, 8));
		meta.textContent = parts.join(" · ");
		meta.title = group.configuration;
		summary.appendChild(meta);
		details.appendChild(summary);

		const body = document.createElement("div");
		body.className = "Box-body overflow-auto";
		details.appendChild(body);
		if (!group.attempts.length) {
			body.textContent = "No individual test attempts were reported.";
			return details;
		}
		const table = /** @type {!HTMLTableElement} */ (document.createElement("table"));
		table.className = "bes-test-attempts text-small";
		appendTableHeader(table, ["Run / shard / attempt", "Result", "Duration", "Execution", "Details"]);
		const rows = /** @type {!HTMLTableSectionElement} */ (table.createTBody());
		for (const event of group.attempts) {
			const id = event.getId();
			const attempt = id && id.getTestResult();
			const result = event.getTestResult();
			if (!attempt || !result) continue;
			const row = /** @type {!HTMLTableRowElement} */ (rows.insertRow());
			const ordinal = row.insertCell(-1);
			ordinal.className = "text-mono";
			ordinal.textContent = [attempt.getRun(), attempt.getShard(), attempt.getAttempt()].join(" / ");
			row.insertCell(-1).appendChild(testStatusLabel(result.getStatus()));
			const elapsed = result.getTestAttemptDuration();
			const legacyMillis = Number(result.getTestAttemptDurationMillis());
			row.insertCell(-1).textContent = elapsed ? formatDuration(elapsed.getSeconds(), elapsed.getNanos())
				: legacyMillis ? formatElapsed(legacyMillis) : "—";
			const execution = result.getExecutionInfo();
			row.insertCell(-1).textContent = result.getCachedLocally() ? "Local cache" :
				execution && execution.getCachedRemotely() ? "Remote cache" :
				(execution && execution.getStrategy()) || "—";
			const info = row.insertCell(-1);
			const text = result.getStatusDetails();
			if (text) info.appendChild(document.createTextNode(text));
			for (const output of result.getTestActionOutputList()) {
				const file = document.createElement("div");
				file.className = "text-mono";
				file.textContent = fileSummary(output);
				info.appendChild(file);
			}
			if (!info.hasChildNodes()) info.textContent = "—";
		}
		body.appendChild(table);
		return details;
	}

	/**
	 * @private
	 * @param {string} message
	 * @return {!HTMLElement}
	 */
	dataTabMessage_(message) {
		const empty = /** @type {!HTMLElement} */ (document.createElement("p"));
		empty.className = "Box p-3 color-fg-muted";
		empty.textContent = message;
		return empty;
	}

	/** @private */
	renderMetrics_() {
		const body = this.getElement_(goog.getCssName("bes-metrics"));
		const metrics = this.progress_.metrics;
		if (!metrics) {
			const ended = this.progress_.finished || this.progress_.last || this.local_;
			const message = ended ? "No build metrics were reported." : "Waiting for build metrics…";
			if (body.textContent !== message) {
				dom.removeChildren(body);
				body.appendChild(this.dataTabMessage_(message));
			}
			return;
		}
		if (metrics === this.renderedMetrics_) return;
		this.renderedMetrics_ = metrics;
		dom.removeChildren(body);
		const timing = metrics.getTimingMetrics();
		const actions = metrics.getActionSummary();
		/** @type {!Array<!Array<string>>} */
		const entries = [];
		if (timing) {
			entries.push(
				["Wall time", formatElapsed(Number(timing.getWallTimeInMs()))],
				["CPU time", formatElapsed(Number(timing.getCpuTimeInMs()))],
				["Analysis time", formatElapsed(Number(timing.getAnalysisPhaseTimeInMs()))],
				["Execution time", formatElapsed(Number(timing.getExecutionPhaseTimeInMs()))],
			);
		}
		const path = criticalPathMillis(metrics);
		if (path !== null) entries.push(["Critical path", formatElapsed(path)]);
		if (actions) entries.push(["Actions executed", Number(actions.getActionsExecuted()).toLocaleString()]);
		if (entries.length) {
			const section = document.createElement("section");
			section.className = "Box Box--condensed mb-3";
			const header = document.createElement("h2");
			header.className = "Box-header Box-title";
			header.textContent = "Build metrics";
			section.appendChild(header);
			const summary = document.createElement("dl");
			summary.className = "Box-body bes-invocation-metadata";
			for (const entry of entries) {
				const item = document.createElement("div");
				const term = document.createElement("dt");
				term.className = "color-fg-muted text-small";
				term.textContent = entry[0];
				const value = document.createElement("dd");
				value.className = "text-mono";
				value.textContent = entry[1];
				item.appendChild(term);
				item.appendChild(value);
				summary.appendChild(item);
			}
			section.appendChild(summary);
			body.appendChild(section);
		}
		body.appendChild(this.createBuildMetricsDetail_(metrics, false));
	}

	/** @private */
	renderEventBrowser_() {
		const browser = /** @type {!HTMLDetailsElement} */ (
			this.getElement_(goog.getCssName("bes-browser"))
		);
		if (!browser.open || !this.events_.length) {
			this.resultsHandler_.removeAll();
			dom.removeChildren(this.getElement_(goog.getCssName("bes-browser-body")));
			return;
		}
		this.resultsHandler_.removeAll();
		const body = this.getElement_(goog.getCssName("bes-browser-body"));
		dom.removeChildren(body);
		body.appendChild(this.createTimeline_());
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
		const selectedTypes = this.selectedTypes_;
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
		/** @return {!Array<!BuildEvent>} */
		const filteredEvents = () =>
			selectedTypes.size
				? this.events_.filter((event) => selectedTypes.has(event.getPayloadCase()))
				: this.events_.slice();
		/** @type {!Array<!BuildEvent>} */
		let visibleEvents = filteredEvents();

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
		const updateTimeline = () => {
			seek.max = String(Math.max(0, visibleEvents.length - 1));
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
		const applyTypeFilter = () => {
			const current = visibleEvents[this.selectedIndex_];
			visibleEvents = filteredEvents();
			const retainedIndex = visibleEvents.indexOf(current);
			this.selectedIndex_ = retainedIndex >= 0 ? retainedIndex : 0;
			updateTimeline();
		};
		for (const payloadCase of payloadCases) {
			const button = typeButtons.get(payloadCase);
			if (!button) continue;
			this.resultsHandler_.listen(button, events.EventType.CLICK, () => {
				if (selectedTypes.has(payloadCase)) selectedTypes.delete(payloadCase);
				else selectedTypes.add(payloadCase);
				applyTypeFilter();
			});
		}
		this.resultsHandler_.listen(clear, events.EventType.CLICK, () => {
			selectedTypes.clear();
			applyTypeFilter();
		});
		this.resultsHandler_.listen(seek, events.EventType.INPUT, () =>
			select(Number(seek.value)),
		);
		this.resultsHandler_.listen(previous, events.EventType.CLICK, () =>
			select(this.selectedIndex_ - 1),
		);
		this.resultsHandler_.listen(next, events.EventType.CLICK, () =>
			select(this.selectedIndex_ + 1),
		);
		this.resultsHandler_.listen(
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
		updateTimeline();
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
		swatch.style.backgroundColor = eventMarkColor(event);
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
	 * @param {boolean=} expanded
	 * @return {!HTMLElement}
	 */
	createBuildMetricsDetail_(metrics, expanded = true) {
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
			section.open = expanded;
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

	/** @private */
	renderOverviewCriticalPath_() {
		const logs = this.progress_.toolLogs;
		const duration = criticalPathMillis(this.progress_.metrics);
		const ended = this.progress_.finished || this.progress_.last;
		if (!ended && !this.local_) return;
		if (this.renderedPathLogs_ === logs && this.renderedPathTime_ === duration) return;
		this.renderedPathLogs_ = logs;
		this.renderedPathTime_ = duration;
		const root = this.getElement_(goog.getCssName("bes-critical-path"));
		dom.removeChildren(root);
		const path = this.createCriticalPathDetail_(logs, duration);
		if (path) root.appendChild(path);
	}

	/**
	 * @private
	 * @param {?BuildToolLogs} logs
	 * @param {?number=} duration
	 * @return {?HTMLElement}
	 */
	createCriticalPathDetail_(logs, duration = null) {
		const content = criticalPathLog(logs);
		const criticalPath = parseCriticalPath(content);
		if (duration !== null) criticalPath.timeMillis = duration;
		if (!content && duration === null) return null;
		const root = /** @type {!HTMLElement} */ (document.createElement("section"));
		root.className = "Box Box--condensed my-3";
		const header = document.createElement("div");
		header.className = "Box-header d-flex flex-items-center";
		const title = document.createElement("h3");
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
		if (!criticalPath.items.length) {
			const unavailable = document.createElement("p");
			unavailable.className = "Box-body color-fg-muted mb-0";
			unavailable.textContent = "Action breakdown unavailable.";
			root.appendChild(unavailable);
			return root;
		}
		const table = /** @type {!HTMLTableElement} */ (document.createElement("table"));
		table.className = "bes-critical-path-table width-full text-small";
		appendTableHeader(table, ["#", "Duration", "% of path", "Action"]);
		const lastItem = criticalPath.items[criticalPath.items.length - 1];
		const chartMillis = Math.max(criticalPath.timeMillis, lastItem.startMillis + lastItem.timeMillis);
		const rows = /** @type {!HTMLTableSectionElement} */ (table.createTBody());
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
			const ratio = chartMillis > 0 ? item.timeMillis / chartMillis : 0;
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
			bar.style.marginLeft = chartMillis > 0 ? (item.startMillis / chartMillis * 100) + "%" : "0";
			bar.style.width = Math.max(0.2, ratio * 100) + "%";
			track.appendChild(bar);
			action.appendChild(label);
			action.appendChild(track);
			row.appendChild(number);
			row.appendChild(duration);
			row.appendChild(percent);
			row.appendChild(action);
			rows.appendChild(row);
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

	/** @private */
	renderSummary_() {
		if (!this.fileName_) return;
		const section = this.getElement_(CSS_SUMMARY);
		section.removeAttribute("role");
		section.removeAttribute("tabindex");
		section.removeAttribute("aria-describedby");
		dom.removeChildren(section);
		const overview = document.createElement("div");
		overview.className = "bes-invocation-overview";
		const header = document.createElement("div");
		header.className = "bes-invocation-heading";
		const command = document.createElement("h3");
		command.className = "h3 text-mono bes-invocation-command";
		const startedEvent = this.progress_.started;
		const started = startedEvent && startedEvent.getStarted();
		const finishedEvent = this.progress_.finished;
		const finished = finishedEvent && finishedEvent.getFinished();
		command.textContent = ["bazel", started && started.getCommand(),
			...this.progress_.targets].filter(Boolean).join(" ");
		header.appendChild(command);
		const state = document.createElement("div");
		state.className = "bes-invocation-state";
		const badge = document.createElement("span");
		badge.className = "Label";
		const exit = finished && finished.getExitCode();
		if (exit) {
			const success = exit.getCode() === 0;
			badge.textContent = success ? "Succeeded" : "Failed";
			badge.classList.add(success ? "Label--success" : "Label--danger");
			badge.title = exit.getName() + " (" + exit.getCode() + ")";
		} else if (finished) {
			badge.textContent = "Finished";
		} else if (this.progress_.last || this.local_) {
			badge.textContent = "Incomplete";
			badge.classList.add("Label--attention");
		} else if (!this.source_ && this.events_.length) {
			badge.textContent = "Disconnected";
		} else if (!this.connected_ && this.events_.length) {
			badge.textContent = "Reconnecting";
			badge.classList.add("Label--attention");
		} else if (this.events_.length) {
			badge.textContent = "Building";
			badge.classList.add("Label--accent");
		} else {
			badge.textContent = "Waiting for events";
		}
		state.appendChild(badge);
		const elapsed = document.createElement("time");
		elapsed.className = "text-mono";
		elapsed.setAttribute("aria-label", "Build elapsed time");
		state.appendChild(elapsed);
		header.appendChild(state);
		overview.appendChild(header);

		const metadata = this.progress_.metadata;
		const info = document.createElement("dl");
		info.className = "bes-invocation-metadata";
		/** @type {!Array<!Array<string|null|undefined>>} */
		const entries = [
			["Invocation ID", (started && started.getUuid()) || (!this.local_ ? this.fileName_ : "")],
			["Bazel version", started && started.getBuildToolVersion()],
			["Started", this.buildStartMillis_ === null ? "" : new Date(this.buildStartMillis_).toISOString()],
			["User", (started && started.getUser()) || metadata.get("BUILD_USER")],
			["Host", (started && started.getHost()) || metadata.get("BUILD_HOST")],
			["Workspace", started && started.getWorkspaceDirectory()],
			["Repository", metadata.get("REPO_URL")],
			["Branch", metadata.get("BRANCH_NAME")],
			["Commit", metadata.get("COMMIT_SHA")],
			["Role", metadata.get("ROLE")],
			["BEP file", this.local_ ? this.fileName_ + " · " + formatBytes(this.fileSize_) : ""],
		];
		for (const entry of entries) {
			const value = entry[1];
			if (!value) continue;
			const item = document.createElement("div");
			const term = document.createElement("dt");
			term.className = "color-fg-muted text-small";
			term.textContent = entry[0] || "";
			const description = document.createElement("dd");
			description.textContent = value;
			item.appendChild(term);
			item.appendChild(description);
			info.appendChild(item);
		}
		overview.appendChild(info);
		section.appendChild(overview);

		clearInterval(this.clockTimer_);
		this.clockTimer_ = 0;
		const start = this.buildStartMillis_;
		const finish = finishedEvent ? eventTimestampMillis(finishedEvent) : null;
		const active = !finishedEvent && !this.progress_.last && !this.local_ && this.connected_;
		const updateClock = () => {
			const end = finish ?? (finishedEvent || this.progress_.last || this.local_
				? null
				: active ? Date.now() : this.clockStoppedAt_);
			if (start === null || end === null) {
				elapsed.textContent = "—";
				return;
			}
			const duration = Math.max(0, end - start);
			elapsed.textContent = formatElapsed(duration);
			elapsed.setAttribute("datetime", "PT" + duration / 1000 + "S");
		};
		updateClock();
		if (active && start !== null) this.clockTimer_ = setInterval(updateClock, 250);
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

exports.FrontierMark = FrontierMark;
exports.InvocationProgress = InvocationProgress;
exports.InvocationTerminal = InvocationTerminal;
exports.decodeDelimitedMessages = decodeDelimitedMessages;
exports.formatTerminalText = formatTerminalText;
exports.parseCriticalPath = parseCriticalPath;
exports.renderTerminalText = renderTerminalText;
