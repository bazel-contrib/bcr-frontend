goog.module("bcrfrontend.remoteExecution");

const { appendChild, createDom, removeChildren } = goog.require("goog.dom");
const DomHelper = goog.requireType("goog.dom.DomHelper");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component } = goog.require("stack.ui");
const { Route } = goog.requireType("stack.ui");
const {
	ExecutionIrohBackend,
	openExecutionIrohBackend,
	rememberExecutionInvocationBackend,
} = goog.require("bcrfrontend.invocationTransport");
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const { PoolTimeline } = goog.require("bcrfrontend.remoteExecutionTimeline");
const { ToolSetting, toolSetting, schedulerOrigin } = goog.require(
	"bcrfrontend.toolSettings",
);
const { remoteExecution } = goog.require("soy.bcrfrontend.tools");

/** @typedef {!Object<string, *>} */
let Record;

const PATH = "/tools/remote-execution";
const TITLES = {
	instances: "Instances",
	pool: "Pool",
	operation: "Operation",
	scheduler: "Scheduler",
	worker: "Worker",
};

/**
 * @param {*} value
 * @return {string}
 */
function valueText(value) {
	return value == null || value === "" ? "—" : String(value);
}

/**
 * @param {*} value
 * @return {string}
 */
function stateText(value) {
	return valueText(value)
		.replace(/^(WORKER|OPERATION|ATTEMPT)_STATE_/, "")
		.toLowerCase();
}

/**
 * @param {*} value
 * @return {string}
 */
function localTime(value) {
	if (!value) return "—";
	const time = new Date(String(value));
	return Number.isNaN(time.getTime()) ? "—" : time.toLocaleString();
}

/**
 * @param {*} value
 * @return {(string|Element)}
 */
function tableTime(value) {
	const exact = localTime(value);
	if (exact === "—") return exact;
	const iso = String(value);
	const time = createDom("time", { "title": exact }, formatRelativeShort(iso));
	time.setAttribute("datetime", iso);
	return time;
}

/**
 * @param {*} value
 * @return {!Element}
 */
function stateLabel(value) {
	const state = stateText(value);
	/** @type {!Object<string, string>} */
	const colors = {
		"online": "Label--success",
		"completed": "Label--done",
		"running": "Label--accent",
		"leased": "Label--accent",
		"queued": "Label--attention",
		"draining": "Label--attention",
		"failed": "Label--danger",
		"lost": "Label--danger",
	};
	const color = colors[state];
	return createDom(
		"span",
		color ? "Label " + color : "Label",
		state.charAt(0).toUpperCase() + state.slice(1),
	);
}

/**
 * @param {string} view
 * @param {string=} pool
 * @param {string=} worker
 * @param {string=} operation
 * @return {string}
 */
function link(view, pool = "", worker = "", operation = "") {
	if (view === "manage") return PATH + "/manage";
	if (view === "instances") return PATH + "/instances";
	if (!pool) return PATH;
	let path = PATH + "/pools/" + encodeURIComponent(pool);
	if (worker) path += "/workers/" + encodeURIComponent(worker);
	if (operation) path += "/operations/" + encodeURIComponent(operation);
	return path;
}

/** @typedef {{view: string, pool: string, worker: string, operation: string}} */
let ExecutionLocation;

/**
 * @param {!Array<string>} parts
 * @return {?ExecutionLocation}
 */
function executionLocation(parts) {
	const state = { view: "scheduler", pool: "", worker: "", operation: "" };
	if (!parts.length) return state;
	if (parts.length === 1 && parts[0] === "manage") {
		state.view = "manage";
		return state;
	}
	if (parts.length === 1 && parts[0] === "instances") {
		state.view = "instances";
		return state;
	}
	/** @type {!Array<string>} */
	let path;
	try {
		path = parts.map(decodeURIComponent);
	} catch (_error) {
		return null;
	}
	/** @type {function(string):boolean} */
	const valid = (id) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
	if (path[0] !== "pools" || !valid(path[1] || "")) return null;
	state.pool = path[1];
	state.view = "pool";
	let index = 2;
	if (path[index] === "workers" && valid(path[index + 1] || "")) {
		state.worker = path[index + 1];
		state.view = "worker";
		index += 2;
	}
	if (path.length === index) return state;
	if (
		path.length !== index + 2 ||
		path[index] !== "operations" ||
		!valid(path[index + 1])
	)
		return null;
	state.operation = path[index + 1];
	state.view = "operation";
	return state;
}

/**
 * @param {string} text
 * @param {string} route
 * @return {!Element}
 */
function viewLink(text, route) {
	return createDom("a", { "href": route }, text);
}

/**
 * @param {!Record} instance
 * @return {string}
 */
function instanceLabel(instance) {
	return String(instance["displayName"] || instance["name"] || "Default instance");
}

/**
 * @param {!Record} instance
 * @return {(string|Element)}
 */
function instancePools(instance) {
	const pools = /** @type {!Array<!Record>} */ (instance["pools"] || []);
	if (!pools.length) return "—";
	const links = createDom("span");
	for (const pool of pools) {
		if (links.childNodes.length)
			appendChild(links, document.createTextNode(", "));
		appendChild(links, viewLink(String(pool["name"] || pool["id"]), link("pool", String(pool["id"]))));
	}
	return links;
}

/**
 * @param {*} name
 * @return {string}
 */
function operationId(name) {
	return String(name || "").replace(/^operations\//, "");
}

/**
 * @param {string} title
 * @param {!Array<string>} headers
 * @param {!Array<!Array<(string|Element)>>} rows
 * @return {!Element}
 */
function table(title, headers, rows) {
	const heading = createDom("h3", "h4 mb-2", title);
	if (rows.length === 0)
		return createDom(
			"section",
			null,
			heading,
			createDom("p", "color-fg-muted", "No " + title.toLowerCase() + " yet."),
		);
	const header = createDom(
		"tr",
		null,
		...headers.map((label) => createDom("th", { "scope": "col" }, label)),
	);
	const body = rows.map((columns) =>
		createDom(
			"tr",
			null,
			...columns.map((value) => {
				const full =
					typeof value === "string"
						? value
						: value.getAttribute("title") || value.textContent || "";
				return createDom(
					"td",
					null,
					createDom(
						"div",
						{ "class": "rex-table-value", "title": full },
						value,
					),
				);
			}),
		),
	);
	const element = createDom(
		"table",
		{ "class": "rex-table", "aria-label": title },
		createDom("thead", null, header),
		createDom("tbody", null, ...body),
	);
	element.style.setProperty(
		"--rex-table-min-width",
		headers.length * 6.5 + "rem",
	);
	return createDom(
		"section",
		null,
		heading,
		createDom("div", "rex-table-scroll", element),
	);
}

/**
 * @param {!Record} record
 * @return {(string|Element)}
 */
function invocationLink(record) {
	const id = record["invocationId"];
	return id
		? createDom(
				"a",
				{
					"class": "text-mono text-small",
					"href":
						"/tools/invocation/" +
						encodeURIComponent(String(id)) +
						"?source=execution",
					"data-rex-invocation": String(id),
				},
				String(id),
			)
		: "—";
}

/**
 * @param {!Record} detail
 * @return {!Array<!Element>}
 */
function operationDetails(detail) {
	const operation = /** @type {!Record} */ (detail["operation"]);
	const process = /** @type {?Record} */ (detail["process"] || null);
	const timing = /** @type {?Record} */ (detail["executionMetadata"] || null);
	const attempts = /** @type {!Array<!Record>} */ (detail["attempts"] || []);
	const digest = /** @type {?Record} */ (operation["actionDigest"] || null);
	const rows = [
		["State", stateLabel(operation["state"])],
		["Invocation", invocationLink(operation)],
		["Action digest", valueText(digest?.["hash"])],
		["Instance", valueText(detail["instanceName"])],
		["Worker", valueText(operation["workerId"])],
		["Queued", localTime(operation["queuedAt"])],
		["Started", localTime(operation["startedAt"])],
		["Finished", localTime(operation["finishedAt"])],
		["Execution status", valueText(operation["executionCode"])],
		["Exit code", valueText(operation["exitCode"])],
		["Cached result", operation["cachedResult"] ? "Yes" : "No"],
		[
			"Timeout",
			detail["timeoutMillis"]
				? Number(detail["timeoutMillis"]) / 1000 + " s"
				: "—",
		],
	];
	const content = [
		createDom(
			"div",
			null,
			createDom("h2", "h3", "Operation"),
			createDom(
				"p",
				"text-mono text-small color-fg-muted rex-operation-id",
				valueText(operation["operationName"]),
			),
		),
		table("Overview", ["Field", "Value"], rows),
	];
	const processSection = createDom(
		"section",
		null,
		createDom("h3", "h4 mb-2", "Process"),
	);
	if (process) {
		const argv = /** @type {!Array<string>} */ (process["arguments"] || []);
		const outputs = /** @type {!Array<string>} */ (
			process["outputPaths"] || []
		);
		appendChild(
			processSection,
			createDom(
				"p",
				null,
				"Working directory: ",
				createDom("code", null, String(process["workingDirectory"] || ".")),
			),
		);
		appendChild(
			processSection,
			createDom(
				"pre",
				"rex-operation-command",
				createDom("code", null, JSON.stringify(argv, null, 2)),
			),
		);
		if (outputs.length)
			appendChild(
				processSection,
				createDom(
					"p",
					"mt-2",
					"Declared outputs: ",
					createDom("code", null, outputs.join(", ")),
				),
			);
	} else {
		appendChild(
			processSection,
			createDom(
				"p",
				"color-fg-muted",
				"Command details are unavailable. The build may be using an older backend, or its action or command may have left the cache.",
			),
		);
	}
	content.push(processSection);
	if (timing) {
		content.push(
			table(
				"Worker timing",
				["Phase", "Start", "End"],
				[
					[
						"Input fetch",
						localTime(timing["inputFetchStartTimestamp"]),
						localTime(timing["inputFetchCompletedTimestamp"]),
					],
					[
						"Execution",
						localTime(timing["executionStartTimestamp"]),
						localTime(timing["executionCompletedTimestamp"]),
					],
					[
						"Output upload",
						localTime(timing["outputUploadStartTimestamp"]),
						localTime(timing["outputUploadCompletedTimestamp"]),
					],
				],
			),
		);
	}
	if (detail["stdoutBytes"] || detail["stderrBytes"]) {
		const stdout = /** @type {?Record} */ (detail["stdoutDigest"] || null);
		const stderr = /** @type {?Record} */ (detail["stderrDigest"] || null);
		content.push(
			table(
				"Process output",
				["Stream", "Bytes", "Digest"],
				[
					[
						"stdout",
						String(detail["stdoutBytes"] || 0),
						valueText(stdout?.["hash"]),
					],
					[
						"stderr",
						String(detail["stderrBytes"] || 0),
						valueText(stderr?.["hash"]),
					],
				],
			),
		);
	}
	content.push(
		table(
			"Attempts",
			["Attempt", "Worker", "Status", "Started", "Finished", "Exit code"],
			attempts.map((attempt) => [
				valueText(attempt["attemptNumber"]),
				valueText(attempt["workerId"]),
				stateLabel(attempt["state"]),
				tableTime(attempt["startedAt"]),
				tableTime(attempt["finishedAt"]),
				valueText(attempt["exitCode"]),
			]),
		),
	);
	return content;
}

/**
 * @param {*} from
 * @param {*} to
 * @return {string}
 */
function elapsed(from, to) {
	if (!from || !to) return "—";
	const seconds = Math.floor(
		(Date.parse(String(to)) - Date.parse(String(from))) / 1000,
	);
	if (!Number.isFinite(seconds) || seconds < 0) return "—";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days) return days + "d " + hours + "h";
	if (hours) return hours + "h " + minutes + "m";
	if (minutes) return minutes + "m " + (seconds % 60) + "s";
	return seconds + "s";
}

/**
 * @param {!Record} status
 * @param {boolean} stale
 * @return {!Array<!Element>}
 */
function schedulerDashboard(status, stale) {
	const checked = status["checkedAt"];
	const work = /** @type {?Record} */ (status["work"] || null);
	const pools = /** @type {!Array<!Record>} */ (status["pools"] || []);
	const events = /** @type {!Array<!Record>} */ (status["activity"] || []);
	const health = stale
		? "Unreachable"
		: status["ready"]
			? "Ready"
			: "Not ready";
	const content = [
		createDom("h2", { "class": "h3" }, "Scheduler status"),
		createDom(
			"p",
			{ "class": "color-fg-muted" },
			health +
				" · Last checked " +
				localTime(checked) +
				" · Uptime at last check " +
				elapsed(status["startedAt"], checked),
		),
		table(
			"Health checks",
			["Check", "Result"],
			[
				["SQLite", status["databaseReady"] ? "Ready" : "Unavailable"],
				["Remote cache", status["cacheReady"] ? "Ready" : "Unavailable"],
				["Lease sweep", valueText(status["leaseSweep"])],
				["Last successful sweep", localTime(status["lastSweepSuccess"])],
				["Last sweep failure", localTime(status["lastSweepFailure"])],
			],
		),
		createDom("h2", { "class": "h3 mt-4" }, "Work in flight"),
	];
	if (work) {
		const columns = [
			"Pool",
			"Online workers",
			"Occupied / total slots",
			"Queued",
			"Leased",
			"Running",
			"Oldest queued",
		];
		/** @param {!Record} entry @return {!Array<string>} */
		const usage = (entry) => [
			valueText(entry["onlineWorkers"]),
			valueText(entry["occupiedSlots"]) +
				" / " +
				valueText(entry["totalSlots"]),
			valueText(entry["queuedActions"]),
			valueText(entry["leasedActions"]),
			valueText(entry["runningActions"]),
			elapsed(entry["oldestQueuedAt"], checked),
		];
		content.push(
			table("Pool workload", columns, [
				["All pools", ...usage(work)],
				...pools.map((pool) => [
					viewLink(
						valueText(pool["name"] || pool["id"]),
						link("pool", String(pool["id"])),
					),
					...usage(pool),
				]),
			]),
		);
	} else {
		content.push(
			createDom(
				"p",
				{ "class": "color-fg-muted" },
				"Workload data is unavailable.",
			),
		);
	}
	content.push(
		createDom("h2", { "class": "h3 mt-4" }, "Recent activity"),
		table(
			"Activity",
			["Time", "Event", "Pool", "Worker", "Operation"],
			events.map((event) => [
				localTime(event["at"]),
				valueText(event["message"]),
				viewLink(
					valueText(event["poolId"]),
					link("pool", String(event["poolId"])),
				),
				event["workerId"]
					? viewLink(
							valueText(event["worker"] || event["workerId"]),
							link(
								"worker",
								String(event["poolId"]),
								String(event["workerId"]),
							),
						)
					: "—",
				valueText(event["action"]),
			]),
		),
	);
	return content;
}

class RemoteExecutionComponent extends Component {
	/** @param {?DomHelper=} helper */
	constructor(helper) {
		super(helper);
		this.backend_ = "";
		/** @private {?ExecutionIrohBackend} */
		this.iroh_ = null;
		this.token_ = "";
		this.view_ = "scheduler";
		this.pool_ = "";
		this.worker_ = "";
		this.operation_ = "";
		this.poolName_ = "";
		this.workerName_ = "";
		/** @private {?Record} */
		this.schedulerStatus_ = null;
		/** @private {?AbortController} */
		this.active_ = null;
		this.timer_ = 0;
		/** @private {?PoolTimeline} */
		this.timeline_ = null;
		this.adminBackend_ = "";
		this.adminToken_ = "";
		/** @private {!Array<!Record>} */
		this.managedPools_ = [];
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(remoteExecution));
		this.timeline_ = new PoolTimeline(
			this.field_("timeline"),
			(path, signal) => this.read_(path, signal),
			(pool, operation) => link("operation", pool, "", operation),
			(pool, worker) => link("worker", pool, worker),
		);
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		this.getHandler().listen(
			this.field_("connect"),
			"submit",
			(/** !events.BrowserEvent */ event) => {
				event.preventDefault();
				this.connect_(
					toolSetting(ToolSetting.REMOTE_EXECUTION_SCHEDULER),
					toolSetting(ToolSetting.REMOTE_EXECUTION_VIEWER_TOKEN),
				);
			},
		);
		this.getHandler().listen(
			this.getElementStrict(),
			"click",
			(/** !events.BrowserEvent */ event) => {
				const element = /** @type {!Element} */ (event.target);
				const invocation = element.closest("a[data-rex-invocation]");
				if (invocation) {
					if (this.backend_) {
						rememberExecutionInvocationBackend(
							invocation.getAttribute("data-rex-invocation") || "",
							new URL(this.backend_).origin,
						);
					}
					return;
				}
			},
		);
		this.getHandler().listen(
			this.field_("admin-connect"),
			"submit",
			(/** !events.BrowserEvent */ event) => {
				event.preventDefault();
				this.loadManagedPools_();
			},
		);
		this.getHandler().listen(
			this.field_("admin-form"),
			"submit",
			(/** !events.BrowserEvent */ event) => {
				event.preventDefault();
				this.saveManagedPool_();
			},
		);
		this.getHandler().listen(this.field_("admin-pool"), "change", () => {
			this.showManagedPool_(this.input_("admin-pool").value);
		});
		this.getHandler().listen(
			this.field_("admin-instance-form"),
			"submit",
			(/** !events.BrowserEvent */ event) => {
				event.preventDefault();
				this.saveManagedInstance_();
			},
		);
		this.getHandler().listen(this.field_("instance-choice"), "change", () => this.refresh_());
	}

	/** @override @param {!Route} route */
	goDown(route) {
		const tail = route.unmatchedPath();
		if (!executionLocation(tail)) {
			super.goDown(route);
			return;
		}
		this.goHere(route.advance(tail.length));
	}

	/** @override @param {!Route} route */
	goHere(route) {
		super.goHere(route);
		const state = executionLocation(route.path().slice(3));
		if (!state) return;
		const url = new URL(window.location.href);
		const legacy = url.searchParams.get("view");
		if (state.view === "scheduler" && legacy) {
			const pool = url.searchParams.get("pool") || "";
			const worker = url.searchParams.get("worker") || "";
			const destination = link(
				legacy === "manage" ? "manage" : "",
				legacy === "pool" || legacy === "worker" ? pool : "",
				legacy === "worker" ? worker : "",
			);
			const migrated = executionLocation(
				destination
					.slice(PATH.length + 1)
					.split("/")
					.filter(Boolean),
			);
			if (migrated) {
				Object.assign(state, migrated);
				url.pathname = destination;
			}
			url.searchParams.delete("view");
			url.searchParams.delete("pool");
			url.searchParams.delete("worker");
			window.history.replaceState(window.history.state, "", url);
		}
		if (state.view !== "pool" || state.pool !== this.pool_) this.timeline_?.close();
		if (state.pool !== this.pool_) this.poolName_ = "";
		if (state.pool !== this.pool_ || state.worker !== this.worker_)
			this.workerName_ = "";
		this.view_ = state.view;
		this.pool_ = state.pool;
		this.worker_ = state.worker;
		this.operation_ = state.operation;
		this.renderBreadcrumb_();
		this.field_("manage").hidden = this.view_ !== "manage";
		this.field_("instance-filter").hidden = this.view_ !== "instances";
		const panel = this.field_("panel");
		panel.hidden = this.view_ === "manage";
		if (!panel.hidden) panel.setAttribute("aria-label", TITLES[this.view_]);
		if (this.backend_ || this.iroh_) {
			void this.refresh_();
		} else if (!this.active_) {
			const address = toolSetting(ToolSetting.REMOTE_EXECUTION_SCHEDULER);
			const token = toolSetting(ToolSetting.REMOTE_EXECUTION_VIEWER_TOKEN);
			if (address.startsWith("bcr-iroh-v1:") || token)
				void this.connect_(address, token);
			else this.empty_("Connect to view the scheduler, pools, and operations.");
		}
		if (
			this.view_ === "manage" &&
			toolSetting(ToolSetting.REMOTE_EXECUTION_ADMIN_TOKEN) &&
			!this.adminBackend_ &&
			!(/** @type {!HTMLButtonElement} */ (this.field_("admin-load")).disabled)
		) {
			void this.loadManagedPools_();
		}
	}

	/** @override */
	hide() {
		this.stop_();
		this.timeline_?.close();
		this.iroh_?.close();
		this.iroh_ = null;
		this.backend_ = "";
		this.token_ = "";
		this.adminBackend_ = "";
		this.adminToken_ = "";
		this.field_("admin-form").hidden = true;
		this.field_("admin-status").textContent = "";
		this.setConnectionStatus_("Disconnected", "");
		super.hide();
	}

	/** @override */
	exitDocument() {
		this.stop_();
		this.timeline_?.close();
		this.iroh_?.close();
		this.iroh_ = null;
		super.exitDocument();
	}

	/**
	 * @private
	 * @param {string} key
	 * @return {!HTMLElement}
	 */
	field_(key) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector('[data-rex="' + key + '"]')
		);
	}

	/**
	 * @private
	 * @param {string} key
	 * @return {!(HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)}
	 */
	input_(key) {
		return /** @type {!(HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement)} */ (
			this.field_(key)
		);
	}

	/**
	 * @private
	 * @param {string} origin
	 * @param {string} token
	 * @param {string} path
	 * @param {string=} body
	 * @return {!Promise<!Response>}
	 */
	async adminRequest_(origin, token, path, body) {
		const response = await fetch(
			origin + "/api/remote-execution/admin" + path,
			{
				method: body === undefined ? "GET" : "PUT",
				headers: {
					"Authorization": "Bearer " + token,
					"Content-Type": "application/json",
				},
				body,
				cache: "no-store",
				redirect: "error",
			},
		);
		if (!response.ok) throw new Error(await response.text());
		return response;
	}

	/** @private @param {string=} selected */
	async loadManagedPools_(selected = "") {
		const button = /** @type {!HTMLButtonElement} */ (
			this.field_("admin-load")
		);
		const status = this.field_("admin-status");
		button.disabled = true;
		this.field_("admin-form").hidden = true;
		this.field_("admin-instance-form").hidden = true;
		try {
			const origin = selected
				? this.adminBackend_
				: schedulerOrigin(
						toolSetting(ToolSetting.REMOTE_EXECUTION_ADMIN_ORIGIN),
					);
			const token = selected
				? this.adminToken_
				: toolSetting(ToolSetting.REMOTE_EXECUTION_ADMIN_TOKEN);
			if (!token) throw new Error("Set an admin token in Tools settings.");
			const response = await this.adminRequest_(origin, token, "/pools");
			const result = /** @type {!Record} */ (await response.json());
			await this.loadAdminInstances_(origin, token);
			this.managedPools_ = /** @type {!Array<!Record>} */ (result["pools"]);
			this.adminBackend_ = origin;
			this.adminToken_ = token;
			status.textContent = selected ? "Pool saved." : "";
			const choices = this.input_("admin-pool");
			removeChildren(choices);
			appendChild(choices, createDom("option", { value: "" }, "New pool"));
			for (const pool of this.managedPools_) {
				appendChild(
					choices,
					createDom(
						"option",
						{ value: String(pool["id"]) },
						String(pool["name"] || pool["id"]),
					),
				);
			}
			choices.value = selected;
			this.showManagedPool_(choices.value);
			this.field_("admin-form").hidden = false;
			this.field_("admin-instance-form").hidden = false;
		} catch (/** @type {*} */ error) {
			status.textContent =
				error instanceof Error ? error.message : "Could not load pools.";
		} finally {
			button.disabled = false;
		}
	}

	/** @private @param {string} id */
	showManagedPool_(id) {
		const pool = this.managedPools_.find((pool) => pool["id"] === id);
		this.input_("admin-id").value = id;
		/** @type {!HTMLInputElement} */ (this.field_("admin-id")).readOnly =
			Boolean(pool);
		this.input_("admin-name").value = String(pool?.["name"] || "");
		const instance = this.input_("admin-instance");
		if (pool) instance.value = String(pool["instance"] || "");
		this.input_("admin-gateway").value = String(
			pool?.["iroh_gateway_id"] || "",
		);
		const platform = /** @type {!Object<string, string>} */ (
			pool?.["platform"] || {}
		);
		this.input_("admin-platform").value = Object.keys(platform)
			.map((name) => name + "=" + platform[name])
			.join("\n");
		const revoked = /** @type {!Array<string>} */ (
			pool?.["revoked_workers"] || []
		);
		this.input_("admin-revoked").value = revoked.join("\n");
	}

	/**
	 * @private
	 * @param {string} origin
	 * @param {string} token
	 * @param {string=} selected
	 */
	async loadAdminInstances_(origin, token, selected) {
		const response = await this.adminRequest_(origin, token, "/instances");
		const result = /** @type {!Record} */ (await response.json());
		const instances = /** @type {!Array<!Record>} */ (result["instances"]);
		const choices = /** @type {!HTMLSelectElement} */ (this.field_("admin-instance"));
		const previous = selected === undefined ? choices.value : selected;
		removeChildren(choices);
		for (const instance of instances) {
			const name = String(instance["name"]);
			const label = instanceLabel(instance);
			appendChild(choices, createDom("option", { value: name }, name && label !== name ? label + " (" + name + ")" : label));
		}
		choices.value = previous;
		if (choices.selectedIndex < 0 && instances.length) choices.selectedIndex = 0;
	}

	/** @private */
	async saveManagedInstance_() {
		const save = /** @type {!HTMLButtonElement} */ (this.field_("admin-save-instance"));
		save.disabled = true;
		const status = this.field_("admin-status");
		try {
			const name = this.input_("admin-instance-name").value.trim();
			await this.adminRequest_(this.adminBackend_, this.adminToken_, "/instances", JSON.stringify({
				"name": name,
				"displayName": this.input_("admin-instance-display").value.trim(),
			}));
			await this.loadAdminInstances_(
				this.adminBackend_,
				this.adminToken_,
				this.input_("admin-pool").value ? undefined : name,
			);
			status.textContent = "Instance saved.";
		} catch (/** @type {*} */ error) {
			status.textContent = error instanceof Error ? error.message : "Could not save the instance.";
		} finally {
			save.disabled = false;
		}
	}

	/** @private */
	async saveManagedPool_() {
		const save = /** @type {!HTMLButtonElement} */ (this.field_("admin-save"));
		const load = /** @type {!HTMLButtonElement} */ (this.field_("admin-load"));
		save.disabled = true;
		load.disabled = true;
		try {
			const instance = /** @type {!HTMLSelectElement} */ (this.field_("admin-instance"));
			if (instance.selectedIndex < 0) throw new Error("Create an execution instance first.");
			const id = this.input_("admin-id").value.trim();
			/** @type {!Object<string, string>} */
			const platform = Object.create(null);
			for (const line of this.input_("admin-platform").value.split("\n")) {
				if (!line.trim()) continue;
				const split = line.indexOf("=");
				const key = line.slice(0, split).trim();
				const value = line.slice(split + 1).trim();
				if (split < 0 || !key || !value || key in platform)
					throw new Error(
						"Enter one distinct NAME=VALUE platform property per line.",
					);
				platform[key] = value;
			}
			const body = JSON.stringify({
				"id": id,
				"name": this.input_("admin-name").value.trim(),
				"instance": instance.value,
				"platform": platform,
				"iroh_gateway_id": this.input_("admin-gateway").value.trim(),
				"revoked_workers": this.input_("admin-revoked")
					.value.split(/\s+/)
					.filter(Boolean),
			});
			await this.adminRequest_(
				this.adminBackend_,
				this.adminToken_,
				"/pools/" + encodeURIComponent(id),
				body,
			);
			await this.loadManagedPools_(id);
		} catch (/** @type {*} */ error) {
			this.field_("admin-status").textContent =
				error instanceof Error ? error.message : "Could not save the pool.";
		} finally {
			save.disabled = false;
			load.disabled = false;
		}
	}

	/**
	 * @private
	 * @param {string} address
	 * @param {string} token
	 */
	async connect_(address, token) {
		this.stop_();
		this.timeline_?.close();
		this.iroh_?.close();
		this.iroh_ = null;
		this.backend_ = "";
		this.schedulerStatus_ = null;
		if (this.view_ === "scheduler") this.empty_("Checking scheduler…");
		const connection = new AbortController();
		this.active_ = connection;
		this.setConnectionStatus_("Connecting…", "Label--accent");
		try {
			if (address.trim().startsWith("bcr-iroh-v1:")) {
				const iroh = await openExecutionIrohBackend(address.trim());
				if (connection.signal.aborted) {
					iroh.close();
					return;
				}
				this.iroh_ = iroh;
				this.refresh_();
				return;
			}
			const origin = schedulerOrigin(address);
			if (!token.trim())
				throw new Error("Set the scheduler’s viewer token in Tools settings.");
			this.backend_ = origin + "/api/remote-execution";
			this.token_ = token.trim();
			this.refresh_();
		} catch (/** @type {*} */ error) {
			if (!connection.signal.aborted)
				this.setConnectionStatus_(
					"Connection failed",
					"Label--danger",
					error instanceof Error ? error.message : "Scheduler request failed.",
				);
		}
	}

	/**
	 * @private
	 * @param {string} state
	 * @param {string} color
	 * @param {string=} detail
	 */
	setConnectionStatus_(state, color, detail = "") {
		const label = this.field_("status");
		const message = this.field_("status-detail");
		label.className = "Label " + color;
		if (label.textContent !== state) label.textContent = state;
		if (message.textContent !== detail) message.textContent = detail;
	}

	/** @private */
	renderBreadcrumb_() {
		const list = this.field_("breadcrumb");
		/** @type {!Array<!Array<string>>} */
		const crumbs = [["Scheduler", PATH]];
		if (this.view_ === "manage") crumbs.push(["Manage pools and instances", link("manage")]);
		if (this.view_ === "instances") crumbs.push(["Instances", link("instances")]);
		if (this.pool_)
			crumbs.push([this.poolName_ || this.pool_, link("pool", this.pool_)]);
		if (this.worker_)
			crumbs.push([
				this.workerName_ || this.worker_,
				link("worker", this.pool_, this.worker_),
			]);
		if (this.operation_)
			crumbs.push(["Operation " + this.operation_.slice(0, 12), ""]);
		/** @type {!Array<!Element>} */
		const items = crumbs.map(([label, href], index) =>
			createDom(
				"li",
				null,
				index === crumbs.length - 1
					? createDom("span", { "aria-current": "page" }, label)
					: viewLink(label, href),
			),
		);
		const next = items.map((item) => item.outerHTML).join("");
		if (list.innerHTML !== next) {
			removeChildren(list);
			for (const item of items) appendChild(list, item);
		}
	}

	/**
	 * @private
	 * @param {string} message
	 */
	empty_(message) {
		const panel = this.field_("panel");
		removeChildren(panel);
		appendChild(panel, createDom("p", { "class": "color-fg-muted" }, message));
	}

	/** @private */
	stop_() {
		if (this.active_) this.active_.abort();
		this.active_ = null;
		clearTimeout(this.timer_);
		this.timer_ = 0;
	}

	/**
	 * @private
	 * @param {string} path
	 * @param {!AbortSignal} signal
	 * @return {!Promise<!Record>}
	 */
	async read_(path, signal) {
		if (this.iroh_) return await this.iroh_.read(path);
		const response = await fetch(this.backend_ + path, {
			signal,
			headers: { "Authorization": "Bearer " + this.token_ },
			cache: "no-store",
		});
		if (!response.ok)
			throw new Error("Scheduler returned HTTP " + response.status);
		return /** @type {!Record} */ (await response.json());
	}

	/**
	 * @private
	 * @param {!AbortSignal} signal
	 * @return {!Promise<!Record>}
	 */
	readSchedulerStatus_(signal) {
		const request = new AbortController();
		const cancel = () => request.abort();
		signal.addEventListener("abort", cancel, { once: true });
		return new Promise(
			(
				/** function(!Record):void */ resolve,
				/** function(*):void */ reject,
			) => {
				const timer = setTimeout(() => {
					reject(new Error("Scheduler status check timed out."));
					cancel();
				}, 6000);
				this.read_("/status", request.signal)
					.then(resolve, reject)
					.finally(() => {
						clearTimeout(timer);
						signal.removeEventListener("abort", cancel);
					});
			},
		);
	}

	/**
	 * @private
	 * @param {string} path
	 * @param {string} key
	 * @param {!AbortSignal} signal
	 * @return {!Promise<!Array<!Record>>}
	 */
	async list_(path, key, signal) {
		const result = [];
		let token = "";
		do {
			const data = await this.read_(
				path +
					"?page_size=100" +
					(token ? "&page_token=" + encodeURIComponent(token) : ""),
				signal,
			);
			result.push(.../** @type {!Array<!Record>} */ (data[key] || []));
			token = String(data["nextPageToken"] || "");
		} while (token && result.length < 500);
		return result;
	}

	/**
	 * @private
	 * @param {string} path
	 * @param {!AbortSignal} signal
	 * @return {!Promise<void>}
	 * @suppress {reportUnknownTypes} Closure's stream reader extern lacks a result type.
	 */
	async waitForActivity_(path, signal) {
		if (this.iroh_) {
			await this.iroh_.waitForActivity(path);
			return;
		}
		const response = await fetch(this.backend_ + path, {
			signal,
			headers: { "Authorization": "Bearer " + this.token_ },
			cache: "no-store",
		});
		if (!response.ok)
			throw new Error("Scheduler returned HTTP " + response.status);
		if (!response.body) return;
		const body = /** @type {!ReadableStream<!Uint8Array>} */ (response.body);
		const reader = body.getReader();
		try {
			await reader.read();
		} finally {
			await reader.cancel(undefined).catch(() => {});
			reader.releaseLock();
		}
	}

	/**
	 * @private
	 * @param {!Array<!Element>} content
	 */
	renderPanel_(content) {
		const panel = this.field_("panel");
		const next = content
			.map((/** !Element */ element) => element.outerHTML)
			.join("");
		if (panel.innerHTML !== next) {
			removeChildren(panel);
			content.forEach((/** !Element */ element) => appendChild(panel, element));
		}
	}

	/**
	 * @private
	 * @param {!Record} row
	 * @param {string} worker
	 * @return {(string|Element)}
	 */
	operationLink_(row, worker) {
		const id = operationId(row["operationName"]);
		const digest = /** @type {?Record} */ (row["actionDigest"] || null);
		const hash = String(digest?.["hash"] || id);
		if (!id) return hash ? hash.slice(0, 12) : "—";
		const anchor = viewLink(
			hash.slice(0, 12),
			link("operation", this.pool_, worker, id),
		);
		anchor.setAttribute("title", hash);
		anchor.className = "text-mono";
		return anchor;
	}

	/**
	 * @private
	 * @param {string} path
	 * @param {!AbortSignal} signal
	 * @return {!Promise<!Array<!Element>>}
	 */
	async operationContent_(path, signal) {
		const id = this.operation_;
		const workerId = this.worker_;
		const workerPath = path + "/workers/" + encodeURIComponent(workerId);
		/** @type {!Record} */
		let detail;
		try {
			detail = await this.read_(
				path + "/operations/" + encodeURIComponent(id),
				signal,
			);
		} catch (/** @type {*} */ error) {
			// Older HTTP servers and Iroh companions only expose operation lists.
			if (
				signal.aborted ||
				!(error instanceof Error) ||
				!/HTTP (400|404)\b/.test(error.message)
			)
				throw error;
			const operations = await this.list_(
				path + "/operations",
				"operations",
				signal,
			);
			const operation = operations.find(
				(row) => operationId(row["operationName"]) === id,
			);
			if (!operation)
				return [
					createDom(
						"p",
						"color-fg-muted",
						"This operation was not found in the pool.",
					),
				];
			const attempts = workerId
				? (
						await this.list_(workerPath + "/attempts", "attempts", signal)
					).filter((row) => operationId(row["operationName"]) === id)
				: [];
			detail = /** @type {!Record} */ ({
				"operation": operation,
				"attempts": attempts,
			});
		}
		if (signal.aborted) return [];
		const operation = /** @type {!Record} */ (detail["operation"]);
		const attempts = /** @type {!Array<!Record>} */ (detail["attempts"] || []);
		if (
			workerId &&
			workerId !== operation["workerId"] &&
			!attempts.some((row) => row["workerId"] === workerId)
		)
			return [
				createDom(
					"p",
					"color-fg-muted",
					"This operation has no attempts on this worker.",
				),
			];
		const poolDetail = await this.read_(path, signal);
		const workerDetail = workerId ? await this.read_(workerPath, signal) : null;
		if (signal.aborted) return [];
		const pool = /** @type {?Record} */ (poolDetail["pool"] || null);
		const worker = /** @type {?Record} */ (workerDetail?.["worker"] || null);
		this.poolName_ = String(pool?.["displayName"] || this.pool_);
		this.workerName_ = String(worker?.["displayName"] || workerId);
		return operationDetails(detail);
	}

	/**
	 * @private
	 * @param {!Array<!Record>} instances
	 * @return {!Element}
	 */
	renderInstances_(instances) {
		const choice = /** @type {!HTMLSelectElement} */ (this.field_("instance-choice"));
		const selected = choice.value;
		for (let index = 0; index < instances.length; index++) {
			const instance = instances[index];
			const value = "instance:" + String(instance["name"]);
			const label = instanceLabel(instance);
			const existing = choice.options.item(index + 1);
			if (existing) {
				existing.value = value;
				existing.textContent = label;
			} else {
				appendChild(choice, createDom("option", { value }, label));
			}
		}
		choice.options.length = instances.length + 1;
		choice.value = selected;
		if (choice.selectedIndex < 0) choice.selectedIndex = 0;
		const visible = choice.value
			? instances.filter((instance) => choice.value === "instance:" + String(instance["name"]))
			: instances;
		return table(
			"Execution instances",
			["Instance", "REAPI name", "Pools", "Online workers", "Queued", "Leased", "Running"],
			visible.map((instance) => [
				instanceLabel(instance),
				String(instance["name"] || "—"),
				instancePools(instance),
				valueText(instance["onlineWorkers"]),
				valueText(instance["queuedActions"]),
				valueText(instance["leasedActions"]),
				valueText(instance["runningActions"]),
			]),
		);
	}

	/** @private */
	async refresh_() {
		this.stop_();
		const active = new AbortController();
		this.active_ = active;
		const signal = active.signal;
		const path = "/pools/" + encodeURIComponent(this.pool_);
		/** @type {!Array<!Element>} */
		let content = [];
		let activity = "";
		try {
			if (this.view_ === "manage") {
				await this.read_("/pools?page_size=1", signal);
			} else if (this.view_ === "instances") {
				const snapshot = await this.read_("/instances", signal);
				if (signal.aborted) return;
				const instances = /** @type {!Array<!Record>} */ (snapshot["instances"]);
				content = [this.renderInstances_(instances)];
			} else if (this.view_ === "scheduler") {
				const pools = await this.list_("/pools", "pools", signal);
				content = [
					table(
						"Pools",
						[
							"Pool",
							"Instance",
							"Workers",
							"Slots",
							"Queued",
							"Running",
							"Oldest queued",
						],
						pools.map((pool) => [
							viewLink(
								valueText(pool["displayName"] || pool["poolId"]),
								link("pool", String(pool["poolId"])),
							),
							valueText(pool["instanceName"]),
							valueText(pool["onlineWorkers"] || 0),
							String(pool["occupiedSlots"] || 0) +
								" / " +
								String(pool["totalSlots"] || 0),
							valueText(pool["queuedOperations"] || 0),
							valueText(pool["runningOperations"] || 0),
							tableTime(pool["oldestQueuedAt"]),
						]),
					),
				];
				try {
					const status = await this.readSchedulerStatus_(signal);
					if (signal.aborted) return;
					this.schedulerStatus_ = status;
					content.push(...schedulerDashboard(status, false));
				} catch (_error) {
					if (signal.aborted) return;
					if (this.schedulerStatus_)
						content.push(...schedulerDashboard(this.schedulerStatus_, true));
				}
			} else if (this.view_ === "pool" && this.pool_) {
				this.timeline_?.open(this.pool_);
				const detail = await this.read_(path, signal);
				activity =
					path + "/activity?after=" + String(detail["activitySequence"] || "0");
				const workers = await this.list_(path + "/workers", "workers", signal);
				const operations = await this.list_(
					path + "/operations",
					"operations",
					signal,
				);
				if (signal.aborted) return;
				const pool = /** @type {!Record} */ (detail["pool"]);
				this.poolName_ = String(pool["displayName"] || this.pool_);
				/** @type {!Map<string, string>} */
				const workerNames = new Map();
				for (const worker of workers)
					workerNames.set(
						String(worker["workerId"]),
						valueText(worker["displayName"] || worker["workerId"]),
					);
				content = [
					createDom(
						"h2",
						{ "class": "h3" },
						valueText(pool["displayName"] || pool["poolId"]),
					),
					createDom(
						"p",
						{ "class": "color-fg-muted" },
						String(pool["queuedOperations"] || 0) +
							" queued · " +
							String(pool["runningOperations"] || 0) +
							" running · oldest queued " +
							localTime(pool["oldestQueuedAt"]),
					),
					table(
						"Workers",
						["Worker", "Status", "Slots", "Last seen"],
						workers.map((worker) => [
							viewLink(
								valueText(worker["displayName"] || worker["workerId"]),
								link("worker", this.pool_, String(worker["workerId"])),
							),
							stateLabel(worker["state"]),
							String(worker["occupiedSlots"] || 0) +
								" / " +
								String(worker["totalSlots"] || 0),
							tableTime(worker["lastSeenAt"]),
						]),
					),
					table(
						"Operations",
						["Action", "Status", "Worker", "Queued", "Invocation"],
						operations.map((op) => {
							const workerId = valueText(op["workerId"]);
							const name = workerNames.get(workerId);
							const worker = name
								? viewLink(name, link("worker", this.pool_, workerId))
								: null;
							worker?.setAttribute("title", workerId);
							return [
								this.operationLink_(op, workerId === "—" ? "" : workerId),
								stateLabel(op["state"]),
								worker || workerId,
								tableTime(op["queuedAt"]),
								invocationLink(op),
							];
						}),
					),
				];
			} else if (this.view_ === "worker" && this.pool_ && this.worker_) {
				const workerPath =
					path + "/workers/" + encodeURIComponent(this.worker_);
				const detail = await this.read_(workerPath, signal);
				activity =
					workerPath +
					"/activity?after=" +
					String(detail["activitySequence"] || "0");
				const attempts = await this.list_(
					workerPath + "/attempts",
					"attempts",
					signal,
				);
				if (signal.aborted) return;
				const worker = /** @type {!Record} */ (detail["worker"]);
				this.workerName_ = String(worker["displayName"] || this.worker_);
				const properties = /** @type {!Array<!Record>} */ (
					(worker["platform"] &&
						/** @type {!Record} */ (worker["platform"])["properties"]) ||
						[]
				);
				content = [
					createDom(
						"h2",
						{ "class": "h3" },
						valueText(worker["displayName"] || worker["workerId"]),
					),
					createDom(
						"p",
						{ "class": "color-fg-muted" },
						stateText(worker["state"]) +
							" · version " +
							valueText(worker["version"]) +
							" · last seen " +
							localTime(worker["lastSeenAt"]),
					),
					createDom(
						"p",
						null,
						properties
							.map(
								(entry) =>
									valueText(entry["name"]) + "=" + valueText(entry["value"]),
							)
							.join(" · "),
					),
					table(
						"Attempts",
						[
							"Operation",
							"Attempt",
							"Status",
							"Exit code",
							"Started",
							"Finished",
							"Invocation",
						],
						attempts.map((attempt) => [
							this.operationLink_(attempt, this.worker_),
							valueText(attempt["attemptNumber"]),
							stateLabel(attempt["state"]),
							valueText(attempt["exitCode"]),
							tableTime(attempt["startedAt"]),
							tableTime(attempt["finishedAt"]),
							invocationLink(attempt),
						]),
					),
				];
			} else if (this.view_ === "operation") {
				content = await this.operationContent_(path, signal);
			}
			if (signal.aborted) return;
			this.setConnectionStatus_(
				"Connected",
				"Label--success",
				this.iroh_
					? "Using the Iroh viewer ticket."
					: new URL(this.backend_).origin,
			);
			this.renderBreadcrumb_();
			if (this.view_ === "manage") return;
			this.renderPanel_(content);
			if (activity) {
				await this.waitForActivity_(activity, signal);
				if (!signal.aborted)
					this.timer_ = setTimeout(() => this.refresh_(), 250);
				return;
			}
		} catch (/** @type {*} */ error) {
			if (signal.aborted) return;
			if (this.view_ !== "scheduler") {
				this.empty_(
					error instanceof Error ? error.message : "Could not load this view.",
				);
			} else {
				if (this.schedulerStatus_)
					this.renderPanel_(schedulerDashboard(this.schedulerStatus_, true));
				else this.empty_("Scheduler status is unavailable.");
			}

			this.setConnectionStatus_(
				"Connection failed",
				"Label--danger",
				error instanceof Error ? error.message : "Scheduler request failed.",
			);
		}
		if (!signal.aborted && this.view_ !== "manage")
			this.timer_ = setTimeout(() => this.refresh_(), 5000);
	}
}

exports.RemoteExecutionComponent = RemoteExecutionComponent;
