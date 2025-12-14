/**
 * @fileoverview MVS (Minimal Version Selection) algorithm implementation for client-side dependency resolution.
 *
 * This implements the MVS algorithm as described in:
 * https://research.swtch.com/vgo-mvs
 *
 * The algorithm selects the minimal (youngest) set of module versions that satisfies all constraints.
 */

goog.module('centrl.mvs');

const ModuleVersion = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleVersion');
const ModuleMetadata = goog.require('proto.build.stack.bazel.bzlmod.v1.ModuleMetadata');
const Registry = goog.require('proto.build.stack.bazel.bzlmod.v1.Registry');
const DependencyTree = goog.require('proto.build.stack.bazel.bzlmod.v1.DependencyTree');
const DependencyTreeNode = goog.require('proto.build.stack.bazel.bzlmod.v1.DependencyTreeNode');
const asserts = goog.require('goog.asserts');

/**
 * MVS calculator that computes dependency trees for module versions.
 */
class MVS {
    /**
     * @param {!Map<string, !ModuleVersion>} moduleVersionMap Map of "module@version" -> ModuleVersion proto
     * @param {!Map<string, !ModuleMetadata>} moduleMetadataMap Map of moduleName -> ModuleMetadata proto
     */
    constructor(moduleVersionMap, moduleMetadataMap) {
        /** @private @const {!Map<string, !ModuleVersion>} */
        this.moduleVersionMap_ = moduleVersionMap;

        /** @private @const {!Map<string, !ModuleMetadata>} */
        this.moduleMetadataMap_ = moduleMetadataMap;
    }

    /**
     * Builds the module version map and metadata map from registry.
     * @param {!Registry} registry The registry proto object
     * @return {{moduleVersionMap: !Map<string, !ModuleVersion>, moduleMetadataMap: !Map<string, !ModuleMetadata>}}
     */
    static buildMaps(registry) {
        const moduleVersionMap = new Map();
        const moduleMetadataMap = new Map();

        // Iterate through all modules
        for (const module of registry.getModulesList()) {
            const moduleName = module.getName();
            const metadata = module.getMetadata();

            if (metadata) {
                moduleMetadataMap.set(moduleName, metadata);
            }

            // Iterate through all versions
            for (const moduleVersion of module.getVersionsList()) {
                const version = moduleVersion.getVersion();
                const key = `${moduleName}@${version}`;
                moduleVersionMap.set(key, moduleVersion);
            }
        }

        return { moduleVersionMap, moduleMetadataMap };
    }

    /**
     * Computes the MVS dependency tree for a given module version.
     * @param {string} moduleName The root module name
     * @param {string} version The root module version
     * @param {(boolean|string)=} includeDev Whether to include dev dependencies: false (exclude), true (include all), 'only' (only dev)
     * @return {?DependencyTree}
     */
    computeDependencyTree(moduleName, version, includeDev = false) {
        const rootKey = `${moduleName}@${version}`;
        const rootModuleVersion = this.moduleVersionMap_.get(rootKey);

        if (!rootModuleVersion) {
            console.error(`Module version not found: ${rootKey}`);
            return null;
        }

        // Track selected versions (module name -> ModuleVersion)

        /** @type {!Map<string,!ModuleVersion>} */
        const selected = new Map();
        selected.set(moduleName, rootModuleVersion);

        // Track visited nodes to avoid cycles
        /** @type {!Set<string>} */
        const visited = new Set();

        const children = this.buildTree(rootModuleVersion, visited, selected, includeDev);

        // Run validation checks (output to console only)
        this.checkYankedVersions_(selected);
        this.checkBazelCompatibility_(selected);
        this.checkDirectDeps_(rootModuleVersion, selected);

        const tree = new DependencyTree();
        tree.setModuleVersion(rootModuleVersion);

        // If includeDev === 'only', filter root children to only include dev dependencies
        if (includeDev === 'only') {
            const devOnlyChildren = children.filter(child => child.getDev());
            tree.setChildrenList(devOnlyChildren);
        } else {
            tree.setChildrenList(children);
        }

        return tree;
    }

    /**
     * Recursively build the dependency tree using MVS.
     * The visited set tracks module@version keys to prevent infinite loops.
     * Diamond dependencies (same module appearing multiple times) are allowed.
     * @param {!ModuleVersion} moduleVersion The current module version
     * @param {!Set<string>} visited Set of visited module@version keys
     * @param {!Map<string,!ModuleVersion>} selected Map of selected module versions
     * @param {(boolean|string)=} includeDev Whether to include dev dependencies: false (exclude), true (include all), 'only' (only dev)
     * @return {!Array<!DependencyTreeNode>}
     */
    buildTree(moduleVersion, visited, selected, includeDev) {
        const moduleKey = `${moduleVersion.getName()}@${moduleVersion.getVersion()}`;

        // Prevent infinite loops by checking if we've already visited this exact module@version
        if (visited.has(moduleKey)) {
            return [];
        }
        visited.add(moduleKey);

        const deps = moduleVersion.getDepsList();
        if (!deps || deps.length === 0) {
            return [];
        }

        /** @type {!Array<!DependencyTreeNode>} */
        const children = [];

        for (const dep of deps) {
            // Skip unresolved dependencies
            if (dep.getUnresolved()) {
                continue;
            }

            // Filter based on dev dependency mode
            if (!includeDev) {
                // Skip dev dependencies when includeDev is false
                if (dep.getDev()) {
                    continue;
                }
            }
            // If includeDev === true, include all dependencies

            const depModuleName = dep.getName();
            let requestedVersion = dep.getVersion();

            // Check for override on this dependency
            let overrideType = '';
            if (dep.getOverride()) {
                overrideType = this.getOverrideType_(asserts.assertObject(dep.getOverride()));
                // For single_version_override, use the override version
                if (dep.getOverride().hasSingleVersionOverride()) {
                    const overrideVersion = dep.getOverride().getSingleVersionOverride().getVersion();
                    if (overrideVersion) {
                        requestedVersion = overrideVersion;
                    }
                }
            }

            const currentSelected = selected.get(depModuleName);

            // MVS: Select maximum version
            let selectedModuleVersion;
            let upgraded = false;

            if (!currentSelected) {
                const depKey = `${depModuleName}@${requestedVersion}`;
                selectedModuleVersion = this.moduleVersionMap_.get(depKey);
                if (selectedModuleVersion) {
                    selected.set(depModuleName, selectedModuleVersion);
                }
            } else {
                const comparison = this.compareVersions_(
                    depModuleName,
                    requestedVersion,
                    currentSelected.getVersion()
                );

                if (comparison > 0) {
                    // Requested version is higher, upgrade
                    const depKey = `${depModuleName}@${requestedVersion}`;
                    selectedModuleVersion = this.moduleVersionMap_.get(depKey);
                    if (selectedModuleVersion) {
                        selected.set(depModuleName, selectedModuleVersion);
                        upgraded = true;
                    }
                } else {
                    // Current selected version is higher or equal
                    selectedModuleVersion = currentSelected;
                    upgraded = currentSelected.getVersion() !== requestedVersion;
                }
            }

            if (!selectedModuleVersion) {
                console.warn(`Module version not found: ${depModuleName}@${requestedVersion}`);
                continue;
            }

            // Check if this node was already visited
            const selectedKey = `${selectedModuleVersion.getName()}@${selectedModuleVersion.getVersion()}`;
            const isPruned = visited.has(selectedKey);

            // Recursively build children (visited set prevents infinite loops)
            const grandchildren = this.buildTree(selectedModuleVersion, visited, selected, includeDev);

            const node = new DependencyTreeNode();
            node.setModuleVersion(selectedModuleVersion);
            node.setRequestedVersion(requestedVersion);
            node.setUpgraded(upgraded);
            node.setDev(dep.getDev() || false);
            node.setPruned(isPruned);
            node.setOverrideType(overrideType);
            node.setChildrenList(grandchildren);
            children.push(node);
        }

        return children;
    }

    /**
     * Computes a flat map of selected versions (similar to the backend MVS result).
     * @param {string} moduleName The root module name
     * @param {string} version The root module version
     * @param {boolean=} includeDev Whether to include dev dependencies (default: false)
     * @return {!Map<string, !ModuleVersion>} Map of module name -> selected ModuleVersion
     */
    computeSelectedVersions(moduleName, version, includeDev = false) {
        const tree = this.computeDependencyTree(moduleName, version, includeDev);
        const selected = new Map();
        this.flatten(tree.getChildrenList(), selected);
        return selected;
    }

    /**
     * Flatten the tree into a map.
     * @param {!Array<!DependencyTreeNode>} nodes
     * @param {!Map<string,!ModuleVersion>} selected
     */
    flatten(nodes, selected) {
        for (const node of nodes) {
            const nodeModuleName = node.getModuleVersion().getName();
            const current = selected.get(nodeModuleName);

            if (!current) {
                selected.set(nodeModuleName, asserts.assertObject(node.getModuleVersion()));
            } else {
                const comparison = this.compareVersions_(
                    nodeModuleName,
                    node.getModuleVersion().getVersion(),
                    current.getVersion()
                );
                if (comparison > 0) {
                    selected.set(nodeModuleName, asserts.assertObject(node.getModuleVersion()));
                }
            }

            const children = node.getChildrenList();
            if (children && children.length > 0) {
                this.flatten(children, selected);
            }
        }
    }

    /**
     * Determines the type of override from a ModuleDependencyOverride proto.
     * @param {!proto.build.stack.bazel.bzlmod.v1.ModuleDependencyOverride} override The override proto
     * @return {string} Override type: "single_version", "git", "archive", "local_path", or empty string
     * @private
     */
    getOverrideType_(override) {
        if (override.hasGitOverride()) return 'git';
        if (override.hasArchiveOverride()) return 'archive';
        if (override.hasSingleVersionOverride()) return 'single_version';
        if (override.hasLocalPathOverride()) return 'local_path';
        return '';
    }

    /**
     * Check for yanked versions in the selected dependency graph.
     * Logs warnings to console for any yanked versions found.
     * @param {!Map<string,!ModuleVersion>} selected Map of module name -> selected ModuleVersion
     * @private
     */
    checkYankedVersions_(selected) {
        for (const name of selected.keys()) {
            const metadata = this.moduleMetadataMap_.get(name);
            if (!metadata) continue;

            const yankedMap = metadata.getYankedVersionsMap();
            if (!yankedMap) continue;

            const version = asserts.assertObject(selected.get(name));
            const yankedInfo = yankedMap.get(version.getVersion());
            if (yankedInfo) {
                console.warn(
                    `⚠️ Yanked version detected: ${name}@${version.getVersion()}\n` +
                    `Reason: ${yankedInfo}`
                );
            }
        }
    }

    /**
     * Check Bazel compatibility requirements for selected modules.
     * Logs info to console for modules with bazel_compatibility requirements.
     * @param {!Map<string,!ModuleVersion>} selected Map of module name -> selected ModuleVersion
     * @private
     */
    checkBazelCompatibility_(selected) {
        for (const version of selected.values()) {
            const compatList = version.getBazelCompatibilityList();
            if (compatList && compatList.length > 0) {
                console.info(
                    `ℹ️ Bazel compatibility requirements for ${version.getName()}@${version.getVersion()}:`,
                    compatList.join(', ')
                );
            }
        }
    }

    /**
     * Check for direct dependency mismatches between requested and selected versions.
     * Logs warnings to console for any mismatches.
     * @param {!ModuleVersion} rootModule The root module version
     * @param {!Map<string,!ModuleVersion>} selected Map of module name -> selected ModuleVersion
     * @private
     */
    checkDirectDeps_(rootModule, selected) {
        for (const dep of rootModule.getDepsList()) {
            const selectedVersion = selected.get(dep.getName());
            if (selectedVersion && dep.getVersion() !== selectedVersion.getVersion()) {
                console.warn(
                    `⚠️ Direct dependency mismatch: ${dep.getName()}\n` +
                    `Requested: ${dep.getVersion()}, Selected: ${selectedVersion.getVersion()}`
                );
            }
        }
    }

    /**
     * Compares two versions for a module using the module metadata version list.
     * The metadata contains versions in sorted order (last one is most recent).
     * @param {string} moduleName The module name
     * @param {string} v1 First version
     * @param {string} v2 Second version
     * @return {number} -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
     * @private
     */
    compareVersions_(moduleName, v1, v2) {
        if (v1 === v2) {
            return 0;
        }

        const metadata = this.moduleMetadataMap_.get(moduleName);
        if (!metadata) {
            // Fallback to string comparison if no metadata
            console.warn(`No metadata found for module: ${moduleName}, falling back to string comparison`);
            return v1 < v2 ? -1 : 1;
        }

        const versions = metadata.getVersionsList();
        const index1 = versions.indexOf(v1);
        const index2 = versions.indexOf(v2);

        // If either version is not found, fall back to string comparison
        if (index1 === -1 || index2 === -1) {
            console.warn(`Version not found in metadata for ${moduleName}: v1=${v1} (index=${index1}), v2=${v2} (index=${index2})`);
            return v1 < v2 ? -1 : 1;
        }

        // Higher index means more recent version
        if (index1 < index2) return -1;
        if (index1 > index2) return 1;
        return 0;
    }
}

exports = {
    MVS,
    DependencyTree,
    DependencyTreeNode,
};

