goog.module("bcrfrontend.modules");

const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleDependency = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleDependency",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Attestations = goog.require(
	"proto.build.stack.bazel.registry.v1.Attestations",
);
const ModuleVersionPackages = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleVersionPackages",
);
const ModuleVersionSymbols = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleVersionSymbols",
);
const SymbolSource = goog.require(
	"proto.build.stack.bazel.symbol.v1.SymbolSource",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const asserts = goog.require("goog.asserts");
const dom = goog.require("goog.dom");
const events = goog.require("goog.events");
const soy = goog.require("goog.soy");
const style = goog.require("goog.style");
const { Component, Route } = goog.require("stack.ui");
const { getApplication, gzipDecode } = goog.require("bcrfrontend.common");
const { ContentComponent } = goog.require("bcrfrontend.ContentComponent");
const { ContentSelect } = goog.require("bcrfrontend.ContentSelect");
const { ModuleVersionSymbolsSelect, DocumentationReadmeComponent } =
	goog.require("bcrfrontend.documentation");
const { ModuleVersionPackagesSelect, buildNavTargetGroups } =
	goog.require("bcrfrontend.packages");
const { PresubmitSelect } = goog.require("bcrfrontend.presubmit");
const {
	SourceArchiveFileSelect,
	KIND_OVERLAY,
	KIND_PATCHES,
} = goog.require("bcrfrontend.sourceArchiveFiles");
const { MvsDependencyTree } = goog.require("bcrfrontend.mvs_tree");
const { SelectNav } = goog.require("bcrfrontend.SelectNav");
const { isDocumentDisplayModeMaintainer } = goog.require(
	"bcrfrontend.settings",
);
const {
	moduleBlankslateComponent,
	moduleSearchComponent,
	moduleSelect,
	modulesMapSelect,
	modulesMapSelectNav,
	moduleVersionBlankslateComponent,
	moduleVersionComponent,
	moduleVersionDependenciesComponent,
	moduleVersionDependentsComponent,
	moduleVersionSelectNav,
	moduleVersionsFilterSelect,
	searchModulesResultsList,
} = goog.require("soy.bcrfrontend.app");
const { attestationsTabContent, moduleVersionsListComponent } =
	goog.require("soy.registry");
const { sourceSelect } = goog.require("soy.bcrfrontend.packages");
const { computeLanguageData, sanitizeLanguageName, unsanitizeLanguageName } =
	goog.require("bcrfrontend.language");
const {
	calculateAgeSinceLatestVersion,
	calculateAgeSummary,
	computeTotalBazelVersions,
	computeTotalSymbols,
	createMaintainersMap,
	createModuleMap,
	createModuleVersionMap,
	getLatestModuleVersion,
	getLatestModuleVersions,
	getLatestModuleVersionsByName,
	getModuleDirectDeps,
	getVersionDistances,
	getYankedMap,
	refreshBcrSidePaneSymbols,
} = goog.require("bcrfrontend.registry");
const { formatDate, formatRelativePast } = goog.require("bcrfrontend.format");
const { highlightAll } = goog.require("bcrfrontend.syntax");
const { commitSha: uiCommitSha } = goog.require("bcrfrontend.uiVersion");

/**
 * Fetch documentation for a module version from the site assets.
 * @param {!ModuleVersion} moduleVersion
 * @returns {!Promise<?ModuleVersionSymbols>}
 */
async function fetchModuleVersionSymbolsFromGithubRepository(moduleVersion) {
	const name = moduleVersion.getName();
	const version = moduleVersion.getVersion();
	const baseUrl =
		new URLSearchParams(window.location.search).get("modules_base_url") || "";
	const url = `${baseUrl}/modules/${name}/${version}/documentationinfo.pb.gz`;
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const gzipData = new Uint8Array(await response.arrayBuffer());
		const decompressed = await gzipDecode(gzipData);
		return ModuleVersionSymbols.deserializeBinary(decompressed);
	} catch (/** @type {*} */ e) {
		console.error(`Failed to fetch docs for ${name}@${version}:`, e);
		return null;
	}
}

/**
 * Fetch BUILD-file extraction (ModuleVersionPackages) for a module version
 * from the site assets. Used as a fallback when the registry-wide
 * packages.pb.gz didn't carry data for this version (e.g. older versions not
 * selected by MVS, but whose per-version artifact was committed to the site
 * repo).
 * @param {!ModuleVersion} moduleVersion
 * @returns {!Promise<?ModuleVersionPackages>}
 */
async function fetchModuleVersionPackagesFromGithubRepository(moduleVersion) {
	const name = moduleVersion.getName();
	const version = moduleVersion.getVersion();
	const baseUrl =
		new URLSearchParams(window.location.search).get("modules_base_url") || "";
	const url = `${baseUrl}/modules/${name}/${version}/packageinfo.pb.gz`;
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const gzipData = new Uint8Array(await response.arrayBuffer());
		const decompressed = await gzipDecode(gzipData);
		return ModuleVersionPackages.deserializeBinary(decompressed);
	} catch (/** @type {*} */ e) {
		console.error(`Failed to fetch packages for ${name}@${version}:`, e);
		return null;
	}
}

/**
 * @enum {string}
 */
const TabName = {
	DOCS: "docs",
	LIST: "list",
	OVERVIEW: "overview",
	SOURCE: "source",
	TESTING: "testing",
};

/**
 * Sub-tabs rendered inside the Source tab's right-hand pane.
 * @enum {string}
 */
const SourceTabName = {
	PACKAGES: "packages",
	ATTESTATIONS: "attestations",
	OVERLAY: "overlay",
	PATCHES: "patches",
};

/**
 * @enum {string}
 */
const ModulesListTabName = {
	ALL: "all",
	SEARCH: "search",
};

class ModulesMapSelect extends ContentSelect {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Map<string,!Module>} */
		this.modules_ = createModuleMap(registry);
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(modulesMapSelect));
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
				name,
				new ModulesMapSelectNav(this.registry_, this.modules_, this.dom_),
			);
			this.select(name, route);
			return;
		}

		const module = this.modules_.get(name);
		if (module) {
			this.addTab(
				name,
				new ModuleSelect(name, this.registry_, module, this.dom_),
			);
			this.select(name, route);
			return;
		}

		this.addTab(name, new ModuleBlankslateComponent(name, this.dom_));
		this.select(name, route);
	}
}
exports.ModulesMapSelect = ModulesMapSelect;

class ModuleSelect extends ContentSelect {
	/**
	 * @param {string} name
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(name, registry, module, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {string} */
		this.moduleName_ = name;

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.latest_ = getLatestModuleVersion(module);

		/** @private @const @type {!Map<string,!ModuleVersion>} */
		this.moduleVersions_ = createModuleVersionMap(module);
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(moduleSelect, {
				name: this.moduleName_,
				module: this.module_,
			}),
		);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(
			this.latest_.getVersion(),
			route.add(this.latest_.getVersion()),
		);
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === "latest") {
			this.addTab(
				name,
				new ModuleVersionSelectNav(this.registry_, this.module_, this.latest_),
			);
			this.select(name, route);
			return;
		}

		const moduleVersion = this.moduleVersions_.get(name);
		if (moduleVersion) {
			this.addTab(
				name,
				new ModuleVersionSelectNav(this.registry_, this.module_, moduleVersion),
			);
			this.select(name, route);
			return;
		}

		this.addTab(name, new ModuleVersionBlankslateComponent(this.module_, name));
		this.select(name, route);
	}
}

/**
 * @typedef {{
 *   name: string,
 *   sanitizedName: string
 * }}
 */
let Language;

/**
 * @typedef {{
 *   version: string,
 *   compat: number,
 *   commitDate: string,
 *   directDeps: !Array<!ModuleDependency>
 * }}
 */
let VersionData;

// Global cache for version data computation
/** @type {!Map<string, {versionData: !Array<!VersionData>, totalDeps: number}>} */
const versionDataCache = new Map();

/**
 * Get cached version data for a module, computing it if not cached
 * @param {!Registry} registry
 * @param {!Module} module
 * @returns {{versionData: !Array<!VersionData>, totalDeps: number}}
 */
function getCachedVersionData(registry, module) {
	const cacheKey = `${module.getName()}@${registry.getCommitSha()}`;

	if (versionDataCache.has(cacheKey)) {
		return versionDataCache.get(cacheKey);
	}

	/** @type {!Array<!VersionData>} */
	const versionData = [];
	let totalDeps = 0;
	const versions = module.getVersionsList().slice();
	versions.sort((a, b) => {
		return (
			new Date(b.getCommit().getDate()) - new Date(a.getCommit().getDate())
		);
	});

	for (let i = 0; i < versions.length; i++) {
		const v = versions[i];
		const directDeps = getModuleDirectDeps(registry, module, v.getVersion());
		totalDeps += directDeps.length;

		// Calculate age summary from previous version
		let ageSummary = null;
		if (i < versions.length - 1) {
			const currentCommit = v.getCommit();
			const prevCommit = versions[i + 1].getCommit();
			if (!currentCommit || !prevCommit) {
				ageSummary = "(no commit)";
			} else {
				const currentDate = new Date(currentCommit.getDate());
				const prevDate = new Date(prevCommit.getDate());
				const diffMs = currentDate - prevDate;
				const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
				if (totalDays > 0) {
					ageSummary = calculateAgeSummary(totalDays);
				} else if (totalDays === 0) {
					// Same day release - calculate hours
					const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
					if (totalHours > 0) {
						ageSummary = `${totalHours}h`;
					} else {
						ageSummary = "<1h";
					}
				} else {
					// negative days - should not happen given we sorted by date
					// already!
					ageSummary = calculateAgeSummary(totalDays);
				}
			}
		}

		versionData.push(
			/** @type{!VersionData} **/ ({
				version: v.getVersion(),
				compat: v.getCompatibilityLevel(),
				commitDate: formatDate(v.getCommit().getDate()),
				directDeps,
				ageSummary,
			}),
		);
	}

	const result = { versionData, totalDeps };
	versionDataCache.set(cacheKey, result);

	return result;
}

class ModuleVersionSelectNav extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {{versionData: !Array<!VersionData>, totalDeps: number}} */
		this.versionData_ = getCachedVersionData(registry, module);
	}

	/**
	 * @override
	 */
	createDom() {
		const { versionData, totalDeps } = this.versionData_;
		const timeSinceLatest = calculateAgeSinceLatestVersion(this.module_);

		this.setElementInternal(
			soy.renderAsElement(moduleVersionSelectNav, {
				moduleVersion: this.moduleVersion_,
				metadata: asserts.assertObject(this.module_.getMetadata()),
				versionData,
				totalDeps,
				timeSinceLatest,
			}),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return TabName.OVERVIEW;
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.addNavTabLazy(
			TabName.OVERVIEW,
			"Overview",
			"Module Version Overview",
			undefined,
			`${this.getPathUrl()}/${TabName.OVERVIEW}`,
			() =>
				new ModuleVersionComponent(
					this.registry_,
					this.module_,
					this.moduleVersion_,
					this.versionData_,
				),
		);

		// Source tab: aggregates Source Details, packages, attestations, and
		// overlay/patch files into one place. Deferred because we wait on the
		// packages aggregate fetch so the left-pane SideNav (rule-kind tree)
		// can be rendered up-front; subsequent activations hit the cache.
		this.addNavTabDeferred(
			TabName.SOURCE,
			"Source",
			"Source archive, packages, attestations, overlay, and patches",
			undefined,
			`${this.getPathUrl()}/${TabName.SOURCE}`,
		);

		// Add docs nav tab link - component will be added lazily in selectFail
		// (the DOCS branch waits for the symbols proto to load first).
		this.addNavTabDeferred(
			TabName.DOCS,
			"Documentation",
			"Generated Stardoc Documentation",
			undefined,
			`${this.getPathUrl()}/${TabName.DOCS}`,
		);

		const presubmit = this.moduleVersion_.getPresubmit();
		this.addNavTabLazy(
			TabName.TESTING,
			"Testing",
			"Test Configuration",
			undefined,
			`${this.getPathUrl()}/${TabName.TESTING}`,
			() =>
				new PresubmitSelect(
					this.registry_,
					this.module_,
					this.moduleVersion_,
					presubmit || null,
				),
		);
	}

	/**
	 * @override
	 * @param {string} name
	 * @param {!Route} route
	 */
	selectFail(name, route) {
		if (name === TabName.DOCS) {
			// Lazy load documentation tab - wait for symbols to be available.
			// The user can navigate away before either fetch settles; guard
			// each .then so we don't write to a disposed component.
			getApplication(this)
				.getRegistryWithSymbols()
				.then(() => {
					if (this.isDisposed()) return null;
					const docs = this.moduleVersion_.getSource()?.getDocumentation();
					// In-bundle docs with files: render directly.
					if (docs && docs.getFileList().length > 0) {
						return docs;
					}
					// Empty BEST_EFFORT marker means registry compile-time knew
					// there are no .bzl files to extract — skip the fetch (it
					// would 404) and let the blankslate render.
					if (
						docs &&
						docs.getSource() === SymbolSource.BEST_EFFORT &&
						docs.getFileList().length === 0
					) {
						return docs;
					}
					return fetchModuleVersionSymbolsFromGithubRepository(
						this.moduleVersion_,
					);
				})
				.then((/** @type {?ModuleVersionSymbols} */ docs) => {
					if (this.isDisposed()) return;
					// Use addTab since nav item was already added via addNavTabDeferred
					this.addTab(
						TabName.DOCS,
						new ModuleVersionSymbolsSelect(
							this.module_,
							this.moduleVersion_,
							docs || null,
						),
					);
					this.select(name, route);
				});
			return;
		}

		if (name === TabName.SOURCE) {
			// Wait for the registry-wide packages aggregate (cached after the
			// first call), then fall back to a per-version packageinfo.pb.gz
			// fetch for older versions whose entry wasn't aggregated. After
			// the fetch settles we instantiate SourceSelect so its left-pane
			// SideNav has data on first paint.
			getApplication(this)
				.getRegistryWithPackages()
				.then(() => {
					if (this.isDisposed()) return null;
					const pkgs = this.moduleVersion_.getSource()?.getPackages();
					if (pkgs && pkgs.getPackageList().length > 0) {
						return pkgs;
					}
					if (
						pkgs &&
						pkgs.getSource() === SymbolSource.BEST_EFFORT &&
						pkgs.getPackageList().length === 0
					) {
						return pkgs;
					}
					return fetchModuleVersionPackagesFromGithubRepository(
						this.moduleVersion_,
					);
				})
				.then((/** @type {?ModuleVersionPackages} */ pkgs) => {
					if (this.isDisposed()) return;
					this.addTab(
						TabName.SOURCE,
						new SourceSelect(
							this.registry_,
							this.module_,
							this.moduleVersion_,
							pkgs || null,
						),
					);
					this.select(name, route);
				});
			return;
		}

		super.selectFail(name, route);
	}
}

class ModuleVersionComponent extends Component {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {{versionData: !Array<!VersionData>, totalDeps: number}} versionData
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, versionData, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {{versionData: !Array<!VersionData>, totalDeps: number}} */
		this.versionData_ = versionData;
	}

	/**
	 * @override
	 */
	createDom() {
		const { versionData, totalDeps } = this.versionData_;

		this.setElementInternal(
			soy.renderAsElement(
				moduleVersionComponent,
				{
					module: this.module_,
					metadata: asserts.assertObject(this.module_.getMetadata()),
					deps: this.moduleVersion_.getDepsList().filter((d) => !d.getDev()),
					devDeps: this.moduleVersion_.getDepsList().filter((d) => d.getDev()),
					moduleVersion: this.moduleVersion_,
					yanked: getYankedMap(this.module_.getMetadata()),
					commitDate: formatRelativePast(
						this.moduleVersion_.getCommit().getDate(),
					),
					languageData: computeLanguageData(
						this.module_.getRepositoryMetadata(),
					),
					versionData,
					totalDeps,
				},
				{
					repositoryUrl: this.registry_.getRepositoryUrl(),
					repositoryCommit: this.registry_.getCommitSha(),
					latestVersions: getLatestModuleVersionsByName(this.registry_),
					versionDistances: getVersionDistances(this.registry_),
				},
			),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		highlightAll(this.getElementStrict());

		this.enterDependencies();
		if (isDocumentDisplayModeMaintainer()) {
			this.enterDevDependencies();
			this.enterDependents();
		}
		this.enterReadme();
	}

	enterDependencies() {
		const deps = this.moduleVersion_.getDepsList().filter((d) => !d.getDev());
		if (deps.length > 0) {
			const depsEl = dom.getRequiredElementByClass(
				goog.getCssName("deps"),
				this.getElementStrict(),
			);
			const depsComponent = new ModuleVersionDependenciesComponent(
				this.registry_,
				this.module_,
				this.moduleVersion_,
				false,
				"Dependencies",
			);
			this.addChild(depsComponent, false);
			depsComponent.render(depsEl);
		}
	}

	enterDevDependencies() {
		const deps = this.moduleVersion_.getDepsList().filter((d) => d.getDev());
		if (deps.length > 0) {
			const depsEl = dom.getRequiredElementByClass(
				goog.getCssName("dev-deps"),
				this.getElementStrict(),
			);
			const depsComponent = new ModuleVersionDependenciesComponent(
				this.registry_,
				this.module_,
				this.moduleVersion_,
				true,
				"Dev Dependencies",
			);
			this.addChild(depsComponent, false);
			depsComponent.render(depsEl);
		}
	}

	enterDependents() {
		const deps = getModuleDirectDeps(
			this.registry_,
			this.module_,
			this.moduleVersion_.getVersion(),
		);
		if (deps.length > 0) {
			const depsEl = dom.getRequiredElementByClass(
				goog.getCssName("dependents"),
				this.getElementStrict(),
			);
			// Convert ModuleVersion to ModuleDependency for the component
			const moduleDeps = deps.map((mv) => {
				const dep = new ModuleDependency();
				dep.setName(mv.getName());
				dep.setVersion(mv.getVersion());
				return dep;
			});
			const depsComponent = new ModuleVersionDependentsComponent(
				this.registry_,
				this.module_,
				this.moduleVersion_,
				moduleDeps,
				"Used By",
			);
			this.addChild(depsComponent, false);
			depsComponent.render(depsEl);
		}
	}

	enterReadme() {
		const readmeEl = dom.getRequiredElementByClass(
			goog.getCssName("readme"),
			this.getElementStrict(),
		);
		const component = new DocumentationReadmeComponent(
			this.module_,
			this.moduleVersion_,
			this.dom_,
		);
		this.addChild(component, false);
		component.render(readmeEl);
	}
}

class ModuleVersionDependenciesComponent extends ContentComponent {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {boolean} dev
	 * @param {string} title
	 * @param {!Array<!ModuleDependency>=} opt_deps
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(
		registry,
		module,
		moduleVersion,
		dev,
		title,
		opt_deps,
		opt_domHelper,
	) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {boolean} */
		this.dev_ = dev;

		/** @private @const @type {string} */
		this.title_ = title;

		/** @private @const @type {!Array<!ModuleDependency>} */
		this.deps_ = opt_deps || [];

		/** @private @type {?MvsDependencyTree} */
		this.treeComponent_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		const deps =
			this.deps_.length > 0
				? this.deps_
				: this.moduleVersion_
						.getDepsList()
						.filter((d) => d.getDev() === this.dev_);

		// Get the set of module names in this dependency list
		const depModuleNames = new Set(deps.map((d) => d.getName()));

		// Filter overrides to only include those for modules in this dependency list
		const overrides = this.moduleVersion_
			.getOverrideList()
			.filter((override) => depModuleNames.has(override.getModuleName()));

		this.setElementInternal(
			soy.renderAsElement(
				moduleVersionDependenciesComponent,
				{
					title: this.title_,
					deps: deps,
					overrides: overrides,
				},
				{
					latestVersions: getLatestModuleVersionsByName(this.registry_),
					versionDistances: getVersionDistances(this.registry_),
				},
			),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		highlightAll(this.getElementStrict());

		this.enterListButton();
		this.enterTreeButton();
	}

	enterListButton() {
		this.getHandler().listen(
			this.getCssElement(goog.getCssName("btn-list")),
			events.EventType.CLICK,
			this.handleListButtonElementClick,
		);
	}

	enterTreeButton() {
		this.getHandler().listen(
			this.getCssElement(goog.getCssName("btn-tree")),
			events.EventType.CLICK,
			this.handleTreeButtonElementClick,
		);
	}

	/**
	 * @param {!events.Event} e
	 */
	handleListButtonElementClick(e) {
		this.toggleContentElements(false);
	}

	/**
	 * @param {!events.Event} e
	 */
	handleTreeButtonElementClick(e) {
		this.toggleContentElements(true);
	}

	/**
	 * @param {boolean} displayTree
	 */
	toggleContentElements(displayTree) {
		const contentEl = this.getContentElement();
		const treeContentEl = this.getTreeContentElement();
		const btnListEl = this.getListButtonElement();
		const btnTreeEl = this.getTreeButtonElement();

		if (displayTree && !this.treeComponent_) {
			this.enterTreeComponent(treeContentEl);
		}

		const displayContentEl = displayTree ? treeContentEl : contentEl;
		const hideContentEl = displayTree ? contentEl : treeContentEl;
		const selectButtonEl = displayTree ? btnTreeEl : btnListEl;
		const unselectButtonEl = displayTree ? btnListEl : btnTreeEl;

		style.setElementShown(displayContentEl, true);
		style.setElementShown(hideContentEl, false);

		dom.classlist.add(selectButtonEl, "selected");
		dom.classlist.remove(unselectButtonEl, "selected");
	}

	/**
	 * @param {!Element} treeContentEl The elenent to render the tree into.
	 * @returns
	 */
	enterTreeComponent(treeContentEl) {
		const app = getApplication(this);
		const mvs = app.getMvs();
		const moduleName = this.moduleVersion_.getName();
		const version = this.moduleVersion_.getVersion();

		/** @type {string|boolean} */
		const modifier = this.dev_ ? "only" : false;

		const treeComponent = (this.treeComponent_ = new MvsDependencyTree(
			moduleName,
			version,
			mvs,
			modifier,
			this.dom_,
		));
		this.addChild(treeComponent, false);
		treeComponent.render(treeContentEl);
	}

	/**
	 * @return {!Element} Element to contain the mvs tree.
	 */
	getTreeContentElement() {
		return this.getCssElement(goog.getCssName("tree-content"));
	}

	/**
	 * @return {!Element}.
	 */
	getListButtonElement() {
		return this.getCssElement(goog.getCssName("btn-list"));
	}

	/**
	 * @return {!Element}.
	 */
	getTreeButtonElement() {
		return this.getCssElement(goog.getCssName("btn-tree"));
	}
}

class ModuleVersionDependentsComponent extends ContentComponent {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!Array<!ModuleDependency>} directDeps
	 * @param {string} title
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(
		registry,
		module,
		moduleVersion,
		directDeps,
		title,
		opt_domHelper,
	) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {!Array<!ModuleDependency>} */
		this.directDeps_ = directDeps;

		/** @private @const @type {string} */
		this.title_ = title;

		/** @private @type {?Object} */
		this.matrixData_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(moduleVersionDependentsComponent, {
				title: this.title_,
				deps: this.directDeps_,
			}),
		);
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.enterListButton();
		this.enterTableButton();

		this.enterTableContent(this.getTableContentElement());
	}

	enterListButton() {
		this.getHandler().listen(
			this.getCssElement(goog.getCssName("btn-list")),
			events.EventType.CLICK,
			this.handleListButtonElementClick,
		);
	}

	enterTableButton() {
		this.getHandler().listen(
			this.getCssElement(goog.getCssName("btn-table")),
			events.EventType.CLICK,
			this.handleTableButtonElementClick,
		);
	}

	/**
	 * @param {!events.Event} e
	 */
	handleListButtonElementClick(e) {
		this.toggleContentElements(false);
	}

	/**
	 * @param {!events.Event} e
	 */
	handleTableButtonElementClick(e) {
		this.toggleContentElements(true);
	}

	/**
	 * @param {boolean} displayTable
	 */
	toggleContentElements(displayTable) {
		const listContentEl = this.getListContentElement();
		const tableContentEl = this.getTableContentElement();
		const btnListEl = this.getListButtonElement();
		const btnTableEl = this.getTableButtonElement();

		if (displayTable && !this.matrixData_) {
			this.enterTableContent(tableContentEl);
		}

		const displayContentEl = displayTable ? tableContentEl : listContentEl;
		const hideContentEl = displayTable ? listContentEl : tableContentEl;
		const selectButtonEl = displayTable ? btnTableEl : btnListEl;
		const unselectButtonEl = displayTable ? btnListEl : btnTableEl;

		style.setElementShown(displayContentEl, true);
		style.setElementShown(hideContentEl, false);

		dom.classlist.add(selectButtonEl, "selected");
		dom.classlist.remove(unselectButtonEl, "selected");
	}

	/**
	 * @param {!Element} tableContentEl The element to render the table into.
	 */
	enterTableContent(tableContentEl) {
		// Calculate matrix data
		this.matrixData_ = this.getDependentsByVersion();

		// Render the table
		this.renderDependentsMatrix(tableContentEl, this.matrixData_);
	}

	/**
	 * Get dependents organized by module and version.
	 * Returns a structure showing which modules depend on each version of the current module.
	 * Only shows versions from the current version backwards, and each dependent appears only once
	 * at the newest version it depends on (the "front").
	 * @return {{modules: !Array<string>, versions: !Array<string>, matrix: !Map<string, string>}}
	 */
	getDependentsByVersion() {
		const moduleName = this.moduleVersion_.getName();
		const module = this.module_;
		const currentVersion = this.moduleVersion_.getVersion();

		// Get all versions in order (newest to oldest)
		const allVersions = module.getVersionsList().map((v) => v.getVersion());

		// Find index of current version
		const currentIndex = allVersions.indexOf(currentVersion);
		if (currentIndex === -1) {
			return { modules: [], versions: [], matrix: new Map() };
		}

		// Only show versions from current backwards (current version and older)
		const versions = allVersions.slice(currentIndex);

		// Map to track the newest version each module depends on
		// Structure: moduleDepName -> version (the newest/front version)
		/** @type {!Map<string, string>} */
		const dependentsMap = new Map();

		// Iterate through all modules in the registry
		for (const depModule of this.registry_.getModulesList()) {
			if (depModule.getName() === moduleName) {
				continue;
			}

			const depModuleName = depModule.getName();

			// Check all versions of this dependent module
			for (const depModuleVersion of depModule.getVersionsList()) {
				for (const dep of depModuleVersion.getDepsList()) {
					if (dep.getName() === moduleName) {
						const version = dep.getVersion();

						// Only consider versions in our range (current and older)
						if (!versions.includes(version)) {
							continue;
						}

						// If we haven't seen this dependent yet, or if this version is newer
						// than what we've seen, update it
						const existingVersion = dependentsMap.get(depModuleName);
						if (!existingVersion) {
							dependentsMap.set(depModuleName, version);
						} else {
							// Check if this version is newer (earlier in the versions array)
							const existingIndex = versions.indexOf(existingVersion);
							const newIndex = versions.indexOf(version);
							if (newIndex < existingIndex) {
								dependentsMap.set(depModuleName, version);
							}
						}
					}
				}
			}
		}

		// Get unique versions that actually have dependents
		/** @type {!Set<string>} */
		const usedVersions = new Set(dependentsMap.values());
		/** @type {function(string): boolean} */
		const hasVersion = (v) => usedVersions.has(v);
		const filteredVersions = versions.filter(hasVersion);

		// Sort modules by their front version (newest first)
		// This makes checkmarks appear more to the left at the top, moving right as you scroll down
		const moduleNames = Array.from(dependentsMap.keys()).sort(
			/**
			 * @param {string} a
			 * @param {string} b
			 * @returns {number}
			 */
			(a, b) => {
				const versionA = dependentsMap.get(a);
				const versionB = dependentsMap.get(b);

				if (!versionA || !versionB) {
					return 0;
				}

				const indexA = filteredVersions.indexOf(versionA);
				const indexB = filteredVersions.indexOf(versionB);

				// Sort by version index (earlier index = newer version = top of list)
				return indexA - indexB;
			},
		);

		return {
			modules: moduleNames,
			versions: filteredVersions,
			matrix: dependentsMap,
		};
	}

	/**
	 * Render the dependents matrix as a table.
	 * @param {!Element} container
	 * @param {{modules: !Array<string>, versions: !Array<string>, matrix: !Map<string, string>}} data
	 */
	renderDependentsMatrix(container, data) {
		// Wrapper for horizontal scroll with grab cursor.
		// NOTE: every attribute key here is quoted on purpose. Closure
		// Compiler ADVANCED renames unquoted property keys, which silently
		// strips `class`/`style` attributes from the rendered DOM.
		const wrapper = dom.createDom("div", {
			"class": "m-1 dependents-matrix",
			"style": "overflow-x: scroll; cursor: grab;",
			"onmousedown": /** @this {!HTMLElement} */ function () {
				this.style.cursor = "grabbing";
			},
			"onmouseup": /** @this {!HTMLElement} */ function () {
				this.style.cursor = "grab";
			},
			"onmouseleave": /** @this {!HTMLElement} */ function () {
				this.style.cursor = "grab";
			},
		});

		const table = dom.createDom("table", {
			"class": "width-full p-0",
			"style": "border-collapse: collapse;",
		});

		// Header row
		const thead = dom.createDom("thead");
		const headerRow = dom.createDom("tr");

		const moduleHeader = dom.createDom("th", {
			"class": "text-left p-1 pr-2 position-sticky color-bg-default",
			"style": "z-index: 2; left: 0;",
		});
		dom.appendChild(headerRow, moduleHeader);

		for (const version of data.versions) {
			const headerContent = dom.createDom(
				"div",
				{
					"style":
						"writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; min-height: 100px; display: flex; align-items: flex-end; justify-content: flex-start;",
				},
				version,
			);

			const th = dom.createDom(
				"th",
				{
					"class": "text-left text-small p-1 pl-2",
				},
				headerContent,
			);
			dom.appendChild(headerRow, th);
		}
		dom.appendChild(thead, headerRow);
		dom.appendChild(table, thead);

		// Body rows
		const tbody = dom.createDom("tbody");
		for (const moduleName of data.modules) {
			const frontVersion = data.matrix.get(moduleName);

			// Skip if no version (shouldn't happen, but be safe)
			if (!frontVersion) {
				continue;
			}

			const row = dom.createDom("tr");

			// Get the latest version of the dependent module
			const depModule = this.registry_
				.getModulesList()
				.find((m) => m.getName() === moduleName);
			const latestVersion = depModule
				? depModule.getVersionsList()[0].getVersion()
				: "";

			// Match the styling used by moduleDependencyRow (registry.soy):
			// the name carries the link's default weight, the version
			// renders alongside it via `ml-1 text-light text-small`. We
			// keep the matrix's "version then name" reading order, so the
			// version comes first with `mr-1 text-light text-small`.
			const versionText = dom.createDom(
				"span",
				{ "class": "mr-1 text-light text-small" },
				latestVersion,
			);
			const moduleNameText = dom.createDom(
				"span",
				{ "class": "text-bold" },
				moduleName,
			);
			const moduleLink = dom.createDom(
				"a",
				{
					"href": `/modules/${moduleName}/${latestVersion}`,
					"class": "Box-row-link no-wrap",
				},
				[versionText, moduleNameText],
			);

			const moduleCell = dom.createDom(
				"td",
				{
					"class": "p-1 pr-2 position-sticky text-right color-bg-default",
					"style": "left: 0; white-space: nowrap;",
				},
				moduleLink,
			);
			dom.appendChild(row, moduleCell);

			// Render cells - only mark the front version
			for (const version of data.versions) {
				const isAtFront = version === frontVersion;
				const cellClasses = isAtFront
					? "text-center p-1 border color-bg-success"
					: "text-center p-1 border color-bg-subtle";
				const cell = dom.createDom(
					"td",
					{
						"class": cellClasses,
						"style": "max-width: 2em; width: 2em;",
					},
					isAtFront ? "•" : "",
				);
				dom.appendChild(row, cell);
			}
			dom.appendChild(tbody, row);
		}
		dom.appendChild(table, tbody);

		dom.appendChild(wrapper, table);
		dom.appendChild(container, wrapper);
	}

	/**
	 * @return {!Element}
	 */
	getListContentElement() {
		return this.getCssElement(goog.getCssName("list-content"));
	}

	/**
	 * @return {!Element}
	 */
	getTableContentElement() {
		return this.getCssElement(goog.getCssName("table-content"));
	}

	/**
	 * @return {!Element}
	 */
	getListButtonElement() {
		return this.getCssElement(goog.getCssName("btn-list"));
	}

	/**
	 * @return {!Element}
	 */
	getTableButtonElement() {
		return this.getCssElement(goog.getCssName("btn-table"));
	}
}

class AttestationsComponent extends ContentComponent {
	/**
	 * @param {!ModuleVersion} moduleVersion
	 * @param {!Attestations} attestations Empty Attestations() is valid;
	 *   the soy template renders a blankslate when the map is empty.
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(moduleVersion, attestations, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;

		/** @private @const @type {!Attestations} */
		this.attestations_ = attestations;
	}

	/** @override */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(attestationsTabContent, {
				moduleVersion: this.moduleVersion_,
				attestations: this.attestations_,
			}),
		);
	}
}

/**
 * Two-pane SelectNav that hosts the Source tab. Left pane shows
 * moduleSourceTable + (if packages) packagesNavSection; right pane is a
 * sub-tab selector across packages/attestations/overlay/patches.
 */
class SourceSelect extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {!Module} module
	 * @param {!ModuleVersion} moduleVersion
	 * @param {?ModuleVersionPackages} packages Packages aggregate for this
	 *   module-version (or null if data wasn't available).
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, module, moduleVersion, packages, opt_domHelper) {
		super(opt_domHelper);
		/** @private @const @type {!Registry} */
		this.registry_ = registry;
		/** @private @const @type {!Module} */
		this.module_ = module;
		/** @private @const @type {!ModuleVersion} */
		this.moduleVersion_ = moduleVersion;
		/** @private @const @type {?ModuleVersionPackages} */
		this.packages_ = packages;
	}

	/** @override */
	createDom() {
		const navTargetGroups =
			this.packages_ && this.packages_.getPackageList().length > 0
				? buildNavTargetGroups(this.packages_)
				: [];
		this.setElementInternal(
			soy.renderAsElement(
				sourceSelect,
				{
					moduleVersion: this.moduleVersion_,
					navTargetGroups,
				},
				// moduleSourceTable (called via sourceSelect's left pane)
				// references the bcrModuleVersionPatch/OverlayFileUrl helpers
				// which take repositoryUrl + repositoryCommit as @inject params.
				{
					repositoryUrl: this.registry_.getRepositoryUrl(),
					repositoryCommit: this.registry_.getCommitSha(),
				},
			),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		if (this.packages_ && this.packages_.getPackageList().length > 0) {
			return SourceTabName.PACKAGES;
		}
		return SourceTabName.ATTESTATIONS;
	}

	/** @override */
	enterDocument() {
		super.enterDocument();

		const moduleVersion = this.moduleVersion_;
		const source = moduleVersion.getSource();

		// Packages — conditional. Reuses ModuleVersionPackagesSelect so nested
		// /source/packages/<pkg-path> routing keeps working.
		const packages = this.packages_;
		if (packages && packages.getPackageList().length > 0) {
			const nonNullPackages = asserts.assert(packages);
			this.addNavTabLazy(
				SourceTabName.PACKAGES,
				"Packages",
				"BUILD-file targets",
				packages.getPackageList().length,
				`${this.getPathUrl()}/${SourceTabName.PACKAGES}`,
				() =>
					new ModuleVersionPackagesSelect(
						this.module_,
						this.moduleVersion_,
						nonNullPackages,
						this.dom_,
					),
			);
		}

		// Attestations — always registered; soy template handles blankslate.
		const attestations =
			moduleVersion.getAttestations() ?? new Attestations();
		const nonNullAttestations = asserts.assert(attestations);
		const attestationsCount =
			nonNullAttestations.getAttestationsMap()?.getLength() ?? 0;
		this.addNavTabLazy(
			SourceTabName.ATTESTATIONS,
			"Attestations",
			"Source attestations and supply-chain provenance",
			attestationsCount > 0 ? attestationsCount : undefined,
			`${this.getPathUrl()}/${SourceTabName.ATTESTATIONS}`,
			() => new AttestationsComponent(moduleVersion, nonNullAttestations),
		);

		// Overlay — conditional on at least one overlay file. Trie-routed file
		// browser; SourceArchiveFileSelect handles /<mod>/<ver>/source/overlay
		// and drills into /<filename> via greedy longest-prefix match.
		const overlayLen = source ? source.getOverlayMap().getLength() : 0;
		if (source && overlayLen > 0) {
			const nonNullSource = asserts.assert(source);
			this.addNavTabLazy(
				SourceTabName.OVERLAY,
				"Overlay",
				"Files added on top of the upstream source archive",
				overlayLen,
				`${this.getPathUrl()}/${SourceTabName.OVERLAY}`,
				() =>
					new SourceArchiveFileSelect(
						this.registry_,
						this.module_,
						moduleVersion,
						nonNullSource,
						KIND_OVERLAY,
					),
			);
		}

		// Patches — conditional on at least one patch file. Same Trie pattern
		// as overlay; renders the diff with Shiki's `diff` language.
		const patchesLen = source ? source.getPatchesMap().getLength() : 0;
		if (source && patchesLen > 0) {
			const nonNullSource = asserts.assert(source);
			this.addNavTabLazy(
				SourceTabName.PATCHES,
				"Patches",
				"Patches applied to the upstream source archive",
				patchesLen,
				`${this.getPathUrl()}/${SourceTabName.PATCHES}`,
				() =>
					new SourceArchiveFileSelect(
						this.registry_,
						this.module_,
						moduleVersion,
						nonNullSource,
						KIND_PATCHES,
					),
			);
		}
	}
}

class ModulesMapSelectNav extends SelectNav {
	/**
	 * @param {!Registry} registry
	 * @param {!Map<string,!Module>} modules
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, modules, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @const @type {!Map<string,!Module>} */
		this.modules_ = modules;

		/** @private @const @type {!Array<!ModuleVersion>} */
		this.all_ = getLatestModuleVersions(registry);
	}

	/**
	 * @override
	 */
	createDom() {
		const maintainers = createMaintainersMap(this.registry_);
		let totalModuleVersions = 0;
		for (const module of this.modules_.values()) {
			totalModuleVersions += module.getVersionsList().length;
		}
		this.setElementInternal(
			soy.renderAsElement(modulesMapSelectNav, {
				registry: this.registry_,
				totalModules: this.modules_.size,
				totalModuleVersions: totalModuleVersions,
				totalMaintainers: maintainers.size,
				totalSymbols: computeTotalSymbols(this.registry_),
				totalBazelVersions: computeTotalBazelVersions(this.registry_),
				uiCommitSha: uiCommitSha,
			}),
		);
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goHere(route) {
		this.select(ModulesListTabName.ALL, route.add(ModulesListTabName.ALL));
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.enterAllTab();
		this.enterSearchTab();

		getApplication(this)
			.getRegistryWithSymbols()
			.then(() => {
				if (this.isDisposed()) return;
				refreshBcrSidePaneSymbols(this.getElement(), this.registry_);
			});
	}

	enterSearchTab() {
		this.addNavTabLazy(
			ModulesListTabName.SEARCH,
			"Search",
			"Search modules",
			undefined,
			`${this.getPathUrl()}/${ModulesListTabName.SEARCH}`,
			() => new ModuleSearchComponent(this.registry_, this.dom_),
		);
	}

	enterAllTab() {
		this.addNavTabLazy(
			ModulesListTabName.ALL,
			"Modules",
			"All Modules",
			this.all_.length,
			`${this.getPathUrl()}/${ModulesListTabName.ALL}`,
			() => new ModuleVersionsFilterSelect(this.modules_, this.all_, this.dom_),
		);
	}

	/**
	 * @override
	 * @returns {string}
	 */
	getDefaultTabName() {
		return ModulesListTabName.ALL;
	}
}

class ModuleVersionsFilterSelect extends ContentSelect {
	/**
	 * @param {!Map<string,!Module>} modules
	 * @param {!Array<!ModuleVersion>} moduleVersions
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(modules, moduleVersions, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Map<string,!Module>} */
		this.modules_ = modules;

		/** @private @const @type {!Array<!ModuleVersion>} */
		this.moduleVersions_ = moduleVersions;

		/** @private @const @type {!Array<!Language>} */
		this.languages_ = this.getModulesPrimaryLanguages();
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(
				moduleVersionsFilterSelect,
				{
					languages: this.languages_,
				},
				{
					pathUrl: this.getPathUrl(),
				},
			),
		);
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
				name,
				new ModuleVersionsListComponent(this.moduleVersions_, this.dom_),
			);
			this.select(name, route);
			return;
		}
		// Check if name matches any language filter
		const langFilter = this.languages_.find(
			(filter) => filter.sanitizedName === name,
		);
		if (langFilter) {
			this.addTab(
				name,
				new ModuleVersionsListComponent(
					this.getLanguageModuleVersions(unsanitizeLanguageName(name)),
					this.dom_,
				),
			);
			this.select(name, route);
			return;
		}
		super.selectFail(name, route);
	}

	/**
	 * @returns {!Array<string>}
	 */
	getAllLanguages() {
		const set = new Set();

		for (const mv of this.moduleVersions_) {
			const module = this.modules_.get(mv.getName());
			const md = module.getRepositoryMetadata();
			if (md && md.getLanguagesMap()) {
				for (const value of md.getLanguagesMap().keys()) {
					set.add(value);
				}
			}
		}

		const list = Array.from(set);
		list.sort();
		return list;
	}

	/**
	 * @returns {!Array<!Language>}
	 */
	getModulesPrimaryLanguages() {
		/** @type {!Set<string>} */
		const set = new Set();

		for (const mv of this.moduleVersions_) {
			const module = this.modules_.get(mv.getName());
			const md = module.getRepositoryMetadata();
			if (md && md.getPrimaryLanguage()) {
				set.add(md.getPrimaryLanguage());
			}
		}

		/** @type {!Array<string>} **/
		const names = Array.from(set);
		names.sort();

		return names.map(
			(name) =>
				/** @type {!Language} */ ({
					name,
					sanitizedName: sanitizeLanguageName(name),
				}),
		);
	}

	/**
	 *
	 * @param {string} lang
	 * @return {!Array<!ModuleVersion>}
	 */
	getLanguageModuleVersions(lang) {
		const result = [];
		for (const mv of this.moduleVersions_) {
			const module = this.modules_.get(mv.getName());
			const md = module.getRepositoryMetadata();
			if (md && md.getLanguagesMap()) {
				if (md.getLanguagesMap().has(lang)) {
					result.push(mv);
				}
			}
		}
		return result;
	}
}

class ModuleSearchComponent extends ContentComponent {
	/**
	 * @param {!Registry} registry
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(registry, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Registry} */
		this.registry_ = registry;

		/** @private @type {?HTMLInputElement} */
		this.searchInput_ = null;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(soy.renderAsElement(moduleSearchComponent));
	}

	/**
	 * @override
	 * @return {Element}
	 */
	getContentElement() {
		return this.getCssElement(goog.getCssName("search-results"));
	}

	/**
	 * @override
	 */
	enterDocument() {
		super.enterDocument();

		this.searchInput_ = /** @type {?HTMLInputElement} */ (
			this.getElementStrict().querySelector(".js-search-input")
		);

		if (this.searchInput_) {
			this.getHandler().listen(
				this.searchInput_,
				events.EventType.INPUT,
				this.handleSearchInput_,
			);
		}

		highlightAll(this.getElementStrict());
	}

	/**
	 * Handle input events on the dedicated search box.
	 * @param {!events.Event} e
	 * @private
	 */
	handleSearchInput_(e) {
		const value = this.searchInput_.value.trim();
		if (!value) {
			const el = this.getContentElement();
			dom.removeChildren(el);
			return;
		}
		const tokens = value.split(/\s+/);
		const results = this.searchModules(tokens);
		const el = this.getContentElement();
		soy.renderElement(el, searchModulesResultsList, {
			tokens,
			results,
		});
	}

	/**
	 * @override
	 * @param {!Route} route
	 */
	goDown(route) {
		const tokens = route.unmatchedPath();
		const results = this.searchModules(tokens);
		const el = this.getContentElement();
		soy.renderElement(el, searchModulesResultsList, {
			tokens,
			results,
		});

		// Pre-fill the search input with the query
		if (this.searchInput_) {
			this.searchInput_.value = tokens.join(" ");
		}

		route.done(this);
	}

	/**
	 * Search modules by matching tokens against names and descriptions.
	 * @param {!Array<string>} tokens
	 * @return {!Array<!ModuleVersion>}
	 */
	searchModules(tokens) {
		const results = [];
		/** @type {!Array<string>} */
		const lowerTokens = tokens.map((t) => t.toLowerCase());

		for (const module of this.registry_.getModulesList()) {
			const name = module.getName().toLowerCase();
			const description =
				module.getRepositoryMetadata()?.getDescription()?.toLowerCase() || "";

			// Check if any token matches name or description
			const matches = lowerTokens.some(
				(token) => name.includes(token) || description.includes(token),
			);

			if (matches && module.getVersionsList().length > 0) {
				// Get the first (latest) version
				results.push(module.getVersionsList()[0]);
			}
		}
		return results;
	}
}
exports.ModuleSearchComponent = ModuleSearchComponent;

class ModuleVersionsListComponent extends Component {
	/**
	 * @param {!Array<!ModuleVersion>} moduleVersions
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(moduleVersions, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const */
		this.moduleVersions_ = moduleVersions;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(moduleVersionsListComponent, {
				moduleVersions: this.moduleVersions_,
			}),
		);
	}
}

class ModuleBlankslateComponent extends Component {
	/**
	 * @param {string} moduleName
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(moduleName, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {string} */
		this.moduleName_ = moduleName;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(moduleBlankslateComponent, {
				moduleName: this.moduleName_,
			}),
		);
	}
}

class ModuleVersionBlankslateComponent extends Component {
	/**
	 * @param {!Module} module
	 * @param {string} version
	 * @param {?dom.DomHelper=} opt_domHelper
	 */
	constructor(module, version, opt_domHelper) {
		super(opt_domHelper);

		/** @private @const @type {!Module} */
		this.module_ = module;

		/** @private @const @type {string} */
		this.version_ = version;
	}

	/**
	 * @override
	 */
	createDom() {
		this.setElementInternal(
			soy.renderAsElement(moduleVersionBlankslateComponent, {
				module: this.module_,
				version: this.version_,
			}),
		);
	}
}
