goog.module("bcr.main");

const BazelFlagDb = goog.require("proto.build.stack.bazel.help.v1.BazelFlagDb");
const ModuleRegistryPackages = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleRegistryPackages",
);
const ModuleRegistrySymbols = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleRegistrySymbols",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const RegistryApp = goog.require("bcrfrontend.App");
const base64 = goog.require("goog.crypt.base64");
const { RefreshController, collectBootAssetHashes } = goog.require(
	"bcrfrontend.refresh",
);
const { gzipDecode } = goog.require("bcrfrontend.common");
const { loadLabelToUrlKey } = goog.require("bcrfrontend.starlark");

/**
 * Main entry point for the browser application.
 *
 * @param {string} registryDataBase64 the raw base64 encoded registry protobuf data
 */
async function main(registryDataBase64) {
	const registry = Registry.deserializeBinary(
		await base64GzDecode(registryDataBase64),
	);
	setupRegistry(registry);

	// Create lazy-loading promise for registry with symbols
	const registryWithSymbols = createRegistryWithSymbolsPromise(registry);

	// Same shape for the BUILD-file extraction registry.
	const registryWithPackages = createRegistryWithPackagesPromise(registry);

	// Derived index: load-coordinate → list of usages. Built once when the
	// packages.pb.gz fetch resolves.
	const ruleUsageIndex = registryWithPackages.then(buildRuleUsageIndex);

	// One-shot lazy loader for the bazel flag db. The first call kicks off
	// the fetch; subsequent calls reuse the cached promise.
	const getBazelFlagDb = createBazelFlagDbLoader();

	// Strip any prerendered DOM before mounting the SPA. The prerender
	// build step writes a snapshot of the rendered DOM into <body> so first
	// paint is fast; once bcr.js loads, app.render(document.body) appends
	// its own .a-main element rather than replacing the prerendered one,
	// so we'd end up with two copies side-by-side. Remove non-bootstrap
	// children (preserve <script>/<link>/<style> so we don't break our own
	// module bootstrap or any injected styles).
	const stale = document.body.querySelectorAll(
		":scope > :not(script):not(link):not(style)",
	);
	for (let i = 0; i < stale.length; i++) {
		stale[i].remove();
	}

	const refreshController = new RefreshController({
		manifestUrl: metaUrl("bcr:manifest-url"),
		bootCommitSha: registry.getCommitSha() || "",
		bootAssetHashes: collectBootAssetHashes(),
	});

	const app = new RegistryApp(
		registry,
		registryWithSymbols,
		registryWithPackages,
		ruleUsageIndex,
		getBazelFlagDb,
		refreshController,
	);
	app.render(document.body);
	app.start();

	document.documentElement.classList.remove("bcr-booting");

	// Initialize the prerender-ready flag. The actual flip-to-true happens
	// in RegistryApp.handleRouteDone after each routing transition (initial
	// route AND subsequent SPA-style pushState), so prerender_pages picks
	// up a fresh signal per URL without main() needing to coordinate.
	window["__bcrPrerenderReady"] = false;
}

/**
 * Look up a build-time-substituted asset URL from a meta tag in <head>.
 * The releasecompiler replaces `{<originalName>}` placeholders in index.html
 * with content-hashed filenames; the meta tag carries the resolved URL so the
 * browser bypasses cached payloads after every deploy.
 *
 * @param {string} name  meta-tag name (e.g. "bcr:symbols-url")
 * @return {?string}     the resolved URL, or null if the meta tag is missing
 */
function metaUrl(name) {
	const el = document.querySelector(`meta[name="${name}"]`);
	const v = el?.getAttribute("content") || "";
	return v ? v : null;
}

/**
 * Builds a memoized loader for the lazy-fetched bazel flag database.
 * @returns {function():!Promise<!BazelFlagDb>}
 */
function createBazelFlagDbLoader() {
	/** @type {?Promise<!BazelFlagDb>} */
	let cached = null;
	return () => {
		if (cached) return cached;
		cached = (async () => {
			const url = metaUrl("bcr:bazelflagdb-url");
			if (!url) {
				throw new Error(
					"bazelflagdb URL not set in <meta name=bcr:bazelflagdb-url>",
				);
			}
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Failed to fetch ${url}: ${response.status}`);
			}
			const gzipData = new Uint8Array(await response.arrayBuffer());
			const decompressed = await gzipDecode(gzipData);
			return BazelFlagDb.deserializeBinary(decompressed);
		})();
		return cached;
	};
}

/**
 * Setup the registry once deserialized.  Currently this involves propagating
 * RepositoryMetadata from Module down to ModuleVersion.
 * @param {!Registry} registry
 */
function setupRegistry(registry) {
	for (const module of registry.getModulesList()) {
		const md = module.getRepositoryMetadata();
		if (md) {
			for (const moduleVersion of module.getVersionsList()) {
				moduleVersion.setRepositoryMetadata(md);
			}
		}
	}
}

/**
 * Decorates a Registry with symbols from ModuleRegistrySymbols.
 * This mirrors the Go logic in cmd/registrycompiler/registrycompiler.go:79-94.
 * @param {!Registry} registry The registry to decorate
 * @param {!ModuleRegistrySymbols} symbolsRegistry The symbols to apply
 */
function decorateRegistryWithSymbols(registry, symbolsRegistry) {
	// Build lookup map: moduleVersionsById = Map<"name@version", ModuleVersion>
	/** @type {!Map<string,!ModuleVersion>} */
	const moduleVersionsById = new Map();
	for (const module of registry.getModulesList()) {
		for (const mv of module.getVersionsList()) {
			const id = `${mv.getName()}@${mv.getVersion()}`;
			moduleVersionsById.set(id, mv);
		}
	}

	// Decorate each ModuleVersion with its symbols
	for (const d of symbolsRegistry.getModuleVersionList()) {
		const id = `${d.getModuleName()}@${d.getVersion()}`;
		const mv = moduleVersionsById.get(id);
		if (mv) {
			const source = mv.getSource();
			if (source && !source.getDocumentation()) {
				source.setDocumentation(d);
			}
		}
	}
}

/**
 * Decorates a Registry with packages from ModuleRegistryPackages.
 * Mirrors decorateRegistryWithSymbols but writes onto ModuleSource.packages.
 * @param {!Registry} registry The registry to decorate
 * @param {!ModuleRegistryPackages} packagesRegistry The packages to apply
 */
function decorateRegistryWithPackages(registry, packagesRegistry) {
	/** @type {!Map<string,!ModuleVersion>} */
	const moduleVersionsById = new Map();
	for (const module of registry.getModulesList()) {
		for (const mv of module.getVersionsList()) {
			const id = `${mv.getName()}@${mv.getVersion()}`;
			moduleVersionsById.set(id, mv);
		}
	}

	for (const p of packagesRegistry.getModuleVersionList()) {
		const id = `${p.getModuleName()}@${p.getVersion()}`;
		const mv = moduleVersionsById.get(id);
		if (mv) {
			const source = mv.getSource();
			if (source && !source.getPackages()) {
				source.setPackages(p);
			}
		}
	}
}

/**
 * Creates a Promise that fetches packages.pb.gz and decorates the registry.
 * @param {!Registry} registry The base registry to decorate
 * @returns {!Promise<!Registry>} Promise that resolves to decorated registry
 */
function createRegistryWithPackagesPromise(registry) {
	return (async () => {
		try {
			const url = metaUrl("bcr:packages-url");
			if (!url) {
				throw new Error("packages URL not set in <meta name=bcr:packages-url>");
			}
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Failed to fetch ${url}: ${response.status}`);
			}
			const gzipData = new Uint8Array(await response.arrayBuffer());
			const decompressed = await gzipDecode(gzipData);
			const packagesRegistry =
				ModuleRegistryPackages.deserializeBinary(decompressed);
			decorateRegistryWithPackages(registry, packagesRegistry);
			return registry;
		} catch (/** @type {*} */ e) {
			console.error("Failed to load packages:", e);
			return registry;
		}
	})();
}

/**
 * Creates a Promise that fetches symbols.pb.gz and decorates the registry.
 * @param {!Registry} registry The base registry to decorate
 * @returns {!Promise<!Registry>} Promise that resolves to decorated registry
 */
function createRegistryWithSymbolsPromise(registry) {
	return (async () => {
		try {
			const url = metaUrl("bcr:symbols-url");
			if (!url) {
				throw new Error("symbols URL not set in <meta name=bcr:symbols-url>");
			}
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Failed to fetch ${url}: ${response.status}`);
			}
			const gzipData = new Uint8Array(await response.arrayBuffer());
			const decompressed = await gzipDecode(gzipData);
			const symbolsRegistry =
				ModuleRegistrySymbols.deserializeBinary(decompressed);
			decorateRegistryWithSymbols(registry, symbolsRegistry);
			return registry;
		} catch (/** @type {*} */ e) {
			console.error("Failed to load symbols:", e);
			return registry; // Graceful degradation
		}
	})();
}

/**
 * Strip "@@<repo>//" (or "@<repo>//") from a Package label, returning "ROOT"
 * for the empty (root) package. Mirrors stripRepoPrefix in packages.js;
 * duplicated here to avoid a cross-module dependency.
 * @param {string} pkgName
 * @returns {string}
 */
function stripRepoPrefix_(pkgName) {
	const idx = pkgName.indexOf("//");
	if (idx === -1) return pkgName;
	const rest = pkgName.substring(idx + 2);
	return rest === "" ? "ROOT" : rest;
}

/**
 * Sweep every Target in every Package of every ModuleVersion that carries a
 * decorated `source.packages`, and build a Map<urlKey, Array<TargetRef>>
 * where urlKey is the slash-form load coordinate used by the /targets Trie
 * router. Only Targets whose rule kind resolves to a LoadStmt in their
 * package are indexed; native rules are skipped.
 *
 * @param {!Registry} registry
 * @returns {!Map<string, !Array<{moduleName: string, version: string,
 *                                 pkgPath: string, targetName: string,
 *                                 ruleKind: string}>>}
 */
function buildRuleUsageIndex(registry) {
	/** @type {!Map<string, !Array<{moduleName: string, version: string,
	 *                              pkgPath: string, targetName: string,
	 *                              ruleKind: string}>>} */
	const index = new Map();
	for (const module of registry.getModulesList()) {
		for (const mv of module.getVersionsList()) {
			const packages = mv.getSource()?.getPackages();
			if (!packages) continue;
			const moduleName = mv.getName();
			const version = mv.getVersion();
			for (const pkg of packages.getPackageList()) {
				const pkgPath = stripRepoPrefix_(pkg.getName());
				const loads = pkg.getLoadList();
				if (loads.length === 0) continue;
				for (const target of pkg.getTargetList()) {
					const ruleKind = target.getKind();
					if (!ruleKind) continue;
					// Find the LoadStmt whose effective local name matches.
					let matchedLabel = null;
					let matchedFrom = "";
					outer: for (const ls of loads) {
						for (const sym of ls.getSymbolList()) {
							const localName = sym.getTo() || sym.getFrom();
							if (localName === ruleKind) {
								matchedLabel = ls.getLabel();
								matchedFrom = sym.getFrom();
								break outer;
							}
						}
					}
					if (!matchedLabel) continue; // native or unresolved
					const key = loadLabelToUrlKey(matchedLabel, matchedFrom);
					let bucket = index.get(key);
					if (!bucket) {
						bucket = [];
						index.set(key, bucket);
					}
					bucket.push({
						moduleName,
						version,
						pkgPath,
						targetName: target.getName() || ruleKind,
						ruleKind,
					});
				}
			}
		}
	}
	return index;
}

/**
 * Decode base64+gzip encoded data.
 * @param {string} b64 The base64-encoded gzipped data
 * @returns {!Promise<!Uint8Array>}
 */
async function base64GzDecode(b64) {
	const binaryString = base64.decodeToBinaryString(b64);
	const binaryData = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		binaryData[i] = binaryString.charCodeAt(i);
	}
	return gzipDecode(binaryData);
}

/**
 * Export the entry point.
 */
goog.exportSymbol("bcr.main", main);
