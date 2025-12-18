goog.module("centrl.registry");

const Maintainer = goog.require('proto.build.stack.bazel.bzlmod.v1.Maintainer');
const Module = goog.require('proto.build.stack.bazel.bzlmod.v1.Module');
const ModuleDependency = goog.requireType('proto.build.stack.bazel.bzlmod.v1.ModuleDependency');
const ModuleMetadata = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleMetadata');
const ModuleVersion = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleVersion');
const Registry = goog.require('proto.build.stack.bazel.bzlmod.v1.Registry');
const strings = goog.require('goog.string');


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
    registry.getModulesList().forEach(m => {
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
    registry.getModulesList().forEach(module => {
        module.getMetadata().getMaintainersList().forEach(maintainer => {
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
    registry.getModulesList().forEach(module => {
        module.getVersionsList().forEach(version => {
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
    if (!cachedReverseDepsIndex || cachedReverseDepsCommit !== registry.getCommitSha()) {
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

    registry.getModulesList().forEach(module => {
        const metadata = module.getMetadata();
        metadata.getMaintainersList().forEach(m => {
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
    module.getVersionsList().forEach(mv => {
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
    return registry.getModulesList().map(module => {
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

    // If months, show as decimal months (e.g., "2.5m")
    if (totalDays >= 30) {
        const months = (totalDays / 30).toFixed(1);
        return `${months}m`;
    }

    // Otherwise just show days
    return `${totalDays}d`;
}
exports.calculateAgeSummary = calculateAgeSummary;


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
                ageSummary: ageSummary
            });
        }

        result.set(module.getName(), versionDistanceMap);
    }
    return result;
}
exports.getVersionDistances = getVersionDistances;