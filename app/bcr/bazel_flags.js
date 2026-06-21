goog.module("bcrfrontend.bazelFlags");

const BazelFlag = goog.require("proto.build.stack.bazel.help.v1.BazelFlag");
const BazelFlagDb = goog.require("proto.build.stack.bazel.help.v1.BazelFlagDb");
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const { Component, Route } = goog.require("stack.ui");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { formatMarkdownAll } = goog.require("bcrfrontend.markdown");
const { getApplication } = goog.require("bcrfrontend.common");
const {
	computeTopPrimaryLanguages,
	computeTotalBazelVersions,
	computeTotalPeople,
	computeTotalSymbols,
	createMaintainersMap,
	createModuleMap,
	refreshBcrSidePaneBazelFlags,
	refreshBcrSidePaneSymbols,
} = goog.require("bcrfrontend.registry");
const {
	bazelFlagDetail,
	bazelFlagGroup,
	bazelFlagsCategoriesTable,
	bazelFlagsCommandsTable,
	bazelFlagsListComponent,
	bazelFlagsListSelectNav,
	bazelFlagsResultsList,
	bazelFlagsSelect,
	bazelFlagsTagsTable,
} = goog.require("soy.bcrfrontend.app");
const { counterLabel } = goog.require("soy.registry");
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");

/**
 * @enum {string}
 */
const TabName = {
	LIST: "list",
	TAG: "tag",
	TAGS: "tags",
	CATEGORY: "category",
	CATEGORIES: "categories",
	COMMANDS: "commands",
};

/**
 * Top-level container for /bazel/flags. Routes:
 *   /bazel/flags          → default to "list" tab
 *   /bazel/flags/list     → BazelFlagsListSelectNav (search + list)
 *   /bazel/flags/<name>   → BazelFlagDetailComponent (resolved against the DB)
 */
class BazelFlagsSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(bazelFlagsSelect));
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(TabName.LIST, route.add(TabName.LIST));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.LIST) {
			this.addTab(
				TabName.LIST,
				new BazelFlagsListSelectNav(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		if (name === TabName.TAG) {
			this.addTab(
				TabName.TAG,
				new BazelFlagsByTagSelect(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		if (name === TabName.CATEGORY) {
			this.addTab(
				TabName.CATEGORY,
				new BazelFlagsByCategorySelect(this.registry_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		// Treat any other segment as a flag name; the detail component
		// resolves it against the lazy-loaded DB.
		this.addTab(
			name,
			new BazelFlagDetailComponent(this.registry_, name, this.dom_),
		);
		this.select(name, route);
	}
}
exports.BazelFlagsSelect = BazelFlagsSelect;

/**
 * Sub-Select at /bazel/flags/tag/. Consumes the next path segment as the tag
 * name and instantiates BazelFlagsByTagComponent for it.
 */
class BazelFlagsByTagSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(bazelFlagsSelect));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		this.addTab(
			name,
			new BazelFlagsByTagComponent(this.registry_, name, this.dom_),
		);
		this.select(name, route);
	}
}
exports.BazelFlagsByTagSelect = BazelFlagsByTagSelect;

/**
 * Sub-Select at /bazel/flags/category/. Consumes the next (URL-encoded)
 * segment as a help-category title and instantiates
 * BazelFlagsByCategoryComponent for it.
 */
class BazelFlagsByCategorySelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(bazelFlagsSelect));
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		this.addTab(
			name,
			new BazelFlagsByCategoryComponent(this.registry_, name, this.dom_),
		);
		this.select(name, route);
	}
}
exports.BazelFlagsByCategorySelect = BazelFlagsByCategorySelect;

/**
 * Tabbed page at /bazel/flags/list. Today the only tab is "List"; the
 * SelectNav shape leaves room for sibling tabs (e.g. "By command", "Diff
 * between versions") without restructuring the route.
 */
class BazelFlagsListSelectNav extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		const modules = createModuleMap(this.registry_);
		const maintainers = createMaintainersMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}

		this.setElementInternal(
			soy.renderAsElement(bazelFlagsListSelectNav, {
				registry: this.registry_,
				totalModules: modules.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalPeople: computeTotalPeople(this.registry_),
				totalSymbols: computeTotalSymbols(this.registry_),
				topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
				totalBazelVersions: computeTotalBazelVersions(this.registry_),
				uiCommitSha: uiCommitSha,
			}),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return TabName.LIST;
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addNavTabLazy(
			TabName.LIST,
			"Flags",
			"All Bazel Flags",
			undefined,
			`${this.getPathUrl()}/${TabName.LIST}`,
			() => new BazelFlagsListComponent(this.registry_, this.dom_),
		);

		this.addNavTabLazy(
			TabName.CATEGORIES,
			"Categories",
			"Help-text categories the flags belong to",
			undefined,
			`${this.getPathUrl()}/${TabName.CATEGORIES}`,
			() => new BazelFlagsCategoriesComponent(this.registry_, this.dom_),
		);

		this.addNavTabLazy(
			TabName.TAGS,
			"Tags",
			"Tags attached to flags (incompatible_change, experimental, …)",
			undefined,
			`${this.getPathUrl()}/${TabName.TAGS}`,
			() => new BazelFlagsTagsComponent(this.registry_, this.dom_),
		);

		this.addNavTabLazy(
			TabName.COMMANDS,
			"Commands",
			"Bazel commands the flags apply to",
			undefined,
			`${this.getPathUrl()}/${TabName.COMMANDS}`,
			() => new BazelFlagsCommandsComponent(this.registry_, this.dom_),
		);

		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});

		// Inject counts into the three nav tabs once the DB loads.
		// addNavTabLazy was called with count=undefined so the Counter badges
		// aren't pre-rendered; we append them here.
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				const flagCount = typed.getFlagList().length;
				/** @type {!Set<string>} */
				const categorySet = new Set();
				/** @type {!Set<string>} */
				const tagSet = new Set();
				let commandCount = 0;
				for (const command of typed.getCommandsList()) {
					if (command) commandCount++;
				}
				for (const flag of typed.getFlagList()) {
					const c = flag.getCategory();
					if (c) categorySet.add(c);
					for (const t of flag.getTagList()) {
						if (t) tagSet.add(t);
					}
				}
				const root = this.getElement();
				if (!root) return;
				/**
				 * @param {string} name
				 * @param {number} count
				 */
				const setBadge = (name, count) => {
					const tab = root.querySelector(`[data-name="${name}"]`);
					if (tab && !tab.querySelector(".Counter")) {
						tab.appendChild(
							soy.renderAsElement(counterLabel, { count: count }),
						);
					}
				};
				setBadge(TabName.LIST, flagCount);
				setBadge(TabName.CATEGORIES, categorySet.size);
				setBadge(TabName.TAGS, tagSet.size);
				setBadge(TabName.COMMANDS, commandCount);
				refreshBcrSidePaneBazelFlags(document.body, flagCount);
			});
	}
}

/**
 * Search input + filtered results. Awaits the lazy-loaded BazelFlagDb on
 * first enter; renders a "loading" placeholder until the proto arrives.
 */
class BazelFlagsListComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @type {?BazelFlagDb} */
		this.db_ = null;

		/** @private @type {?HTMLInputElement} */
		this.searchInput_ = null;

		/** @private @type {?Element} */
		this.resultsContainer_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(bazelFlagsListComponent));
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		const root = this.getElementStrict();
		this.searchInput_ = /** @type {?HTMLInputElement} */ (
			root.querySelector(".js-flag-search-input")
		);
		this.resultsContainer_ = root.querySelector(".js-flag-search-results");

		if (this.searchInput_) {
			this.getHandler().listen(this.searchInput_, events.EventType.INPUT, () =>
				this.renderResults_(),
			);
		}

		this.renderLoading_();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				this.db_ = /** @type {!BazelFlagDb} */ (db);
				this.renderResults_();
				refreshBcrSidePaneBazelFlags(
					document.body,
					this.db_.getFlagList().length,
				);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				console.error("Failed to load bazel flag db:", err);
				this.renderError_(err);
			});
	}

	/**
	 * @private
	 */
	renderLoading_() {
		if (!this.resultsContainer_) return;
		this.resultsContainer_.innerHTML = "";
		const div = dom.createDom("div", { class: "color-fg-muted p-3" });
		div.textContent = "Loading flag database…";
		this.resultsContainer_.appendChild(div);
	}

	/**
	 * @private
	 * @param {*} err
	 */
	renderError_(err) {
		if (!this.resultsContainer_) return;
		this.resultsContainer_.innerHTML = "";
		const div = dom.createDom("div", { class: "flash flash-error" });
		div.textContent = `Failed to load flag database: ${err}`;
		this.resultsContainer_.appendChild(div);
	}

	/**
	 * @private
	 */
	renderResults_() {
		if (!this.db_ || !this.resultsContainer_) return;
		const all = this.db_.getFlagList();
		const query = this.searchInput_
			? this.searchInput_.value.trim().toLowerCase()
			: "";
		const filtered = filterFlags(all, query);

		const items = buildFlagItems(filtered, this.db_);

		soy.renderElement(
			/** @type {!Element} */ (this.resultsContainer_),
			bazelFlagsResultsList,
			{ items: items },
		);
	}
}

/**
 * Categories tab at /bazel/flags/list/categories — renders a table of every
 * distinct category in the DB with the flag count for each. Each row links
 * to /bazel/flags/category/<encoded-category>.
 */
class BazelFlagsCategoriesComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				/** @type {!Map<string, number>} */
				const counts = new Map();
				for (const flag of typed.getFlagList()) {
					const cat = flag.getCategory();
					if (!cat) continue;
					counts.set(cat, (counts.get(cat) || 0) + 1);
				}
				/** @type {!Array<!{name: string, count: number}>} */
				const categories = [];
				counts.forEach((count, name) => {
					categories.push({ name: name, count: count });
				});
				categories.sort((a, b) => {
					const la = a.name.toLowerCase();
					const lb = b.name.toLowerCase();
					return la < lb ? -1 : la > lb ? 1 : 0;
				});

				const root = this.getElementStrict();
				root.innerHTML = "";
				const rendered = soy.renderAsElement(bazelFlagsCategoriesTable, {
					categories: categories,
				});
				root.appendChild(rendered);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}
}

/**
 * Tags tab at /bazel/flags/list/tags — renders a table of every distinct
 * tag in the DB with the flag count for each. Each row links to
 * /bazel/flags/tag/<tag>.
 */
class BazelFlagsTagsComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				/** @type {!Map<string, number>} */
				const counts = new Map();
				for (const flag of typed.getFlagList()) {
					for (const t of flag.getTagList()) {
						if (!t) continue;
						counts.set(t, (counts.get(t) || 0) + 1);
					}
				}
				/** @type {!Array<!{name: string, count: number}>} */
				const tags = [];
				counts.forEach((count, name) => {
					tags.push({ name: name, count: count });
				});
				tags.sort((a, b) => {
					const la = a.name.toLowerCase();
					const lb = b.name.toLowerCase();
					return la < lb ? -1 : la > lb ? 1 : 0;
				});

				const root = this.getElementStrict();
				root.innerHTML = "";
				const rendered = soy.renderAsElement(bazelFlagsTagsTable, {
					tags: tags,
				});
				root.appendChild(rendered);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}
}

/**
 * Commands tab at /bazel/flags/list/commands — renders every Bazel command
 * in the DB with the number of flags that apply to it. Each row links to the
 * existing /bazel/command/<command> flag group page.
 */
class BazelFlagsCommandsComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;
	}

	/**
	 * @override
	 */
	createDom() {
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				const commandNames = typed.getCommandsList();
				/** @type {!Array<number>} */
				const counts = new Array(commandNames.length).fill(0);

				for (const flag of typed.getFlagList()) {
					for (const commandIdx of flag.getCommandIndexList()) {
						if (commandIdx >= 0 && commandIdx < counts.length) {
							counts[commandIdx]++;
						}
					}
				}

				/** @type {!Array<!{name: string, count: number}>} */
				const commands = [];
				commandNames.forEach((name, i) => {
					if (!name) return;
					commands.push({ name: name, count: counts[i] || 0 });
				});

				const root = this.getElementStrict();
				root.innerHTML = "";
				const rendered = soy.renderAsElement(bazelFlagsCommandsTable, {
					commands: commands,
				});
				root.appendChild(rendered);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}
}

/**
 * Group page at /bazel/flags/tag/<tag>: lists every flag carrying <tag>.
 */
class BazelFlagsByTagComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {string} tagName
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, tagName, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {string} */
		this.tagName_ = tagName;
	}

	/**
	 * @override
	 */
	createDom() {
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				const flags = typed
					.getFlagList()
					.filter((/** @type {!BazelFlag} */ f) =>
						f.getTagList().includes(this.tagName_),
					);
				const items = buildFlagItems(flags, typed);

				const modules = createModuleMap(this.registry_);
				const maintainers = createMaintainersMap(this.registry_);
				let totalModuleVersions = 0;
				for (const module of modules.values()) {
					totalModuleVersions += module.getVersionsList().length;
				}

				const root = this.getElementStrict();
				root.innerHTML = "";
				const rendered = soy.renderAsElement(bazelFlagGroup, {
					title: `Flags tagged "${this.tagName_}"`,
					emptyMessage: `No flags carry tag "${this.tagName_}".`,
					items: items,
					registry: this.registry_,
					totalModules: modules.size,
					totalModuleVersions: totalModuleVersions,
					totalMaintainers: maintainers.size,
					totalPeople: computeTotalPeople(this.registry_),
					totalSymbols: computeTotalSymbols(this.registry_),
					topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
					totalBazelVersions: computeTotalBazelVersions(this.registry_),
					uiCommitSha: uiCommitSha,
				});
				root.appendChild(rendered);
				installFlagGroupSearch(rendered, items, (input, listener) => {
					this.getHandler().listen(input, events.EventType.INPUT, listener);
				});
				refreshBcrSidePaneBazelFlags(document.body, typed.getFlagList().length);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}
}

/**
 * Group page at /bazel/command/<command>: lists every flag whose
 * command_index includes the named command. If the command isn't in the DB
 * (typo or removed), shows an in-page blankslate.
 */
class BazelFlagsByCommandComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {string} commandName
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, commandName, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {string} */
		this.commandName_ = commandName;
	}

	/**
	 * @override
	 */
	createDom() {
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				const cmdIdx = typed.getCommandsList().indexOf(this.commandName_);

				const modules = createModuleMap(this.registry_);
				const maintainers = createMaintainersMap(this.registry_);
				let totalModuleVersions = 0;
				for (const module of modules.values()) {
					totalModuleVersions += module.getVersionsList().length;
				}

				const root = this.getElementStrict();
				root.innerHTML = "";

				if (cmdIdx < 0) {
					const rendered = soy.renderAsElement(bazelFlagGroup, {
						title: `Flags applicable to ${this.commandName_}`,
						emptyMessage: `No command named "${this.commandName_}".`,
						items: [],
						registry: this.registry_,
						totalModules: modules.size,
						totalModuleVersions: totalModuleVersions,
						totalMaintainers: maintainers.size,
						totalPeople: computeTotalPeople(this.registry_),
						totalSymbols: computeTotalSymbols(this.registry_),
						topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
						totalBazelVersions: computeTotalBazelVersions(this.registry_),
						uiCommitSha: uiCommitSha,
					});
					root.appendChild(rendered);
					installFlagGroupSearch(rendered, [], (input, listener) => {
						this.getHandler().listen(input, events.EventType.INPUT, listener);
					});
					return;
				}

				const flags = typed
					.getFlagList()
					.filter((/** @type {!BazelFlag} */ f) =>
						f.getCommandIndexList().includes(cmdIdx),
					);
				const items = buildFlagItems(flags, typed);
				const rendered = soy.renderAsElement(bazelFlagGroup, {
					title: `Flags applicable to ${this.commandName_}`,
					emptyMessage: `No flags applicable to "${this.commandName_}".`,
					items: items,
					registry: this.registry_,
					totalModules: modules.size,
					totalModuleVersions: totalModuleVersions,
					totalMaintainers: maintainers.size,
					totalPeople: computeTotalPeople(this.registry_),
					totalSymbols: computeTotalSymbols(this.registry_),
					topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
					totalBazelVersions: computeTotalBazelVersions(this.registry_),
					uiCommitSha: uiCommitSha,
				});
				root.appendChild(rendered);
				installFlagGroupSearch(rendered, items, (input, listener) => {
					this.getHandler().listen(input, events.EventType.INPUT, listener);
				});
				refreshBcrSidePaneBazelFlags(document.body, typed.getFlagList().length);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}
}
exports.BazelFlagsByCommandComponent = BazelFlagsByCommandComponent;

/**
 * Group page at /bazel/flags/category/<encoded-category>: lists every flag
 * whose canonical category title matches. The path segment is URL-encoded
 * because help category titles are full-sentence descriptions with spaces
 * and punctuation; we decodeURIComponent before comparing.
 */
class BazelFlagsByCategoryComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {string} encodedCategory The URL-encoded category from the path.
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, encodedCategory, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {string} */
		this.categoryName_ = decodeSafe(encodedCategory);
	}

	/**
	 * @override
	 */
	createDom() {
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();
		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				const flags = typed
					.getFlagList()
					.filter(
						(/** @type {!BazelFlag} */ f) =>
							f.getCategory() === this.categoryName_,
					);
				const items = buildFlagItems(flags, typed);

				const modules = createModuleMap(this.registry_);
				const maintainers = createMaintainersMap(this.registry_);
				let totalModuleVersions = 0;
				for (const module of modules.values()) {
					totalModuleVersions += module.getVersionsList().length;
				}

				const root = this.getElementStrict();
				root.innerHTML = "";
				const rendered = soy.renderAsElement(bazelFlagGroup, {
					title: `Flags in category "${this.categoryName_}"`,
					emptyMessage: `No flags found in category "${this.categoryName_}".`,
					items: items,
					registry: this.registry_,
					totalModules: modules.size,
					totalModuleVersions: totalModuleVersions,
					totalMaintainers: maintainers.size,
					totalPeople: computeTotalPeople(this.registry_),
					totalSymbols: computeTotalSymbols(this.registry_),
					topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
					totalBazelVersions: computeTotalBazelVersions(this.registry_),
					uiCommitSha: uiCommitSha,
				});
				root.appendChild(rendered);
				installFlagGroupSearch(rendered, items, (input, listener) => {
					this.getHandler().listen(input, events.EventType.INPUT, listener);
				});
				refreshBcrSidePaneBazelFlags(document.body, typed.getFlagList().length);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}
}

/**
 * decodeURIComponent that returns the input unchanged if decoding throws
 * (malformed %xx sequence). Belt-and-suspenders for hand-typed URLs.
 *
 * @param {string} s
 * @returns {string}
 */
function decodeSafe(s) {
	try {
		return decodeURIComponent(s);
	} catch (e) {
		return s;
	}
}

/**
 * Builds the [flag, description, current] row data shared between the all-
 * flags list and the tag/command group pages.
 *
 * @param {!Array<!BazelFlag>} flags
 * @param {!BazelFlagDb} db
 * @returns {!Array<!{flag: !BazelFlag, description: string, current: boolean}>}
 */
function buildFlagItems(flags, db) {
	const latestIdx = db.getBazelVersionsList().length - 1;
	return flags.map((flag) => ({
		flag: flag,
		description: flag.getDescriptionList().join(" "),
		current: latestIdx >= 0 && flag.getVersionIndexList().includes(latestIdx),
	}));
}

/**
 * Adds client-side filtering to a rendered bazelFlagGroup.
 *
 * @param {!Element} root
 * @param {!Array<!{flag: !BazelFlag, description: string, current: boolean}>} items
 * @param {function(!HTMLInputElement, function())} listen
 */
function installFlagGroupSearch(root, items, listen) {
	const input = /** @type {?HTMLInputElement} */ (
		root.querySelector(".js-flag-group-search-input")
	);
	const results = root.querySelector(".js-flag-group-search-results");
	if (!input || !results) return;

	listen(input, () => {
		const query = input.value.trim().toLowerCase();
		soy.renderElement(
			/** @type {!Element} */ (results),
			bazelFlagsResultsList,
			{ items: filterFlagItems(items, query) },
		);
	});
}

/**
 * @param {!Array<!{flag: !BazelFlag, description: string, current: boolean}>} items
 * @param {string} query lowercase trimmed query.
 * @returns {!Array<!{flag: !BazelFlag, description: string, current: boolean}>}
 */
function filterFlagItems(items, query) {
	if (!query) return items;
	const tokens = query.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return items;

	return items.filter((item) => {
		const name = item.flag.getName().toLowerCase();
		const short = item.flag.getShort().toLowerCase();
		const description = item.description.toLowerCase();
		return tokens.every(
			(token) =>
				name.includes(token) ||
				short.includes(token) ||
				description.includes(token),
		);
	});
}

/**
 * Detail page at /bazel/flags/<name>. Awaits the lazy-loaded BazelFlagDb,
 * then resolves <name> to a BazelFlag and renders the 2-panel detail.
 */
class BazelFlagDetailComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {string} flagName
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, flagName, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {string} */
		this.flagName_ = flagName;
	}

	/**
	 * @override
	 */
	createDom() {
		// Render a placeholder so we have a stable element to swap in/out.
		const placeholder = dom.createDom("div", { class: "p-3 color-fg-muted" });
		placeholder.textContent = "Loading flag database…";
		this.setElementInternal(placeholder);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		getApplication(this)
			.getBazelFlagDb()
			.then((db) => {
				if (this.isDisposed()) return;
				const typed = /** @type {!BazelFlagDb} */ (db);
				this.renderDetail_(typed);
				refreshBcrSidePaneBazelFlags(document.body, typed.getFlagList().length);
			})
			.catch((err) => {
				if (this.isDisposed()) return;
				const root = this.getElementStrict();
				root.innerHTML = "";
				const flash = dom.createDom("div", { class: "flash flash-error" });
				flash.textContent = `Failed to load flag database: ${err}`;
				root.appendChild(flash);
			});
	}

	/**
	 * @private
	 * @param {!BazelFlagDb} db
	 */
	renderDetail_(db) {
		const flag = db
			.getFlagList()
			.find((/** @type {!BazelFlag} */ f) => f.getName() === this.flagName_);

		const root = this.getElementStrict();
		root.innerHTML = "";

		if (!flag) {
			const blank = dom.createDom("div", { class: "blankslate p-3" });
			blank.textContent = `No flag named "${this.flagName_}" was found.`;
			root.appendChild(blank);
			return;
		}

		const versionList = db.getBazelVersionsList();
		const presentSet = new Set(flag.getVersionIndexList());
		const versions = versionList.map((v, i) => ({
			name: v,
			active: presentSet.has(i),
		}));

		const commandTable = db.getCommandsList();
		const presentCommandIdxes = new Set(flag.getCommandIndexList());
		/** @type {!Array<{name: string, active: boolean}>} */
		const commands = commandTable.map((name, i) => ({
			name: name,
			active: presentCommandIdxes.has(i),
		}));

		const modules = createModuleMap(this.registry_);
		const maintainers = createMaintainersMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of modules.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}

		const rendered = soy.renderAsElement(bazelFlagDetail, {
			registry: this.registry_,
			flag: flag,
			versions: versions,
			commands: commands,
			totalModules: modules.size,
			totalModuleVersions: totalModuleVersions,
			totalMaintainers: maintainers.size,
			totalPeople: computeTotalPeople(this.registry_),
			totalSymbols: computeTotalSymbols(this.registry_),
			topPrimaryLanguages: computeTopPrimaryLanguages(this.registry_, 10),
			totalBazelVersions: computeTotalBazelVersions(this.registry_),
			uiCommitSha: uiCommitSha,
		});
		root.appendChild(rendered);

		// Render the description as markdown so backticks become inline
		// code, paragraphs flow naturally despite hard-wrapped help text,
		// etc. Soy's {css('marked')} class is the marker formatMarkdownAll
		// picks up.
		formatMarkdownAll(/** @type {!Element} */ (rendered));
	}
}

/**
 * Substring filter on flag name + description. Returns flags in the order
 * they appear in the DB (already alphabetical).
 *
 * @param {!Array<!BazelFlag>} flags
 * @param {string} query lowercase trimmed query.
 * @returns {!Array<!BazelFlag>}
 */
function filterFlags(flags, query) {
	if (!query) return flags;
	const tokens = query.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return flags;

	return flags.filter((flag) => {
		const name = flag.getName().toLowerCase();
		// Only test description if name doesn't already match — saves work.
		for (const token of tokens) {
			if (name.includes(token)) continue;
			const desc = flag.getDescriptionList().join(" ").toLowerCase();
			if (!desc.includes(token)) return false;
		}
		return true;
	});
}
