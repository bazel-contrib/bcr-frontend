/**
 * @fileoverview Settings components for appearance and tool preferences.
 */
goog.module("bcrfrontend.settings");

const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { getApplication } = goog.require("bcrfrontend.common");
const { RefreshController, RefreshMode } = goog.require("bcrfrontend.refresh");
const { openInvocationBackend, openExecutionIrohBackend } = goog.require(
	"bcrfrontend.invocationTransport",
);
const {
	ToolSetting,
	readToolSetting,
	writeToolSetting,
	toolSetting,
	schedulerOrigin,
	cacheStatusURL,
} = goog.require("bcrfrontend.toolSettings");
const { settingsAppearanceComponent, settingsSelect, settingsToolsComponent } =
	goog.require("soy.bcrfrontend.settings");

/**
 * @enum {string}
 */
const LocalStorageKey = {
	COLOR_MODE: "color-mode",
	DISPLAY_MODE: "display-mode",
	REFRESH_MODE: "refresh-mode",
};

/**
 * @enum {string}
 */
const DisplayMode = {
	CONSUMER: "consumer",
	MAINTAINER: "maintainer",
};

/**
 * @enum {string}
 */
const TabName = {
	APPEARANCE: "appearance",
	TOOLS: "tools",
};

/**
 * Settings page with navigation.
 */
class SettingsSelect extends ContentSelect {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(
				settingsSelect,
				{},
				{
					pathUrl: this.getPathUrl(),
				},
			),
		);
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.APPEARANCE) {
			this.addTab(name, new SettingsAppearanceComponent(this.dom_));
		} else if (name === TabName.TOOLS) {
			this.addTab(name, new SettingsToolsComponent(this.dom_));
		} else {
			super.selectFail(name, route);
			return;
		}
		this.select(name, route);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.APPEARANCE, route.add(TabName.APPEARANCE));
	}
}

/** @type {!Object<string, !ToolSetting>} */
const TOOL_FIELDS = {
	"bes": ToolSetting.BUILD_EVENT_BACKEND,
	"scheduler": ToolSetting.REMOTE_EXECUTION_SCHEDULER,
	"viewer-token": ToolSetting.REMOTE_EXECUTION_VIEWER_TOKEN,
	"admin": ToolSetting.REMOTE_EXECUTION_ADMIN_ORIGIN,
	"admin-token": ToolSetting.REMOTE_EXECUTION_ADMIN_TOKEN,
	"cache": ToolSetting.REMOTE_CACHE_STATUS,
	"bazel-bes": ToolSetting.BAZEL_BES_BACKEND,
	"bazel-cache": ToolSetting.BAZEL_REMOTE_CACHE,
	"bazel-executor": ToolSetting.BAZEL_REMOTE_EXECUTOR,
	"worker": ToolSetting.WORKER_ENDPOINT,
};

/** @type {!Object<string, string>} */
const BAZEL_FLAGS = {
	"bazel-bes": "--bes_backend=",
	"bazel-cache": "--remote_cache=",
	"bazel-executor": "--remote_executor=",
};

/**
 * @param {string} value
 * @return {string}
 */
function endpointLabel(value) {
	if (value.startsWith("bcr-iroh-v1:")) return "Iroh viewer ticket";
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch (_error) {
		return /^[a-z0-9.[\]:-]+$/i.test(value) ? value : "—";
	}
}

/**
 * @param {string} kind
 * @param {!AbortSignal} signal
 * @return {!Promise<void>}
 */
async function testToolConnection(kind, signal) {
	if (kind === "bes") {
		const backend = await openInvocationBackend(
			toolSetting(ToolSetting.BUILD_EVENT_BACKEND),
		);
		const close = () => backend.close();
		try {
			if (signal.aborted) return;
			signal.addEventListener("abort", close, { once: true });
			await backend.list();
			return;
		} finally {
			signal.removeEventListener("abort", close);
			close();
		}
	}
	const scheduler = toolSetting(ToolSetting.REMOTE_EXECUTION_SCHEDULER);
	if (kind === "scheduler" && scheduler.startsWith("bcr-iroh-v1:")) {
		const backend = await openExecutionIrohBackend(scheduler);
		const close = () => backend.close();
		try {
			if (signal.aborted) return;
			signal.addEventListener("abort", close, { once: true });
			await backend.read("/pools?page_size=1");
			return;
		} finally {
			signal.removeEventListener("abort", close);
			close();
		}
	}

	const headers = new Headers();
	let url;
	if (kind === "cache") {
		url = cacheStatusURL(toolSetting(ToolSetting.REMOTE_CACHE_STATUS));
	} else {
		const admin = kind === "admin";
		const address = admin
			? toolSetting(ToolSetting.REMOTE_EXECUTION_ADMIN_ORIGIN)
			: scheduler;
		const token = toolSetting(
			admin
				? ToolSetting.REMOTE_EXECUTION_ADMIN_TOKEN
				: ToolSetting.REMOTE_EXECUTION_VIEWER_TOKEN,
		);
		if (!token)
			throw new Error(
				admin ? "Enter an admin token." : "Enter a viewer token.",
			);
		url =
			schedulerOrigin(address) +
			"/api/remote-execution" +
			(admin ? "/admin/pools" : "/pools?page_size=1");
		headers.set("Authorization", "Bearer " + token);
	}
	const response = await fetch(url, {
		signal,
		headers,
		cache: "no-store",
		credentials: "omit",
		redirect: "error",
	});
	if (!response.ok)
		throw new Error("Server returned HTTP " + response.status + ".");
	const data = /** @type {!Object<string, *>} */ (await response.json());
	if (kind === "cache" && (!data["startedAt"] || !data["storage"]))
		throw new Error("The endpoint did not return a cache status snapshot.");
}

class SettingsToolsComponent extends Component {
	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(settingsToolsComponent));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();
		const root = this.getElementStrict();
		const status = /** @type {!HTMLElement} */ (
			root.querySelector("[data-tool-save]")
		);
		for (const input of root.querySelectorAll("input[data-tool-setting]")) {
			const field = /** @type {!HTMLInputElement} */ (input);
			const key = TOOL_FIELDS[String(field.getAttribute("data-tool-setting"))];
			field.value = readToolSetting(key);
			if (
				!field.value &&
				key !== ToolSetting.REMOTE_EXECUTION_ADMIN_ORIGIN &&
				toolSetting(key)
			)
				field.placeholder = toolSetting(key);
			this.getHandler().listen(field, events.EventType.INPUT, () => {
				const saved = writeToolSetting(key, field.value);
				status.hidden = saved;
				status.textContent = saved
					? ""
					: "Could not save tool settings in this browser.";
				this.updateDiagram_();
			});
		}
		for (const item of root.querySelectorAll("form[data-tool-probe]")) {
			const form = /** @type {!HTMLFormElement} */ (item);
			this.getHandler().listen(
				form,
				events.EventType.SUBMIT,
				(/** !events.BrowserEvent */ event) => {
					event.preventDefault();
					void this.probe_(form);
				},
			);
		}
		this.updateDiagram_();
	}

	/** @private */
	updateDiagram_() {
		for (const node of this.getElementStrict().querySelectorAll(
			"[data-tool-endpoint]",
		)) {
			const name = String(node.getAttribute("data-tool-endpoint"));
			const label =
				(BAZEL_FLAGS[name] || "") +
				endpointLabel(toolSetting(TOOL_FIELDS[name]));
			node.textContent = label;
			node.setAttribute("title", label);
		}
	}

	/**
	 * @private
	 * @param {!HTMLFormElement} form
	 */
	async probe_(form) {
		const button = /** @type {!HTMLButtonElement} */ (
			form.querySelector("button")
		);
		const status = /** @type {!HTMLElement} */ (
			form.querySelector("[role=status]")
		);
		button.disabled = true;
		status.textContent = "Connecting…";
		status.className = "text-small color-fg-muted";
		const controller = new AbortController();
		let timer = 0;
		try {
			await Promise.race([
				testToolConnection(
					String(form.getAttribute("data-tool-probe")),
					controller.signal,
				),
				new Promise((resolve, reject) => {
					timer = setTimeout(() => {
						reject(new Error("The connection timed out."));
						controller.abort();
					}, 7000);
				}),
			]);
			status.textContent = "Connected";
			status.className = "text-small color-fg-success";
		} catch (/** @type {*} */ error) {
			status.textContent =
				error instanceof Error ? error.message : "Could not connect.";
			status.className = "text-small color-fg-danger";
		} finally {
			clearTimeout(timer);
			button.disabled = false;
		}
	}
}

/**
 * Theme/appearance settings component.
 */
class SettingsAppearanceComponent extends Component {
	/**
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(opt_domHelper) {
		super(opt_domHelper);

		/** @private @type {?HTMLSelectElement} */
		this.themeSelectEl_ = null;

		/** @private @type {?HTMLSelectElement} */
		this.displaySelectEl_ = null;

		/** @private @type {?HTMLSelectElement} */
		this.refreshSelectEl_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(settingsAppearanceComponent));
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.enterThemeSelect();
		this.enterDisplaySelect();
		this.enterRefreshSelect();
	}

	/**
	 * @override
	 */
	exitDocument() {
		this.themeSelectEl_ = null;
		this.displaySelectEl_ = null;
		this.refreshSelectEl_ = null;
		super.exitDocument();
	}

	enterThemeSelect() {
		this.themeSelectEl_ = /** @type {!HTMLSelectElement} */ (
			this.getCssElement("theme")
		);

		let colorMode = this.getLocalStorageColorMode();
		if (colorMode) {
			this.setDocumentColorMode(colorMode);
		} else {
			colorMode = this.getDocumentColorMode();
			this.setLocalStorageColorMode(colorMode);
		}
		this.themeSelectEl_.value = colorMode;

		this.getHandler().listen(
			this.themeSelectEl_,
			events.EventType.CHANGE,
			this.handleThemeSelectChange,
		);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 */
	handleThemeSelectChange(e) {
		const colorMode = this.themeSelectEl_.value || "auto";
		this.setDocumentColorMode(colorMode);
		this.setLocalStorageColorMode(colorMode);
	}

	enterDisplaySelect() {
		this.displaySelectEl_ = /** @type {!HTMLSelectElement} */ (
			this.getCssElement("display")
		);

		let displayMode = this.getLocalStorageDisplayMode();
		if (displayMode) {
			this.setDocumentDisplayMode(displayMode);
		} else {
			displayMode = DisplayMode.CONSUMER;
			this.setLocalStorageDisplayMode(displayMode);
			this.setDocumentDisplayMode(displayMode);
		}
		this.displaySelectEl_.value = displayMode;

		this.getHandler().listen(
			this.displaySelectEl_,
			events.EventType.CHANGE,
			this.handleDisplaySelectChange,
		);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 */
	handleDisplaySelectChange(e) {
		const displayMode = this.displaySelectEl_.value || DisplayMode.CONSUMER;
		this.setDocumentDisplayMode(displayMode);
		this.setLocalStorageDisplayMode(displayMode);
		window.location.reload();
	}

	enterRefreshSelect() {
		this.refreshSelectEl_ = /** @type {!HTMLSelectElement} */ (
			this.getCssElement("refresh")
		);

		let refreshMode = this.getLocalStorageRefreshMode();
		if (
			refreshMode !== RefreshMode.OFF &&
			refreshMode !== RefreshMode.NOTIFY &&
			refreshMode !== RefreshMode.AUTO
		) {
			refreshMode = RefreshMode.NOTIFY;
			this.setLocalStorageRefreshMode(refreshMode);
		}
		this.refreshSelectEl_.value = refreshMode;

		this.getHandler().listen(
			this.refreshSelectEl_,
			events.EventType.CHANGE,
			this.handleRefreshSelectChange,
		);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 */
	handleRefreshSelectChange(e) {
		const refreshMode = this.refreshSelectEl_.value || RefreshMode.NOTIFY;
		this.setLocalStorageRefreshMode(refreshMode);
		// Notify the live controller — no page reload needed, this setting
		// only controls the polling behavior, not anything rendered.
		const controller = /** @type {?RefreshController} */ (
			getApplication(this).getRefreshController()
		);
		if (controller) {
			controller.setMode(refreshMode);
		}
	}

	/**
	 * @returns {string}
	 */
	getDocumentColorMode() {
		return (
			this.themeSelectEl_.ownerDocument.documentElement.getAttribute(
				"data-color-mode",
			) || "auto"
		);
	}

	/**
	 * @param {string} colorMode
	 */
	setDocumentColorMode(colorMode) {
		this.themeSelectEl_.ownerDocument.documentElement.setAttribute(
			"data-color-mode",
			colorMode,
		);
	}

	/**
	 * @returns {?string}
	 */
	getLocalStorageColorMode() {
		return window.localStorage?.getItem(LocalStorageKey.COLOR_MODE);
	}

	/**
	 * @param {string} colorMode
	 */
	setLocalStorageColorMode(colorMode) {
		if (window.localStorage) {
			window.localStorage.setItem(LocalStorageKey.COLOR_MODE, colorMode);
		}
	}

	/**
	 * @returns {?string}
	 */
	getLocalStorageDisplayMode() {
		return window.localStorage?.getItem(LocalStorageKey.DISPLAY_MODE);
	}

	/**
	 * @param {string} displayMode
	 */
	setLocalStorageDisplayMode(displayMode) {
		if (window.localStorage) {
			window.localStorage.setItem(LocalStorageKey.DISPLAY_MODE, displayMode);
		}
	}

	/**
	 * @returns {?string}
	 */
	getLocalStorageRefreshMode() {
		return window.localStorage?.getItem(LocalStorageKey.REFRESH_MODE);
	}

	/**
	 * @param {string} refreshMode
	 */
	setLocalStorageRefreshMode(refreshMode) {
		if (window.localStorage) {
			window.localStorage.setItem(LocalStorageKey.REFRESH_MODE, refreshMode);
		}
	}

	/**
	 * @param {string} displayMode
	 */
	setDocumentDisplayMode(displayMode) {
		this.displaySelectEl_.ownerDocument.documentElement.setAttribute(
			"data-display-mode",
			displayMode,
		);
	}

	/**
	 * @param {string} cssName
	 * @return {!HTMLElement}
	 */
	getCssElement(cssName) {
		return /** @type {!HTMLElement} */ (
			dom.getRequiredElementByClass(cssName, this.getElementStrict())
		);
	}
}

/**
 * Get the current display mode from the document.
 * @return {string}
 */
function getDocumentDisplayMode() {
	return (
		document.documentElement.getAttribute("data-display-mode") ||
		DisplayMode.CONSUMER
	);
}

/**
 * Check if the display mode is "maintainer".
 * @return {boolean}
 */
function isDocumentDisplayModeMaintainer() {
	return getDocumentDisplayMode() === DisplayMode.MAINTAINER;
}

exports.SettingsSelect = SettingsSelect;
exports.DisplayMode = DisplayMode;
exports.isDocumentDisplayModeMaintainer = isDocumentDisplayModeMaintainer;
