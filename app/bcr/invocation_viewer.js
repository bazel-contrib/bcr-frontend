/** @fileoverview Display live or recorded Bazel invocations. */
goog.module("bcrfrontend.invocationViewer");

const BuildEvent = goog.require("proto.build_event_stream.BuildEvent");
const BuildMetrics = goog.require("proto.build_event_stream.BuildMetrics");
const BuildToolLogs = goog.require("proto.build_event_stream.BuildToolLogs");
const EventHandler = goog.requireType("goog.events.EventHandler");
const base64 = goog.require("goog.crypt.base64");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const {
	COLLECTION_COMPLETE,
	COLLECTION_INCOMPLETE,
	FrontierMark,
	InvocationFailure,
	InvocationProgress,
	eventOutcome,
	eventTimestampMillis,
	fileSummary,
	invocationFailure,
	payloadCaseName,
	testStatusName,
} = goog.require("bcrfrontend.invocationEvents");
const { Component } = goog.require("stack.ui");
const {
	FrontierActionReaders,
	InvocationFrontier,
	expectedFrontierLabel,
	formatFrontierWait,
	frontierMarkLabel,
	frontierWait,
} = goog.require("bcrfrontend.invocationFrontier");
const { InvocationBackend, openInvocationBackend } = goog.require(
	"bcrfrontend.invocationTransport",
);
const { InvocationTerminal, formatTerminalText, renderTerminalText } =
	goog.require("bcrfrontend.invocationTerminal");
const {
	InvocationTest,
	appendTableHeader,
	createBuildMetricsDetail,
	createBuildStatCards,
	createCriticalPathDetail,
	criticalPathMillis,
	groupInvocationTests,
	testStatusLabel,
} = goog.require("bcrfrontend.invocationMetrics");
const { createSelectedEventDetail } = goog.require(
	"bcrfrontend.invocationEventDetails",
);
const { eventStatusIcon, invocationViewer } = goog.require(
	"soy.bcrfrontend.tools",
);
const { formatBytes, formatDuration, formatElapsed, summaryTime } =
	goog.require("bcrfrontend.invocationFormat");
const { getApplication } = goog.require("bcrfrontend.common");
const {
	incompleteStatus,
	invocationStatus,
	renderInvocationStatusIcon,
	replayResultStatus,
	storedExitStatus,
} = goog.require("bcrfrontend.invocationStatus");

const CSS_RESULTS = goog.getCssName("results");

const CSS_SUMMARY = goog.getCssName("summary");

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
		handler.listen(
			button,
			events.EventType.KEYDOWN,
			(/** !events.BrowserEvent */ e) => {
				const key = e.key;
				let next;
				switch (key) {
					case "ArrowLeft":
						next = (index + buttons.length - 1) % buttons.length;
						break;
					case "ArrowRight":
						next = (index + 1) % buttons.length;
						break;
					case "Home":
						next = 0;
						break;
					case "End":
						next = buttons.length - 1;
						break;
					default:
						return;
				}
				e.preventDefault();
				select(next);
				buttons[next].focus();
			},
		);
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

class BuildEventViewerComponent extends Component {
	/** @param {?dom.DomHelper=} opt_domHelper */
	constructor(opt_domHelper) {
		super(opt_domHelper);
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
		/** @private @type {?function(!Object<string, *>):void} */
		this.onSummary_ = null;

		/** @private @type {?number} */
		this.clockStoppedAt_ = null;
		/** @private @type {boolean} */
		this.connected_ = false;
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
		this.setElementInternal(soy.renderAsElement(invocationViewer));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		this.bindTabs_();
		this.bindFrontier_();
	}

	/**
	 * @param {string} address
	 * @param {string} id
	 * @param {function(string, boolean, boolean):void} onStatus
	 * @param {function(!Object<string, *>):void} onSummary
	 */
	async followInvocation(address, id, onStatus, onSummary) {
		this.stopBackend_();
		const generation = this.loadGeneration_;
		this.progress_ = new InvocationProgress(id);
		this.clockStoppedAt_ = null;
		this.resetResults_();
		this.lastCursor_ = "0";
		this.renderSummary_();
		try {
			const source = await openInvocationBackend(address);
			if (generation !== this.loadGeneration_) {
				source.close();
				return;
			}
			this.source_ = source;
			this.onSummary_ = onSummary;
			this.cacheTimer_ = setInterval(
				() => this.refreshCacheStats_(source, id),
				1500,
			);
			void this.refreshCacheStats_(source, id);
			source.watch(
				id,
				() => this.lastCursor_,
				(
					/** string */ cursor,
					/** string */ data,
					/** number= */ receivedAt,
					/** number= */ sentAt,
				) => {
					if (generation === this.loadGeneration_)
						this.receiveBuildEvent_(
							source,
							id,
							cursor,
							data,
							receivedAt || 0,
							sentAt || 0,
							onStatus,
						);
				},
				(
					/** string */ message,
					/** boolean */ connected,
					/** boolean= */ closed,
				) => {
					if (generation !== this.loadGeneration_) return;
					if (closed) {
						this.disconnectBackend_();
					} else {
						this.connected_ = connected;
						this.clockStoppedAt_ = connected
							? null
							: (this.clockStoppedAt_ ?? Date.now());
						this.renderSummary_();
					}
					onStatus(message, connected, Boolean(closed));
				},
			);
		} catch (_error) {
			if (generation !== this.loadGeneration_) return;
			this.stopBackend_();
			const message =
				"Could not open invocation " +
				id +
				". Check the backend URL or Iroh viewer ticket.";
			this.getElement_(CSS_SUMMARY).appendChild(
				dom.createDom(
					"p",
					{ "class": "color-fg-danger", "role": "alert" },
					message,
				),
			);
			onStatus(message, false, true);
		}
	}

	stopFollowing() {
		this.terminal_?.clearHighlight();
		this.stopBackend_();
	}

	/**
	 * @private
	 * @param {!InvocationBackend} source
	 * @param {string} id
	 * @param {string} cursor
	 * @param {string} data
	 * @param {number} receivedAt
	 * @param {number} sentAt
	 * @param {function(string, boolean, boolean):void} onStatus
	 */
	receiveBuildEvent_(source, id, cursor, data, receivedAt, sentAt, onStatus) {
		const last = this.lastCursor_;
		if (
			!/^[1-9][0-9]*$/.test(cursor) ||
			cursor.length < last.length ||
			(cursor.length === last.length && cursor <= last)
		)
			return;
		try {
			const bytes = base64.decodeStringToUint8Array(data);
			const event = BuildEvent.deserializeBinary(bytes);
			this.lastCursor_ = cursor;
			const arrival =
				receivedAt > 0 && Number.isFinite(receivedAt)
					? receivedAt
					: this.progress_.frontierNow();
			this.progress_.add(event, arrival, sentAt);
			if (event.getLastMessage()) {
				this.refreshCacheStats_(source, id, true);
			}
			if (!this.renderTimer_) {
				this.renderTimer_ = setTimeout(() => {
					this.renderTimer_ = 0;
					this.renderResults_();
				}, 250);
			}
		} catch (_error) {
			this.disconnectBackend_();
			onStatus("Could not decode a backend build event.", false, true);
		}
	}

	/** @private */
	disconnectBackend_() {
		const renderPending = this.renderTimer_ !== 0;
		this.stopBackend_();
		if (renderPending) this.renderResults_();
		else this.renderSummary_();
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
		this.onSummary_ = null;
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

	/** @param {!InvocationProgress} invocation */
	showReplay(invocation) {
		this.stopBackend_();
		this.resetResults_();
		this.progress_ = invocation;
		this.renderResults_();
	}

	/** @private */
	bindTabs_() {
		const tabs = this.getElement_(goog.getCssName("bes-tabs"));
		this.terminal_ = new InvocationTerminal(
			this.getElement_(goog.getCssName("bes-log-full")),
		);
		bindViewerTabs(this.getHandler(), tabs, (index) => this.selectTab_(index));
		this.getHandler().listen(
			this.getElement_(goog.getCssName("bes-download-log")),
			events.EventType.CLICK,
			() => this.downloadLog_(),
		);
		const search = this.getElement_(goog.getCssName("bes-log-search"));
		this.getHandler().listen(search, "input", () => this.searchTerminal_());
		this.getHandler().listen(
			search,
			"keydown",
			(/** !events.BrowserEvent */ event) => {
				event.stopPropagation();
				if (event.key !== "Enter") return;
				event.preventDefault();
				this.searchTerminal_(event.shiftKey ? -1 : 1);
			},
		);
	}

	/**
	 * @private
	 * @param {number=} direction
	 * @param {boolean=} reveal
	 */
	searchTerminal_(direction = 0, reveal = true) {
		if (!this.terminal_) return;
		const input = /** @type {!HTMLInputElement} */ (
			this.getElement_(goog.getCssName("bes-log-search"))
		);
		const result = this.getElement_(goog.getCssName("bes-log-search-result"));
		const message = this.terminal_.search(input.value, direction, reveal);
		if (result.textContent !== message) result.textContent = message;
	}

	/**
	 * @private
	 * @param {number} index
	 * @param {boolean=} skipRender
	 */
	selectTab_(index, skipRender = false) {
		if (this.activeTab_ === 1 && index !== 1) this.terminal_?.clearHighlight();
		this.activeTab_ = index;
		showViewerTab(
			this.getElement_(goog.getCssName("bes-tabs")),
			this.getElement_(CSS_RESULTS),
			index,
		);
		if (!skipRender) {
			this.renderTab_();
			if (index === 1) this.searchTerminal_(0, false);
		}
	}

	/** @private */
	downloadLog_() {
		const chunks = this.progress_.logChunks;
		if (!chunks.length) return;
		const blob = new Blob(chunks, { type: "text/plain;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download =
			(this.progress_.file?.name || this.progress_.sourceId) + ".log";
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
				if (this.terminal_?.update(this.progress_.logChunks))
					this.searchTerminal_(0, false);
				/** @type {!HTMLButtonElement} */ (
					this.getElement_(goog.getCssName("bes-download-log"))
				).disabled = this.progress_.logChunks.length === 0;
				break;
			case 2:
				this.renderTests_();
				break;
			case 3:
				this.renderMetrics_();
				this.renderCacheStats_();
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
		const frontier = new InvocationFrontier(
			canvas,
			scroll,
			spacer,
			readers,
			(mark) => this.inspectFrontierMark_(mark),
		);
		this.frontier_ = frontier;
		if (this.progress_.history.length) frontier.update(this.progress_);
		this.frontierObserver_ = new ResizeObserver(() => frontier.draw());
		this.frontierObserver_.observe(scroll);
		this.getHandler().listen(scroll, events.EventType.SCROLL, () =>
			frontier.draw(),
		);
		this.getHandler().listen(
			canvas,
			events.EventType.CLICK,
			(/** !events.BrowserEvent */ e) => {
				const mark = frontier.pick(
					/** @type {!MouseEvent} */ (e.getBrowserEvent()),
				);
				if (mark) frontier.select(mark);
			},
		);
		this.getHandler().listen(
			canvas,
			events.EventType.MOUSEMOVE,
			(/** !events.BrowserEvent */ e) => {
				const mark = frontier.pick(
					/** @type {!MouseEvent} */ (e.getBrowserEvent()),
				);
				canvas.title = mark ? frontierMarkLabel(mark) : "";
			},
		);
		this.getHandler().listen(
			canvas,
			events.EventType.KEYDOWN,
			(/** !events.BrowserEvent */ e) =>
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
		this.getElement_(goog.getCssName("bes-tabs")).classList.add("d-none");
		this.getElement_(goog.getCssName("bes-log-body")).hidden = true;
		this.selectTab_(0, true);
		const stats = this.getElement_(goog.getCssName("bes-build-stats"));
		dom.removeChildren(stats);
		stats.hidden = true;
		if (this.terminal_) this.terminal_.reset();
		/** @type {!HTMLInputElement} */ (
			this.getElement_(goog.getCssName("bes-log-search"))
		).value = "";
		this.getElement_(goog.getCssName("bes-log-search-result")).textContent = "";
		dom.removeChildren(this.getElement_(goog.getCssName("bes-critical-path")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-tests")));
		dom.removeChildren(this.getElement_(goog.getCssName("bes-metrics")));
		dom.removeChildren(
			this.getElement_(goog.getCssName("bes-frontier-detail")),
		);
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
			? mark === this.progress_.last
				? "Final event"
				: "Received"
			: this.progress_.collectionEnded()
				? "Unreceived"
				: "Expected";
		const parents = mark.parents.length;
		const children = mark.children.length;
		const text =
			state +
			" · " +
			label +
			" · " +
			parents +
			(parents === 1 ? " parent" : " parents") +
			" · " +
			children +
			(children === 1 ? " child" : " children");
		if (caption.textContent !== text) caption.textContent = text;
		const timer = this.getElement_(goog.getCssName("bes-frontier-wait"));
		const wait = mark.event
			? null
			: frontierWait(mark, this.progress_.frontierNow());
		timer.hidden = wait === null;
		if (wait !== null) {
			timer.textContent =
				(this.progress_.collectionEnded() ? "Waited " : "Waiting ") +
				formatFrontierWait(wait);
			timer.setAttribute("datetime", "PT" + wait + "S");
		}
		if (this.inspected_ === mark && this.inspectedEvent_ === mark.event) return;
		this.inspected_ = mark;
		this.inspectedEvent_ = mark.event;
		this.getElement_(goog.getCssName("bes-frontier-type")).hidden = false;
		const swatch = this.getElement_(goog.getCssName("bes-frontier-swatch"));
		swatch.style.backgroundColor = mark.color;
		swatch.classList.toggle("is-action", Boolean(mark.event?.getAction()));
		this.getElement_(goog.getCssName("bes-frontier-type-name")).textContent =
			mark.event
				? payloadCaseName(mark.event.getPayloadCase())
				: expectedFrontierLabel(mark.id).type;
		const outcome = this.getElement_(goog.getCssName("bes-frontier-outcome"));
		dom.removeChildren(outcome);
		const success = mark.event && eventOutcome(mark.event);
		if (success !== null)
			outcome.appendChild(soy.renderAsElement(eventStatusIcon, { success }));
		const detail = this.getElement_(goog.getCssName("bes-frontier-detail"));
		dom.removeChildren(detail);
		if (mark.event) {
			detail.appendChild(
				createSelectedEventDetail(mark.event, () =>
					getApplication(this).getBazelFlagDb(),
				),
			);
		}
	}

	/** @private */
	renderResults_() {
		this.renderSummary_();
		this.getElement_(CSS_RESULTS).classList.remove("d-none");
		this.getElement_(goog.getCssName("bes-tabs")).classList.remove("d-none");
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
			const atBottom =
				terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 8;
			dom.removeChildren(terminal);
			terminal.appendChild(
				renderTerminalText(
					formatTerminalText(log || "No build output received."),
				),
			);
			if (atBottom || this.renderedLog_ === null)
				terminal.scrollTop = terminal.scrollHeight;
			this.renderedLog_ = log;
		}
		this.getElement_(goog.getCssName("bes-log-limit")).hidden =
			!this.progress_.logTruncated;
	}

	/** @private */
	renderOverview_() {
		this.renderInlineLog_();
		this.renderStatCards_();
		this.renderOverviewCriticalPath_();
		const pending = this.frontier_ ? this.frontier_.update(this.progress_) : 0;
		const received = this.progress_.history.length + " received";
		this.getElement_(goog.getCssName("bes-frontier-count")).textContent =
			this.progress_.collectionEnded()
				? "Stream ended · " +
					(pending ? pending + " unreceived · " : "") +
					received
				: pending + " expected · " + received;
		this.renderMnemonicBreakdown_();
	}

	/** @private */
	renderMnemonicBreakdown_() {
		const key =
			this.progress_.receivedActions + "/" + this.progress_.collectionEnded();
		if (key === this.mnemonicRenderKey_) return;
		this.mnemonicRenderKey_ = key;
		const body = this.getElement_(goog.getCssName("bes-frontier-mnemonics"));
		dom.removeChildren(body);
		const counts = this.progress_.mnemonics;
		if (!counts.size) {
			body.appendChild(
				dom.createDom(
					"p",
					"color-fg-muted text-small mb-0",
					this.progress_.collectionEnded()
						? "No action events received."
						: "Waiting for action events.",
				),
			);
			return;
		}
		const list = dom.createDom("ul", "bes-mnemonic-counts");
		/** @type {!Array<string>} */
		const names = Array.from(counts.keys());
		names.sort(
			(a, b) =>
				(counts.get(b)?.count || 0) - (counts.get(a)?.count || 0) ||
				a.localeCompare(b),
		);
		for (const name of names) {
			const tally = counts.get(name);
			if (!tally) continue;
			const swatch = document.createElement("span");
			swatch.className = "bes-mnemonic-swatch";
			swatch.style.backgroundColor = tally.color;
			swatch.setAttribute("aria-hidden", "true");
			list.appendChild(
				dom.createDom(
					"li",
					null,
					swatch,
					dom.createDom("code", null, name || "Unspecified"),
					dom.createDom("span", "text-bold", tally.count.toLocaleString()),
				),
			);
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
			const previous = this.cacheSummary_;
			this.cacheSummary_ = summary;
			const state = String(summary["state"] || "");
			const ended =
				state === COLLECTION_COMPLETE || state === COLLECTION_INCOMPLETE;
			const endedAt = ended ? summaryTime(summary, "lastEventAt") : null;
			const changed =
				state !== this.progress_.collectionState ||
				endedAt !== this.progress_.collectionEndedAt ||
				JSON.stringify(previous?.["result"] || null) !==
					JSON.stringify(summary["result"] || null);
			this.progress_.collectionState = state;
			this.progress_.collectionEndedAt = endedAt;
			if (ended && this.activeTab_ !== 0) this.frontier_?.stopClock();
			if (state === COLLECTION_COMPLETE) {
				clearInterval(this.cacheTimer_);
				this.cacheTimer_ = 0;
			}
			if (changed) {
				this.onSummary_?.(summary);
				if (this.progress_.history.length) this.renderResults_();
				else this.renderSummary_();
			}
			if (this.activeTab_ === 3 && this.progress_.history.length)
				this.renderCacheStats_();
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
		const hits =
			stored != null ? Number(stored) : this.progress_.bazelRemoteCacheHits;
		const telemetry = /** @type {?Object<string, *>} */ (
			summary && summary["remoteCache"]
		);
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
			traffic.set(
				operation,
				(traffic.get(operation) || 0) + Number(row["transferredBytes"] || 0),
			);
		}
		/** @type {!Array<!Array<string>>} */
		const entries = [];
		entries.push([
			"Remote hits reported by Bazel",
			hits === null
				? this.source_ && !this.progress_.collectionEnded()
					? "Awaiting build metrics"
					: "Unavailable"
				: hits.toLocaleString(),
		]);
		const lookup = counts.get("ac_lookup");
		if (lookup) {
			const found = lookup.get("hit") || 0;
			const missing = lookup.get("miss") || 0;
			const total = found + missing;
			const rate = total
				? ((100 * found) / total).toFixed(1) + "% hit rate · "
				: "";
			entries.push([
				"Action cache lookups",
				rate +
					found.toLocaleString() +
					" hits · " +
					missing.toLocaleString() +
					" misses · " +
					(lookup.get("error") || 0).toLocaleString() +
					" errors",
			]);
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
			const parts = [
				(results.get(entry[2]) || 0).toLocaleString() + " " + entry[3],
			];
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
		const ended =
			!!this.progress_.finished ||
			this.progress_.collectionEnded() ||
			!!this.progress_.file;
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
			body.appendChild(
				this.dataTabMessage_(
					ended
						? "No test results were reported."
						: "Waiting for test results…",
				),
			);
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
			const description = status
				? testStatusName(status).toLowerCase()
				: ended
					? "without summary"
					: "awaiting summary";
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
		groups.sort(
			(a, b) =>
				order(a) - order(b) ||
				a.label.localeCompare(b.label) ||
				a.configuration.localeCompare(b.configuration),
		);
		for (const group of groups) {
			body.appendChild(
				this.createTestGroup_(group, ended, open.has(group.key)),
			);
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
		const details = /** @type {!HTMLDetailsElement} */ (
			document.createElement("details")
		);
		details.className = "bes-data-details";
		details.open = open;
		details.setAttribute("data-test-key", group.key);
		const payload = group.summary && group.summary.getTestSummary();
		const summary = document.createElement("summary");
		const badge = testStatusLabel(
			payload ? payload.getOverallStatus() : 0,
			ended ? "Summary unavailable" : "Awaiting summary",
		);
		badge.classList.add("mr-2");
		const name = document.createElement("span");
		name.className = "bes-test-target text-bold";
		name.textContent = group.label || "Unnamed test";
		summary.append(badge, name);
		const duration = payload && payload.getTotalRunDuration();
		const meta = document.createElement("span");
		meta.className = "ml-2 text-small color-fg-muted";
		const attemptCount = payload
			? payload.getTotalRunCount() || group.attempts.length
			: group.attempts.length;
		const parts = [
			attemptCount + (attemptCount === 1 ? " attempt" : " attempts"),
		];
		if (duration)
			parts.push(formatDuration(duration.getSeconds(), duration.getNanos()));
		if (group.configuration)
			parts.push("Config " + group.configuration.slice(0, 8));
		meta.textContent = parts.join(" · ");
		meta.title = group.configuration;
		summary.appendChild(meta);
		details.appendChild(summary);

		const body = document.createElement("div");
		body.className = "overflow-auto pb-2";
		details.appendChild(body);
		if (!group.attempts.length) {
			body.textContent = "No individual test attempts were reported.";
			return details;
		}
		const table = /** @type {!HTMLTableElement} */ (
			document.createElement("table")
		);
		table.className = "bes-test-attempts text-small";
		appendTableHeader(table, [
			"Run / shard / attempt",
			"Result",
			"Duration",
			"Execution",
			"Details",
		]);
		const rows = /** @type {!HTMLTableSectionElement} */ (table.createTBody());
		for (const event of group.attempts) {
			const id = event.getId();
			const attempt = id && id.getTestResult();
			const result = event.getTestResult();
			if (!attempt || !result) continue;
			const row = /** @type {!HTMLTableRowElement} */ (rows.insertRow());
			const ordinal = row.insertCell(-1);
			ordinal.className = "text-mono";
			ordinal.textContent = [
				attempt.getRun(),
				attempt.getShard(),
				attempt.getAttempt(),
			].join(" / ");
			row.insertCell(-1).appendChild(testStatusLabel(result.getStatus()));
			const elapsed = result.getTestAttemptDuration();
			const legacyMillis = Number(result.getTestAttemptDurationMillis());
			row.insertCell(-1).textContent = elapsed
				? formatDuration(elapsed.getSeconds(), elapsed.getNanos())
				: legacyMillis
					? formatElapsed(legacyMillis)
					: "—";
			const execution = result.getExecutionInfo();
			row.insertCell(-1).textContent = result.getCachedLocally()
				? "Local cache"
				: execution && execution.getCachedRemotely()
					? "Remote cache"
					: (execution && execution.getStrategy()) || "—";
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
		empty.className = "color-fg-muted";
		empty.textContent = message;
		return empty;
	}

	/** @private */
	renderMetrics_() {
		const body = this.getElement_(goog.getCssName("bes-metrics"));
		const metrics = this.progress_.metrics;
		if (!metrics) {
			const ended =
				this.progress_.finished ||
				this.progress_.collectionEnded() ||
				this.progress_.file;
			const message = ended
				? "No build metrics were reported."
				: "Waiting for build metrics…";
			if (body.textContent !== message) {
				dom.removeChildren(body);
				body.appendChild(this.dataTabMessage_(message));
			}
			return;
		}
		if (metrics === this.renderedMetrics_) return;
		this.renderedMetrics_ = metrics;
		dom.removeChildren(body);
		body.appendChild(createBuildMetricsDetail(metrics, false));
	}

	/** @private */
	renderOverviewCriticalPath_() {
		const logs = this.progress_.toolLogs;
		const duration = criticalPathMillis(this.progress_.metrics);
		const ended = this.progress_.finished || this.progress_.collectionEnded();
		if (!ended && !this.progress_.file) return;
		if (this.renderedPathLogs_ === logs && this.renderedPathTime_ === duration)
			return;
		this.renderedPathLogs_ = logs;
		this.renderedPathTime_ = duration;
		const root = this.getElement_(goog.getCssName("bes-critical-path"));
		dom.removeChildren(root);
		const path = createCriticalPathDetail(logs, duration);
		if (path) root.appendChild(path);
	}

	/** @private */
	renderSummary_() {
		const id = this.progress_.invocationId();
		if (!id) return;
		const section = this.getElement_(CSS_SUMMARY);
		const restoreCommandFocus = this.commandToggle_ === document.activeElement;
		if (this.commandObserver_) this.commandObserver_.disconnect();
		dom.removeChildren(section);
		const overview = document.createElement("div");
		overview.className = "bes-invocation-overview";
		const command = /** @type {!HTMLElement} */ (document.createElement("h3"));
		command.className = "h3 text-mono bes-invocation-command";
		command.id = this.getId() + "-command";
		const startedEvent = this.progress_.started;
		const started = startedEvent && startedEvent.getStarted();
		const start =
			(startedEvent ? eventTimestampMillis(startedEvent) : null) ??
			summaryTime(this.cacheSummary_, "startedAt");
		const finishedEvent = this.progress_.finished;
		const file = this.progress_.file;
		const headingId = this.getElement_(goog.getCssName("bes-heading-id"));
		headingId.textContent = id;
		headingId.title = id;
		command.textContent = [
			"bazel",
			started && started.getCommand(),
			...this.progress_.targets,
		]
			.filter(Boolean)
			.join(" ");
		const toggle = /** @type {!HTMLButtonElement} */ (
			document.createElement("button")
		);
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
		const failure = invocationFailure(this.progress_);
		const stored = storedExitStatus(this.cacheSummary_);
		const outcome =
			finishedEvent || failure
				? replayResultStatus(this.progress_, failure)
				: stored;
		const state = this.progress_.collectionState;
		let status =
			state === COLLECTION_INCOMPLETE
				? incompleteStatus(outcome)
				: outcome ||
					(state === COLLECTION_COMPLETE
						? invocationStatus("Complete", "neutral")
						: replayResultStatus(this.progress_, failure));
		if (!status) {
			if (!this.source_ && this.progress_.history.length) {
				status = invocationStatus("Disconnected", "neutral");
			} else if (!this.connected_ && this.progress_.history.length) {
				status = invocationStatus("Reconnecting", "warning");
			} else if (this.progress_.history.length) {
				status = invocationStatus("Building", "running");
			} else {
				status = invocationStatus("Waiting for events", "neutral");
			}
		}
		badge.className =
			"bes-invocation-state text-small text-bold " +
			goog.getCssName("bes-heading-state") +
			" " +
			status.color;
		badge.textContent = status.label;
		badge.title = status.title;
		const icon = this.getElement_(goog.getCssName("bes-heading-icon"));
		// Keep the spinner mounted across build event updates so its rotation continues.
		if (icon.firstElementChild?.getAttribute("title") !== status.title) {
			dom.removeChildren(icon);
			icon.appendChild(renderInvocationStatusIcon(status));
		}
		const elapsed = this.getElement_(goog.getCssName("bes-heading-elapsed"));
		elapsed.hidden = false;
		overview.appendChild(
			dom.createDom("div", "bes-invocation-command-block", command, toggle),
		);
		this.renderFailureSummary_(failure);
		const workspace = started?.getWorkspaceDirectory();
		if (workspace) {
			overview.appendChild(
				dom.createDom(
					"p",
					{
						"class": "bes-invocation-workspace text-small",
						"title": workspace,
					},
					dom.createDom("span", "color-fg-muted mr-2", "Workspace"),
					" ",
					dom.createDom("code", null, workspace),
				),
			);
		}

		const metadata = this.progress_.metadata;
		const info = document.createElement("dl");
		info.className = "bes-invocation-metadata";
		/** @type {!Array<!Array<string|null|undefined>>} */
		const entries = [
			["Bazel version", started && started.getBuildToolVersion()],
			["Started", start === null ? "" : new Date(start).toISOString()],
			["User", (started && started.getUser()) || metadata.get("BUILD_USER")],
			["Host", (started && started.getHost()) || metadata.get("BUILD_HOST")],
			["Repository", metadata.get("REPO_URL")],
			["Branch", metadata.get("BRANCH_NAME")],
			["Commit", metadata.get("COMMIT_SHA")],
			["Role", metadata.get("ROLE")],
			["BEP file", file ? file.name + " · " + formatBytes(file.size) : ""],
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
		this.commandObserver_ ??= new ResizeObserver(() =>
			this.updateCommandToggle_(),
		);
		this.commandObserver_.observe(command);
		if (restoreCommandFocus && !toggle.hidden)
			toggle.focus({ preventScroll: true });

		clearInterval(this.clockTimer_);
		this.clockTimer_ = 0;
		const finish =
			(finishedEvent ? eventTimestampMillis(finishedEvent) : null) ??
			summaryTime(this.cacheSummary_, "finishedAt");
		const observedEnd = this.progress_.collectionEndedAt;
		const observedStart =
			observedEnd === null
				? null
				: summaryTime(this.cacheSummary_, "createdAt");
		const active =
			finish === null &&
			!finishedEvent &&
			!this.progress_.collectionEnded() &&
			!file &&
			this.connected_;
		const updateClock = () => {
			const end =
				finish ??
				observedEnd ??
				(finishedEvent || this.progress_.collectionEnded() || file
					? null
					: active
						? Date.now()
						: this.clockStoppedAt_);
			const beginning = finish === null ? (observedStart ?? start) : start;
			if (beginning === null || end === null) {
				elapsed.textContent = "—";
				elapsed.removeAttribute("datetime");
				elapsed.removeAttribute("title");
				return;
			}
			const duration = Math.max(0, end - beginning);
			const minutes = Math.floor(duration / 60000);
			const seconds = ((duration % 60000) / 1000).toFixed(3);
			elapsed.textContent = minutes
				? minutes + "m " + seconds.padStart(6, "0") + "s"
				: seconds + "s";
			elapsed.setAttribute("datetime", "PT" + duration / 1000 + "S");
			elapsed.title =
				finish === null && observedStart !== null
					? "From the first to the last received event"
					: "";
		};
		updateClock();
		if (active && start !== null)
			this.clockTimer_ = setInterval(updateClock, 250);
	}

	/** @private */
	updateCommandToggle_() {
		const command = this.commandHeading_;
		const toggle = this.commandToggle_;
		if (!command || !toggle) return;
		const expanded = this.commandExpanded_;
		command.classList.toggle("bes-invocation-command-collapsed", !expanded);
		toggle.hidden =
			!expanded && command.scrollHeight <= command.clientHeight + 1;
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
		summary.appendChild(
			dom.createDom("h3", "h4 mb-1 color-fg-danger", "Build failure"),
		);
		if (failure.context)
			summary.appendChild(
				dom.createDom("p", "text-bold mb-1", failure.context),
			);
		summary.appendChild(
			dom.createDom("pre", "bes-failure-message", failure.message),
		);
		if (this.progress_.logChunks.length) {
			const button = dom.createDom(
				"button",
				{ "type": "button", "class": "btn btn-sm mt-2" },
				"Open terminal",
			);
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

exports.BuildEventViewerComponent = BuildEventViewerComponent;
