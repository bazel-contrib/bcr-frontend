goog.module("bcrfrontend.App");

const BazelFlagDb = goog.require("proto.build.stack.bazel.help.v1.BazelFlagDb");
const ComponentEventType = goog.require("goog.ui.Component.EventType");
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const asserts = goog.require("goog.asserts");
const dataset = goog.require("goog.dom.dataset");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { App, Component, Route, RouteEvent, RouteEventType } =
	goog.require("stack.ui");
const { Application, SearchProvider } = goog.requireType("bcrfrontend.common");
const { BodySelect } = goog.require("bcrfrontend.body");
const { DocumentationSearchHandler } = goog.require(
	"bcrfrontend.documentation_search",
);
const { MVS } = goog.require("bcrfrontend.mvs");
const { ModuleSearchHandler } = goog.require("bcrfrontend.module_search");
const { SearchComponent } = goog.require("bcrfrontend.search");
const { copyToClipboard } = goog.require("bcrfrontend.clipboard");
const { createMaintainersMap, createModuleMap } = goog.require(
	"bcrfrontend.registry",
);
const { registryApp, toastSuccess } = goog.require("soy.bcrfrontend.app");

/**
 * Top-level app component.
 *
 * @implements {Application}
 */
class RegistryApp extends App {
	/**
	 * @param {!Registry} registry
	 * @param {!Promise<!Registry>} registryWithSymbols
	 * @param {!Promise<!Registry>} registryWithPackages
	 * @param {!Promise<*>} ruleUsageIndex resolves to Map<urlKey, Array<TargetRef>>.
	 * @param {function():!Promise<*>} bazelFlagDbLoader memoized lazy loader.
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(
		registry,
		registryWithSymbols,
		registryWithPackages,
		ruleUsageIndex,
		bazelFlagDbLoader,
		opt_domHelper,
	) {
		super(opt_domHelper);

		/** @private @const */
		this.registry_ = registry;

		/** @private @const */
		this.registryWithSymbols_ = registryWithSymbols;

		/** @private @const */
		this.registryWithPackages_ = registryWithPackages;

		/** @private @const */
		this.ruleUsageIndex_ = ruleUsageIndex;

		/** @private @const @type {function():!Promise<*>} */
		this.bazelFlagDbLoader_ = bazelFlagDbLoader;

		/** @private @type {!Map<string,string>} */
		this.options_ = new Map();

		/** @private @type {?Component} */
		this.activeComponent_ = null;

		/** @private @type {!BodySelect} */
		this.body_ = new BodySelect(this.registry_, opt_domHelper);

		/** @const @private @type {!ModuleSearchHandler} */
		this.moduleSearchHandler_ = new ModuleSearchHandler(this.registry_);

		/** @const @private @type {!DocumentationSearchHandler} */
		this.documentationSearchHandler_ = new DocumentationSearchHandler(
			this.registryWithSymbols_,
		);

		/** @private @type {?SearchComponent} */
		this.search_ = null;

		// Build MVS maps from this.registry_
		const { moduleVersionMap, moduleMetadataMap } = MVS.buildMaps(
			this.registry_,
		);

		/** @private @const @type {!MVS} */
		this.mvs_ = new MVS(moduleVersionMap, moduleMetadataMap);
	}

	/**
	 * Returns a set of named flags.  This is a way to pass in compile-time global
	 * constants into goog.modules.
	 * @override
	 * @returns {!Map<string,string>}
	 */
	getOptions() {
		return this.options_;
	}

	/**
	 * Returns the MVS instance.
	 * @override
	 * @return {!MVS}
	 */
	getMvs() {
		return this.mvs_;
	}

	/**
	 * Returns the registry proto loaded at startup (pre-symbol decoration).
	 * @override
	 * @returns {!Registry}
	 */
	getRegistry() {
		return this.registry_;
	}

	/**
	 * Returns the promise that resolves when symbols are loaded and decorated.
	 * @override
	 * @returns {!Promise<!Registry>}
	 */
	getRegistryWithSymbols() {
		return this.registryWithSymbols_;
	}

	/**
	 * Returns the promise that resolves when packages are loaded and decorated.
	 * @override
	 * @returns {!Promise<!Registry>}
	 */
	getRegistryWithPackages() {
		return this.registryWithPackages_;
	}

	/**
	 * Returns the promise that resolves to the rule-usage index.
	 * @override
	 * @returns {!Promise<*>}
	 */
	getRuleUsageIndex() {
		return this.ruleUsageIndex_;
	}

	/**
	 * Returns a memoized promise for the lazy-loaded bazel flag database.
	 * @override
	 * @returns {!Promise<*>}
	 */
	getBazelFlagDb() {
		return this.bazelFlagDbLoader_();
	}

	/** @override */
	createDom() {
		this.setElementInternal(soy.renderAsElement(registryApp));
	}

	/** @override */
	enterDocument() {
		super.enterDocument();

		this.addChild(this.body_, true);

		this.enterRouter();
		this.enterSearch();
		this.enterKeys();
		this.enterTopLevelClickEvents();
	}

	/**
	 * Setup event listeners that bubble up to the app.
	 */
	enterTopLevelClickEvents() {
		this.getHandler().listen(
			this.getElementStrict(),
			events.EventType.CLICK,
			this.handleElementClick,
		);
	}

	/**
	 * Register for router events.
	 */
	enterRouter() {
		const handler = this.getHandler();
		const router = this.getRouter();

		handler.listen(router, ComponentEventType.ACTION, this.handleRouteBegin);
		handler.listen(router, RouteEventType.DONE, this.handleRouteDone);
		handler.listen(router, RouteEventType.PROGRESS, this.handleRouteProgress);
		handler.listen(router, RouteEventType.FAIL, this.handleRouteFail);
	}

	/**
	 * Setup the search component.
	 */
	enterSearch() {
		const formEl = asserts.assertElement(
			this.getElementStrict().querySelector("form"),
		);

		this.search_ = new SearchComponent(this, formEl);

		events.listen(this.search_, events.EventType.FOCUS, () =>
			this.getKbd().setEnabled(false),
		);
		events.listen(this.search_, events.EventType.BLUR, () =>
			this.getKbd().setEnabled(true),
		);

		this.search_.addSearchProvider(
			this.moduleSearchHandler_.getSearchProvider(),
		);
		this.search_.addSearchProvider(
			this.documentationSearchHandler_.getSearchProvider(),
		);

		this.search_.setCurrentSearchProviderByName("modules");
	}

	/**
	 * Setup keyboard shorcuts.
	 */
	enterKeys() {
		this.getHandler().listen(
			window.document.documentElement,
			"keydown",
			this.onKeyDown,
		);
		this.getKbd().setEnabled(true);
	}

	/**
	 * @param {!events.BrowserEvent=} e
	 * suppress {checkTypes}
	 */
	onKeyDown(e) {
		if (this.search_.isActive()) {
			const inputValue = this.search_.getValue();

			switch (e.keyCode) {
				case events.KeyCodes.ESC:
					this.blurSearchBox(e);
					break;
				case events.KeyCodes.SLASH:
					// If input is empty, switch to module search
					if (inputValue.length === 0) {
						this.focusSearchBox(
							e,
							this.moduleSearchHandler_.getSearchProvider(),
						);
					}
					break;
				case events.KeyCodes.PERIOD:
					// If input is empty, switch to documentation search
					if (inputValue.length === 0) {
						this.focusSearchBox(
							e,
							this.documentationSearchHandler_.getSearchProvider(),
						);
					}
					break;
			}
			return;
		}

		// CMD-P (Mac) or CTRL-P (Windows/Linux) to focus documentation search
		if (e.keyCode === events.KeyCodes.P && (e.metaKey || e.ctrlKey)) {
			if (this.getKbd().isEnabled()) {
				this.focusSearchBox(
					e,
					this.documentationSearchHandler_.getSearchProvider(),
				);
			}
			return;
		}

		switch (e.keyCode) {
			case events.KeyCodes.SLASH:
				if (this.getKbd().isEnabled()) {
					this.focusSearchBox(e, this.moduleSearchHandler_.getSearchProvider());
				}
				break;
			case events.KeyCodes.PERIOD:
				if (this.getKbd().isEnabled()) {
					this.focusSearchBox(
						e,
						this.documentationSearchHandler_.getSearchProvider(),
					);
				}
				break;
			case events.KeyCodes.COMMA:
				if (this.getKbd().isEnabled()) {
					e.preventDefault();
					this.setLocation(["settings"]);
				}
				break;
			case events.KeyCodes.OPEN_SQUARE_BRACKET:
				if (this.getKbd().isEnabled()) {
					this.gotoSibling(-1, e);
				}
				break;
			case events.KeyCodes.CLOSE_SQUARE_BRACKET:
				if (this.getKbd().isEnabled()) {
					this.gotoSibling(+1, e);
				}
				break;
			case events.KeyCodes.TILDE:
				// Shift+` produces ~ on US keyboards; require shift so a bare
				// backtick doesn't navigate.
				if (this.getKbd().isEnabled() && e.shiftKey) {
					e.preventDefault();
					this.setLocation(["home"]);
				}
				break;
		}

		if (this.activeComponent_) {
			this.activeComponent_.dispatchEvent(e);
		}
	}

	/**
	 * Focuses the search box.
	 *
	 * @param {!events.BrowserEvent=} opt_e The browser event this action is
	 *     in response to. If provided, the event's propagation will be cancelled.
	 * @param {?SearchProvider=} opt_searchProvider If a provider is given, set to the active one.
	 */
	focusSearchBox(opt_e, opt_searchProvider) {
		if (opt_searchProvider) {
			this.search_.setCurrentProvider(opt_searchProvider);
		}
		this.search_.focus();
		if (opt_e) {
			opt_e.preventDefault();
			opt_e.stopPropagation();
		}
	}

	/**
	 * UnFocuses the search box.
	 *
	 * @param {!events.BrowserEvent=} opt_e The browser event this action is
	 *     in response to. If provided, the event's propagation will be cancelled.
	 */
	blurSearchBox(opt_e) {
		this.search_.blur();
		if (opt_e) {
			opt_e.preventDefault();
			opt_e.stopPropagation();
		}
	}

	/**
	 * @param {!events.Event} e
	 */
	handleRouteBegin(e) {}

	/**
	 * @param {!events.Event} e
	 */
	handleRouteDone(e) {
		const routeEvent = /** @type {!RouteEvent} */ (e);
		this.activeComponent_ = routeEvent.component || null;
		// DEBUG const route = /** @type {!Route} */ (e.target);
		// DEBUG console.log("done:", route.getPath());
	}

	/**
	 * @param {!events.Event} e
	 */
	handleRouteProgress(e) {
		const routeEvent = /** @type {!RouteEvent} */ (e);
		// DEBUG console.info(`progress: ${routeEvent.route.unmatchedPath()}`, routeEvent);
	}

	/**
	 * @param {!events.Event} e
	 */
	handleRouteFail(e) {
		const route = /** @type {!Route} */ (e.target);
		this.getRouter().unlistenRoute();
		this.activeComponent_ = null;
		console.error("not found:", route.getPath());
		// DEBUG this.route("/" + TabName.NOT_FOUND + route.getPath());
	}

	/**
	 * @override
	 * @param {!Route} route the route object
	 */
	go(route) {
		route.touch(this);
		route.progress(this);
		this.body_.go(route);
	}

	/**
	 * Handle element click event and search for an el with a 'data-route'
	 * or data-clippy element.  If found, send it.
	 *
	 * @param {!events.BrowserEvent} e
	 */
	handleElementClick(e) {
		const target = /** @type {?Node} */ (e.target);
		if (!target) {
			return;
		}

		dom.getAncestor(
			target,
			(node) => {
				if (!(node instanceof Element)) {
					return false;
				}
				const route = dataset.get(node, "route");
				if (route) {
					this.setLocation(route.split("/"));
					return true;
				}
				const clippy = dataset.get(node, "clippy");
				if (clippy) {
					copyToClipboard(clippy);
					this.toastSuccess(`copied: ${clippy}`);
					return true;
				}
				const searchprovider = dataset.get(node, "searchprovider");
				if (searchprovider) {
					this.search_.focusSearchProviderByName(searchprovider);
					return true;
				}
				const action = dataset.get(node, "action");
				if (action === "next-sibling") {
					this.gotoSibling(+1);
					return true;
				}
				if (action === "prev-sibling") {
					this.gotoSibling(-1);
					return true;
				}
				if (node instanceof HTMLAnchorElement) {
					return this.maybeNavigateAnchor_(node, e);
				}
				return false;
			},
			true,
		);
	}

	/**
	 * Intercept a left-click on a same-origin <a href="/..."> and route via the
	 * SPA router instead of letting the browser do a full page load. Keeping
	 * the real href means right-click → "Open in new tab" still works: the
	 * server's SPA fallback serves index.html for the new tab.
	 *
	 * @param {!HTMLAnchorElement} anchor
	 * @param {!events.BrowserEvent} e
	 * @return {boolean} true if the click was intercepted.
	 * @private
	 */
	maybeNavigateAnchor_(anchor, e) {
		if (e.defaultPrevented) return false;
		if (e.button !== 0) return false;
		if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
		const tgt = anchor.target;
		if (tgt && tgt !== "_self") return false;
		if (anchor.hasAttribute("download")) return false;
		const rawHref = anchor.getAttribute("href");
		if (!rawHref) return false;
		if (
			rawHref.startsWith("javascript:") ||
			rawHref.startsWith("mailto:") ||
			rawHref.startsWith("tel:")
		) {
			return false;
		}
		const url = new URL(anchor.href, window.location.href);
		if (url.origin !== window.location.origin) return false;
		// In-page hash navigation (e.g. <a href="#section">) — let the browser
		// scroll without re-running the router.
		if (
			url.pathname === window.location.pathname &&
			url.search === window.location.search &&
			url.hash
		) {
			return false;
		}
		// Legacy `/#/foo` bookmarks: pull the path out of the hash.
		let path = url.pathname;
		if (path === "/" && url.hash.startsWith("#/")) {
			path = url.hash.substring(1);
		}
		const segments = path.split("/").filter(Boolean);
		if (segments.length === 0) return false;
		e.preventDefault();
		this.setLocation(segments);
		return true;
	}

	/**
	 * Cycle to the next/previous sibling within the current section. Works
	 * on /maintainers/<handle>, /modules/<name>/..., and
	 * /bazel/flags/<flag-name>. No-op elsewhere.
	 *
	 * @param {number} direction +1 for next, -1 for previous
	 * @param {!events.BrowserEvent=} opt_e
	 */
	gotoSibling(direction, opt_e) {
		// Always swallow the keystroke so it doesn't leak into a focused
		// input or trigger the default action of the clicked anchor.
		if (opt_e) opt_e.preventDefault();

		// The app uses path-based routing; hash links like `/#/maintainers/foo`
		// also work, so check both.
		const raw = window.location.pathname + window.location.hash;
		const segments = raw
			.replace(/^[#/]+/, "")
			.split(/[\/#]+/)
			.filter(Boolean);
		if (segments.length < 2) return;

		if (segments[0] === "maintainers") {
			const names = [...createMaintainersMap(this.registry_).keys()];
			this.cycleSibling_(["maintainers"], names, segments[1], direction);
			return;
		}
		if (segments[0] === "modules") {
			// /modules/<name>/<version>/packages/<pkg>/[...] — cycle through the
			// packages of this module-version rather than across modules. The
			// package path itself is slash-separated and may be multiple
			// segments long, and additional segments after it (target name,
			// LIST tab) should be discarded on cycle.
			if (segments[3] === "packages" && segments.length >= 5) {
				const moduleMapForPkg = createModuleMap(this.registry_);
				const moduleForPkg = moduleMapForPkg.get(
					decodeURIComponent(segments[1]),
				);
				const versionStr = decodeURIComponent(segments[2]);
				/** @type {?ModuleVersion} */
				let mvForPkg = null;
				if (moduleForPkg) {
					for (const v of moduleForPkg.getVersionsList()) {
						if (v.getVersion() === versionStr) {
							mvForPkg = v;
							break;
						}
					}
				}
				const pkgList = mvForPkg?.getSource()?.getPackages()?.getPackageList();
				if (pkgList && pkgList.length > 0) {
					/** @type {!Array<string>} */
					const allPaths = pkgList.map((p) =>
						stripRepoPrefixForCycle(p.getName()),
					);
					/** @type {!Set<string>} */
					const known = new Set(allPaths);
					/** @type {!Array<string>} */
					const sorted = allPaths.slice().sort();

					// Greedy longest-prefix match: trim trailing segments until
					// what's left is a known package path. Works for both
					// `/packages/lib/foo` and `/packages/lib/foo/my_target`.
					/** @type {!Array<string>} */
					const tail = segments.slice(4).map((s) => decodeURIComponent(s));
					/** @type {?string} */
					let current = null;
					for (let n = tail.length; n > 0; n--) {
						const candidate = tail.slice(0, n).join("/");
						if (known.has(candidate)) {
							current = candidate;
							break;
						}
					}
					if (current !== null) {
						const idx = sorted.indexOf(current);
						/** @type {string} */
						const next =
							sorted[(idx + direction + sorted.length) % sorted.length];
						this.setLocation([
							"modules",
							segments[1],
							segments[2],
							"packages",
							...next.split("/"),
						]);
						return;
					}
				}
			}

			const moduleMap = createModuleMap(this.registry_);
			/** @type {!Array<string>} */
			const names = [];
			moduleMap.forEach((_, key) => names.push(key));
			if (names.length === 0) return;
			names.sort((a, b) => {
				const la = a.toLowerCase();
				const lb = b.toLowerCase();
				return la < lb ? -1 : la > lb ? 1 : 0;
			});
			const idx = names.indexOf(decodeURIComponent(segments[1]));
			if (idx === -1) return;
			const nextName = names[(idx + direction + names.length) % names.length];

			// Preserve only the top-level tab (e.g. "docs", "testing",
			// "overview") across modules. Deeper subpaths (a specific symbol,
			// file, or version-specific anchor) don't generalize to the next
			// module and would 404, so we drop them. The version (segments[2])
			// is module-specific, so substitute the next module's latest. If
			// there is no trailing path beyond the version, drop the version
			// entirely and let the destination module's default route choose.
			const tab = segments[3];
			if (!tab) {
				this.setLocation(["modules", nextName]);
				return;
			}
			const nextModule = moduleMap.get(nextName);
			const versions = nextModule ? nextModule.getVersionsList() : null;
			const latestVersion =
				versions && versions.length > 0 ? versions[0].getVersion() : "latest";
			this.setLocation(["modules", nextName, latestVersion, tab]);
			return;
		}
		if (
			segments[0] === "bazel" &&
			segments[1] === "flags" &&
			segments.length >= 3 &&
			segments[2] !== "list" &&
			segments[2] !== "tag"
		) {
			// /bazel/flags/<flag-name> — cycle through every flag in the DB.
			this.bazelFlagDbLoader_().then((db) => {
				const typed = /** @type {!BazelFlagDb} */ (db);
				const names = typed.getFlagList().map((f) => f.getName());
				this.cycleSibling_(["bazel", "flags"], names, segments[2], direction);
			});
			return;
		}
	}

	/**
	 * Sorts `names` alphabetically and navigates to `[...prefix, sibling]`
	 * where `sibling` is the entry `direction` positions away from
	 * `currentName` (wrapping at the ends).
	 *
	 * @private
	 * @param {!Array<string>} prefix path prefix segments (e.g. ["modules"]).
	 * @param {!Array<string>} names siblings in the current section.
	 * @param {string} currentName segment value to match (URL-encoded ok).
	 * @param {number} direction +1 or -1.
	 */
	cycleSibling_(prefix, names, currentName, direction) {
		if (names.length === 0) return;
		const sorted = names.slice().sort((a, b) => {
			const la = a.toLowerCase();
			const lb = b.toLowerCase();
			return la < lb ? -1 : la > lb ? 1 : 0;
		});
		const current = decodeURIComponent(currentName);
		const idx = sorted.indexOf(current);
		if (idx === -1) return;
		const next = (idx + direction + sorted.length) % sorted.length;
		this.setLocation([...prefix, sorted[next]]);
	}

	/**
	 * Place an info toast on the page
	 * @param {string} message
	 * @param {number=} opt_dismiss
	 */
	toastSuccess(message, opt_dismiss) {
		const toast = soy.renderAsElement(toastSuccess, { message });
		dom.append(document.body, toast);
		setTimeout(() => dom.removeNode(toast), opt_dismiss || 3000);
	}
}

/**
 * Strip the leading "@@<repo>//" segment from a package label, returning
 * "ROOT" for the empty (root) package. Duplicates the helper in packages.js
 * so app.js doesn't need to depend on it; keep them in sync.
 *
 * @param {string} pkgName
 * @returns {string}
 */
function stripRepoPrefixForCycle(pkgName) {
	const idx = pkgName.indexOf("//");
	if (idx === -1) return pkgName;
	const rest = pkgName.substring(idx + 2);
	return rest === "" ? "ROOT" : rest;
}

exports = RegistryApp;
