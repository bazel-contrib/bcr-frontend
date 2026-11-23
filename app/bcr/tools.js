/**
 * @fileoverview Browser-based Bazel tools and Build Event Protocol viewer.
 */
goog.module("bcrfrontend.tools");

const Aborted = goog.require("proto.build_event_stream.Aborted");
const BazelFlagDb = goog.require("proto.build.stack.bazel.help.v1.BazelFlagDb");
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
const { InvocationBackend, openInvocationBackend } = goog.require("bcrfrontend.invocationTransport");
const {
	eventStatusIcon,
	invocationGroups,
	invocationResultGlyph,
	invocationViewer,
	toolsCatalog,
	toolsSelect,
} = goog.require("soy.bcrfrontend.tools");

const EventHandler = goog.requireType("goog.events.EventHandler");
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
		return this.frontierEndedAt_ ?? (this.serverNow_
			? this.serverNow_ + performance.now() - this.serverObservedAt_
			: Date.now());
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

// Unquoted keys are renamed alongside the generated protobuf toObject fields.
/** @const {!Object<string, string>} */
const BUILD_METRIC_CATEGORIES = {
	actionSummary: "Actions",
	memoryMetrics: "Memory",
	targetMetrics: "Targets",
	packageMetrics: "Packages",
	timingMetrics: "Timing",
	cumulativeMetrics: "Bazel server totals",
	artifactMetrics: "Artifacts",
	buildGraphMetrics: "Build graph",
	workerMetricsList: "Workers",
	networkMetrics: "Network",
	workerPoolMetrics: "Worker pools",
	dynamicExecutionMetrics: "Dynamic execution",
	remoteAnalysisCacheStatistics: "Remote analysis cache",
};

/** @const {!Object<string, string>} */
const BUILD_METRIC_FIELDS = {
	actionCacheStatistics: "actionCacheStatistics",
	actionCount: "actionCount",
	actionCountNotIncludingAspects: "actionCountNotIncludingAspects",
	actionDataList: "actionDataList",
	actionLookupValueCount: "actionLookupValueCount",
	actionLookupValueCountNotIncludingAspects: "actionLookupValueCountNotIncludingAspects",
	actionsCreated: "actionsCreated",
	actionsCreatedNotIncludingAspects: "actionsCreatedNotIncludingAspects",
	actionsExecuted: "actionsExecuted",
	actionsExecutionStartInMs: "actionsExecutionStartInMs",
	aliveCount: "aliveCount",
	analysisCacheBatches: "analysisCacheBatches",
	analysisCacheBytesReceived: "analysisCacheBytesReceived",
	analysisCacheKeyBytesSent: "analysisCacheKeyBytesSent",
	analysisCacheOps: "analysisCacheOps",
	analysisPhaseTimeInMs: "analysisPhaseTimeInMs",
	aspectList: "aspectList",
	aspectName: "aspectName",
	builtValuesList: "builtValuesList",
	bytesRecv: "bytesRecv",
	bytesSent: "bytesSent",
	cacheCheckSemaphoreWaitTimeInMs: "cacheCheckSemaphoreWaitTimeInMs",
	cacheHits: "cacheHits",
	cacheMisses: "cacheMisses",
	changedValuesList: "changedValuesList",
	cleanedValuesList: "cleanedValuesList",
	code: "code",
	collectTimeInMs: "collectTimeInMs",
	computationSteps: "computationSteps",
	count: "count",
	cpuTimeInMs: "cpuTimeInMs",
	createdCount: "createdCount",
	criticalPathTime: "criticalPathTime",
	destroyedCount: "destroyedCount",
	dirtiedValuesList: "dirtiedValuesList",
	evaluatedValuesList: "evaluatedValuesList",
	evictedCount: "evictedCount",
	execKind: "execKind",
	executionPhaseTimeInMs: "executionPhaseTimeInMs",
	firstStartedMs: "firstStartedMs",
	garbageCollected: "garbageCollected",
	garbageMetricsList: "garbageMetricsList",
	globFilesystemOperationCost: "globFilesystemOperationCost",
	hash: "hash",
	hits: "hits",
	inputFileConfiguredTargetCount: "inputFileConfiguredTargetCount",
	interruptedExceptionDestroyedCount: "interruptedExceptionDestroyedCount",
	ioExceptionDestroyedCount: "ioExceptionDestroyedCount",
	isMeasurable: "isMeasurable",
	isMultiplex: "isMultiplex",
	isSandbox: "isSandbox",
	key: "key",
	lastActionStartTimeInMs: "lastActionStartTimeInMs",
	lastEndedMs: "lastEndedMs",
	loadDuration: "loadDuration",
	loadTimeInMs: "loadTimeInMs",
	localRunner: "localRunner",
	localWins: "localWins",
	missDetailsList: "missDetailsList",
	misses: "misses",
	mnemonic: "mnemonic",
	name: "name",
	nanos: "nanos",
	numAnalyses: "numAnalyses",
	numBuilds: "numBuilds",
	numTargets: "numTargets",
	numTransitiveLoads: "numTransitiveLoads",
	otherConfiguredTargetCount: "otherConfiguredTargetCount",
	outputArtifactCount: "outputArtifactCount",
	outputArtifactsFromActionCache: "outputArtifactsFromActionCache",
	outputArtifactsSeen: "outputArtifactsSeen",
	outputFileConfiguredTargetCount: "outputFileConfiguredTargetCount",
	packageLoadMetricsList: "packageLoadMetricsList",
	packageOverhead: "packageOverhead",
	packagesLoaded: "packagesLoaded",
	packetsRecv: "packetsRecv",
	packetsSent: "packetsSent",
	peakBytesRecvPerSec: "peakBytesRecvPerSec",
	peakBytesSentPerSec: "peakBytesSentPerSec",
	peakPacketsRecvPerSec: "peakPacketsRecvPerSec",
	peakPacketsSentPerSec: "peakPacketsSentPerSec",
	peakPostGcHeapSize: "peakPostGcHeapSize",
	peakPostGcTenuredSpaceHeapSize: "peakPostGcTenuredSpaceHeapSize",
	postInvocationSkyframeNodeCount: "postInvocationSkyframeNodeCount",
	priorActionsExecuted: "priorActionsExecuted",
	priorWorkerMemoryInKb: "priorWorkerMemoryInKb",
	processId: "processId",
	raceStatisticsList: "raceStatisticsList",
	reason: "reason",
	remoteCacheHits: "remoteCacheHits",
	remoteRunner: "remoteRunner",
	remoteWins: "remoteWins",
	ruleClass: "ruleClass",
	ruleClassList: "ruleClassList",
	runnerCountList: "runnerCountList",
	saveTimeInMs: "saveTimeInMs",
	seconds: "seconds",
	sizeInBytes: "sizeInBytes",
	skyfunctionName: "skyfunctionName",
	sourceArtifactsRead: "sourceArtifactsRead",
	systemNetworkStats: "systemNetworkStats",
	systemTime: "systemTime",
	targetsConfigured: "targetsConfigured",
	targetsConfiguredNotIncludingAspects: "targetsConfiguredNotIncludingAspects",
	targetsLoaded: "targetsLoaded",
	topLevelArtifacts: "topLevelArtifacts",
	type: "type",
	unknownDestroyedCount: "unknownDestroyedCount",
	usedHeapSizePostBuild: "usedHeapSizePostBuild",
	userExecExceptionDestroyedCount: "userExecExceptionDestroyedCount",
	userTime: "userTime",
	valueStoreKeyBytesSent: "valueStoreKeyBytesSent",
	valueStoreReadBatches: "valueStoreReadBatches",
	valueStoreReadOpsNotFound: "valueStoreReadOpsNotFound",
	valueStoreReadOpsSuccessful: "valueStoreReadOpsSuccessful",
	valueStoreValueBytesReceived: "valueStoreValueBytesReceived",
	valueStoreValueBytesSent: "valueStoreValueBytesSent",
	valueStoreWriteBatches: "valueStoreWriteBatches",
	valueStoreWriteOps: "valueStoreWriteOps",
	wallTimeInMs: "wallTimeInMs",
	workerId: "workerId",
	workerIdsList: "workerIdsList",
	workerKeyHash: "workerKeyHash",
	workerMemoryInKb: "workerMemoryInKb",
	workerPoolStatsList: "workerPoolStatsList",
	workerStatsList: "workerStatsList",
	workerStatus: "workerStatus",
};

/**
 * @param {string} name
 * @return {string}
 */
function metricLabel(name) {
	const label = name
		.replace(/List$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.toLowerCase()
		.replace(/\bcpu\b/g, "CPU")
		.replace(/\bgc\b/g, "GC")
		.replace(/\brecv\b/g, "received")
		.replace(/ in ms$/, " (ms)")
		.replace(/ in kb$/, " (KB)")
		.replace(/ in bytes$/, " (bytes)");
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
			const label = metricLabel(BUILD_METRIC_FIELDS[key] || key);
			const childPath = path ? path + " · " + label : label;
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
 * @param {number} millis
 * @return {string}
 */
function statSeconds(millis) {
	return (millis / 1000).toLocaleString(undefined, {maximumFractionDigits: 3}) + " s";
}

/**
 * @param {string} title
 * @param {!Array<!Array<string>>=} entries
 * @return {!Element}
 */
function buildStatCard(title, entries) {
	const card = dom.createDom("article", {"class": "Box bes-build-stat", "aria-label": title},
		dom.createDom("h3", "h5 m-0", title));
	if (!entries || !entries.length) return card;
	const values = dom.createDom("dl", "text-small");
	for (const entry of entries) {
		values.appendChild(dom.createDom("div", null,
			dom.createDom("dt", "color-fg-muted", entry[0]),
			dom.createDom("dd", "text-bold", entry[1])));
	}
	card.appendChild(values);
	return card;
}

/**
 * @param {!BuildMetrics} metrics
 * @return {!DocumentFragment}
 */
function createBuildStatCards(metrics) {
	const cards = document.createDocumentFragment();
	const actions = metrics.getActionSummary();
	const graph = metrics.getBuildGraphMetrics();
	if (actions || graph) {
		// Bazel can omit Action Count when analysis was fully cached.
		const total = Number(graph?.getActionCount() ?? 0);
		cards.appendChild(buildStatCard("Actions", [
			["Executed", actions ? Number(actions.getActionsExecuted()).toLocaleString() : "—"],
			["Total", total ? total.toLocaleString() : "—"],
		]));
	}
	const targets = metrics.getTargetMetrics();
	if (targets) cards.appendChild(buildStatCard("Targets", [
		["Configured", Number(targets.getTargetsConfigured()).toLocaleString()],
	]));
	const timing = metrics.getTimingMetrics();
	if (timing) {
		// CPU and elapsed durations can overlap, so compare them on a shared scale.
		/** @type {!Array<{label: string, millis: number, color: string}>} */
		const durations = [
			{label: "Wall", millis: Number(timing.getWallTimeInMs()), color: "bes-build-timing-wall"},
			{label: "CPU", millis: Number(timing.getCpuTimeInMs()), color: "bes-build-timing-cpu"},
			{label: "Execution", millis: Number(timing.getExecutionPhaseTimeInMs()), color: "bes-build-timing-execution"},
		];
		const max = Math.max(1, ...durations.map((value) => value.millis));
		const card = buildStatCard("Timing");
		for (const duration of durations) {
			const bar = /** @type {!HTMLElement} */ (dom.createDom("span", duration.color));
			bar.style.width = Math.max(0, duration.millis) / max * 100 + "%";
			card.appendChild(dom.createDom("div", "bes-build-timing-row text-small",
				dom.createDom("span", "color-fg-muted", duration.label),
				dom.createDom("span", {"class": "bes-build-timing-track", "aria-hidden": "true"}, bar),
				dom.createDom("span", "text-mono text-right", statSeconds(duration.millis))));
		}
		cards.appendChild(card);
	}
	const path = criticalPathMillis(metrics);
	if (path !== null) cards.appendChild(buildStatCard("Critical path", [["Duration", statSeconds(path)]]));

	const artifacts = metrics.getArtifactMetrics();
	const outputs = artifacts?.getOutputArtifactsSeen();
	const cached = artifacts?.getOutputArtifactsFromActionCache();
	if (outputs || cached) {
		/** @type {!Array<!Array<string>>} */
		const entries = [];
		if (outputs) entries.push(["Outputs", Number(outputs.getCount()).toLocaleString() +
			" · " + formatBytes(Number(outputs.getSizeInBytes()))]);
		if (cached) entries.push(["From local action cache", Number(cached.getCount()).toLocaleString() +
			" · " + formatBytes(Number(cached.getSizeInBytes()))]);
		cards.appendChild(buildStatCard("Artifacts", entries));
	}
	const network = metrics.getNetworkMetrics()?.getSystemNetworkStats();
	if (network) cards.appendChild(buildStatCard("Host network", [
		["Sent", formatBytes(Number(network.getBytesSent()))],
		["Received", formatBytes(Number(network.getBytesRecv()))],
	]));
	const cache = metrics.getRemoteAnalysisCacheStatistics();
	if (cache) {
		const hits = Number(cache.getCacheHits());
		const misses = Number(cache.getCacheMisses());
		cards.appendChild(buildStatCard("Remote analysis cache", hits + misses ? [
			["Hit rate", groupRate(hits, hits + misses)],
			["Hits", hits.toLocaleString()],
			["Misses", misses.toLocaleString()],
		] : [["Lookups", "None"]]));
	}

	/** @type {!Map<string, !Array<{ids: string, actions: number}>>} */
	const workers = new Map();
	for (const worker of metrics.getWorkerMetricsList()) {
		const name = worker.getMnemonic() || "Unnamed workers";
		let group = workers.get(name);
		if (!group) {
			group = [];
			workers.set(name, group);
		}
		const ids = worker.getWorkerIdsList();
		group.push({
			ids: ids.length ? (ids.length > 1 ? "Workers " : "Worker ") + ids.join(", ")
				: worker.getWorkerId() ? "Worker " + worker.getWorkerId()
				: worker.getProcessId() ? "Process " + worker.getProcessId() : "",
			actions: Number(worker.getActionsExecuted()),
		});
	}
	/** @type {!Array<string>} */
	const names = Array.from(workers.keys());
	names.sort((a, b) => a.localeCompare(b));
	for (const name of names) {
		const group = workers.get(name);
		if (!group) continue;
		const card = buildStatCard(name);
		card.setAttribute("aria-label", name + " workers");
		const counts = dom.createDom("ul", {"role": "list", "aria-label": "Actions executed per worker"});
		for (let index = 0; index < group.length; index++) {
			const worker = group[index];
			const description = (worker.ids || "Worker " + (index + 1)) + " · " + worker.actions.toLocaleString() + " executed";
			counts.appendChild(dom.createDom("li", {"class": "text-mono", "title": description}, worker.actions.toLocaleString()));
		}
		card.appendChild(dom.createDom("div", "bes-worker-counts text-small",
			dom.createDom("span", "color-fg-muted", "Executed"), counts));
		cards.appendChild(card);
	}
	return cards;
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
		if (name === "igroup") {
			this.addTab(name, new InvocationGroupsComponent(this.dom_));
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

/**
 * @param {!EventHandler} handler
 * @param {!HTMLElement} tabs
 * @param {function(number):void} select
 */
function bindViewerTabs(handler, tabs, select) {
	const buttons = tabs.querySelectorAll("button");
	for (let i = 0; i < buttons.length; i++) {
		const button = buttons[i];
		const index = Number(i);
		handler.listen(button, events.EventType.CLICK, () => select(index));
		handler.listen(button, events.EventType.KEYDOWN, (/** !events.BrowserEvent */ e) => {
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
			select(next);
			buttons[next].focus();
		});
	}
}

/**
 * @param {!HTMLElement} tablist
 * @param {!HTMLElement} content
 * @param {number} index
 */
function showViewerTab(tablist, content, index) {
	const tabs = tablist.querySelectorAll("button");
	const panels = content.querySelectorAll(':scope > [role="tabpanel"]');
	for (let i = 0; i < tabs.length; i++) {
		const active = i === index;
		tabs[i].setAttribute("aria-selected", String(active));
		tabs[i].tabIndex = active ? 0 : -1;
		/** @type {!HTMLElement} */ (panels[i]).hidden = !active;
	}
}

/**
 * @param {!HTMLElement} body
 * @param {!Array<!Array<string>>} entries
 */
function renderGroupMetricList(body, entries) {
	const list = dom.createDom("dl", "bes-invocation-metadata");
	for (const entry of entries) {
		list.appendChild(dom.createDom("div", null,
			dom.createDom("dt", "color-fg-muted text-small", entry[0]),
			dom.createDom("dd", "text-bold", entry[1])));
	}
	dom.removeChildren(body);
	body.appendChild(list);
}

/**
 * @param {number} numerator
 * @param {number} denominator
 * @return {string}
 */
function groupRate(numerator, denominator) {
	return denominator ? (100 * numerator / denominator).toFixed(1) + "%" : "—";
}

/**
 * @param {string} scope
 * @return {string}
 */
function readViewerBackend(scope) {
	try {
		return window.sessionStorage.getItem("bcr.viewer.backend." + scope) || "";
	} catch (_error) {
		return "";
	}
}

/**
 * @param {string} scope
 * @param {string} address
 */
function rememberViewerBackend(scope, address) {
	try {
		window.sessionStorage.setItem("bcr.viewer.backend." + scope, address);
	} catch (_error) {
		// The viewer also works when the browser disables session storage.
	}
}

/**
 * @param {!URL} url
 * @param {string} id
 */
function setInvocationQuery(url, id) {
	if (id) url.searchParams.set("invocation", id);
	else url.searchParams.delete("invocation");
}

/** @param {!URL} url */
function replaceViewerLocation(url) {
	if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
}

/**
 * @param {string} page
 * @param {string} id
 */
function selectInvocationInUrl(page, id) {
	const url = new URL(window.location.href);
	if (url.pathname.replace(/\/$/, "") !== "/tools/" + page) return;
	setInvocationQuery(url, id);
	replaceViewerLocation(url);
}

/**
 * @param {!URLSearchParams} params
 * @return {string}
 */
function groupFollowMode(params) {
	const mode = params.get("follow");
	if (mode === "auto" || mode === "off" || mode === "manual") return mode;
	// Older group links omitted the follow parameter for manual selections.
	return params.get("invocation") ? "manual" : "auto";
}

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
		case "success": color = "color-fg-success"; break;
		case "failure":
		case "tests": color = "color-fg-danger"; break;
		case "interrupted":
		case "input":
		case "empty":
		case "warning": color = "color-fg-attention"; break;
		case "infrastructure": color = "color-fg-done"; break;
		case "running": color = "color-fg-accent"; break;
	}
	return {label, kind, color, title: code === null ? label : label + " (" + code + ")"};
}

/**
 * @param {string} name
 * @param {?number} code
 * @return {!InvocationStatus}
 */
function invocationExitStatus(name, code) {
	let kind = code === 0 ? "success" : "failure";
	switch (name) {
		case "SUCCESS": kind = "success"; break;
		case "INTERRUPTED": kind = "interrupted"; break;
		case "COMMAND_LINE_ERROR":
		case "PARSING_FAILURE": kind = "input"; break;
		case "TESTS_FAILED": kind = "tests"; break;
		case "NO_TESTS_FOUND": kind = "empty"; break;
		case "PARTIAL_ANALYSIS_FAILURE":
		case "LOCK_HELD_NOBLOCK_FOR_LOCK": kind = "warning"; break;
		case "REMOTE_ENVIRONMENTAL_ERROR":
		case "LOCAL_ENVIRONMENTAL_ERROR":
		case "REMOTE_ERROR":
		case "OOM_ERROR":
		case "BLAZE_INTERNAL_ERROR":
		case "PUBLISH_ERROR":
		case "REMOTE_CACHE_EVICTED":
		case "PERSISTENT_BUILD_EVENT_SERVICE_UPLOAD_ERROR":
		case "EXTERNAL_DEPS_ERROR": kind = "infrastructure"; break;
	}
	return invocationStatus(name || (code === 0 ? "Succeeded" : "Failed"), kind, code);
}

/**
 * @param {!InvocationStatus} status
 * @return {!Element}
 */
function renderInvocationStatusIcon(status) {
	return dom.createDom("span", {
		"class": "bes-invocation-status-icon " + status.color,
		"role": "img", "aria-label": status.label, "title": status.title,
	}, soy.renderAsElement(invocationResultGlyph, {kind: status.kind}));
}

class InvocationGroupsComponent extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
		/** @private @type {?InvocationBackend} */
		this.backend_ = null;
		/** @private @type {?BuildEventViewerComponent} */
		this.viewer_ = null;
		/** @private @type {!Array<!Object<string, *>>} */
		this.runs_ = [];
		/** @private @type {?Set<string>} */
		this.seenRuns_ = null;
		/** @private */ this.generation_ = 0;
		/** @private */ this.pollTimer_ = 0;
		/** @private */ this.address_ = "";
		/** @private */ this.group_ = "";
		/** @private */ this.watchedId_ = "";
		/** @private */ this.requestedId_ = "";
		/** @private */ this.historyKey_ = "";
		/** @private */ this.activeGroupTab_ = 0;
		/** @private */ this.metricsInFlight_ = false;
		/** @private */ this.lastMetricsRead_ = 0;
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(invocationGroups));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const groupInput = this.input_(goog.getCssName("igroup-name"));
		const showLast = this.input_(goog.getCssName("igroup-show-last"));
		this.getHandler().listen(showLast, "change", () => {
			const url = new URL(window.location.href);
			url.searchParams.set("showLast", showLast.checked ? "1" : "0");
			replaceViewerLocation(url);
		});
		const follow = this.input_(goog.getCssName("igroup-follow"));
		this.getHandler().listen(follow, "change", () => {
			this.setFollowMode_(follow.checked ? "auto" : "off");
			if (!this.seenRuns_) return;
			if (follow.checked) this.returnToGroup_();
			this.renderGroupStatus_();
		});
		bindViewerTabs(this.getHandler(), this.groupElement_(goog.getCssName("igroup-tabs")),
			(index) => this.selectGroupTab_(index));
		this.getHandler().listen(this.groupElement_(goog.getCssName("igroup-form")), "submit", (/** !events.BrowserEvent */ event) => {
			event.preventDefault();
			this.openGroup_();
		});
		this.getHandler().listen(this.groupElement_(goog.getCssName("igroup-list")), "click", (/** !events.BrowserEvent */ event) => {
			const target = /** @type {!Element} */ (event.target).closest("[data-group-name]");
			if (!target) return;
			groupInput.value = target.getAttribute("data-group-name") || "";
			this.openGroup_();
		});
		this.getHandler().listen(this.groupElement_(goog.getCssName("igroup-runs")), "click", (/** !events.BrowserEvent */ event) => {
			const target = /** @type {!Element} */ (event.target).closest("[data-invocation-id]");
			const id = target && target.getAttribute("data-invocation-id");
			if (id) {
				if (this.followMode_() === "auto") this.setFollowMode_("manual");
				this.watch_(id);
				this.renderGroupStatus_();
				this.selectGroupTab_(0);
				this.groupElement_(goog.getCssName("igroup-current-tab")).focus();
			}
		});
	}

	/**
	 * @private
	 * @param {!URL} url
	 */
	syncGroupOptions_(url) {
		const follow = groupFollowMode(url.searchParams);
		const showLast = url.searchParams.get("showLast") !== "0";
		url.searchParams.set("follow", follow);
		url.searchParams.set("showLast", showLast ? "1" : "0");
		this.input_(goog.getCssName("igroup-follow")).checked = follow === "auto";
		this.input_(goog.getCssName("igroup-show-last")).checked = showLast;
	}

	/** @private @return {string} */
	followMode_() {
		return groupFollowMode(new URL(window.location.href).searchParams);
	}

	/** @private @param {string} mode */
	setFollowMode_(mode) {
		const url = new URL(window.location.href);
		url.searchParams.set("follow", mode);
		this.input_(goog.getCssName("igroup-follow")).checked = mode === "auto";
		replaceViewerLocation(url);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		super.goHere(route);
		const groupInput = this.input_(goog.getCssName("igroup-name"));
		const url = new URL(window.location.href);
		this.syncGroupOptions_(url);
		replaceViewerLocation(url);
		const params = url.searchParams;
		const group = params.get("group");
		if (group !== null) {
			groupInput.value = group;
			const remembered = readViewerBackend("group." + group);
			if (remembered) this.input_(goog.getCssName("igroup-backend")).value = remembered;
		}
		const id = params.get("invocation") || "";
		if (groupInput.value && (!this.backend_ || groupInput.value !== this.group_ ||
			id !== (this.requestedId_ || this.watchedId_))) this.openGroup_();
		else if (this.seenRuns_) {
			if (!this.requestedId_) this.selectActiveRun_();
			this.renderGroupStatus_();
		}
	}

	/** @override */
	hide() {
		this.closeGroup_();
		super.hide();
	}

	/** @override */
	exitDocument() {
		this.closeGroup_();
		super.exitDocument();
	}

	/** @private */
	closeGroup_() {
		clearTimeout(this.pollTimer_);
		this.generation_++;
		this.metricsInFlight_ = false;
		this.lastMetricsRead_ = 0;
		if (this.backend_) this.backend_.close();
		this.backend_ = null;
		this.stopWatching_();
	}

	/** @private */
	async openGroup_() {
		this.closeGroup_();
		const generation = this.generation_;
		this.address_ = this.input_(goog.getCssName("igroup-backend")).value.trim();
		this.group_ = this.input_(goog.getCssName("igroup-name")).value.trim();
		this.runs_ = [];
		this.seenRuns_ = null;
		this.historyKey_ = "";
		this.groupElement_(goog.getCssName("igroup-list")).classList.add("d-none");
		this.groupElement_(goog.getCssName("igroup-current-tab")).textContent = "Current";
		this.renderHistory_();
		const pending = this.group_ ? "Waiting for the group connection…" : "Connect to a backend and choose a group.";
		this.setGroupWaitingMessage_(pending);
		if (this.group_ && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.group_)) {
			this.setBackendStatus_("Disconnected", "", "Enter a valid group name.");
			return;
		}
		const url = new URL(window.location.href);
		const sameGroup = this.group_ !== "" && url.searchParams.get("group") === this.group_;
		if (!sameGroup && groupFollowMode(url.searchParams) === "manual") url.searchParams.set("follow", "auto");
		this.syncGroupOptions_(url);
		this.requestedId_ = sameGroup ? url.searchParams.get("invocation") || "" : "";
		setInvocationQuery(url, this.requestedId_);
		if (this.group_) url.searchParams.set("group", this.group_);
		else url.searchParams.delete("group");
		replaceViewerLocation(url);
		this.setBackendStatus_("Connecting", "Label--accent", "Opening the invocation backend…");
		try {
			const backend = await openInvocationBackend(this.address_);
			if (generation !== this.generation_) {
				backend.close();
				return;
			}
			this.backend_ = backend;
			if (this.group_) {
				rememberViewerBackend("group." + this.group_, this.address_);
				await this.pollGroup_(backend, generation);
			} else {
				const result = await backend.listGroups();
				if (generation !== this.generation_) return;
				const groups = /** @type {!Array<!Object<string, *>>} */ (result["groups"] || []);
				this.setBackendStatus_("Connected", "Label--success", groups.length ? "Choose an invocation group."
					: "No groups yet. Enter a group name to wait for its first build.");
				this.renderCatalog_(groups);
			}
		} catch (/** @type {*} */ error) {
			if (generation === this.generation_) {
				this.setBackendStatus_("Connection failed", "Label--danger",
					error instanceof Error ? error.message : "Could not connect to invocation groups.");
				this.setGroupWaitingMessage_("Connect to a backend and choose a group.");
			}
		}
	}

	/**
	 * @private
	 * @param {string} message
	 */
	setGroupWaitingMessage_(message) {
		const status = this.groupElement_(goog.getCssName("igroup-status"));
		status.hidden = false;
		if (status.textContent !== message) status.textContent = message;
		this.groupElement_(goog.getCssName("igroup-runs-empty")).textContent = message;
		this.setMetricsMessage_(message);
	}

	/**
	 * @private
	 * @param {string} state
	 * @param {string} color
	 * @param {string} detail
	 * @param {string=} group
	 */
	setBackendStatus_(state, color, detail, group = "") {
		const label = this.groupElement_(goog.getCssName("igroup-backend-label"));
		if (label.textContent !== state) label.textContent = state;
		label.className = ["Label", goog.getCssName("igroup-backend-label"), color].filter(Boolean).join(" ");
		const message = this.groupElement_(goog.getCssName("igroup-backend-detail"));
		const flag = "--build_metadata=igroup=" + group;
		const suffix = " on a build to add it to the " + group + " group.)";
		const text = group ? detail + group + " (Set " + flag + suffix : detail;
		if (message.textContent === text) return;
		message.textContent = detail;
		if (group) message.append(dom.createDom("strong", "text-mono", group), " (Set ",
			dom.createDom("code", null, flag), suffix);
	}

	/**
	 * @private
	 * @param {!InvocationBackend} backend
	 * @param {number} generation
	 */
	async pollGroup_(backend, generation) {
		try {
			const result = await backend.listGroup(this.group_);
			if (generation !== this.generation_) return;
			const transport = this.address_.startsWith("bcr-iroh-v1:") ? "Iroh" : "HTTP";
			this.setBackendStatus_("Connected", "Label--success", "Connected over " + transport +
				" · Watching group ", this.group_);
			this.runs_ = /** @type {!Array<!Object<string, *>>} */ (result["invocations"] || []);
			const seen = this.seenRuns_;
			const newestUnseen = seen && this.runs_.find((run) => !seen.has(String(run["invocationId"])));
			this.seenRuns_ = new Set(this.runs_.map((run) => String(run["invocationId"])));
			this.renderHistory_();
			if (this.requestedId_) {
				if (this.runs_.some((run) => run["invocationId"] === this.requestedId_)) {
					this.watch_(this.requestedId_);
				}
			} else {
				this.selectActiveRun_(newestUnseen ? String(newestUnseen["invocationId"]) : "");
				if (!seen && !this.watchedId_ && new URL(window.location.href).searchParams.get("showLast") !== "0") {
					const last = this.runs_.find((run) =>
						run["state"] === "INVOCATION_STATE_COMPLETE" || run["state"] === "INVOCATION_STATE_INCOMPLETE");
					if (last) this.watch_(String(last["invocationId"]));
				}
			}
			this.renderGroupStatus_();
			this.refreshMetrics_();
		} catch (/** @type {*} */ error) {
			if (generation !== this.generation_) return;
			const detail = error instanceof Error ? error.message : "Could not load this group.";
			this.setBackendStatus_("Retrying", "Label--attention", detail + " Retrying the group connection…");
			if (this.seenRuns_ === null) this.setGroupWaitingMessage_("Waiting for the group connection…");
		}
		this.pollTimer_ = setTimeout(() => this.pollGroup_(backend, generation), 2000);
	}

	/**
	 * @private
	 * @param {number} index
	 */
	selectGroupTab_(index) {
		this.activeGroupTab_ = index;
		showViewerTab(this.groupElement_(goog.getCssName("igroup-tabs")),
			this.groupElement_(goog.getCssName("igroup-content")), index);
		const mode = this.followMode_();
		if (index === 1 && (this.requestedId_ || mode === "manual")) {
			if (mode === "manual") this.setFollowMode_("auto");
			this.returnToGroup_();
			this.renderGroupStatus_();
		}
		this.refreshMetrics_();
	}

	/** @private */
	returnToGroup_() {
		this.requestedId_ = "";
		selectInvocationInUrl("igroup", this.watchedId_);
		this.selectActiveRun_();
	}

	/** @private */
	async refreshMetrics_() {
		const backend = this.backend_;
		if (!backend || !this.seenRuns_ || this.activeGroupTab_ < 2 || this.activeGroupTab_ > 4 ||
			this.metricsInFlight_ || Date.now() - this.lastMetricsRead_ < 10000) return;
		const generation = this.generation_;
		this.metricsInFlight_ = true;
		this.lastMetricsRead_ = Date.now();
		try {
			const metrics = await backend.groupMetrics(this.group_);
			if (generation === this.generation_) this.renderMetrics_(metrics);
		} catch (_error) {
			if (generation === this.generation_) this.setMetricsMessage_("Could not load group metrics.");
		} finally {
			if (generation === this.generation_) this.metricsInFlight_ = false;
		}
	}

	/**
	 * @private
	 * @param {string} message
	 */
	setMetricsMessage_(message) {
		/** @type {!Array<string>} */
		const panels = [goog.getCssName("igroup-build-metrics"), goog.getCssName("igroup-cache-metrics"),
			goog.getCssName("igroup-test-metrics")];
		for (const css of panels) {
			this.renderMetricBlankslate_(this.groupElement_(css), message);
		}
	}

	/**
	 * @private
	 * @param {!HTMLElement} body
	 * @param {string} message
	 */
	renderMetricBlankslate_(body, message) {
		dom.removeChildren(body);
		body.appendChild(dom.createDom("p", "bes-group-empty", message));
	}

	/**
	 * @private
	 * @param {!Object<string, *>} metrics
	 */
	renderMetrics_(metrics) {
		/** @type {function(string):number} */
		const count = (field) => Number(metrics[field] || 0);
		/** @type {function(string):string} */
		const time = (field) => metrics[field] == null ? "—" : formatElapsed(Number(metrics[field]));
		const total = count("invocationCount");
		if (!total) {
			this.setMetricsMessage_("Waiting for the first build to report group metrics.");
			return;
		}
		const running = count("runningCount");
		const succeeded = count("succeededCount");
		const failed = count("failedCount");
		renderGroupMetricList(this.groupElement_(goog.getCssName("igroup-build-metrics")), [
			["Invocations", total.toLocaleString()],
			["Running", running.toLocaleString()],
			["Succeeded", succeeded.toLocaleString()],
			["Failed", failed.toLocaleString()],
			["Other outcomes", (total - running - succeeded - failed).toLocaleString()],
			["Success rate", groupRate(succeeded, succeeded + failed)],
			["Average build time", time("averageDurationMs")],
			["Median build time", time("medianDurationMs")],
			["P95 build time", time("p95DurationMs")],
			["Completed builds with timing", count("timingSampleCount").toLocaleString()],
		]);
		this.renderGroupCache_(/** @type {!Object<string, *>} */ (metrics["cache"] || {}));
		if (metrics["tests"]) this.renderGroupTests_(/** @type {!Object<string, *>} */ (metrics["tests"]));
		else this.renderMetricBlankslate_(this.groupElement_(goog.getCssName("igroup-test-metrics")),
			"Group test metrics require SQLite.");
	}

	/**
	 * @private
	 * @param {!Object<string, *>} cache
	 */
	renderGroupCache_(cache) {
		const body = this.groupElement_(goog.getCssName("igroup-cache-metrics"));
		const hits = Number(cache["actionCacheHits"] || 0);
		const misses = Number(cache["actionCacheMisses"] || 0);
		const sampled = Number(cache["actionCacheInvocationCount"] || 0);
		if (!sampled && cache["bazelRemoteCacheHits"] == null) {
			this.renderMetricBlankslate_(body, "No action cache lookups recorded. Connect Bazel to an instrumented cache to see the hit rate.");
			return;
		}
		renderGroupMetricList(body, [
			["Action cache hit rate", groupRate(hits, hits + misses)],
			["Hits", hits.toLocaleString()],
			["Misses", misses.toLocaleString()],
			["Errors", Number(cache["actionCacheErrors"] || 0).toLocaleString()],
			["Builds with action cache lookups", sampled.toLocaleString()],
			["Remote cache hits reported by Bazel", cache["bazelRemoteCacheHits"] == null ? "—"
				: Number(cache["bazelRemoteCacheHits"]).toLocaleString()],
		]);
		const message = sampled
			? "Hit rate uses hits divided by hits plus misses."
			: "No action cache lookups recorded. The rate needs telemetry from the instrumented cache.";
		body.appendChild(dom.createDom("p", "mt-3 mb-0 color-fg-muted text-small", message));
	}

	/**
	 * @private
	 * @param {!Object<string, *>} tests
	 */
	renderGroupTests_(tests) {
		const body = this.groupElement_(goog.getCssName("igroup-test-metrics"));
		const summaries = Number(tests["summaryCount"] || 0);
		const flakes = Number(tests["flakyCount"] || 0);
		if (!summaries) {
			this.renderMetricBlankslate_(body, "No test summaries recorded.");
			return;
		}
		renderGroupMetricList(body, [
			["Test configurations reported", summaries.toLocaleString()],
			["Flaky", flakes.toLocaleString()],
			["Failed or timed out", Number(tests["failedOrTimedOutCount"] || 0).toLocaleString()],
		]);
		const targets = /** @type {!Array<!Object<string, *>>} */ (tests["flakyTargets"] || []);
		if (targets.length) {
			body.appendChild(dom.createDom("h3", "h4 mt-3", "Most frequently flaky targets"));
			const list = dom.createDom("ul", "pl-3 mt-1 mb-0");
			for (const target of targets) {
				const count = Number(target["flakyCount"]).toLocaleString();
				const total = Number(target["summaryCount"]).toLocaleString();
				list.appendChild(dom.createDom("li", "mb-1",
					dom.createDom("code", "bes-test-target", String(target["label"])),
					" · " + count + " of " + total + " flaky"));
			}
			body.appendChild(list);
		} else {
			body.appendChild(dom.createDom("p", "mt-3 mb-0 color-fg-muted text-small",
				"No flaky targets reported."));
		}
	}

	/**
	 * @private
	 * @param {string=} newestUnseen
	 */
	selectActiveRun_(newestUnseen = "") {
		const running = "INVOCATION_STATE_IN_PROGRESS";
		if (this.followMode_() !== "auto" || this.runs_.some((run) =>
			run["invocationId"] === this.watchedId_ && run["state"] === running)) return;
		const next = this.runs_.find((run) => run["state"] === running);
		if (next) this.watch_(String(next["invocationId"]));
		// A short build can start and finish between two group polls.
		else if (newestUnseen) this.watch_(newestUnseen);
	}

	/**
	 * @private
	 * @param {string} id
	 */
	watch_(id) {
		this.requestedId_ = "";
		selectInvocationInUrl("igroup", id);
		if (id === this.watchedId_) return;
		this.watchedId_ = id;
		const mount = this.groupElement_(goog.getCssName("igroup-viewer"));
		if (!this.viewer_) {
			this.viewer_ = new BuildEventViewerComponent(this.getDomHelper(), true);
			this.addChild(this.viewer_, false);
			this.viewer_.render(mount);
		}
		mount.classList.remove("d-none");
		this.viewer_.followInvocation(this.address_, id);
	}

	/** @private */
	stopWatching_() {
		if (this.viewer_) this.viewer_.stopFollowing();
		this.watchedId_ = "";
		this.groupElement_(goog.getCssName("igroup-viewer")).classList.add("d-none");
	}

	/** @private */
	renderGroupStatus_() {
		const current = this.runs_.find((run) => run["invocationId"] === this.watchedId_);
		const status = this.groupElement_(goog.getCssName("igroup-status"));
		status.hidden = Boolean(current);
		const message = current ? "" : this.requestedId_ ? "Waiting for invocation " + this.requestedId_
			: this.followMode_() === "auto" ? this.group_ + " · Waiting for the next build"
			: "Select a run from the Runs tab.";
		if (status.textContent !== message) status.textContent = message;
		const tab = this.groupElement_(goog.getCssName("igroup-current-tab"));
		const name = current && current["state"] !== "INVOCATION_STATE_IN_PROGRESS" ? "Last" : "Current";
		if (tab.textContent !== name) tab.textContent = name;
	}

	/**
	 * @private
	 * @param {!Array<!Object<string, *>>} groups
	 */
	renderCatalog_(groups) {
		const list = this.groupElement_(goog.getCssName("igroup-list"));
		dom.removeChildren(list);
		for (const group of groups) {
			const name = String(group["name"]);
			list.appendChild(dom.createDom("button", {
				"type": "button", "class": "Box-row btn-link d-block width-full text-left", "data-group-name": name,
			}, name));
		}
		list.classList.toggle("d-none", !groups.length);
	}

	/** @private */
	renderHistory_() {
		/** @type {!Array<{id: string, command: string, status: !InvocationStatus, time: string, timeLabel: string}>} */
		const rows = this.runs_.map((run) => {
			const id = String(run["invocationId"]);
			const command = ["bazel", run["command"], ...(/** @type {!Array<string>} */ (run["targetPatterns"] || []))]
				.filter(Boolean).join(" ");
			const result = /** @type {?Object<string, *>} */ (run["result"] || null);
			const exit = result && result["exitCode"];
			const name = String(result && result["exitCodeName"] || "");
			const status = name || typeof exit === "number" ? invocationExitStatus(name, typeof exit === "number" ? exit : null)
				: run["state"] === "INVOCATION_STATE_IN_PROGRESS" ? invocationStatus("Running", "running")
				: run["state"] === "INVOCATION_STATE_INCOMPLETE" ? invocationStatus("Incomplete", "warning")
				: invocationStatus("Finished", "neutral");
			const time = String(run["finishedAt"] || run["startedAt"] || run["createdAt"] || "");
			const timeLabel = run["finishedAt"] ? "Finished" : run["startedAt"] ? "Started" : "Recorded";
			return {id, command, status, time, timeLabel};
		});
		const key = JSON.stringify(rows);
		const empty = this.groupElement_(goog.getCssName("igroup-runs-empty"));
		empty.hidden = Boolean(rows.length);
		if (!rows.length && empty.textContent !== "No invocations yet.") empty.textContent = "No invocations yet.";
		this.groupElement_(goog.getCssName("igroup-runs-table")).hidden = !rows.length;
		if (key === this.historyKey_) return;
		this.historyKey_ = key;
		const list = this.groupElement_(goog.getCssName("igroup-runs"));
		const focused = document.activeElement?.getAttribute("data-invocation-id");
		dom.removeChildren(list);
		const dates = new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"});
		for (const row of rows) {
			const command = dom.createDom("code", {"class": "bes-group-run-command", "title": row.command}, row.command);
			const date = new Date(row.time);
			const displayedTime = row.time && Number.isFinite(date.getTime()) ? row.timeLabel + " " + dates.format(date) : "";
			const time = displayedTime ? dom.createDom("time",
				{"class": "bes-group-run-time color-fg-muted", "datetime": row.time, "title": displayedTime}, displayedTime) : null;
			const button = dom.createDom("button", {
				"type": "button", "class": "btn-link branch-name bes-group-run-id", "data-invocation-id": row.id, "title": row.id,
			}, row.id);
			list.appendChild(dom.createDom("tr", {"class": "bes-group-run", "data-invocation-id": row.id},
				dom.createDom("td", null, renderInvocationStatusIcon(row.status)), dom.createDom("td", null, button),
				dom.createDom("td", null, command), dom.createDom("td", null, time)));
			if (focused === row.id) /** @type {!HTMLElement} */ (button).focus({preventScroll: true});
		}
	}

	/**
	 * @private
	 * @param {string} cssName
	 * @return {!HTMLElement}
	 */
	groupElement_(cssName) {
		return /** @type {!HTMLElement} */ (this.getElementStrict().querySelector("." + cssName));
	}

	/**
	 * @private
	 * @param {string} cssName
	 * @return {!HTMLInputElement}
	 */
	input_(cssName) {
		return /** @type {!HTMLInputElement} */ (this.groupElement_(cssName));
	}
}

const FRONTIER_COLUMN_WIDTH = 36;
const FRONTIER_ROW_HEIGHT = 20;
const FRONTIER_INSET = 10;
const FRONTIER_EXPECTED_WIDTH = 220;
const FRONTIER_EXPECTED_HEIGHT = 52;
const FRONTIER_MAX_FLIGHTS = 24;
const FRONTIER_FLIGHT_LANES = 8;

/**
 * @param {?BuildEventId} id
 * @return {{type: string, detail: string}}
 */
function expectedFrontierLabel(id) {
	const progress = id?.getProgress();
	if (progress) return {type: "Progress", detail: "#" + progress.getOpaqueCount()};
	const action = id?.getActionCompleted();
	if (action) {
		const output = action.getPrimaryOutput().split("/").pop() || "";
		return {type: "Action", detail: [action.getLabel(), output].filter(Boolean).join(" · ")};
	}
	const summary = buildEventIdSummary(id);
	const separator = summary.indexOf(": ");
	return separator < 0 ? {type: summary, detail: ""}
		: {type: summary.slice(0, separator), detail: summary.slice(separator + 2)};
}

/**
 * @param {!FrontierMark} mark
 * @param {number} now
 * @return {?number}
 */
function frontierWait(mark, now) {
	return mark.announcedAt === null ? null : Math.max(0, Math.floor((now - mark.announcedAt) / 1000));
}

/**
 * @param {number} seconds
 * @return {string}
 */
function formatFrontierWait(seconds) {
	return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

/**
 * @param {!CanvasRenderingContext2D} context
 * @param {string} label
 * @param {number} width
 * @return {string}
 */
function fitFrontierLabel(context, label, width) {
	if (context.measureText(label).width <= width) return label;
	let first = 0;
	let end = label.length;
	while (first < end) {
		const mid = Math.ceil((first + end) / 2);
		if (context.measureText(label.slice(0, mid) + "…").width <= width) first = mid;
		else end = mid - 1;
	}
	return label.slice(0, first) + "…";
}

/** @typedef {{column: number, row: number}} */
let FrontierCell;
/** @typedef {{columns: !Array<!Array<?FrontierMark>>, cells: !Map<!FrontierMark, !FrontierCell>,
 *    parents: !Map<!FrontierMark, !Array<!FrontierMark>>,
 *    children: !Map<!FrontierMark, !Array<!FrontierMark>>,
 *    departures: !Map<!FrontierMark, !FrontierCell>,
 *    suppressed: !Set<!FrontierMark>,
 *    bodyRows: number}} */
let FrontierLayout;

/**
 * @param {!FrontierMark} mark
 * @return {boolean}
 */
function isFrontierBackbone(mark) {
	const type = mark.id?.getIdCase();
	return type === BuildEventId.IdCase.STARTED || type === BuildEventId.IdCase.PROGRESS ||
		type === BuildEventId.IdCase.BUILD_FINISHED;
}

/**
 * Layer the received graph by its longest path from a root, with roots on the
 * right. Each shared child gets one cell regardless of how many parents
 * announced it.
 * @param {!InvocationProgress} progress
 * @param {number=} start
 * @return {!FrontierLayout}
 */
function layoutFrontier(progress, start = progress.history.length) {
	const history = progress.history;
	/** @type {!Array<!FrontierMark>} */
	const pending = Array.from(progress.pending.values());
	/** @type {!Set<!FrontierMark>} */
	const removed = new Set();
	/** @type {!Set<!FrontierMark>} */
	const suppressed = new Set();
	/** @param {!FrontierMark} mark */
	const removeFromFrontier = (mark) => {
		const artifactSet = mark.id?.getIdCase() === BuildEventId.IdCase.NAMED_SET || mark.event?.hasNamedSetOfFiles();
		if (!artifactSet && !mark.event?.hasAction()) return;
		removed.add(mark);
		if (artifactSet) suppressed.add(mark);
		const directParents = /** @type {!Array<!FrontierMark>} */ (mark.parents);
		for (const parent of directParents) {
			if (!parent.event?.hasProgress()) continue;
			removed.add(parent);
			if (artifactSet) suppressed.add(parent);
		}
	};
	history.forEach(removeFromFrontier);
	pending.forEach(removeFromFrontier);
	/** @type {!Array<number>} */
	const depth = history.map(() => 0);
	/** @type {!Array<number>} */
	const remaining = history.map((mark) =>
		mark.parents.filter((/** !FrontierMark */ parent) => parent.event !== null).length);
	/** @type {!Array<!FrontierMark>} */
	const ready = history.filter((mark) => !remaining[mark.index]);
	for (let i = 0; i < ready.length; i++) {
		const parent = ready[i];
		const children = /** @type {!Array<!FrontierMark>} */ (parent.children);
		for (const child of children) {
			if (!child.event) continue;
			depth[child.index] = Math.max(depth[child.index], depth[parent.index] + 1);
			if (--remaining[child.index] === 0) ready.push(child);
		}
	}

	/** @type {!Array<!Array<!FrontierMark>>} */
	const layers = [];
	for (const mark of history) {
		if (mark === progress.last && !removed.has(mark)) continue;
		const rank = depth[mark.index];
		if (!layers[rank]) layers[rank] = [];
		layers[rank].push(mark);
	}

	// Keep siblings together and put a shared child near its earliest parent.
	/** @type {!Map<!FrontierMark, number>} */
	const rowsByMark = new Map();
	for (const layer of layers) {
		if (!layer) continue;
		/** @type {!Map<!FrontierMark, number>} */
		const preferred = new Map();
		for (const mark of layer) {
			let row = Infinity;
			const parents = /** @type {!Array<!FrontierMark>} */ (mark.parents);
			for (const parent of parents) {
				row = Math.min(row, rowsByMark.get(parent) ?? Infinity);
			}
			preferred.set(mark, row);
		}
		layer.sort((a, b) => {
			const left = preferred.get(a) ?? Infinity;
			const right = preferred.get(b) ?? Infinity;
			return left === right ? a.index - b.index : left - right;
		});
		layer.forEach((mark, row) => rowsByMark.set(mark, row));
	}

	/** @type {!Array<!Array<?FrontierMark>>} */
	const columns = [];
	/** @type {!Array<!FrontierMark>} */
	const expected = pending.filter((mark) => !suppressed.has(mark));
	expected.sort((a, b) => {
		const left = a.announcedAt ?? Infinity;
		const right = b.announcedAt ?? Infinity;
		return left === right ? 0 : left - right;
	});
	columns.push(expected);
	if (progress.last && !removed.has(progress.last)) {
		columns.push(isFrontierBackbone(progress.last) ? [progress.last] : [null, progress.last]);
	}
	/** @type {!Map<!FrontierMark, !FrontierCell>} */
	const departures = new Map();
	for (let i = layers.length - 1; i >= 0; i--) {
		if (!layers[i]) continue;
		/** @type {!Array<!FrontierMark>} */
		const backbone = [];
		/** @type {!Array<!FrontierMark>} */
		const branches = [];
		/** @type {!Array<{mark: !FrontierMark, row: number}>} */
		const leaving = [];
		let branchRow = 1;
		for (const mark of layers[i]) {
			if (!removed.has(mark)) {
				if (isFrontierBackbone(mark)) backbone.push(mark);
				else {
					branches.push(mark);
					branchRow++;
				}
			} else if (mark.index >= start && !suppressed.has(mark)) {
				leaving.push({mark, row: isFrontierBackbone(mark) ? 0 : branchRow++});
			}
		}
		// Parallel progress events get their own column so none spill into a branch row.
		for (let j = backbone.length - 1; j > 0; j--) columns.push([backbone[j]]);
		const column = columns.length;
		for (const departure of leaving) {
			departures.set(departure.mark, {column, row: departure.row});
		}
		if (branches.length || backbone.length) columns.push([backbone[0] || null, ...branches]);
	}
	/** @type {!Map<!FrontierMark, !FrontierCell>} */
	const cells = new Map();
	let bodyRows = 0;
	columns.forEach((marks, column) => {
		if (column > 0) bodyRows = Math.max(bodyRows, marks.length);
		marks.forEach((mark, row) => {
			if (mark) cells.set(mark, {column, row});
		});
	});

	// Keep dependencies reachable through excised marks without changing the stored events.
	/** @type {!Map<!FrontierMark, !Array<!FrontierMark>>} */
	const parents = new Map();
	/** @type {!Map<!FrontierMark, !Array<!FrontierMark>>} */
	const children = new Map();
	const projected = /** @type {!Array<!FrontierMark>} */ (ready.concat(expected));
	for (const mark of projected) {
		/** @type {!Set<!FrontierMark>} */
		const upstream = new Set();
		const directParents = /** @type {!Array<!FrontierMark>} */ (mark.parents);
		for (const parent of directParents) {
			if (removed.has(parent)) {
				const ancestors = parents.get(parent);
				if (ancestors) for (const ancestor of ancestors) upstream.add(ancestor);
			} else if (cells.has(parent)) upstream.add(parent);
		}
		/** @type {!Array<!FrontierMark>} */
		const connected = Array.from(upstream);
		parents.set(mark, connected);
		if (removed.has(mark)) continue;
		for (const parent of connected) {
			let next = children.get(parent);
			if (!next) {
				next = [];
				children.set(parent, next);
			}
			next.push(mark);
		}
	}
	return {columns, cells, parents, children, departures, suppressed, bodyRows};
}

/** @typedef {{index: number, success: boolean, mnemonic: string, path: string, color: string}} */
let FrontierActionReading;

/** @typedef {{x: number, y: number}} */
let FrontierPoint;

/**
 * The lateral spread peaks mid-flight and converges at the reader.
 * @param {!FrontierPoint} origin
 * @param {!FrontierPoint} target
 * @param {number} lane
 * @return {!Array<!Keyframe>}
 */
function frontierFlightFrames(origin, target, lane) {
	/** @type {!Array<!Keyframe>} */
	const frames = [];
	/**
	 * @param {number} x
	 * @param {number} y
	 * @param {number} offset
	 * @param {number} opacity
	 */
	const step = (x, y, offset, opacity) => frames.push({
		offset, opacity,
		transform: "translate(" + x + "px," + y + "px)",
	});
	step(origin.x, origin.y, 0, 1);
	step(origin.x + 3, origin.y - 2, 0.045, 1);
	step(origin.x - 4, origin.y + 1, 0.09, 1);
	step(origin.x, origin.y, 0.14, 1);
	const arc = (lane - (FRONTIER_FLIGHT_LANES - 1) / 2) * 12;
	for (let i = 1; i <= 8; i++) {
		const t = i / 8;
		const x = target.x + (origin.x - target.x) * (1 - t) ** (1.35 + lane * 0.025);
		const y = origin.y + (target.y - origin.y) * t ** 2 + arc * 4 * t * (1 - t);
		step(x, Math.max(4, Math.min(target.y, y)), 0.14 + 0.86 * t, i === 8 ? 0 : 1);
	}
	return frames;
}

class FrontierActionReaders {
	/**
	 * @param {!HTMLElement} layer
	 * @param {!HTMLElement} reader
	 */
	constructor(layer, reader) {
		this.layer_ = layer;
		this.reader_ = reader;
		this.reducedMotion_ = window.matchMedia("(prefers-reduced-motion: reduce)");
		/** @private */ this.latest_ = -1;
		/** @private */ this.nextFlight_ = 0;
		/** @private @const {!Map<!Animation, {particle: !HTMLElement, reading: ?FrontierActionReading}>} */
		this.flights_ = new Map();
	}

	reset() {
		this.finish();
		this.latest_ = -1;
		this.nextFlight_ = 0;
		this.write_("—", "", "", "", true);
	}

	finish() {
		for (const [animation, flight] of this.flights_) {
			animation.cancel();
			flight.particle.remove();
			if (flight.reading) this.read_(flight.reading);
		}
		this.flights_.clear();
	}

	/** @private @return {boolean} */
	canAnimate_() {
		return !this.reducedMotion_.matches && !document.hidden &&
			typeof this.layer_.animate === "function" && this.flights_.size < FRONTIER_MAX_FLIGHTS;
	}

	/**
	 * @param {!Array<!FrontierMark>} history
	 * @param {number} start
	 * @param {function(!FrontierMark):?FrontierPoint} origin
	 */
	update(history, start, origin) {
		if (start >= history.length) return;
		/** @type {?FrontierActionReading} */
		let direct = null;
		for (let index = start; index < history.length; index++) {
			const mark = history[index];
			const action = mark.event?.getAction();
			if (!action) continue;
			const file = action.getPrimaryOutput();
			const path = mark.id?.getActionCompleted()?.getPrimaryOutput() ||
				(file ? [...file.getPathPrefixList(), file.getName()].filter(Boolean).join("/") : "");
			/** @type {!FrontierActionReading} */
			const reading = {index, success: action.getSuccess(), mnemonic: action.getType() || "Unspecified",
				path, color: mark.color};
			const source = this.canAnimate_() ? origin(mark) : null;
			if (source) this.launch_(reading, source);
			else direct = reading;
		}
		if (direct) this.read_(direct);
	}

	/**
	 * @private
	 * @param {!FrontierActionReading} reading
	 */
	read_(reading) {
		if (reading.index < this.latest_) return;
		this.latest_ = reading.index;
		const path = reading.path.replace(/\\/g, "/").replace(/^.*?bazel-out\/[^/]+\/(?:bin|genfiles)\//, "");
		const parts = path.split("/").filter(Boolean);
		const compact = parts.length > 3 ? "…/" + parts.slice(-3).join("/") : parts.join("/");
		this.write_(reading.mnemonic, compact || "No primary output", reading.path, reading.color, reading.success);
	}

	/**
	 * @private
	 * @param {string} mnemonic
	 * @param {string} path
	 * @param {string} fullPath
	 * @param {string} color
	 * @param {boolean} success
	 */
	write_(mnemonic, path, fullPath, color, success) {
		const row = this.reader_;
		row.classList.toggle("is-failed", !success);
		row.setAttribute("aria-label", color ? (success ? "Last successful action" : "Last failed action") : "Last completed action");
		const dot = /** @type {?HTMLElement} */ (row.querySelector(".bes-frontier-reader-dot"));
		const name = /** @type {?HTMLElement} */ (row.querySelector(".bes-frontier-reader-mnemonic"));
		const output = /** @type {?HTMLElement} */ (row.querySelector(".bes-frontier-reader-output"));
		if (dot) dot.style.backgroundColor = color;
		if (name) {
			name.textContent = mnemonic;
			name.title = mnemonic;
		}
		if (output) {
			output.textContent = path;
			output.title = fullPath;
		}
	}

	/**
	 * @private
	 * @param {!FrontierActionReading} reading
	 * @param {!FrontierPoint} origin
	 */
	launch_(reading, origin) {
		const gate = this.reader_.parentElement?.querySelector(reading.success
			? ".bes-frontier-arrival-success" : ".bes-frontier-arrival-failed");
		if (!gate) {
			this.read_(reading);
			return;
		}
		const bounds = this.layer_.getBoundingClientRect();
		const target = gate.getBoundingClientRect();
		const end = {x: target.left - bounds.left + target.width / 2,
			y: target.top - bounds.top + target.height / 2};
		const lane = this.nextFlight_ % FRONTIER_FLIGHT_LANES;
		const stagger = lane * 12 + Math.floor(this.nextFlight_ / FRONTIER_FLIGHT_LANES) * 55;
		this.nextFlight_ = (this.nextFlight_ + 1) % FRONTIER_MAX_FLIGHTS;
		const distance = Math.hypot(end.x - origin.x, end.y - origin.y);
		this.animate_(reading.color, frontierFlightFrames(origin, end, lane),
			Math.min(950, 575 + distance / 3) + lane * 20, reading, stagger);
	}

	/**
	 * @param {!FrontierPoint} origin
	 * @param {string} color
	 */
	fadeProgress(origin, color) {
		if (!this.canAnimate_()) return;
		const position = "translate(" + origin.x + "px," + origin.y + "px)";
		this.animate_(color, [
			{transform: position, opacity: 1},
			{transform: position + " scale(1.35)", opacity: 0.7},
			{transform: position + " scale(0)", opacity: 0},
		], 300, null);
	}

	/**
	 * @private
	 * @param {string} color
	 * @param {!Array<!Keyframe>} frames
	 * @param {number} duration
	 * @param {?FrontierActionReading} reading
	 * @param {number=} delay
	 */
	animate_(color, frames, duration, reading, delay = 0) {
		const particle = /** @type {!HTMLElement} */ (dom.createDom("span", reading
			? "bes-frontier-particle" : "bes-frontier-particle is-progress"));
		particle.style.color = color;
		particle.style.backgroundColor = color;
		this.layer_.appendChild(particle);
		const animation = particle.animate(frames, {duration, delay, fill: "both"});
		this.flights_.set(animation, {particle, reading});
		animation.onfinish = () => {
			if (!this.flights_.delete(animation)) return;
			particle.remove();
			if (reading) this.read_(reading);
		};
	}
}

class InvocationFrontier {
	/**
	 * @param {!HTMLCanvasElement} canvas
	 * @param {!HTMLElement} scroll
	 * @param {!HTMLElement} spacer
	 * @param {!FrontierActionReaders} readers
	 * @param {function(!FrontierMark):void} inspect
	 */
	constructor(canvas, scroll, spacer, readers, inspect) {
		this.canvas = canvas;
		this.scroll = scroll;
		this.spacer = spacer;
		this.readers_ = readers;
		this.inspect = inspect;
		/** @private @type {?InvocationProgress} */
		this.progress_ = null;
		/** @private @type {!FrontierLayout} */
		this.layout_ = {columns: [[]], cells: new Map(), parents: new Map(),
			children: new Map(), departures: new Map(), suppressed: new Set(), bodyRows: 0};
		/** @private @type {?FrontierMark} */
		this.selected_ = null;
		/** @private */ this.received_ = 0;
		/** @private */ this.clock_ = 0;
	}

	/**
	 * @param {!InvocationProgress} progress
	 * @return {number} The count of expected events shown in the frontier.
	 */
	update(progress) {
		let start = this.received_;
		/** @type {?FrontierLayout} */
		let previous = this.layout_;
		if (this.progress_ !== progress) {
			start = 0;
			previous = null;
			this.readers_.reset();
			this.selected_ = null;
			this.scroll.scrollTop = 0;
			this.scroll.scrollLeft = 0;
			this.canvas.title = "";
		} else if (this.received_ === progress.history.length) {
			return this.layout_.columns[0].length;
		}
		this.progress_ = progress;
		this.received_ = progress.history.length;
		this.layout_ = layoutFrontier(progress, start);
		this.draw(start, previous);
		if (this.selected_) {
			this.inspect(this.selected_);
			if (!this.layout_.cells.has(this.selected_)) this.selected_ = null;
		}
		const running = !progress.last && this.layout_.columns[0].some((mark) => mark && mark.announcedAt !== null);
		if (running && !this.clock_) {
			this.clock_ = setInterval(() => {
				this.draw();
				if (this.selected_ && !this.selected_.event) this.inspect(this.selected_);
			}, 1000);
		} else if (!running) {
			this.stopClock();
		}
		return this.layout_.columns[0].length;
	}

	stop() {
		this.stopClock();
		this.readers_.finish();
	}

	stopClock() {
		clearInterval(this.clock_);
		this.clock_ = 0;
	}

	/**
	 * @private
	 * @param {number} column
	 * @param {number} row
	 * @return {?FrontierMark}
	 */
	markAt_(column, row) {
		return this.layout_.columns[column]?.[row] || null;
	}

	/** @private @return {number} */
	expectedWidth_() {
		return this.layout_.columns[0].length
			? Math.min(FRONTIER_EXPECTED_WIDTH, Math.floor(this.scroll.clientWidth * 0.58))
			: 0;
	}

	/**
	 * @param {number=} firstNewMark
	 * @param {?FrontierLayout=} previous
	 */
	draw(firstNewMark = this.received_, previous = null) {
		const width = this.scroll.clientWidth;
		const height = this.scroll.clientHeight;
		const context = /** @type {?CanvasRenderingContext2D} */ (this.canvas.getContext("2d"));
		const progress = this.progress_;
		if (!width || !height || !context) {
			if (progress) this.readers_.update(progress.history, firstNewMark, () => null);
			return;
		}
		const {columns, cells, parents, children, departures, suppressed, bodyRows} = this.layout_;
		const expectedColumn = columns[0];
		const band = this.expectedWidth_();
		const bodyLeft = band + FRONTIER_INSET;
		const contentWidth = bodyLeft + (columns.length - 1) * FRONTIER_COLUMN_WIDTH + FRONTIER_INSET;
		const contentHeight = 2 * FRONTIER_INSET + Math.max(bodyRows * FRONTIER_ROW_HEIGHT,
			expectedColumn.length * FRONTIER_EXPECTED_HEIGHT);
		this.spacer.style.width = Math.max(width, contentWidth) + "px";
		this.spacer.style.height = Math.max(0, contentHeight - height) + "px";
		const scale = window.devicePixelRatio || 1;
		if (this.canvas.width !== Math.round(width * scale) || this.canvas.height !== Math.round(height * scale)) {
			this.canvas.width = Math.round(width * scale);
			this.canvas.height = Math.round(height * scale);
		}
		this.canvas.style.height = height + "px";
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, width, height);

		const top = this.scroll.scrollTop;
		const left = this.scroll.scrollLeft;
		const firstRow = Math.max(0, Math.floor((top - FRONTIER_INSET) / FRONTIER_ROW_HEIGHT));
		const endRow = Math.ceil((top + height - FRONTIER_INSET) / FRONTIER_ROW_HEIGHT);
		const firstColumn = 1 + Math.max(0, Math.floor((left + band - bodyLeft) / FRONTIER_COLUMN_WIDTH));
		const endColumn = Math.min(columns.length, 1 + Math.ceil((left + width - bodyLeft) / FRONTIER_COLUMN_WIDTH));
		/** @type {function(!FrontierCell):number} */
		const x = (cell) => cell.column === 0 ? band :
			bodyLeft + (cell.column - 0.5) * FRONTIER_COLUMN_WIDTH - left;
		/** @type {function(!FrontierCell):number} */
		const y = (cell) => FRONTIER_INSET + (cell.row + 0.5) *
			(cell.column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT) - top;

		/** @type {!Array<?FrontierMark>} */
		const expected = expectedColumn.slice(
			Math.max(0, Math.floor((top - FRONTIER_INSET) / FRONTIER_EXPECTED_HEIGHT)),
			Math.ceil((top + height - FRONTIER_INSET) / FRONTIER_EXPECTED_HEIGHT),
		);
		/** @type {!Array<!FrontierMark>} */
		const visible = [];
		for (let column = firstColumn; column < endColumn; column++) {
			const marks = columns[column];
			const end = Math.min(endRow, marks.length);
			for (let row = firstRow; row < end; row++) {
				const mark = marks[row];
				if (mark) visible.push(mark);
			}
		}
		/** @type {!Set<!FrontierMark>} */
		const visibleMarks = new Set(visible);
		for (const mark of expected) {
			if (mark) visibleMarks.add(mark);
		}
		const selected = this.selected_;
		const canvasStyle = getComputedStyle(this.canvas);
		const foreground = canvasStyle.color;
		const primary = new Path2D();
		const shared = new Path2D();
		const highlighted = new Path2D();
		/** @type {function(!FrontierMark, !FrontierMark):void} */
		const addEdge = (parent, child) => {
			const from = cells.get(parent);
			const to = cells.get(child);
			if (!from || !to) return;
			const active = selected === parent || selected === child;
			const fromX = x(from);
			const toX = x(to);
			const path = active ? highlighted : parents.get(child)?.[0] === parent ? primary : shared;
			const sourceY = y(from);
			const targetY = y(to);
			const midpoint = (fromX + toX) / 2;
			path.moveTo(fromX, sourceY);
			path.bezierCurveTo(midpoint, sourceY, midpoint, targetY, toX, targetY);
		};
		for (const mark of visibleMarks) {
			for (const child of children.get(mark) || []) addEdge(mark, child);
			for (const parent of parents.get(mark) || []) {
				if (!visibleMarks.has(parent)) addEdge(parent, mark);
			}
		}
		/** @type {function(!FrontierMark):void} */
		const paintMark = (mark) => {
			const cell = cells.get(mark);
			if (!cell) return;
			const mx = x(cell);
			const my = y(cell);
			context.strokeStyle = foreground;
			context.globalAlpha = 0.6;
			context.fillStyle = mark.color;
			context.strokeRect(mx - 4, my - 4, 8, 8);
			context.globalAlpha = 1;
			context.fillRect(mx - 3.5, my - 3.5, 7, 7);
			if (mark === selected) context.strokeRect(mx - 6, my - 6, 12, 12);
		};

		context.save();
		context.beginPath();
		context.rect(band, 0, width - band, height);
		context.clip();
		context.strokeStyle = foreground;
		context.globalAlpha = 0.35;
		context.stroke(primary);
		context.globalAlpha = 0.24;
		context.setLineDash([2, 3]);
		context.stroke(shared);
		context.setLineDash([]);
		context.globalAlpha = 0.85;
		context.stroke(highlighted);
		for (const mark of visible) paintMark(mark);
		context.restore();
		if (band) {
			const now = this.progress_?.frontierNow() ?? 0;
			context.fillStyle = foreground;
			context.globalAlpha = 0.2;
			context.fillRect(band - 1, 0, 1, height);
			context.textBaseline = "top";
			for (const mark of expected) {
				if (!mark) continue;
				const cell = cells.get(mark);
				if (!cell) continue;
				const center = y(cell);
				const start = FRONTIER_INSET;
				const cardWidth = band - start - 8;
				const cardTop = center - 22;
				context.fillStyle = foreground;
				context.globalAlpha = mark === selected ? 0.16 : 0.06;
				context.fillRect(start, cardTop, cardWidth, 44);
				context.strokeStyle = mark === selected ? foreground : mark.color;
				context.globalAlpha = mark === selected ? 1 : 0.55;
				context.strokeRect(start + 0.5, cardTop + 0.5, cardWidth - 1, 43);
				context.globalAlpha = 0.35;
				context.strokeStyle = foreground;
				context.beginPath();
				context.moveTo(start + cardWidth, center);
				context.lineTo(band, center);
				context.stroke();

				const label = expectedFrontierLabel(mark.id);
				const age = frontierWait(mark, now);
				const timer = age === null ? "—" : formatFrontierWait(age);
				context.fillStyle = foreground;
				context.globalAlpha = 1;
				context.font = "12px monospace";
				context.textAlign = "right";
				context.fillText(timer, start + cardWidth - 8, cardTop + 6);
				const timerWidth = context.measureText(timer).width;
				context.textAlign = "left";
				context.font = "600 12px " + canvasStyle.fontFamily;
				context.fillText(fitFrontierLabel(context, label.type, cardWidth - timerWidth - 24), start + 8, cardTop + 6);
				context.font = "12px " + canvasStyle.fontFamily;
				context.globalAlpha = 0.8;
				context.fillText(fitFrontierLabel(context, label.detail, cardWidth - 16), start + 8, cardTop + 24);
			}
			context.globalAlpha = 1;
		}
		if (progress) this.readers_.update(progress.history, firstNewMark, (mark) => {
			const cell = departures.get(mark);
			if (!cell) return null;
			const mx = x(cell);
			const my = y(cell);
			return mx >= band && mx < width && my >= 0 && my < height ? {x: mx, y: my} : null;
		});
		if (previous) {
			const oldBand = previous.columns[0].length
				? Math.min(FRONTIER_EXPECTED_WIDTH, Math.floor(width * 0.58)) : 0;
			previous.cells.forEach((cell, mark) => {
				if (cell.column === 0 || cells.has(mark) || suppressed.has(mark) || !mark.event?.hasProgress()) return;
				const mx = oldBand + FRONTIER_INSET + (cell.column - 0.5) * FRONTIER_COLUMN_WIDTH - left;
				const my = y(cell);
				if (mx >= oldBand && mx < width && my >= 0 && my < height) this.readers_.fadeProgress({x: mx, y: my}, mark.color);
			});
		}
		departures.forEach((cell, mark) => {
			if (!mark.event?.hasProgress() || previous?.cells.has(mark)) return;
			const mx = x(cell);
			const my = y(cell);
			if (mx >= band && mx < width && my >= 0 && my < height) this.readers_.fadeProgress({x: mx, y: my}, mark.color);
		});
	}

	/**
	 * @param {!MouseEvent} event
	 * @return {?FrontierMark}
	 */
	pick(event) {
		const bounds = this.canvas.getBoundingClientRect();
		const x = event.clientX - bounds.left;
		const y = event.clientY - bounds.top;
		const band = this.expectedWidth_();
		const expected = x < band;
		const column = expected ? 0 : 1 + Math.floor((x + this.scroll.scrollLeft - band - FRONTIER_INSET) /
			FRONTIER_COLUMN_WIDTH);
		if (!expected && column < 1) return null;
		const row = Math.floor((y + this.scroll.scrollTop - FRONTIER_INSET) /
			(expected ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT));
		return this.markAt_(column, row);
	}

	/** @param {!FrontierMark} mark */
	select(mark) {
		this.selected_ = mark;
		this.inspect(mark);
		this.draw();
	}

	/** @param {!KeyboardEvent} event */
	navigate(event) {
		const key = event.key;
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
		event.preventDefault();
		const current = this.selected_ && this.layout_.cells.get(this.selected_);
		let mark = this.markAt_(0, 0) || this.markAt_(1, 0) || this.markAt_(1, 1);
		if (key === "End") {
			const root = this.progress_?.history[0];
			const lastColumn = this.layout_.columns.length - 1;
			mark = root && this.layout_.cells.has(root) ? root
				: this.markAt_(lastColumn, 0) || this.markAt_(lastColumn, 1) || mark;
		} else if (current && key !== "Home") {
			let {column, row} = current;
			switch (key) {
				case "ArrowLeft": column--; break;
				case "ArrowRight": column++; break;
				case "ArrowUp": row--; break;
				case "ArrowDown": row++; break;
			}
			if (column !== current.column && this.layout_.columns[column]) {
				const previousHeight = current.column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT;
				const nextHeight = column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT;
				row = Math.min(Math.floor((row + 0.5) * previousHeight / nextHeight),
					this.layout_.columns[column].length - 1);
			}
			mark = this.markAt_(column, row);
			if (!mark && column !== current.column && row === 0) mark = this.markAt_(column, 1);
		}
		if (!mark) return;
		const cell = this.layout_.cells.get(mark);
		if (!cell) return;
		const band = this.expectedWidth_();
		if (key === "Home") this.scroll.scrollLeft = 0;
		if (cell.column > 0) {
			const left = band + FRONTIER_INSET + (cell.column - 1) * FRONTIER_COLUMN_WIDTH;
			if (left < this.scroll.scrollLeft + band) this.scroll.scrollLeft = left - band;
			else if (left + FRONTIER_COLUMN_WIDTH > this.scroll.scrollLeft + this.scroll.clientWidth) {
				this.scroll.scrollLeft = left + FRONTIER_COLUMN_WIDTH - this.scroll.clientWidth;
			}
		}
		const rowHeight = cell.column === 0 ? FRONTIER_EXPECTED_HEIGHT : FRONTIER_ROW_HEIGHT;
		const top = FRONTIER_INSET + cell.row * rowHeight;
		if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
		else if (top + rowHeight > this.scroll.scrollTop + this.scroll.clientHeight) {
			this.scroll.scrollTop = top + rowHeight - this.scroll.clientHeight;
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
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 * @param {boolean=} embedded
	 */
	constructor(opt_domHelper, embedded = false) {
		super(opt_domHelper);

		/** @private @const */ this.embedded_ = embedded;
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
		/** @private @type {string} */
		this.mnemonicRenderKey_ = "";
		/** @private @type {?InvocationTerminal} */
		this.terminal_ = null;
		/** @private @type {number} */
		this.activeTab_ = 0;
		/** @private @type {string} */
		this.testsRenderKey_ = "";
		/** @private @type {?BuildMetrics} */
		this.renderedMetrics_ = null;
		/** @private @type {?BuildMetrics} */
		this.renderedStatMetrics_ = null;
		/** @private @type {?BuildToolLogs} */
		this.renderedPathLogs_ = null;
		/** @private @type {?number} */
		this.renderedPathTime_ = null;
		/** @private @type {number} */
		this.clockTimer_ = 0;
		/** @private @type {?ResizeObserver} */
		this.commandObserver_ = null;
		/** @private @type {?HTMLElement} */
		this.commandHeading_ = null;
		/** @private @type {?HTMLButtonElement} */
		this.commandToggle_ = null;
		/** @private */
		this.commandExpanded_ = false;
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
		/** @private @type {?number} */
		this.buildStartMillis_ = null;
		/** @private @type {?InvocationBackend} */
		this.source_ = null;
		/** @private @type {string} */
		this.lastCursor_ = "0";
		/** @private @type {number} */
		this.renderTimer_ = 0;
		/** @private @type {number} */
		this.loadGeneration_ = 0;
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(invocationViewer, {embedded: this.embedded_}));
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
		if (this.progress_.history.length) this.renderTab_();
		if (this.embedded_) return;
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
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		super.goHere(route);
		if (this.embedded_) return;
		const address = readViewerBackend("invocation");
		if (address) this.backendInput_(goog.getCssName("bes-backend")).value = address;
		const id = new URL(window.location.href).searchParams.get("invocation");
		if (!id) {
			if (!this.local_ && this.fileName_) selectInvocationInUrl("invocation", this.fileName_);
			return;
		}
		this.backendInput_(goog.getCssName("bes-id")).value = id;
		if (this.local_ || this.fileName_ !== id || !this.source_) this.connectBackend_();
	}

	/**
	 * @private
	 * @param {string} name
	 * @return {!HTMLInputElement}
	 */
	backendInput_(name) {
		return /** @type {!HTMLInputElement} */ (this.getElement_(name));
	}

	/** @private */
	async refreshRuns_() {
		const status = this.getElement_(goog.getCssName("bes-connection"));
		status.textContent = "Loading saved runs…";
		const address = this.backendInput_(goog.getCssName("bes-backend")).value.trim();
		/** @type {?InvocationBackend} */
		let backend = null;
		try {
			backend = await openInvocationBackend(address);
			const result =
				/** @type {!Object<string,!Array<!Object<string,string>>>} */ (
					await backend.list()
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
					"Could not load runs. Check the backend and viewer access.";
		} finally {
			if (backend) backend.close();
		}
	}

	/** @private */
	async connectBackend_() {
		const status = this.getElement_(goog.getCssName("bes-connection"));
		const id = this.backendInput_(goog.getCssName("bes-id")).value.trim();
		if (!id) {
			status.textContent = "Enter an invocation ID or select a saved run.";
			return;
		}
		const address = this.backendInput_(goog.getCssName("bes-backend")).value.trim();
		selectInvocationInUrl("invocation", id);
		await this.followInvocation(address, id);
	}

	/**
	 * @param {string} address
	 * @param {string} id
	 */
	async followInvocation(address, id) {
		const status = this.getElement_(goog.getCssName("bes-connection"));
		this.stopBackend_();
		const generation = this.loadGeneration_;
		status.textContent = "Connecting…";
		try {
			const source = await openInvocationBackend(address);
			if (generation !== this.loadGeneration_) {
				source.close();
				return;
			}
			this.source_ = source;
			if (!this.embedded_) rememberViewerBackend("invocation", address);
			this.progress_ = new InvocationProgress();
			this.local_ = false;
			this.connected_ = false;
			this.clockStoppedAt_ = null;
			this.resetResults_();
			this.buildStartMillis_ = null;
			this.fileName_ = id;
			this.fileSize_ = 0;
			this.lastCursor_ = "0";
			this.renderSummary_();
			this.getElement_(CSS_STATUS).textContent = "";
			this.cacheTimer_ = setInterval(() => this.refreshCacheStats_(source, id), 1500);
			source.watch(id, () => this.lastCursor_,
				(/** string */ cursor, /** string */ data, /** number= */ receivedAt, /** number= */ sentAt) => {
					if (generation === this.loadGeneration_) this.receiveBuildEvent_(source, id, cursor, data, receivedAt, sentAt);
			}, (/** string */ message, /** boolean */ connected, /** boolean= */ closed) => {
				if (generation !== this.loadGeneration_) return;
				if (closed) {
					this.disconnectBackend_();
				} else {
					this.connected_ = connected;
					this.clockStoppedAt_ = connected ? null : this.clockStoppedAt_ ?? Date.now();
					this.renderSummary_();
				}
				status.textContent = message;
			});
		} catch (_error) {
			if (generation !== this.loadGeneration_) return;
			this.stopBackend_();
			status.textContent = "Could not connect. Check the backend URL or Iroh viewer ticket.";
		}
	}

	stopFollowing() {
		this.stopBackend_();
	}

	/**
	 * @private
	 * @param {!InvocationBackend} source
	 * @param {string} id
	 * @param {string} cursor
	 * @param {string} data
	 * @param {number=} receivedAt
	 * @param {number=} sentAt
	 */
	receiveBuildEvent_(source, id, cursor, data, receivedAt = 0, sentAt = 0) {
		const last = this.lastCursor_;
		if (!/^[1-9][0-9]*$/.test(cursor) || cursor.length < last.length ||
			(cursor.length === last.length && cursor <= last)) return;
		const status = this.getElement_(goog.getCssName("bes-connection"));
		try {
			const bytes = base64.decodeStringToUint8Array(data);
			const event = BuildEvent.deserializeBinary(bytes);
			this.lastCursor_ = cursor;
			const arrival = receivedAt > 0 && Number.isFinite(receivedAt) ? receivedAt : this.progress_.frontierNow();
			this.progress_.add(event, arrival, sentAt);
			if (event.getLastMessage()) {
				clearInterval(this.cacheTimer_);
				this.cacheTimer_ = 0;
				this.refreshCacheStats_(source, id, true);
			}
			this.fileSize_ += bytes.length;
			if (event.getPayloadCase() === BuildEvent.PayloadCase.STARTED) {
				this.buildStartMillis_ = eventTimestampMillis(event);
			}
			status.textContent = "Following " + id + " · " + this.progress_.history.length + " events";
			if (!this.renderTimer_) {
				this.renderTimer_ = setTimeout(() => {
					this.renderTimer_ = 0;
					this.renderResults_();
				}, 250);
			}
		} catch (_error) {
			this.disconnectBackend_();
			status.textContent = "Could not decode a backend build event.";
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
		if (this.frontier_) this.frontier_.stop();
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
		if (this.commandObserver_) this.commandObserver_.disconnect();
		super.exitDocument();
	}

	/** @override */
	disposeInternal() {
		this.stopBackend_();
		if (this.commandObserver_) this.commandObserver_.disconnect();
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
			this.progress_ = new InvocationProgress();
			for (const event of fileEvents) this.progress_.add(event);
			this.local_ = true;
			selectInvocationInUrl("invocation", "");
			this.fileName_ = file.name;
			this.fileSize_ = file.size;
			this.buildStartMillis_ = this.progress_.started ? eventTimestampMillis(this.progress_.started) : null;
			status.textContent = "";
			status.className = goog.getCssName("status");
			this.renderResults_();
			getApplication(this).toastSuccess(
				"Loaded " + this.progress_.history.length + " events from " + file.name + ".",
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
		bindViewerTabs(this.getHandler(), tabs, (index) => this.selectTab_(index));
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
		showViewerTab(this.getElement_(goog.getCssName("bes-tabs")),
			this.getElement_(CSS_RESULTS), index);
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
		const readers = new FrontierActionReaders(
			this.getElement_(goog.getCssName("bes-frontier-flights")),
			this.getElement_(goog.getCssName("bes-frontier-reader")),
		);
		const frontier = new InvocationFrontier(canvas, scroll, spacer, readers,
			(mark) => this.inspectFrontierMark_(mark));
		this.frontier_ = frontier;
		if (this.progress_.history.length) frontier.update(this.progress_);
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
		this.commandExpanded_ = false;
		this.inspected_ = null;
		this.inspectedEvent_ = null;
		this.renderedLog_ = null;
		this.mnemonicRenderKey_ = "";
		this.cacheSummary_ = null;
		this.testsRenderKey_ = "";
		this.renderedMetrics_ = null;
		this.renderedStatMetrics_ = null;
		this.renderedPathLogs_ = null;
		this.renderedPathTime_ = null;
		this.getElement_(CSS_RESULTS).classList.add("d-none");
		this.getElement_(goog.getCssName("bes-log-body")).hidden = true;
		this.selectTab_(0, true);
		const stats = this.getElement_(goog.getCssName("bes-build-stats"));
		dom.removeChildren(stats);
		stats.hidden = true;
		if (this.terminal_) this.terminal_.reset();
		dom.removeChildren(this.getElement_(goog.getCssName("bes-critical-path")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-tests")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-metrics")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-frontier-detail")));
		this.getElement_(goog.getCssName("bes-frontier-caption")).textContent =
			"Select a mark to inspect its event and connections.";
		this.getElement_(goog.getCssName("bes-frontier-wait")).hidden = true;
		this.getElement_(goog.getCssName("bes-frontier-type")).hidden = true;
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
		const parents = mark.parents.length;
		const children = mark.children.length;
		const text = state + " · " + label + " · " + parents + (parents === 1 ? " parent" : " parents") +
			" · " + children + (children === 1 ? " child" : " children");
		if (caption.textContent !== text) caption.textContent = text;
		const timer = this.getElement_(goog.getCssName("bes-frontier-wait"));
		const wait = mark.event ? null : frontierWait(mark, this.progress_.frontierNow());
		timer.hidden = wait === null;
		if (wait !== null) {
			timer.textContent = (this.progress_.last ? "Waited " : "Waiting ") + formatFrontierWait(wait);
			timer.setAttribute("datetime", "PT" + wait + "S");
		}
		if (this.inspected_ === mark && this.inspectedEvent_ === mark.event) return;
		this.inspected_ = mark;
		this.inspectedEvent_ = mark.event;
		this.getElement_(goog.getCssName("bes-frontier-type")).hidden = false;
		const swatch = this.getElement_(goog.getCssName("bes-frontier-swatch"));
		swatch.style.backgroundColor = mark.color;
		swatch.classList.toggle("is-action", Boolean(mark.event?.getAction()));
		this.getElement_(goog.getCssName("bes-frontier-type-name")).textContent = mark.event
			? payloadCaseName(mark.event.getPayloadCase()) : expectedFrontierLabel(mark.id).type;
		const outcome = this.getElement_(goog.getCssName("bes-frontier-outcome"));
		dom.removeChildren(outcome);
		const success = mark.event && eventOutcome(mark.event);
		if (success !== null) outcome.appendChild(soy.renderAsElement(eventStatusIcon, {success}));
		const detail = this.getElement_(goog.getCssName("bes-frontier-detail"));
		dom.removeChildren(detail);
		if (mark.event) {
			detail.appendChild(this.createSelectedEventDetail_(mark.event));
		}
	}

	/** @private */
	renderResults_() {
		this.renderSummary_();
		this.renderInlineLog_();
		this.renderStatCards_();
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
	renderStatCards_() {
		const metrics = this.progress_.metrics;
		if (!metrics || metrics === this.renderedStatMetrics_) return;
		this.renderedStatMetrics_ = metrics;
		const section = this.getElement_(goog.getCssName("bes-build-stats"));
		dom.removeChildren(section);
		section.appendChild(createBuildStatCards(metrics));
		section.hidden = !section.hasChildNodes();
	}

	/** @private */
	renderInlineLog_() {
		this.getElement_(goog.getCssName("bes-log-body")).hidden = false;
		const terminal = this.getElement_(goog.getCssName("bes-log"));
		const log = this.progress_.log;
		if (this.renderedLog_ !== log) {
			const atBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 8;
			dom.removeChildren(terminal);
			terminal.appendChild(renderTerminalText(formatTerminalText(log || "No build output received.")));
			if (atBottom || this.renderedLog_ === null) terminal.scrollTop = terminal.scrollHeight;
			this.renderedLog_ = log;
		}
		this.getElement_(goog.getCssName("bes-log-limit")).hidden = !this.progress_.logTruncated;
	}

	/** @private */
	renderOverview_() {
		this.renderOverviewCriticalPath_();
		const pending = this.frontier_ ? this.frontier_.update(this.progress_) : 0;
		const received = this.progress_.history.length + " received";
		this.getElement_(goog.getCssName("bes-frontier-count")).textContent = this.progress_.last
			? "Stream ended · " + (pending ? pending + " unreceived · " : "") + received
			: pending + " expected · " + received;
		this.renderMnemonicBreakdown_();
		this.renderCacheStats_();
	}

	/** @private */
	renderMnemonicBreakdown_() {
		const key = this.progress_.receivedActions + "/" + Boolean(this.progress_.last);
		if (key === this.mnemonicRenderKey_) return;
		this.mnemonicRenderKey_ = key;
		const body = this.getElement_(goog.getCssName("bes-frontier-mnemonics"));
		dom.removeChildren(body);
		const counts = this.progress_.mnemonics;
		if (!counts.size) {
			body.appendChild(dom.createDom("p", "color-fg-muted text-small mb-0",
				this.progress_.last ? "No action events received." : "Waiting for action events."));
			return;
		}
		const list = dom.createDom("ul", "bes-mnemonic-counts");
		/** @type {!Array<string>} */
		const names = Array.from(counts.keys());
		names.sort((a, b) =>
			(counts.get(b)?.count || 0) - (counts.get(a)?.count || 0) || a.localeCompare(b));
		for (const name of names) {
			const tally = counts.get(name);
			if (!tally) continue;
			const swatch = document.createElement("span");
			swatch.className = "bes-mnemonic-swatch";
			swatch.style.backgroundColor = tally.color;
			swatch.setAttribute("aria-hidden", "true");
			list.appendChild(dom.createDom("li", null, swatch,
				dom.createDom("code", null, name || "Unspecified"),
				dom.createDom("span", "text-bold", tally.count.toLocaleString())));
		}
		body.appendChild(list);
	}

	/**
	 * @private
	 * @param {!InvocationBackend} source
	 * @param {string} id
	 * @param {boolean=} finalRefresh
	 */
	async refreshCacheStats_(source, id, finalRefresh) {
		if (this.cacheRequestPending_) {
			this.cacheRefreshQueued_ = this.cacheRefreshQueued_ || !!finalRefresh;
			return;
		}
		this.cacheRequestPending_ = true;
		const generation = this.loadGeneration_;
		try {
			const summary = await source.get(id);
			if (generation !== this.loadGeneration_) return;
			this.cacheSummary_ = summary;
			if (this.activeTab_ === 0 && this.progress_.history.length) this.renderCacheStats_();
		} catch (_error) {
			// BES replay can continue independently of the summary request.
		} finally {
			if (generation === this.loadGeneration_) {
				this.cacheRequestPending_ = false;
				if (this.cacheRefreshQueued_) {
					this.cacheRefreshQueued_ = false;
					this.refreshCacheStats_(source, id);
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
		body.appendChild(this.createBuildMetricsDetail_(metrics, false));
	}

	/**
	 * @private
	 * @param {!BuildEvent} event
	 * @return {!HTMLElement}
	 */
	createSelectedEventDetail_(event) {
		const root = document.createElement("div");
		const values = this.selectedEventValues_(event);
		const grid = document.createElement("div");
		grid.className = "bes-summary-grid mt-2";
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
		if (grid.hasChildNodes()) root.appendChild(grid);
		const command = this.createCommandLineDetail_(event);
		if (command) root.appendChild(command);
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
	 * @param {!BuildEvent} event
	 * @return {?HTMLElement}
	 */
	createCommandLineDetail_(event) {
		const root = /** @type {!HTMLElement} */ (document.createElement("dl"));
		root.className = "bes-summary-grid mt-2";
		/** @type {!Array<{link: !HTMLAnchorElement, name: string}>} */
		const unresolved = [];
		/**
		 * @param {string} label
		 * @param {!Array<string>} args
		 * @param {!Array<string>=} canonicalNames
		 */
		const addArguments = (label, args, canonicalNames = []) => {
			root.appendChild(dom.createDom("dt", "text-bold color-fg-muted", label));
			const value = dom.createDom("dd", "bes-detail-value m-0");
			if (!args.length) value.textContent = "None";
			else {
				const list = dom.createDom("ul", "bes-command-arguments text-mono text-small");
				for (let index = 0; index < args.length; index++) {
					const arg = args[index];
					const row = dom.createDom("li");
					const flag = /^--([a-zA-Z][a-zA-Z0-9_-]*)(?=$|[=\s])/.exec(arg);
					const spelling = flag ? flag[0] : "";
					const name = flag ? flag[1] : "";
					const optionName = /** @type {string|undefined} */ (canonicalNames[index]) || "";
					const canonical = /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(optionName) ? optionName : "";
					if (canonical || name) {
						const negated = !canonical && /^no[a-zA-Z]/.test(name) && spelling === arg;
						const target = canonical || (negated ? name.slice(2) : name);
						const link = /** @type {!HTMLAnchorElement} */ (dom.createDom("a",
							{"href": "/bazel/flags/" + encodeURIComponent(target)}, spelling || arg));
						row.appendChild(link);
						if (spelling) row.appendChild(document.createTextNode(arg.slice(spelling.length)));
						if (negated) unresolved.push({link, name});
					} else {
						row.textContent = arg;
					}
					list.appendChild(row);
				}
				value.appendChild(list);
			}
			root.appendChild(value);
		};
		const parsed = event.getOptionsParsed();
		const structured = event.getStructuredCommandLine();
		const original = event.getUnstructuredCommandLine();
		if (parsed) {
			addArguments("Startup options", parsed.getStartupOptionsList());
			addArguments("Explicit startup options", parsed.getExplicitStartupOptionsList());
			addArguments("Command options", parsed.getCmdLineList());
			addArguments("Explicit command options", parsed.getExplicitCmdLineList());
		} else if (structured) {
			for (const section of structured.getSectionsList()) {
				const label = metricLabel(section.getSectionLabel()) || "Arguments";
				const options = section.getOptionList();
				const chunks = section.getChunkList();
				if (options) {
					const entries = options.getOptionList();
					addArguments(label, entries.map((option) => option.getCombinedForm()),
						entries.map((option) => option.getOptionName()));
				} else if (chunks) {
					addArguments(label, chunks.getChunkList());
				}
			}
		} else if (original) {
			addArguments("Arguments", original.getArgsList());
		} else {
			return null;
		}
		if (unresolved.length) {
			void getApplication(this).getBazelFlagDb().then((db) => {
				const flags = /** @type {!BazelFlagDb} */ (db).getFlagList();
				const names = new Set(flags.map((flag) => flag.getName()));
				for (const {link, name} of unresolved) {
					if (names.has(name)) link.href = "/bazel/flags/" + encodeURIComponent(name);
				}
			}).catch(() => {});
		}
		return root;
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
			const label = BUILD_METRIC_CATEGORIES[key] || metricLabel(key);
			section.open = expanded && label === "Timing";
			const summary = document.createElement("summary");
			summary.className = "Box-header text-bold";
			summary.textContent = label;
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
			action.className = "bes-critical-path-action text-mono";
			action.textContent = item.action;
			const start = chartMillis > 0 ? item.startMillis / chartMillis * 100 : 0;
			const end = Math.min(100, start + Math.max(0.2, ratio * 100));
			row.style.setProperty("--bes-critical-path-start", start + "%");
			row.style.setProperty("--bes-critical-path-end", end + "%");
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
		const values = {};
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
				values["Argument count"] = String(payload.getArgsList().length);
				break;
			}
			case BuildEvent.PayloadCase.STRUCTURED_COMMAND_LINE: {
				const payload = event.getStructuredCommandLine();
				if (!payload) break;
				values["Label"] = payload.getCommandLineLabel();
				break;
			}
			case BuildEvent.PayloadCase.OPTIONS_PARSED: {
				const payload = event.getOptionsParsed();
				if (!payload) break;
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
				const failure = payload.getFailureDetail()?.getMessage();
				if (failure) values["Failure detail"] = failure;
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
				const failure = payload.getFailureDetail()?.getMessage();
				if (failure) values["Failure detail"] = failure;
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
				const failure = payload.getFailureDetail()?.getMessage();
				if (failure) values["Failure detail"] = failure;
				break;
			}
			case BuildEvent.PayloadCase.BUILD_TOOL_LOGS: {
				const payload = event.getBuildToolLogs();
				if (!payload) break;
				values["Logs"] = payload.getLogList().map(fileSummary).join("\n") || "None";
				values["Log count"] = String(payload.getLogList().length);
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
		const restoreCommandFocus = this.commandToggle_ === document.activeElement;
		if (this.commandObserver_) this.commandObserver_.disconnect();
		section.removeAttribute("role");
		section.removeAttribute("tabindex");
		section.removeAttribute("aria-describedby");
		dom.removeChildren(section);
		const overview = document.createElement("div");
		overview.className = "bes-invocation-overview";
		const command = /** @type {!HTMLElement} */ (document.createElement("h3"));
		command.className = "h3 text-mono bes-invocation-command";
		command.id = this.getId() + "-command";
		const startedEvent = this.progress_.started;
		const started = startedEvent && startedEvent.getStarted();
		const finishedEvent = this.progress_.finished;
		const finished = finishedEvent && finishedEvent.getFinished();
		const id = (started && started.getUuid()) || (!this.local_ ? this.fileName_ : "");
		const headingId = this.getElement_(goog.getCssName("bes-heading-id"));
		headingId.textContent = id;
		headingId.title = id;
		command.textContent = ["bazel", started && started.getCommand(),
			...this.progress_.targets].filter(Boolean).join(" ");
		const toggle = /** @type {!HTMLButtonElement} */ (document.createElement("button"));
		toggle.type = "button";
		toggle.className = "btn-link text-small mt-1";
		toggle.setAttribute("aria-controls", command.id);
		toggle.onclick = () => {
			this.commandExpanded_ = !this.commandExpanded_;
			this.updateCommandToggle_();
		};
		this.commandHeading_ = command;
		this.commandToggle_ = toggle;
		const badge = this.getElement_(goog.getCssName("bes-heading-state"));
		const exit = finished && finished.getExitCode();
		const failure = invocationFailure(this.progress_);
		/** @type {!InvocationStatus} */
		let status;
		if (exit) {
			status = invocationExitStatus(exit.getName(), exit.getCode());
		} else if (failure) {
			status = invocationStatus("Failed", "failure");
		} else if (finished) {
			status = invocationStatus("Finished", "neutral");
		} else if (this.progress_.last || this.local_) {
			status = invocationStatus("Incomplete", "warning");
		} else if (!this.source_ && this.progress_.history.length) {
			status = invocationStatus("Disconnected", "neutral");
		} else if (!this.connected_ && this.progress_.history.length) {
			status = invocationStatus("Reconnecting", "warning");
		} else if (this.progress_.history.length) {
			status = invocationStatus("Building", "running");
		} else {
			status = invocationStatus("Waiting for events", "neutral");
		}
		badge.className = "bes-invocation-state text-small text-bold " + goog.getCssName("bes-heading-state") +
			" " + status.color;
		badge.textContent = status.label;
		badge.title = status.title;
		const icon = this.getElement_(goog.getCssName("bes-heading-icon"));
		dom.removeChildren(icon);
		icon.appendChild(renderInvocationStatusIcon(status));
		const elapsed = this.getElement_(goog.getCssName("bes-heading-elapsed"));
		elapsed.hidden = false;
		overview.appendChild(dom.createDom("div", "bes-invocation-command-block", command, toggle));
		this.renderFailureSummary_(failure);

		const metadata = this.progress_.metadata;
		const info = document.createElement("dl");
		info.className = "bes-invocation-metadata";
		/** @type {!Array<!Array<string|null|undefined>>} */
		const entries = [
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
		this.updateCommandToggle_();
		this.commandObserver_ ??= new ResizeObserver(() => this.updateCommandToggle_());
		this.commandObserver_.observe(command);
		if (restoreCommandFocus && !toggle.hidden) toggle.focus({preventScroll: true});

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
				elapsed.removeAttribute("datetime");
				return;
			}
			const duration = Math.max(0, end - start);
			const minutes = Math.floor(duration / 60000);
			const seconds = (duration % 60000 / 1000).toFixed(3);
			elapsed.textContent = minutes ? minutes + "m " + seconds.padStart(6, "0") + "s" : seconds + "s";
			elapsed.setAttribute("datetime", "PT" + duration / 1000 + "S");
		};
		updateClock();
		if (active && start !== null) this.clockTimer_ = setInterval(updateClock, 250);
	}

	/** @private */
	updateCommandToggle_() {
		const command = this.commandHeading_;
		const toggle = this.commandToggle_;
		if (!command || !toggle) return;
		const expanded = this.commandExpanded_;
		command.classList.toggle("bes-invocation-command-collapsed", !expanded);
		toggle.hidden = !expanded && command.scrollHeight <= command.clientHeight + 1;
		toggle.setAttribute("aria-expanded", String(expanded));
		toggle.textContent = expanded ? "Collapse command" : "Expand command";
	}

	/**
	 * @private
	 * @param {?InvocationFailure} failure
	 */
	renderFailureSummary_(failure) {
		const summary = this.getElement_(goog.getCssName("bes-failure-body"));
		dom.removeChildren(summary);
		summary.hidden = failure === null;
		if (!failure) return;
		summary.appendChild(dom.createDom("h3", "h4 mb-1 color-fg-danger", "Build failure"));
		if (failure.context) summary.appendChild(dom.createDom("p", "text-bold mb-1", failure.context));
		summary.appendChild(dom.createDom("pre", "bes-failure-message", failure.message));
		if (this.progress_.logChunks.length) {
			const button = dom.createDom("button", {"type": "button", "class": "btn btn-sm mt-2"},
				"Open terminal");
			button.onclick = () => {
				this.selectTab_(1);
				const tab = this.getElementStrict().querySelector("#bes-tab-terminal");
				if (tab) /** @type {!HTMLElement} */ (tab).focus();
			};
			summary.appendChild(button);
		}
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
	if (bytes < 1024 ** 3) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
	return (bytes / 1024 ** 3).toFixed(1) + " GiB";
}

exports.FrontierMark = FrontierMark;
exports.InvocationProgress = InvocationProgress;
exports.invocationFailure = invocationFailure;
exports.layoutFrontier = layoutFrontier;
exports.expectedFrontierLabel = expectedFrontierLabel;
exports.frontierWait = frontierWait;
exports.frontierFlightFrames = frontierFlightFrames;
exports.InvocationTerminal = InvocationTerminal;
exports.decodeDelimitedMessages = decodeDelimitedMessages;
exports.formatTerminalText = formatTerminalText;
exports.parseCriticalPath = parseCriticalPath;
exports.createBuildStatCards = createBuildStatCards;
exports.renderTerminalText = renderTerminalText;
