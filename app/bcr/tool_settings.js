/** @fileoverview Browser preferences shared by the Tools settings and tools. */
goog.module("bcrfrontend.toolSettings");

/** @enum {string} */
const ToolSetting = {
	BUILD_EVENT_BACKEND: "bcr.tools.build-event-backend",
	REMOTE_EXECUTION_SCHEDULER: "bcr.tools.remote-execution-scheduler",
	REMOTE_EXECUTION_VIEWER_TOKEN: "bcr.tools.remote-execution-viewer-token",
	REMOTE_EXECUTION_ADMIN_ORIGIN: "bcr.tools.remote-execution-admin-origin",
	REMOTE_EXECUTION_ADMIN_TOKEN: "bcr.tools.remote-execution-admin-token",
	REMOTE_CACHE_STATUS: "bcr.tools.remote-cache-status",
	REMOTE_CACHE_CONNECTED: "bcr.tools.remote-cache-connected",
	BAZEL_BES_BACKEND: "bcr.tools.bazel-bes-backend",
	BAZEL_REMOTE_CACHE: "bcr.tools.bazel-remote-cache",
	BAZEL_REMOTE_EXECUTOR: "bcr.tools.bazel-remote-executor",
	WORKER_ENDPOINT: "bcr.tools.worker-endpoint",
};

/**
 * @param {!ToolSetting} key
 * @return {string}
 */
function readToolSetting(key) {
	try {
		const saved = window.localStorage.getItem(key);
		if (saved !== null) return saved;
		const session = window.sessionStorage.getItem(key) || "";
		if (session) {
			window.localStorage.setItem(key, session);
			window.sessionStorage.removeItem(key);
		}
		return session;
	} catch (_error) {
		return "";
	}
}

/**
 * @param {!ToolSetting} key
 * @param {string} value
 * @return {boolean}
 */
function writeToolSetting(key, value) {
	try {
		window.localStorage.setItem(key, value.trim());
		return true;
	} catch (_error) {
		return false;
	}
}

/**
 * @param {!ToolSetting} key
 * @return {string}
 */
function toolSetting(key) {
	const saved = readToolSetting(key);
	if (saved) return saved;
	switch (key) {
		case ToolSetting.BUILD_EVENT_BACKEND:
		case ToolSetting.REMOTE_EXECUTION_SCHEDULER:
		case ToolSetting.REMOTE_CACHE_STATUS:
		case ToolSetting.WORKER_ENDPOINT:
			return "http://localhost:1974";
		case ToolSetting.REMOTE_EXECUTION_ADMIN_ORIGIN: {
			const scheduler = readToolSetting(ToolSetting.REMOTE_EXECUTION_SCHEDULER);
			return scheduler && !scheduler.startsWith("bcr-iroh-v1:")
				? scheduler
				: "http://localhost:1974";
		}
		case ToolSetting.BAZEL_BES_BACKEND:
			return "grpc://localhost:1973";
		case ToolSetting.BAZEL_REMOTE_CACHE:
			return "grpc://localhost:1972";
		case ToolSetting.BAZEL_REMOTE_EXECUTOR:
			return "grpc://localhost:1971";
		default:
			return "";
	}
}

/**
 * @param {string} address
 * @return {!URL}
 */
function httpURL(address) {
	const url = new URL(address);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Use an HTTP or HTTPS URL.");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Use a URL without credentials, a query, or a fragment.");
	return url;
}

/**
 * @param {string} address
 * @return {string}
 */
function schedulerOrigin(address) {
	const url = httpURL(address);
	if (
		url.pathname !== "/" ||
		(url.protocol === "http:" &&
			!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
	)
		throw new Error(
			"Enter the scheduler’s HTTPS origin or a loopback HTTP origin.",
		);
	return url.origin;
}

/**
 * @param {string} address
 * @return {string}
 */
function cacheStatusURL(address) {
	const url = httpURL(address);
	const path = url.pathname.replace(/\/$/, "");
	url.pathname = path.endsWith("/api/remote-cache/status")
		? path
		: path + "/api/remote-cache/status";
	return url.href;
}

exports = {
	ToolSetting,
	readToolSetting,
	writeToolSetting,
	toolSetting,
	schedulerOrigin,
	cacheStatusURL,
};
