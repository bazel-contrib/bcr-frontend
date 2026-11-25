/** @fileoverview Render build metrics, aggregate tests, and parse the critical path. */
goog.module("bcrfrontend.invocationMetrics");

const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const BuildMetrics = goog.require("proto.build_event_stream.BuildMetrics");
const BuildToolLogs = goog.require("proto.build_event_stream.BuildToolLogs");
const dom = goog.require("goog.dom");
const { formatBytes, formatElapsed, groupRate } = goog.require("bcrfrontend.invocationFormat");
const { testStatusName } = goog.require("bcrfrontend.invocationEvents");

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
 * @param {!BuildMetrics} metrics
 * @param {boolean=} expanded
 * @return {!HTMLElement}
 */
function createBuildMetricsDetail(metrics, expanded = true) {
	const root = /** @type {!HTMLElement} */ (document.createElement("div"));
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
		section.className = "bes-data-details";
		const label = BUILD_METRIC_CATEGORIES[key] || metricLabel(key);
		section.open = expanded && label === "Timing";
		const summary = document.createElement("summary");
		summary.className = "text-bold";
		summary.textContent = label;
		section.appendChild(summary);
		const body = document.createElement("div");
		body.className = "overflow-auto";
		body.appendChild(createMetricTable(metric));
		section.appendChild(body);
		root.appendChild(section);
	}
	return root;
}

/**
 * @param {?BuildToolLogs} logs
 * @param {?number=} duration
 * @return {?HTMLElement}
 */
function createCriticalPathDetail(logs, duration = null) {
	const content = criticalPathLog(logs);
	const criticalPath = parseCriticalPath(content);
	if (duration !== null) criticalPath.timeMillis = duration;
	if (!content && duration === null) return null;
	const root = /** @type {!HTMLElement} */ (document.createElement("section"));
	const header = document.createElement("div");
	header.className = "d-flex flex-items-center mb-2";
	const title = document.createElement("h3");
	title.className = "h3 flex-auto";
	title.textContent = "Critical path";
	const total = document.createElement("span");
	total.className = "text-mono text-small";
	total.textContent = formatElapsed(criticalPath.timeMillis);
	header.appendChild(title);
	header.appendChild(total);
	root.appendChild(header);
	const body = document.createElement("div");
	body.className = "overflow-auto";
	if (!criticalPath.items.length) {
		const unavailable = document.createElement("p");
		unavailable.className = "color-fg-muted mb-0";
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

exports.metricLabel = metricLabel;
exports.appendTableHeader = appendTableHeader;
exports.criticalPathMillis = criticalPathMillis;
exports.createBuildStatCards = createBuildStatCards;
exports.InvocationTest = InvocationTest;
exports.groupInvocationTests = groupInvocationTests;
exports.testStatusLabel = testStatusLabel;
exports.parseCriticalPath = parseCriticalPath;
exports.createBuildMetricsDetail = createBuildMetricsDetail;
exports.createCriticalPathDetail = createCriticalPathDetail;
