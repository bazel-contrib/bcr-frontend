goog.module("bcrfrontend.registry");

const Maintainer = goog.require(
	"proto.build.stack.bazel.registry.v1.Maintainer",
);
const Module = goog.require("proto.build.stack.bazel.registry.v1.Module");
const ModuleDependency = goog.requireType(
	"proto.build.stack.bazel.registry.v1.ModuleDependency",
);
const ModuleMetadata = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleMetadata",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Presubmit = goog.require("proto.build.stack.bazel.registry.v1.Presubmit");
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const strings = goog.require("goog.string");

// Cache the reverse dependency index globally (tied to registry commit)
let cachedReverseDepsIndex = null;
let cachedReverseDepsCommit = null;

/**
 * @param {!Registry} registry
 * @param {!Module} module
 * @param {string} version
 * @returns {!Array<!ModuleDependency>}
 */
/**
 * Build a reverse dependency index: "module@version" -> [dependent ModuleVersions]
 * This is computed once and cached for O(1) lookups
 * @param {!Registry} registry
 * @returns {!Map<string, !Array<!ModuleVersion>>}
 */
function buildReverseDependencyIndex(registry) {
	/** @type {!Map<string, !Array<!ModuleVersion>>} */
	const index = new Map();

	for (const m of registry.getModulesList()) {
		for (const mv of m.getVersionsList()) {
			for (const dep of mv.getDepsList()) {
				const key = `${dep.getName()}@${dep.getVersion()}`;
				if (!index.has(key)) {
					index.set(key, []);
				}
				const depList = index.get(key);
				if (depList) {
					depList.push(mv);
				}
			}
		}
	}

	return index;
}

/**
 * Builds a mapping of modules from the registry.
 *
 * @param {!Registry} registry
 * @returns {!Map<string,!Module>} set of modules by name
 */
function createModuleMap(registry) {
	const result = new Map();
	registry.getModulesList().forEach((m) => {
		const latest = getLatestModuleVersion(m);
		result.set(latest.getName(), m);
	});
	return result;
}
exports.createModuleMap = createModuleMap;

/**
 * Builds a mapping of maintainers from the registry.
 *
 * @param {!Registry} registry
 * @returns {!Map<string,!Maintainer>} set of modules by name
 */
function createMaintainersMap(registry) {
	const result = new Map();
	registry.getModulesList().forEach((module) => {
		module
			.getMetadata()
			.getMaintainersList()
			.forEach((maintainer) => {
				if (maintainer.getGithub()) {
					result.set(maintainer.getGithub(), maintainer);
				} else if (maintainer.getEmail()) {
					result.set(maintainer.getEmail(), maintainer);
				}
			});
	});
	return result;
}
exports.createMaintainersMap = createMaintainersMap;

/**
 * Builds a mapping of module versions that have documentation.
 *
 * @param {!Registry} registry
 * @returns {!Map<string,!ModuleVersion>} map of module versions by "module@version" key
 */
function createDocumentationMap(registry) {
	const result = new Map();
	registry.getModulesList().forEach((module) => {
		module.getVersionsList().forEach((version) => {
			const docs = version.getSource()?.getDocumentation();
			if (docs) {
				const key = `${module.getName()}@${version.getVersion()}`;
				result.set(key, version);
			}
		});
	});
	return result;
}
exports.createDocumentationMap = createDocumentationMap;

// Cache the presubmit-facet sets per registry commit so we only walk all
// modules once per session.
/** @type {?{platforms: !Array<string>, bazelVersions: !Array<string>}} */
let cachedPresubmitFacets = null;
/** @type {?string} */
let cachedPresubmitFacetsCommit = null;

/**
 * Walks every module version's Presubmit (top-level matrix, BCR test-module
 * matrix, and per-task overrides) and returns the union of all platforms and
 * Bazel versions seen across the registry. Used by the Testing tab to display
 * the universe of possible values, with values absent from the current
 * module's matrix grayed out.
 *
 * @param {!Registry} registry
 * @returns {!{platforms: !Array<string>, bazelVersions: !Array<string>}}
 */
function computeAllPresubmitFacets(registry) {
	const commit = registry.getCommitSha();
	if (cachedPresubmitFacetsCommit === commit && cachedPresubmitFacets) {
		return cachedPresubmitFacets;
	}

	/** @type {!Set<string>} */
	const platforms = new Set();
	/** @type {!Set<string>} */
	const bazelVersions = new Set();

	// Skip Bazel CI's templated placeholders like "${{ all_platforms }}",
	// "${{ bazel }}", etc. They're substitution variables, not concrete values.
	/** @type {function(string): boolean} */
	const isConcrete = (s) => !!s && !s.includes("${{");

	/**
	 * @param {?Presubmit.PresubmitMatrix|undefined} matrix
	 */
	const collectFromMatrix = (matrix) => {
		if (!matrix) return;
		for (const p of matrix.getPlatformList()) {
			if (isConcrete(p)) platforms.add(p);
		}
		for (const v of matrix.getBazelList()) {
			if (isConcrete(v)) bazelVersions.add(v);
		}
	};

	for (const module of registry.getModulesList()) {
		for (const version of module.getVersionsList()) {
			const presubmit = version.getPresubmit();
			if (!presubmit) continue;
			collectFromMatrix(presubmit.getMatrix());
			const bcr = presubmit.getBcrTestModule();
			if (bcr) collectFromMatrix(bcr.getMatrix());
			// Per-task overrides
			const tasksMap = bcr ? bcr.getTasksMap() : presubmit.getTasksMap();
			if (tasksMap) {
				for (const taskName of tasksMap.keys()) {
					const task = tasksMap.get(taskName);
					if (!task) continue;
					const p = task.getPlatform();
					if (isConcrete(p)) platforms.add(p);
					const v = task.getBazel();
					if (isConcrete(v)) bazelVersions.add(v);
				}
			}
		}
	}

	cachedPresubmitFacets = {
		platforms: Array.from(platforms).sort(),
		// Sort newest-first (descending) so e.g. ["9.x", "8.x"] is the natural
		// reading order for Bazel major versions.
		bazelVersions: Array.from(bazelVersions).sort().reverse(),
	};
	cachedPresubmitFacetsCommit = commit;
	return cachedPresubmitFacets;
}
exports.computeAllPresubmitFacets = computeAllPresubmitFacets;

/**
 * Returns true if the file's path is "public" (not in a private/internal/
 * tests/examples/etc. directory). Mirrors the filter used by the symbol
 * search and the docs file list so all three counts agree.
 *
 * @param {?{getLabel: function(): ?{getPkg: function(): string, getName: function(): string}}} file
 * @returns {boolean}
 */
function isPublicSymbolFile(file) {
	const label = file?.getLabel?.();
	if (!label) return true;
	const pkg = label.getPkg?.() || "";
	const name = label.getName?.() || "";
	const path = pkg ? `${pkg}/${name}` : name;
	return !(
		path.includes("private/") ||
		path.includes("internal/") ||
		path.includes("thirdparty/") ||
		path.includes("third_party/") ||
		path.includes("examples/") ||
		path.includes("example/") ||
		path.includes("tests/") ||
		path.includes("vendor/") ||
		path.includes("test/")
	);
}

// SymbolType.SYMBOL_TYPE_VALUE = 9, SYMBOL_TYPE_LOAD_STMT = 10. Hardcoded
// here to avoid a registry.js → symbol-proto dependency just for two ints.
const SYMBOL_TYPE_VALUE = 9;
const SYMBOL_TYPE_LOAD_STMT = 10;

/**
 * Counts the unique documented symbols visible to the global symbol search:
 * one entry per (moduleName, filePath, symName) triple, restricted to public
 * files, excluding LOAD/VALUE pseudo-symbols. Returns 0 until the symbols
 * proto has been loaded and decoded (see Application.getRegistryWithSymbols).
 *
 * @param {!Registry} registry
 * @returns {number}
 */
function computeTotalSymbols(registry) {
	/** @type {!Set<string>} */
	const seen = new Set();
	for (const module of registry.getModulesList()) {
		const moduleName = module.getName();
		for (const version of module.getVersionsList()) {
			const docs = version.getSource()?.getDocumentation();
			if (!docs) continue;
			for (const file of docs.getFileList()) {
				if (file.getError()) continue;
				if (!isPublicSymbolFile(file)) continue;
				const label = file.getLabel();
				const pkg = label?.getPkg() || "";
				const name = label?.getName() || "";
				const filePath = pkg ? `${pkg}/${name}` : name;
				for (const sym of file.getSymbolList()) {
					const t = sym.getType();
					if (t === SYMBOL_TYPE_VALUE || t === SYMBOL_TYPE_LOAD_STMT) {
						continue;
					}
					seen.add(`${sym.getName()} (${moduleName}:${filePath})`);
				}
			}
		}
	}
	return seen.size;
}
exports.computeTotalSymbols = computeTotalSymbols;

/**
 * Updates the count span inside a rendered bcrSidePane with the latest
 * documented-symbols total. Used by views that lazy-load the symbols proto
 * after first paint.
 *
 * @param {?Element} root
 * @param {!Registry} registry
 */
function refreshBcrSidePaneSymbols(root, registry) {
	if (!root) return;
	const span = root.querySelector(".js-symbols-count");
	if (!span) return;
	span.textContent = String(computeTotalSymbols(registry));
}
exports.refreshBcrSidePaneSymbols = refreshBcrSidePaneSymbols;

/**
 * @param {!Module} module
 * @returns {!ModuleVersion}
 */
function getLatestModuleVersion(module) {
	const versions = module.getVersionsList();
	return versions[0];
}
exports.getLatestModuleVersion = getLatestModuleVersion;

/**
 * Get modules that directly depend on a specific version of a module
 * Uses a cached reverse dependency index for O(1) lookups
 * @param {!Registry} registry
 * @param {!Module} module
 * @param {string} version
 * @returns {!Array<!ModuleVersion>}
 */
function getModuleDirectDeps(registry, module, version) {
	// Build/refresh index if needed
	if (
		!cachedReverseDepsIndex ||
		cachedReverseDepsCommit !== registry.getCommitSha()
	) {
		cachedReverseDepsIndex = buildReverseDependencyIndex(registry);
		cachedReverseDepsCommit = registry.getCommitSha();
	}

	const key = `${module.getName()}@${version}`;
	const dependents = cachedReverseDepsIndex.get(key) || [];

	// Return ModuleVersion objects directly (as expected by templates)
	return dependents;
}
exports.getModuleDirectDeps = getModuleDirectDeps;

/**
 * Create a map from the yanked versions.  Regular map seems to play nicer with
 * soy templates than jspb.Map.
 * @param {?ModuleMetadata} metadata
 * @returns {!Map<string,string>}
 */
function getYankedMap(metadata) {
	const result = new Map();
	if (metadata && metadata.getYankedVersionsMap()) {
		for (const k of metadata.getYankedVersionsMap().keys()) {
			const v = metadata.getYankedVersionsMap().get(k);
			result.set(k, v);
		}
	}
	return result;
}
exports.getYankedMap = getYankedMap;

/**
 * @param {!Registry} registry
 * @param {!Maintainer} maintainer
 * @returns {!Array<!ModuleVersion>} set of (latest) module versions that this maintainer maintains
 */
function maintainerModuleVersions(registry, maintainer) {
	const result = new Set();

	const hasGithub = !strings.isEmpty(maintainer.getGithub());
	const hasEmail = !strings.isEmpty(maintainer.getEmail());

	registry.getModulesList().forEach((module) => {
		const metadata = module.getMetadata();
		metadata.getMaintainersList().forEach((m) => {
			if (hasGithub && maintainer.getGithub() === m.getGithub()) {
				result.add(module.getVersionsList()[0]);
				return;
			}
			if (hasEmail && maintainer.getEmail() === m.getEmail()) {
				result.add(module.getVersionsList()[0]);
				return;
			}
		});
	});
	return Array.from(result);
}
exports.maintainerModuleVersions = maintainerModuleVersions;

/**
 * Builds a mapping of module versions from a module.
 *
 * @param {!Module} module
 * @returns {!Map<string,!ModuleVersion>} set of module versions by ID
 */
function createModuleVersionMap(module) {
	const result = new Map();
	module.getVersionsList().forEach((mv) => {
		result.set(mv.getVersion(), mv);
	});
	return result;
}
exports.createModuleVersionMap = createModuleVersionMap;

/**
 * @param {!Registry} registry
 * @returns {!Array<!ModuleVersion>}
 */
function getLatestModuleVersions(registry) {
	return registry.getModulesList().map((module) => {
		return module.getVersionsList()[0];
	});
}
exports.getLatestModuleVersions = getLatestModuleVersions;

/**
 * @param {!Registry} registry
 * @returns {!Map<string,!ModuleVersion>}
 */
function getLatestModuleVersionsByName(registry) {
	const result = new Map();
	for (const module of registry.getModulesList()) {
		for (const moduleVersion of module.getVersionsList()) {
			result.set(module.getName(), moduleVersion);
			break;
		}
	}
	return result;
}
exports.getLatestModuleVersionsByName = getLatestModuleVersionsByName;

/**
 * Calculate a human-readable age summary from a number of days.
 * @param {number} totalDays
 * @returns {string} Age string like "1y 6m" or "6m 23d"
 */
function calculateAgeSummary(totalDays) {
	// If years, show as decimal years (e.g., "1.2y")
	if (totalDays >= 365) {
		const years = (totalDays / 365).toFixed(1);
		return `${years}y`;
	}

	// If months, show as decimal months (e.g., "2.5mo")
	if (totalDays >= 30) {
		const months = (totalDays / 30).toFixed(1);
		return `${months}mo`;
	}

	// Otherwise just show days
	return `${totalDays}d`;
}
exports.calculateAgeSummary = calculateAgeSummary;

/**
 * Calculate the time since the latest version.
 * @param {!Module} module
 * @returns {string|undefined} The formatted age, or undefined if no latest
 * commit was found for the calculation.
 */
function calculateAgeSinceLatestVersion(module) {
	const latestVersion = module.getVersionsList()[0];
	const latestCommit = latestVersion.getCommit();
	if (!latestCommit) {
		return undefined;
	}
	const latestDate = new Date(latestCommit.getDate());
	const now = new Date();
	const diffMs = now - latestDate;
	const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
	if (totalDays > 0) {
		return calculateAgeSummary(totalDays);
	}
	const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
	return totalHours > 0 ? `${totalHours}h` : "<1h";
}
exports.calculateAgeSinceLatestVersion = calculateAgeSinceLatestVersion;

/**
 * Calculate version distances and age summary for each module.
 * @param {!Registry} registry
 * @returns {!Map<string, !Map<string, {versionsBehind: number, ageSummary: ?string}>>} Map of moduleName -> (version -> {versionsBehind, ageSummary})
 */
function getVersionDistances(registry) {
	const result = new Map();
	for (const module of registry.getModulesList()) {
		const moduleVersions = module.getVersionsList();
		if (moduleVersions.length === 0) continue;

		const versionDistanceMap = new Map();

		// Get the latest version's commit date for comparison
		let latestDate = null;
		if (moduleVersions.length > 0 && moduleVersions[0].getCommit()) {
			const dateStr = moduleVersions[0].getCommit().getDate();
			if (dateStr) {
				latestDate = new Date(dateStr);
			}
		}

		// Iterate over actual BCR versions, not metadata versions
		for (let i = 0; i < moduleVersions.length; i++) {
			const moduleVersion = moduleVersions[i];
			const versionStr = moduleVersion.getVersion();
			let ageSummary = null;

			if (moduleVersion.getCommit() && latestDate) {
				const versionDateStr = moduleVersion.getCommit().getDate();
				if (versionDateStr) {
					const versionDate = new Date(versionDateStr);
					const diffMs = latestDate - versionDate;
					const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
					ageSummary = calculateAgeSummary(totalDays);
				}
			}

			versionDistanceMap.set(versionStr, {
				versionsBehind: i,
				ageSummary: ageSummary,
			});
		}

		result.set(module.getName(), versionDistanceMap);
	}
	return result;
}
exports.getVersionDistances = getVersionDistances;
