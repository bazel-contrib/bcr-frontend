/** @fileoverview Decode Bazel build events and track invocation progress. */
goog.module("bcrfrontend.invocationEvents");

const Aborted = goog.require("proto.build_event_stream.Aborted");
const BesFile = goog.require("proto.build_event_stream.File");
const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const BuildEventId = goog.require("proto.build_event_stream.BuildEventId");
const BuildMetrics = goog.require("proto.build_event_stream.BuildMetrics");
const BuildToolLogs = goog.require("proto.build_event_stream.BuildToolLogs");
const base64 = goog.require("goog.crypt.base64");
const { TERMINAL_LIMIT, formatTerminalText, renderTerminalText } = goog.require("bcrfrontend.invocationTerminal");
const { formatBytes, timestampMillis, validDateMillis } = goog.require("bcrfrontend.invocationFormat");
const { mnemonicColor } = goog.require("bcrfrontend.actionColors");

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
 * ColorBrewer-based palette for build event types.
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
 * @param {!BuildEvent} event
 * @return {string}
 */
function eventMarkColor(event) {
	const action = event.getAction();
	const mnemonic = action && action.getType();
	return mnemonic ? mnemonicColor(mnemonic) : payloadCaseColor(event.getPayloadCase());
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

/** @typedef {{id: ?BuildEventId, event: ?BuildEvent, index: number,
 *     announcedAt: ?number,
 *     parents: !Array<!FrontierMark>,
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

/** @typedef {{name: string, size: number, uploadedAt: number}} */
let InvocationFile;

const COLLECTION_COMPLETE = "INVOCATION_STATE_COMPLETE";

const COLLECTION_INCOMPLETE = "INVOCATION_STATE_INCOMPLETE";

class InvocationProgress {
	/**
	 * @param {string=} sourceId Backend lookup ID or a synthetic ID for a local replay.
	 * @param {?InvocationFile=} file
	 */
	constructor(sourceId = "", file = null) {
		/** @const {string} */ this.sourceId = sourceId || "";
		/** @const {?InvocationFile} */ this.file = file ?? null;
		/** @const {!Array<!FrontierMark>} */
		this.history = [];
		/** @const {!Map<string,!FrontierMark>} */
		this.pending = new Map();
		/** @private @const {!Map<string,!FrontierMark>} */
		this.marks_ = new Map();
		/** @type {?FrontierMark} */
		this.last = null;
		/** @type {string} */
		this.collectionState = "";
		/** @type {?number} */
		this.collectionEndedAt = null;
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
		/** @const {!Map<string, {count: number, color: string}>} */
		this.mnemonics = new Map();
		this.receivedActions = 0;
		/** @private */ this.serverNow_ = 0;
		/** @private */ this.serverObservedAt_ = 0;
		/** @private @type {?number} */ this.frontierEndedAt_ = null;
		/** @const {!Array<string>} */
		this.logChunks = [];
		this.log = "";
		this.logTruncated = false;
	}

	/** @return {string} */
	invocationId() {
		return this.started?.getStarted()?.getUuid() || this.sourceId;
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
			announcedAt: null,
			parents: [],
			children: [],
			color: payloadCaseColor(id ? EXPECTED_PAYLOADS.get(id.getIdCase()) || 0 : 0),
		};
		if (key !== null) this.marks_.set(key, mark);
		return mark;
	}

	/**
	 * @param {!BuildEvent} event
	 * @param {?number=} receivedAt
	 * @param {number=} sentAt
	 */
	add(event, receivedAt = null, sentAt = 0) {
		const id = event.getId() || null;
		const mark = this.mark_(id);
		if (mark.event) return;
		if (id && id.getIdCase()) this.pending.delete(frontierId(id));
		mark.event = event;
		mark.index = this.history.length;
		mark.color = eventMarkColor(event);
		this.history.push(mark);
		const action = event.getAction();
		if (action) {
			const mnemonic = action.getType();
			const tally = this.mnemonics.get(mnemonic);
			if (tally) tally.count++;
			else this.mnemonics.set(mnemonic, {count: 1, color: mark.color});
			this.receivedActions++;
		}
		if (sentAt > 0 && Number.isFinite(sentAt)) {
			this.serverNow_ = sentAt;
			this.serverObservedAt_ = performance.now();
		}
		if (event.getLastMessage()) {
			this.last = mark;
			this.frontierEndedAt_ = receivedAt;
		}

		// A child may be announced by several parents or already have arrived.
		const children = new Set();
		for (const childId of event.getChildrenList()) {
			if (!childId.getIdCase()) continue;
			const child = this.mark_(childId);
			if (child === mark || children.has(child)) continue;
			children.add(child);
			mark.children.push(child);
			child.parents.push(mark);
			if (!child.event) {
				if (child.announcedAt === null) child.announcedAt = receivedAt;
				this.pending.set(frontierId(childId), child);
			}
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

	/** @return {number} */
	frontierNow() {
		return this.collectionEndedAt ?? this.frontierEndedAt_ ?? (this.serverNow_
			? this.serverNow_ + performance.now() - this.serverObservedAt_
			: Date.now());
	}

	/** @return {boolean} */
	collectionEnded() {
		return !!this.last || this.collectionState === COLLECTION_COMPLETE || this.collectionState === COLLECTION_INCOMPLETE;
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

/** @typedef {{context: string, message: string}} */
let InvocationFailure;

/**
 * @param {string} message
 * @return {string}
 */
function cleanFailureMessage(message) {
	const limit = 3000;
	const text = formatTerminalText(renderTerminalText(message.slice(0, limit)).textContent || "").trim();
	return message.length > limit ? text + "\n…" : text;
}

/**
 * Find a specific compiler, linker, or runtime diagnostic before falling back
 * to Bazel's ERROR announcement. Prefer the log block for the failed action.
 * @param {string} log
 * @param {string} label
 * @param {string=} detail
 * @return {string}
 */
function consoleFailure(log, label, detail = "") {
	const lines = formatTerminalText(renderTerminalText(log).textContent || "").split("\n");
	const diagnostic = /^\s*(?:fatal )?error(?:\[[\w-]+\])?:\s|:\s+(?:fatal )?error(?:\[[\w-]+\])?:\s|\bundefined reference to\b|^panic:/;
	const matchingAction = label ? lines.findIndex((line) =>
		line.startsWith("ERROR:") && line.includes(label + " failed")) : -1;
	if (matchingAction >= 0) {
		let firstOutput = "";
		for (let i = matchingAction + 1; i < lines.length; i++) {
			const line = lines[i];
			if (/^(?:ERROR|INFO|WARNING|FAILED):/.test(line)) break;
			if (diagnostic.test(line)) return cleanFailureMessage(line);
			const text = line.trim();
			if (!firstOutput && text !== label && text !== "@" + label) firstOutput = text;
		}
		if (firstOutput) return cleanFailureMessage(firstOutput);
	}
	const specific = lines.find((line) => !line.startsWith("ERROR:") && diagnostic.test(line));
	const bazelError = lines.find((line) =>
		line.startsWith("ERROR:") && !/^ERROR: Build did not complete successfully/i.test(line));
	return cleanFailureMessage(specific || detail || bazelError || "");
}

/**
 * @param {!InvocationProgress} progress
 * @return {?InvocationFailure}
 */
function invocationFailure(progress) {
	const finished = progress.finished?.getFinished();
	if (!finished) return null;
	const exit = finished.getExitCode();
	if (exit ? exit.getCode() === 0 : !finished.hasFailureDetail()) return null;
	const detail = finished.getFailureDetail()?.getMessage() || "";
	const fallback = exit ? "Bazel exited with " +
		(exit.getName() ? exit.getName() + " (" + exit.getCode() + ")" : "code " + exit.getCode()) + "."
		: "Bazel reported a build failure.";

	const actionMark = progress.history.find((mark) =>
		mark.event && mark.event.hasAction() && eventOutcome(mark.event) === false);
	const action = actionMark?.event?.getAction();
	if (action) {
		const actionId = actionMark?.id?.getActionCompleted();
		const label = actionId?.getLabel() || "";
		const subject = label || actionId?.getPrimaryOutput() || "";
		const context = [action.getType(), subject].filter(Boolean).join(" · ");
		const stderr = action.getStderr()?.getContents_asU8();
		const inlineError = stderr && stderr.length
			? cleanFailureMessage(new TextDecoder().decode(stderr.subarray(0, 12000))) : "";
		return {context, message: inlineError ||
			consoleFailure(progress.log, label, action.getFailureDetail()?.getMessage() || detail) || fallback};
	}

	const failedTest = progress.history.find((mark) =>
		mark.event && mark.event.hasTestSummary() && eventOutcome(mark.event) === false);
	const testSummary = failedTest?.event?.getTestSummary();
	if (testSummary) {
		return {context: failedTest?.id?.getTestSummary()?.getLabel() || "",
			message: "Test result: " + testStatusName(testSummary.getOverallStatus()) + "."};
	}

	const target = progress.history.find((mark) => mark.event?.getCompleted()?.getFailureDetail());
	const targetDetail = target?.event?.getCompleted()?.getFailureDetail()?.getMessage() || "";
	const abort = progress.history.find((mark) => {
		const aborted = mark.event?.getAborted();
		if (!aborted?.getDescription()) return false;
		const reason = aborted.getReason();
		return reason !== Aborted.AbortReason.SKIPPED && reason !== Aborted.AbortReason.NO_ANALYZE &&
			reason !== Aborted.AbortReason.NO_BUILD && reason !== Aborted.AbortReason.INCOMPLETE;
	});
	const abortDescription = abort?.event?.getAborted()?.getDescription() || "";
	return {
		context: target?.id?.getTargetCompleted()?.getLabel() || "",
		message: cleanFailureMessage(targetDetail || detail || abortDescription) ||
			consoleFailure(progress.log, "") || fallback,
	};
}

/**
 * @param {!BuildEvent} event
 * @return {?number}
 */
function eventTimestampMillis(event) {
	switch (event.getPayloadCase()) {
		case BuildEvent.PayloadCase.STARTED: {
			const payload = event.getStarted();
			return payload ? (timestampMillis(payload.getStartTime()) ?? (validDateMillis(Number(payload.getStartTimeMillis())) || null)) : null;
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
			return payload ? (timestampMillis(payload.getFinishTime()) ?? (validDateMillis(Number(payload.getFinishTimeMillis())) || null)) : null;
		}
		default:
			return null;
	}
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

exports.decodeDelimitedMessages = decodeDelimitedMessages;
exports.payloadCaseName = payloadCaseName;
exports.FrontierMark = FrontierMark;
exports.InvocationFile = InvocationFile;
exports.COLLECTION_COMPLETE = COLLECTION_COMPLETE;
exports.COLLECTION_INCOMPLETE = COLLECTION_INCOMPLETE;
exports.InvocationProgress = InvocationProgress;
exports.eventOutcome = eventOutcome;
exports.InvocationFailure = InvocationFailure;
exports.invocationFailure = invocationFailure;
exports.eventTimestampMillis = eventTimestampMillis;
exports.testStatusName = testStatusName;
exports.abortReasonName = abortReasonName;
exports.testSizeName = testSizeName;
exports.fileSummary = fileSummary;
exports.buildEventIdSummary = buildEventIdSummary;
