/** @fileoverview Browse invocation groups and select live builds or local replays. */
goog.module("bcrfrontend.invocationGroups");

const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const FileDropHandler = goog.require("goog.events.FileDropHandler");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { BuildEventViewerComponent } = goog.require(
	"bcrfrontend.invocationViewer",
);
const { COLLECTION_INCOMPLETE, InvocationProgress, decodeDelimitedMessages } =
	goog.require("bcrfrontend.invocationEvents");
const { Component, Route } = goog.require("stack.ui");
const { METRICS, metricValue, metricLabel } = goog.require(
	"bcrfrontend.invocationCharts",
);
const { InvocationBackend, openInvocationBackend } = goog.require(
	"bcrfrontend.invocationTransport",
);
const {
	InvocationStatus,
	incompleteStatus,
	invocationStatus,
	renderInvocationStatusIcon,
	replayResultStatus,
	storedExitStatus,
} = goog.require("bcrfrontend.invocationStatus");
const { formatBytes, formatElapsed, groupRate } = goog.require(
	"bcrfrontend.invocationFormat",
);
const { formatRelativeShort } = goog.require("bcrfrontend.format");
const { getApplication } = goog.require("bcrfrontend.common");
const { invocationGroups } = goog.require("soy.bcrfrontend.tools");

const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * @param {!Element} body
 * @param {!Array<!Array<string>>} entries
 */
function renderGroupMetricList(body, entries) {
	const list = dom.createDom("dl", "bes-invocation-metadata");
	for (const entry of entries) {
		list.appendChild(
			dom.createDom(
				"div",
				null,
				dom.createDom("dt", "color-fg-muted text-small", entry[0]),
				dom.createDom("dd", "text-bold", entry[1]),
			),
		);
	}
	dom.removeChildren(body);
	body.appendChild(list);
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

const INVOCATION_PATH = "/tools/invocation";

const GROUP_INVOCATIONS_PATH = "/tools/invocations";

const GROUP_VIEW_ID_PREFIX = "igroup-panel-";

const GROUP_VIEWS = new Set([
	"current",
	"group",
	"groups",
	"runs",
	"metrics",
	"tests",
	"cache",
	"usage",
	"upload",
]);

const NO_GROUP = "-";

/**
 * @param {!Array<string>} parts Encoded path segments after /tools.
 * @return {?{group: string, id: string, view: string}}
 */
function parseViewerPath(parts) {
	/** @type {function(string):string} */
	const viewName = (view) =>
		view === "runs" || view === "metrics" || view === "cache" ? "group" : view;
	try {
		const [tool, first = "", second = "", third = ""] =
			parts.map(decodeURIComponent);
		if (
			tool === "invocation" &&
			parts.length <= 3 &&
			(!second || GROUP_VIEWS.has(second))
		) {
			return { group: "", id: first, view: viewName(second) };
		}
		if (
			tool !== "invocations" ||
			parts.length > 4 ||
			(third && !GROUP_VIEWS.has(third))
		)
			return null;
		if (first === NO_GROUP) {
			return !third && GROUP_VIEWS.has(second)
				? { group: "", id: "", view: viewName(second) }
				: null;
		}
		if (!third && GROUP_VIEWS.has(second))
			return { group: first, id: "", view: viewName(second) };
		return { group: first, id: second, view: viewName(third) };
	} catch (_error) {
		return null;
	}
}

/**
 * @param {!URL} url
 * @return {{group: string, id: string, view: string}}
 */
function viewerLocation(url) {
	return (
		parseViewerPath(url.pathname.split("/").filter(Boolean).slice(1)) || {
			group: "",
			id: "",
			view: "",
		}
	);
}

/**
 * @param {!URL} url
 * @param {string} group
 * @param {string} id
 * @param {string} view
 */
function setViewerPath(url, group, id, view) {
	const base = id && !group ? INVOCATION_PATH : GROUP_INVOCATIONS_PATH;
	/** @type {!Array<string>} */
	const parts = [
		group || (!id && view ? NO_GROUP : ""),
		id,
		view || (group && GROUP_VIEWS.has(id) ? "current" : ""),
	];
	url.pathname =
		base +
		parts
			.filter(Boolean)
			.map((part) => "/" + encodeURIComponent(part))
			.join("");
	url.hash = "";
}

/** @param {!URL} url */
function replaceViewerLocation(url) {
	if (url.href !== window.location.href)
		window.history.replaceState(window.history.state, "", url.href);
}

/**
 * @param {!URL} url
 * @return {string}
 */
function groupFollowMode(url) {
	const mode = url.searchParams.get("follow");
	if (mode === "auto" || mode === "off" || mode === "manual") return mode;
	const { group, id } = viewerLocation(url);
	return group && id ? "manual" : "auto";
}

/** @typedef {{id: string, command: string, status: !InvocationStatus, time: string,
 *     timeLabel: string, started: number, recorded: number}} */
let InvocationRow;

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
		/** @private @type {!Array<!Object<string, *>>} */ this.olderRuns_ = [];
		/** @private @type {?Object<string, *>} */ this.activeRun_ = null;
		/** @private @type {?Object<string, *>} */ this.watchedRun_ = null;
		/** @private */ this.nextPage_ = "";
		/** @private */ this.historyExpanded_ = false;
		/** @private */ this.pageInFlight_ = false;
		/** @private */ this.windowDays_ = 30;
		/** @private */ this.metricsRequest_ = 0;
		/** @private @type {?Set<string>} */
		this.seenRuns_ = null;
		/** @private */ this.pendingRunId_ = "";
		/** @private */ this.generation_ = 0;
		/** @private */ this.pollTimer_ = 0;
		/** @private */ this.address_ = "";
		/** @private */ this.group_ = "";
		/** @private */ this.watchedId_ = "";
		/** @private */ this.requestedId_ = "";
		/** @private */ this.historyKey_ = "";
		/** @private */ this.historyClock_ = 0;
		/** @private */ this.activeView_ = "current";
		/** @private */ this.metricsInFlight_ = false;
		/** @private */ this.lastMetricsRead_ = 0;
		/** @private @type {!Map<string, !Object<string, *>>} */ this.buildSamples_ =
			new Map();
		/** @private @const {!Set<string>} */ this.statusFilter_ = new Set([
			"SUCCESS",
		]);
		/** @private */ this.filterOptionsKey_ = "";
		/** @private @type {?BuildEventViewerComponent} */ this.uploadViewer_ =
			null;
		/** @private */ this.uploadGeneration_ = 0;
	}

	/** @override */
	createDom() {
		const altKeyLabel = /^Mac/i.test(navigator.platform) ? "Option" : "Alt";
		this.setElementInternal(
			soy.renderAsElement(invocationGroups, { altKeyLabel }),
		);
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		this.historyClock_ = setInterval(() => {
			if (this.activeView_ === "group" || this.activeView_ === "groups")
				this.refreshRelativeTimes_();
		}, 30000);
		const groupInput = this.input_(goog.getCssName("igroup-name"));
		const showLast = this.input_(goog.getCssName("igroup-show-last"));
		this.getHandler().listen(showLast, "change", () => {
			const url = new URL(window.location.href);
			url.searchParams.set("showLast", showLast.checked ? "1" : "0");
			replaceViewerLocation(url);
			this.updateViewLinks_(url);
		});
		const follow = this.input_(goog.getCssName("igroup-follow"));
		this.getHandler().listen(follow, "change", () => {
			this.setFollowMode_(follow.checked ? "auto" : "off");
			if (!this.seenRuns_) return;
			if (follow.checked) this.returnToGroup_();
			this.renderGroupStatus_();
		});
		const metric = this.groupElement_(goog.getCssName("igroup-metric"));
		METRICS.forEach(({ label }, index) =>
			metric.appendChild(
				dom.createDom("option", { value: String(index) }, label),
			),
		);
		const handler = this.getHandler();
		/** @type {!Array<string>} */
		const searchFields = [
			goog.getCssName("igroup-id-filter"),
			goog.getCssName("igroup-command-filter"),
		];
		for (const css of searchFields)
			handler.listen(this.groupElement_(css), "input", () =>
				this.renderHistory_(),
			);
		handler.listen(metric, "change", () => this.renderHistory_());
		handler.listen(
			this.groupElement_(goog.getCssName("igroup-binning")),
			"change",
			() => this.renderHistory_(),
		);
		handler.listen(
			this.groupElement_(goog.getCssName("igroup-status-options")),
			"change",
			(/** !events.BrowserEvent */ event) => {
				const input = /** @type {!HTMLInputElement} */ (event.target);
				if (input.checked) this.statusFilter_.add(input.value);
				else this.statusFilter_.delete(input.value);
				this.renderHistory_();
			},
		);
		const windowSelect = /** @type {!HTMLSelectElement} */ (
			this.groupElement_(goog.getCssName("igroup-window"))
		);
		handler.listen(windowSelect, "change", () => {
			this.windowDays_ = Number(windowSelect.value);
			this.buildSamples_.clear();
			this.renderHistory_();
			this.metricsRequest_++;
			this.metricsInFlight_ = false;
			this.lastMetricsRead_ = 0;
			if (this.group_ && this.seenRuns_)
				this.setMetricsMessage_("Loading metrics…");
			this.refreshMetrics_();
		});
		this.getHandler().listen(
			this.groupElement_(goog.getCssName("igroup-older-runs")),
			"click",
			() => this.loadOlderRuns_(),
		);
		const root = this.getElementStrict();
		this.getHandler().listen(
			root,
			"click",
			(/** !events.BrowserEvent */ event) => {
				const link = /** @type {!Element} */ (event.target).closest(
					"a[data-view]",
				);
				if (
					!link ||
					event.button !== 0 ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey
				)
					return;
				event.preventDefault();
				this.navigateView_(link.getAttribute("data-view") || "");
			},
		);
		this.getHandler().listen(
			root,
			"keydown",
			(/** !events.BrowserEvent */ event) => {
				const key = /** @type {!KeyboardEvent} */ (event.getBrowserEvent());
				if (
					key.defaultPrevented ||
					!key.altKey ||
					!key.shiftKey ||
					key.ctrlKey ||
					key.metaKey ||
					key.repeat ||
					!/^Digit[1-6]$/.test(key.code) ||
					document.activeElement?.closest(
						"input, textarea, select, [contenteditable]",
					)
				)
					return;
				const link = root.querySelector('[data-shortcut="' + key.code + '"]');
				if (!link) return;
				event.preventDefault();
				this.navigateView_(link.getAttribute("data-view") || "");
			},
		);
		this.getHandler().listen(
			this.groupElement_(goog.getCssName("igroup-form")),
			"submit",
			(/** !events.BrowserEvent */ event) => {
				event.preventDefault();
				const { group, id } = viewerLocation(new URL(window.location.href));
				const single = id && !group && this.activeView_ !== "groups";
				const destination = groupInput.value.trim()
					? this.activeView_ === "groups"
						? "group"
						: ""
					: single
						? ""
						: "groups";
				this.openGroup_(destination);
			},
		);
		this.getHandler().listen(
			this.groupElement_(goog.getCssName("igroup-list")),
			"click",
			(/** !events.BrowserEvent */ event) => {
				const target = /** @type {!Element} */ (event.target).closest(
					"[data-group-name]",
				);
				if (!target) return;
				groupInput.value = target.getAttribute("data-group-name") || "";
				this.openGroup_("group");
			},
		);
		this.getHandler().listen(
			this.groupElement_(goog.getCssName("igroup-runs")),
			"click",
			(/** !events.BrowserEvent */ event) => {
				const target = /** @type {!Element} */ (event.target).closest(
					"[data-invocation-id]",
				);
				const id = target && target.getAttribute("data-invocation-id");
				if (id) this.openRun_(id);
			},
		);
		const input = this.input_(goog.getCssName("igroup-file-input"));
		const drop = new FileDropHandler(root, true);
		this.registerDisposable(drop);
		handler.listen(
			this.groupElement_(goog.getCssName("igroup-choose-file")),
			"click",
			() => input.click(),
		);
		handler.listen(input, "change", () => {
			const file = input.files?.[0];
			input.value = "";
			if (file) this.loadUpload_(file);
		});
		handler.listen(root, "dragenter", (/** !events.BrowserEvent */ event) => {
			const drag = /** @type {!DragEvent} */ (event.getBrowserEvent());
			if (drag.dataTransfer?.types.includes("Files"))
				root.classList.add("is-dragging");
		});
		handler.listen(root, "dragleave", (/** !events.BrowserEvent */ event) => {
			if (!root.contains(/** @type {?Node} */ (event.relatedTarget)))
				root.classList.remove("is-dragging");
		});
		handler.listen(
			drop,
			FileDropHandler.EventType.DROP,
			(/** !events.BrowserEvent */ event) => {
				root.classList.remove("is-dragging");
				const drag = /** @type {!DragEvent} */ (event.getBrowserEvent());
				const file = drag.dataTransfer?.files[0];
				if (file) this.loadUpload_(file);
			},
		);
	}

	/** @private @param {string} id */
	openRun_(id) {
		if (this.followMode_() === "auto") this.setFollowMode_("manual");
		this.navigateView_("current", id);
	}

	/**
	 * @private
	 * @param {!URL} url
	 */
	syncGroupOptions_(url) {
		const follow = groupFollowMode(url);
		const showLast = url.searchParams.get("showLast") !== "0";
		if (follow !== "auto") this.pendingRunId_ = "";
		url.searchParams.set("follow", follow);
		url.searchParams.set("showLast", showLast ? "1" : "0");
		this.input_(goog.getCssName("igroup-follow")).checked = follow === "auto";
		this.input_(goog.getCssName("igroup-show-last")).checked = showLast;
	}

	/** @private @return {string} */
	followMode_() {
		return groupFollowMode(new URL(window.location.href));
	}

	/** @private @param {string} mode */
	setFollowMode_(mode) {
		const url = new URL(window.location.href);
		url.searchParams.set("follow", mode);
		if (mode !== "auto") this.pendingRunId_ = "";
		this.input_(goog.getCssName("igroup-follow")).checked = mode === "auto";
		replaceViewerLocation(url);
		this.updateViewLinks_(url);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goDown(route) {
		const tail = route.unmatchedPath();
		if (!parseViewerPath([route.at(route.index() - 1) || "", ...tail])) {
			super.goDown(route);
			return;
		}
		this.goHere(route.advance(tail.length));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		super.goHere(route);
		const url = new URL(window.location.href);
		const location = parseViewerPath(route.path().slice(2));
		if (!location) return;
		const { group, id, view } = location;
		if (/\/(runs|metrics|cache)$/.test(url.pathname) && view === "group")
			setViewerPath(url, group, id, view);
		this.syncGroupOptions_(url);
		replaceViewerLocation(url);
		this.updateViewLinks_(url);
		this.selectView_(view || (group || id ? "current" : "groups"));
		const sameGroup = group === this.group_;
		const sameRun = id === (this.requestedId_ || this.watchedId_);
		if (
			sameGroup &&
			this.backend_ &&
			id &&
			!sameRun &&
			(!group ||
				this.runs_
					.concat(this.olderRuns_)
					.some((/** !Object<string, *> */ run) => run["invocationId"] === id))
		) {
			this.watch_(id);
			this.renderGroupStatus_();
			return;
		}
		if (sameGroup && sameRun && this.backend_) {
			if (this.seenRuns_) this.renderGroupStatus_();
			return;
		}
		this.input_(goog.getCssName("igroup-name")).value = group;
		const remembered =
			(group && readViewerBackend("group." + group)) ||
			readViewerBackend("invocation");
		if (remembered)
			this.input_(goog.getCssName("igroup-backend")).value = remembered;
		if (
			((group || id) &&
				this.input_(goog.getCssName("igroup-backend")).value.trim()) ||
			(view === "groups" && remembered) ||
			!sameGroup ||
			this.watchedId_
		) {
			this.openGroup_();
		} else if (id) {
			this.groupElement_(goog.getCssName("igroup-status")).textContent =
				"Connect to a backend to open this invocation.";
		}
	}

	/** @override */
	hide() {
		this.uploadGeneration_++;
		this.closeGroup_();
		super.hide();
	}

	/** @override */
	exitDocument() {
		clearInterval(this.historyClock_);
		this.historyClock_ = 0;
		this.uploadGeneration_++;
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

	/** @private @param {string=} view */
	async openGroup_(view = "") {
		this.closeGroup_();
		const generation = this.generation_;
		this.address_ = this.input_(goog.getCssName("igroup-backend")).value.trim();
		this.group_ = this.input_(goog.getCssName("igroup-name")).value.trim();
		const url = new URL(window.location.href);
		const path = viewerLocation(url);
		const singleId =
			!this.group_ && !path.group && view !== "groups" ? path.id : "";
		this.runs_ = [];
		this.olderRuns_ = [];
		this.activeRun_ = null;
		this.watchedRun_ = null;
		this.historyExpanded_ = false;
		this.pageInFlight_ = false;
		/** @type {!HTMLButtonElement} */ (
			this.groupElement_(goog.getCssName("igroup-older-runs"))
		).disabled = false;
		this.nextPage_ = "";
		this.groupElement_(goog.getCssName("igroup-page-status")).textContent = "";
		this.seenRuns_ = null;
		this.buildSamples_.clear();
		this.renderCatalog_([], "Connecting to the backend…");
		this.pendingRunId_ = "";
		this.historyKey_ = "";
		this.renderHistory_();
		const pending = singleId
			? "Waiting for this invocation…"
			: this.group_
				? "Waiting for the group connection…"
				: "Connect to a backend and choose a group.";
		this.setGroupWaitingMessage_(pending);
		if (
			this.group_ &&
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.group_)
		) {
			this.setBackendStatus_("Disconnected", "", "Enter a valid group name.");
			return;
		}
		const sameGroup = this.group_ !== "" && path.group === this.group_;
		if (!sameGroup && groupFollowMode(url) === "manual")
			url.searchParams.set("follow", "auto");
		this.syncGroupOptions_(url);
		this.requestedId_ = sameGroup ? path.id : "";
		if (!singleId)
			setViewerPath(url, this.group_, this.requestedId_, view || path.view);
		replaceViewerLocation(url);
		this.updateViewLinks_(url);
		if (view) this.selectView_(view);
		this.setBackendStatus_(
			"Connecting",
			"Label--accent",
			"Opening the invocation backend…",
		);
		try {
			const backend = await openInvocationBackend(this.address_);
			if (generation !== this.generation_) {
				backend.close();
				return;
			}
			this.backend_ = backend;
			if (this.activeView_ === "groups") void this.refreshCatalog_();
			if (singleId) {
				rememberViewerBackend("invocation", this.address_);
				this.watch_(singleId);
				const result = await backend.list();
				if (generation !== this.generation_) return;
				this.setRunPage_(result);
				this.renderHistory_();
				this.renderGroupStatus_();
			} else if (this.group_) {
				rememberViewerBackend("group." + this.group_, this.address_);
				await this.pollGroup_(backend, generation);
			} else {
				const runsResult = await backend.list();
				if (generation !== this.generation_) return;
				this.setRunPage_(runsResult);
				rememberViewerBackend("invocation", this.address_);
				this.setBackendStatus_(
					"Connected",
					"Label--success",
					"Choose a group from Groups.",
				);
				this.renderHistory_();
			}
		} catch (/** @type {*} */ error) {
			if (generation === this.generation_) {
				this.setBackendStatus_(
					"Connection failed",
					"Label--danger",
					error instanceof Error
						? error.message
						: "Could not connect to invocation groups.",
				);
				this.renderCatalog_([], "Could not connect to the backend.");
				this.setGroupWaitingMessage_(
					"Connect to a backend and choose a group.",
				);
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
		this.groupElement_(goog.getCssName("igroup-runs-empty")).textContent =
			message;
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
		label.className = ["Label", goog.getCssName("igroup-backend-label"), color]
			.filter(Boolean)
			.join(" ");
		const message = this.groupElement_(
			goog.getCssName("igroup-backend-detail"),
		);
		if (!group) {
			if (message.textContent !== detail) message.textContent = detail;
			return;
		}
		const flag = "--build_metadata=igroup=" + group;
		const instruction = " on a build to add it to the " + group + " group.";
		const watching = "Watching group ";
		if (message.textContent === watching + group + "Set " + flag + instruction)
			return;
		message.replaceChildren(
			dom.createDom(
				"div",
				null,
				watching,
				dom.createDom("strong", "text-mono", group),
			),
			dom.createDom(
				"div",
				null,
				"Set ",
				dom.createDom("code", null, flag),
				instruction,
			),
		);
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
			this.setBackendStatus_("Connected", "Label--success", "", this.group_);
			this.setRunPage_(result);
			const seen = this.seenRuns_;
			if (seen && this.followMode_() === "auto") {
				const newestUnseen = this.runs_.find((run) => {
					const id = String(run["invocationId"]);
					return (
						id !== this.watchedId_ && id !== this.requestedId_ && !seen.has(id)
					);
				});
				if (newestUnseen)
					this.pendingRunId_ = String(newestUnseen["invocationId"]);
			}
			this.seenRuns_ = new Set(
				this.runs_.map((run) => String(run["invocationId"])),
			);
			this.renderHistory_();
			const requested = this.requestedId_;
			const watched = this.watchedId_;
			const lookup = requested || watched;
			this.watchedRun_ = lookup
				? this.runs_.find((run) => run["invocationId"] === lookup) ||
					(this.activeRun_?.["invocationId"] === lookup
						? this.activeRun_
						: null)
				: null;
			if (lookup && !this.watchedRun_) {
				try {
					const found = await backend.get(lookup);
					if (generation !== this.generation_) return;
					if (
						found["invocationGroup"] === this.group_ &&
						(this.requestedId_ || this.watchedId_) === lookup
					)
						this.watchedRun_ = found;
				} catch (_error) {
					if (generation !== this.generation_) return;
					// A link can arrive before its first build event.
				}
			}
			if (
				this.requestedId_ &&
				this.watchedRun_?.["invocationId"] === this.requestedId_
			)
				this.watch_(this.requestedId_);
			this.selectActiveRun_();
			if (
				!seen &&
				!this.requestedId_ &&
				!this.watchedId_ &&
				new URL(window.location.href).searchParams.get("showLast") !== "0"
			) {
				const last = this.runs_.find(
					(run) =>
						run["state"] === "INVOCATION_STATE_COMPLETE" ||
						run["state"] === "INVOCATION_STATE_INCOMPLETE",
				);
				if (last) this.watch_(String(last["invocationId"]));
			}
			this.renderGroupStatus_();
			this.refreshMetrics_();
		} catch (/** @type {*} */ error) {
			if (generation !== this.generation_) return;
			const detail =
				error instanceof Error ? error.message : "Could not load this group.";
			this.setBackendStatus_(
				"Retrying",
				"Label--attention",
				detail + " Retrying the group connection…",
			);
			if (this.seenRuns_ === null)
				this.setGroupWaitingMessage_("Waiting for the group connection…");
		}
		this.pollTimer_ = setTimeout(
			() => this.pollGroup_(backend, generation),
			2000,
		);
	}

	/** @private @param {!URL} url */
	updateViewLinks_(url) {
		const { group, id } = viewerLocation(url);
		const destination = new URL(url.href);
		for (const link of this.getElementStrict().querySelectorAll(
			"a[data-view]",
		)) {
			setViewerPath(
				destination,
				group,
				id,
				link.getAttribute("data-view") || "",
			);
			link.setAttribute("href", destination.pathname + destination.search);
		}
	}

	/**
	 * @private
	 * @param {string} view
	 * @param {string=} invocationId
	 */
	navigateView_(view, invocationId) {
		if (!GROUP_VIEWS.has(view)) return;
		const url = new URL(window.location.href);
		const { group, id } = viewerLocation(url);
		setViewerPath(url, group, invocationId ?? id, view);
		getApplication(this).setLocation(url.pathname.split("/").filter(Boolean));
		const panel = this.getElementStrict().querySelector(
			"#" + GROUP_VIEW_ID_PREFIX + view,
		);
		if (panel instanceof HTMLElement && !panel.hidden) {
			panel.focus({ preventScroll: true });
			const top = panel.getBoundingClientRect().top;
			if (top < 0 || top >= window.innerHeight)
				panel.scrollIntoView({ block: "start" });
		}
	}

	/** @private @param {string} view */
	selectView_(view) {
		const content = this.groupElement_(goog.getCssName("igroup-content"));
		const panels = content.querySelectorAll(":scope > [id]");
		let selected = null;
		for (const panel of panels) {
			if (panel.id === GROUP_VIEW_ID_PREFIX + view)
				selected = /** @type {!HTMLElement} */ (panel);
		}
		if (!selected) return;
		this.activeView_ = view;
		if (view === "group" || view === "groups") this.refreshRelativeTimes_();
		if (view === "groups") void this.refreshCatalog_();
		for (const panel of panels) {
			if (panel instanceof HTMLElement) panel.hidden = panel !== selected;
		}
		for (const link of this.getElementStrict().querySelectorAll(
			"a[id][data-view]",
		)) {
			if (link.getAttribute("data-view") === view)
				link.setAttribute("aria-current", "location");
			else link.removeAttribute("aria-current");
		}
		this.refreshMetrics_();
	}

	/** @private */
	returnToGroup_() {
		this.requestedId_ = "";
		if (this.group_) {
			const url = new URL(window.location.href);
			setViewerPath(
				url,
				this.group_,
				this.watchedId_,
				viewerLocation(url).view,
			);
			replaceViewerLocation(url);
			this.updateViewLinks_(url);
		}
		this.selectActiveRun_();
	}

	/** @private */
	async refreshMetrics_() {
		const backend = this.backend_;
		if (
			!backend ||
			!this.group_ ||
			!this.seenRuns_ ||
			(this.activeView_ !== "group" && this.activeView_ !== "tests") ||
			this.metricsInFlight_ ||
			Date.now() - this.lastMetricsRead_ < 10000
		)
			return;
		const generation = this.generation_;
		const request = ++this.metricsRequest_;
		/** @type {function():boolean} */
		const current = () =>
			generation === this.generation_ && request === this.metricsRequest_;
		this.metricsInFlight_ = true;
		this.lastMetricsRead_ = Date.now();
		try {
			const metrics = await backend.groupMetrics(this.group_, this.windowDays_);
			if (current()) this.renderMetrics_(metrics);
		} catch (_error) {
			if (current()) this.setMetricsMessage_("Could not load group metrics.");
		} finally {
			if (current()) this.metricsInFlight_ = false;
		}
	}

	/**
	 * @private
	 * @param {string} message
	 */
	setMetricsMessage_(message) {
		this.groupElement_(goog.getCssName("igroup-totals")).hidden = true;
		this.renderMetricBlankslate_(
			this.groupElement_(goog.getCssName("igroup-test-metrics")),
			message,
		);
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
		const time = (field) =>
			metrics[field] == null ? "—" : formatElapsed(Number(metrics[field]));
		this.buildSamples_ = new Map(
			/** @type {!Array<!Object<string, *>>} */ (metrics["builds"] || []).map(
				(sample) => [String(sample["invocationId"]), sample],
			),
		);
		this.renderHistory_();
		const total = count("invocationCount");
		if (!total) {
			this.setMetricsMessage_("No builds in this time range.");
			return;
		}
		const running = count("runningCount");
		const succeeded = count("succeededCount");
		const failed = count("failedCount");
		const body = this.groupElement_(goog.getCssName("igroup-build-metrics"));
		this.groupElement_(goog.getCssName("igroup-totals")).hidden = false;
		/** @type {!Array<!Array<string>>} */
		const stats = [
			["Invocations", total.toLocaleString()],
			["Running", running.toLocaleString()],
			["Succeeded", succeeded.toLocaleString()],
			["Failed", failed.toLocaleString()],
			[
				"Other outcomes",
				(total - running - succeeded - failed).toLocaleString(),
			],
			["Success rate", groupRate(succeeded, succeeded + failed)],
			["Average build time", time("averageDurationMs")],
			["Median build time", time("medianDurationMs")],
			["P95 build time", time("p95DurationMs")],
		];
		const cache = /** @type {!Object<string, *>} */ (metrics["cache"] || {});
		const hits = Number(cache["actionCacheHits"] || 0);
		const misses = Number(cache["actionCacheMisses"] || 0);
		const errors = Number(cache["actionCacheErrors"] || 0);
		if (hits + misses) {
			stats.push(
				["Action cache hit rate", groupRate(hits, hits + misses)],
				["Action cache hits", hits.toLocaleString()],
				["Action cache misses", misses.toLocaleString()],
			);
		}
		if (errors) stats.push(["Action cache errors", errors.toLocaleString()]);
		if (cache["bazelRemoteCacheHits"] != null) {
			stats.push([
				"Remote cache hits reported by Bazel",
				Number(cache["bazelRemoteCacheHits"]).toLocaleString(),
			]);
		}
		renderGroupMetricList(body, stats);
		if (metrics["tests"])
			this.renderGroupTests_(
				/** @type {!Object<string, *>} */ (metrics["tests"]),
			);
		else
			this.renderMetricBlankslate_(
				this.groupElement_(goog.getCssName("igroup-test-metrics")),
				"Group test metrics require SQLite.",
			);
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
			[
				"Failed or timed out",
				Number(tests["failedOrTimedOutCount"] || 0).toLocaleString(),
			],
		]);
		const targets = /** @type {!Array<!Object<string, *>>} */ (
			tests["flakyTargets"] || []
		);
		if (targets.length) {
			body.appendChild(
				dom.createDom("h3", "h4 mt-3", "Most frequently flaky targets"),
			);
			const list = dom.createDom("ul", "pl-3 mt-1 mb-0");
			for (const target of targets) {
				const count = Number(target["flakyCount"]).toLocaleString();
				const total = Number(target["summaryCount"]).toLocaleString();
				list.appendChild(
					dom.createDom(
						"li",
						"mb-1",
						dom.createDom("code", "bes-test-target", String(target["label"])),
						" · " + count + " of " + total + " flaky",
					),
				);
			}
			body.appendChild(list);
		} else {
			body.appendChild(
				dom.createDom(
					"p",
					"mt-3 mb-0 color-fg-muted text-small",
					"No flaky targets reported.",
				),
			);
		}
	}

	/** @private */
	selectActiveRun_() {
		const running = "INVOCATION_STATE_IN_PROGRESS";
		if (
			this.followMode_() !== "auto" ||
			this.watchedRun_?.["state"] === running
		)
			return;
		const active =
			this.activeRun_ || this.runs_.find((run) => run["state"] === running);
		// Keep a short build eligible even if it finished while another was watched.
		const nextId = active ? String(active["invocationId"]) : this.pendingRunId_;
		if (nextId) {
			this.pendingRunId_ = "";
			this.watch_(nextId);
		}
	}

	/**
	 * @private
	 * @param {string} id
	 */
	watch_(id) {
		this.requestedId_ = "";
		const url = new URL(window.location.href);
		setViewerPath(url, this.group_, id, viewerLocation(url).view);
		replaceViewerLocation(url);
		this.updateViewLinks_(url);
		if (id === this.watchedId_) return;
		this.watchedId_ = id;
		if (this.watchedRun_?.["invocationId"] !== id) {
			this.watchedRun_ =
				this.runs_.find((run) => run["invocationId"] === id) ||
				(this.activeRun_?.["invocationId"] === id ? this.activeRun_ : null) ||
				this.olderRuns_.find((run) => run["invocationId"] === id) ||
				null;
		}
		const viewer = this.showViewer_();
		/** @type {function(string, boolean, boolean):void} */
		const onStatus = (message, connected, closed) => {
			if (this.group_) return;
			this.setBackendStatus_(
				connected ? "Connected" : closed ? "Connection failed" : "Retrying",
				connected
					? "Label--success"
					: closed
						? "Label--danger"
						: "Label--attention",
				connected ? "Watching invocation " + id : message,
			);
		};
		viewer.followInvocation(this.address_, id, onStatus, (summary) => {
			if (this.group_ || this.watchedId_ !== id) return;
			this.watchedRun_ = summary;
			const index = this.runs_.findIndex((run) => run["invocationId"] === id);
			if (index !== -1) {
				this.runs_[index] = summary;
				this.renderHistory_();
			}
			this.renderGroupStatus_();
		});
	}

	/**
	 * @private
	 * @param {boolean=} upload
	 * @return {!BuildEventViewerComponent}
	 */
	showViewer_(upload = false) {
		const mount = this.groupElement_(
			upload
				? goog.getCssName("igroup-upload-viewer")
				: goog.getCssName("igroup-viewer"),
		);
		let viewer = upload ? this.uploadViewer_ : this.viewer_;
		if (!viewer) {
			viewer = new BuildEventViewerComponent(this.getDomHelper(), upload);
			this.addChild(viewer, false);
			viewer.render(mount);
			if (upload) this.uploadViewer_ = viewer;
			else this.viewer_ = viewer;
		}
		mount.classList.remove("d-none");
		return viewer;
	}

	/** @private */
	stopWatching_() {
		if (this.viewer_) this.viewer_.stopFollowing();
		this.watchedId_ = "";
		this.groupElement_(goog.getCssName("igroup-viewer")).classList.add(
			"d-none",
		);
	}

	/** @private */
	renderGroupStatus_() {
		const current = this.watchedRun_;
		const status = this.groupElement_(goog.getCssName("igroup-status"));
		status.hidden = Boolean(this.watchedId_);
		const message = current
			? ""
			: this.requestedId_
				? "Waiting for invocation " + this.requestedId_
				: this.followMode_() === "auto"
					? this.group_ + " · Waiting for the next build"
					: "Select a run from the Group tab.";
		if (status.textContent !== message) status.textContent = message;
	}

	/** @private */
	async refreshCatalog_() {
		const backend = this.backend_;
		if (!backend) return;
		try {
			const result = await backend.listGroups();
			if (backend === this.backend_)
				this.renderCatalog_(
					/** @type {!Array<!Object<string, *>>} */ (result["groups"] || []),
					"No invocation groups found.",
				);
		} catch (_error) {
			if (backend === this.backend_)
				this.renderCatalog_(
					[],
					"Group catalog is unavailable on this connection.",
				);
		}
	}

	/**
	 * @private
	 * @param {!Array<!Object<string, *>>} groups
	 * @param {string} message
	 */
	renderCatalog_(groups, message) {
		const list = this.groupElement_(goog.getCssName("igroup-list"));
		dom.removeChildren(list);
		const dates = new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "long",
		});
		for (const group of groups) {
			const name = String(group["name"]);
			const count = group["invocationCount"];
			const last = String(group["latestInvocationAt"] || "");
			const date = new Date(last);
			const time = Number.isFinite(date.getTime())
				? dom.createDom(
						"time",
						{
							"class": "bes-group-run-time color-fg-muted",
							"title": dates.format(date),
						},
						formatRelativeShort(last),
					)
				: null;
			if (time) time.setAttribute("datetime", last);
			list.appendChild(
				dom.createDom(
					"tr",
					null,
					dom.createDom(
						"td",
						null,
						dom.createDom(
							"button",
							{
								"type": "button",
								"class": "btn-link",
								"data-group-name": name,
							},
							name,
						),
					),
					dom.createDom(
						"td",
						"bes-group-catalog-count",
						count == null ? "—" : Number(count).toLocaleString(),
					),
					dom.createDom("td", null, time || "—"),
				),
			);
		}
		/** @type {!HTMLTableElement} */ (list.closest("table")).hidden =
			!groups.length;
		const status = this.groupElement_(goog.getCssName("igroup-catalog-status"));
		status.textContent = message;
		status.hidden = Boolean(groups.length);
	}

	/** @private @param {!Object<string, *>} result */
	setRunPage_(result) {
		const runs = /** @type {!Array<!Object<string, *>>} */ (
			result["invocations"] || []
		);
		if (this.historyExpanded_) {
			const currentIds = new Set(
				runs.map((run) => String(run["invocationId"])),
			);
			this.olderRuns_ = this.runs_
				.concat(this.olderRuns_)
				.filter(
					(/** !Object<string, *> */ run) =>
						!currentIds.has(String(run["invocationId"])),
				);
		} else {
			this.nextPage_ = String(result["nextPageToken"] || "");
		}
		this.runs_ = runs;
		this.activeRun_ = /** @type {?Object<string, *>} */ (
			result["activeInvocation"] || null
		);
	}

	/** @private */
	async loadOlderRuns_() {
		const backend = this.backend_;
		if (!backend || !this.nextPage_ || this.pageInFlight_) return;
		const generation = this.generation_;
		const button = /** @type {!HTMLButtonElement} */ (
			this.groupElement_(goog.getCssName("igroup-older-runs"))
		);
		const message = this.groupElement_(goog.getCssName("igroup-page-status"));
		this.historyExpanded_ = true;
		this.pageInFlight_ = true;
		button.disabled = true;
		message.textContent = "Loading older runs…";
		try {
			const result = this.group_
				? await backend.listGroup(this.group_, this.nextPage_)
				: await backend.list(this.nextPage_);
			if (generation !== this.generation_) return;
			const rows = /** @type {!Array<!Object<string, *>>} */ (
				result["invocations"] || []
			);
			const seen = new Set(
				this.runs_
					.concat(this.olderRuns_)
					.map((/** !Object<string, *> */ run) => String(run["invocationId"])),
			);
			this.olderRuns_.push(
				...rows.filter((run) => !seen.has(String(run["invocationId"]))),
			);
			this.nextPage_ = String(result["nextPageToken"] || "");
			this.renderHistory_();
			message.textContent = this.nextPage_ ? "" : "All runs loaded.";
		} catch (_error) {
			if (generation === this.generation_)
				message.textContent = "Could not load older runs.";
		} finally {
			if (generation === this.generation_) {
				this.pageInFlight_ = false;
				button.disabled = false;
			}
		}
	}

	/** @private */
	renderHistory_() {
		this.groupElement_(goog.getCssName("igroup-older-runs")).hidden =
			!this.nextPage_;
		const runs = /** @type {!Array<!Object<string, *>>} */ (
			this.runs_.concat(this.olderRuns_)
		);
		/** @type {!Array<!InvocationRow>} */
		const rows = runs.map((run) => {
			const id = String(run["invocationId"]);
			const command = [
				"bazel",
				run["command"],
				.../** @type {!Array<string>} */ (run["targetPatterns"] || []),
			]
				.filter(Boolean)
				.join(" ");
			const result = storedExitStatus(run);
			const status =
				run["state"] === COLLECTION_INCOMPLETE
					? incompleteStatus(result)
					: result ||
						(run["state"] === "INVOCATION_STATE_IN_PROGRESS"
							? invocationStatus("Running", "running")
							: invocationStatus("Finished", "neutral"));
			const last =
				run["state"] === COLLECTION_INCOMPLETE ? run["lastEventAt"] : null;
			const time = String(
				run["finishedAt"] || last || run["startedAt"] || run["createdAt"] || "",
			);
			const timeLabel = run["finishedAt"]
				? "Finished"
				: last
					? "Last event"
					: run["startedAt"]
						? "Started"
						: "Recorded";
			const started = Date.parse(
				String(run["startedAt"] || run["createdAt"] || time),
			);
			const recorded = Date.parse(
				String(run["createdAt"] || run["startedAt"] || time),
			);
			return {
				id,
				command,
				status,
				time,
				timeLabel,
				started,
				recorded,
			};
		});
		const cutoff = Date.now() - this.windowDays_ * 86400000;
		const recent = rows.filter(
			(row) => !Number.isFinite(row.recorded) || row.recorded >= cutoff,
		);
		this.updateRunFilterOptions_(recent);
		const id = this.input_(goog.getCssName("igroup-id-filter"))
			.value.trim()
			.toLowerCase();
		const command = this.input_(goog.getCssName("igroup-command-filter"))
			.value.trim()
			.toLowerCase();
		const visible = recent.filter(
			(row) =>
				this.statusFilter_.has(row.status.label) &&
				row.id.toLowerCase().startsWith(id) &&
				row.command.toLowerCase().includes(command),
		);
		visible.sort(
			(a, b) => (b.started || 0) - (a.started || 0) || a.id.localeCompare(b.id),
		);
		const metricIndex = Number(
			/** @type {!HTMLSelectElement} */ (
				this.groupElement_(goog.getCssName("igroup-metric"))
			).value,
		);
		const metric = METRICS[metricIndex];
		const metricHeading = this.groupElement_(
			goog.getCssName("igroup-metric-heading"),
		);
		if (metricHeading.textContent !== metric.label) {
			metricHeading.textContent = metric.label;
			metricHeading.title = metric.label;
		}
		const bin = Number(
			/** @type {!HTMLSelectElement} */ (
				this.groupElement_(goog.getCssName("igroup-binning"))
			).value,
		);
		/** @type {!Array<?number>} */
		const values = visible.map((row) =>
			metricValue(this.buildSamples_.get(row.id) || null, metric),
		);
		const key = JSON.stringify([visible, metricIndex, bin, values]);
		const empty = this.groupElement_(goog.getCssName("igroup-runs-empty"));
		empty.hidden = Boolean(visible.length);
		empty.textContent = !this.backend_
			? "Connect to a backend and choose a group to see its runs."
			: rows.length
				? "No loaded invocations match these filters."
				: "No invocations yet.";
		if (key === this.historyKey_) return;
		this.historyKey_ = key;
		const list = this.groupElement_(goog.getCssName("igroup-runs"));
		this.renderInvocationRows_(list, visible);
		let maximum = 0;
		for (const value of values) maximum = Math.max(maximum, value ?? 0);
		/** @type {!Map<number, {first: !Element, sum: number, count: number}>} */
		const buckets = new Map();
		for (let index = 0; index < visible.length; index++) {
			const element = /** @type {!HTMLElement} */ (list.children[index]);
			const row = visible[index];
			const value = values[index];
			if (value !== null) {
				element.style.setProperty(
					"--bes-metric-width",
					(maximum ? (100 * value) / maximum : 0) + "%",
				);
				const label = metricLabel(value, metric);
				element.lastElementChild.appendChild(
					dom.createDom(
						"span",
						{
							"class": "bes-group-run-value",
							"title": metric.label + ": " + label,
						},
						label,
					),
				);
			}
			if (!bin) continue;
			const start = Math.floor((row.started || 0) / bin) * bin;
			let bucket = buckets.get(start);
			if (!bucket) {
				bucket = { first: element, sum: 0, count: 0 };
				buckets.set(start, bucket);
			}
			if (value !== null) {
				bucket.sum += value;
				bucket.count++;
			}
		}
		buckets.forEach(({ first, sum, count }, start) => {
			const date = start
				? new Intl.DateTimeFormat(undefined, {
						timeZone: "UTC",
						dateStyle: "medium",
						timeStyle: bin === 3600000 ? "short" : undefined,
					}).format(start) + " UTC"
				: "Unknown time";
			list.insertBefore(
				dom.createDom(
					"tr",
					"bes-group-bin",
					dom.createDom(
						"th",
						{ "colspan": "5" },
						dom.createDom("span", null, date),
						count
							? dom.createDom(
									"span",
									"color-fg-muted",
									"Average " + metricLabel(sum / count, metric),
								)
							: null,
					),
				),
				first,
			);
		});
	}

	/** @private @param {!Array<!InvocationRow>} rows */
	updateRunFilterOptions_(rows) {
		/** @type {!Map<string, !InvocationStatus>} */
		const statuses = new Map();
		statuses.set("SUCCESS", invocationStatus("SUCCESS", "success"));
		for (const row of rows) statuses.set(row.status.label, row.status);
		/** @type {!Set<string>} */
		const uniqueCommands = new Set(rows.map((row) => row.command));
		/** @type {!Array<string>} */
		const commands = Array.from(uniqueCommands);
		commands.sort();
		const key = JSON.stringify([Array.from(statuses.keys()).sort(), commands]);
		if (key === this.filterOptionsKey_) return;
		this.filterOptionsKey_ = key;
		const field = this.groupElement_(goog.getCssName("igroup-status-options"));
		const active = document.activeElement;
		dom.removeChildren(field);
		statuses.forEach((status, label) => {
			const input = /** @type {!HTMLInputElement} */ (
				dom.createDom("input", { type: "checkbox", value: label })
			);
			input.checked = this.statusFilter_.has(label);
			field.appendChild(
				dom.createDom(
					"label",
					null,
					input,
					dom.createDom("span", status.color, label),
				),
			);
			if (
				active instanceof HTMLInputElement &&
				active.value === label &&
				!active.isConnected
			)
				/** @type {!HTMLElement} */ (input).focus({ preventScroll: true });
		});
		const options = this.getElementStrict().querySelector(
			"#igroup-command-options",
		);
		dom.removeChildren(options);
		for (const command of commands)
			options.appendChild(dom.createDom("option", { value: command }));
	}

	/** @private */
	refreshRelativeTimes_() {
		const list = this.groupElement_(
			this.activeView_ === "groups"
				? goog.getCssName("igroup-list")
				: goog.getCssName("igroup-runs"),
		);
		for (const time of list.querySelectorAll("time[datetime]")) {
			const label = formatRelativeShort(time.getAttribute("datetime") || "");
			if (time.textContent !== label) time.textContent = label;
		}
	}

	/**
	 * @private
	 * @param {!HTMLElement} list
	 * @param {!Array<!InvocationRow>} rows
	 */
	renderInvocationRows_(list, rows) {
		const focused = document.activeElement?.getAttribute("data-invocation-id");
		dom.removeChildren(list);
		const dates = new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "long",
		});
		for (const row of rows) {
			const command = dom.createDom(
				"code",
				{ "class": "bes-group-run-command", "title": row.command },
				row.command,
			);
			const date = new Date(row.time);
			const timestamp =
				row.time && Number.isFinite(date.getTime())
					? row.timeLabel + " " + dates.format(date)
					: "";
			const time = timestamp
				? dom.createDom(
						"time",
						{
							"class": "bes-group-run-time color-fg-muted",
							"title": timestamp,
						},
						formatRelativeShort(row.time),
					)
				: null;
			if (time) time.setAttribute("datetime", row.time);
			const button = dom.createDom(
				"button",
				{
					"type": "button",
					"class": "btn-link text-mono text-small bes-group-run-id",
					"data-invocation-id": row.id,
					"title": row.id,
				},
				row.id,
			);
			list.appendChild(
				dom.createDom(
					"tr",
					{
						"class": "bes-group-run",
						"data-invocation-id": row.id,
						"data-outcome": row.status.kind,
					},
					dom.createDom("td", null, renderInvocationStatusIcon(row.status)),
					dom.createDom("td", null, button),
					dom.createDom("td", null, command),
					dom.createDom("td", null, time),
					dom.createDom("td", "bes-group-run-stat"),
				),
			);
			if (focused === row.id)
				/** @type {!HTMLElement} */ (button).focus({ preventScroll: true });
		}
	}

	/** @private @param {!File} file */
	async loadUpload_(file) {
		const generation = ++this.uploadGeneration_;
		if (this.activeView_ !== "upload") this.navigateView_("upload");
		const status = this.groupElement_(goog.getCssName("igroup-upload-status"));
		status.hidden = false;
		status.classList.remove("color-fg-danger");
		if (file.size > MAX_FILE_BYTES) {
			status.textContent =
				"The file exceeds the " + formatBytes(MAX_FILE_BYTES) + " limit.";
			status.classList.add("color-fg-danger");
			return;
		}
		status.textContent = "Reading " + file.name + "…";
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (generation !== this.uploadGeneration_) return;
			const fileEvents = /** @type {!Array<!BuildEvent>} */ (
				decodeDelimitedMessages(bytes, (message) =>
					BuildEvent.deserializeBinary(message),
				)
			);
			if (!fileEvents.length) throw new Error("Empty build event file.");
			const suffix = crypto.getRandomValues(new Uint32Array(2));
			const id =
				"file-" +
				suffix[0].toString(16).padStart(8, "0") +
				suffix[1].toString(16).padStart(8, "0");
			const invocation = new InvocationProgress(id, {
				name: file.name,
				size: file.size,
				uploadedAt: Date.now(),
			});
			for (const event of fileEvents) invocation.add(event);
			this.showViewer_(true).showReplay(invocation);
			status.textContent = "Loaded " + file.name + ".";
		} catch (_error) {
			if (generation !== this.uploadGeneration_) return;
			status.textContent =
				"Could not read this build event file. It may be truncated or invalid.";
			status.classList.add("color-fg-danger");
		}
	}

	/**
	 * @private
	 * @param {string} cssName
	 * @return {!HTMLElement}
	 */
	groupElement_(cssName) {
		return /** @type {!HTMLElement} */ (
			this.getElementStrict().querySelector("." + cssName)
		);
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

exports.InvocationGroupsComponent = InvocationGroupsComponent;
