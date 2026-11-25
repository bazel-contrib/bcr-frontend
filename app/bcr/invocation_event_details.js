/** @fileoverview Render the details of a selected build event. */
goog.module("bcrfrontend.invocationEventDetails");

const BazelFlagDb = goog.require("proto.build.stack.bazel.help.v1.BazelFlagDb");
const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const dom = goog.require("goog.dom");
const { abortReasonName, fileSummary, testSizeName, testStatusName } = goog.require("bcrfrontend.invocationEvents");
const {
	createBuildMetricsDetail,
	createCriticalPathDetail,
	metricLabel,
} = goog.require("bcrfrontend.invocationMetrics");
const { formatDuration, formatTimestamp } = goog.require("bcrfrontend.invocationFormat");
const { formatTerminalText, renderTerminalText } = goog.require("bcrfrontend.invocationTerminal");

/**
 * @param {!BuildEvent} event
 * @param {function():!Promise<*>} getFlagDb
 * @return {!HTMLElement}
 */
function createSelectedEventDetail(event, getFlagDb) {
	const root = document.createElement("div");
	const values = selectedEventValues(event);
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
	const command = createCommandLineDetail(event, getFlagDb);
	if (command) root.appendChild(command);
	if (event.getPayloadCase() === BuildEvent.PayloadCase.BUILD_METRICS) {
		const metrics = event.getBuildMetrics();
		if (metrics) root.appendChild(createBuildMetricsDetail(metrics));
	}
	if (event.getPayloadCase() === BuildEvent.PayloadCase.BUILD_TOOL_LOGS) {
		const logs = event.getBuildToolLogs();
		if (logs) {
			const criticalPath = createCriticalPathDetail(logs);
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
 * @param {!BuildEvent} event
 * @param {function():!Promise<*>} getFlagDb
 * @return {?HTMLElement}
 */
function createCommandLineDetail(event, getFlagDb) {
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
		void getFlagDb().then((db) => {
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
 * @param {!BuildEvent} event
 * @return {!Object<string,string>}
 */
function selectedEventValues(event) {
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

exports.createSelectedEventDetail = createSelectedEventDetail;
