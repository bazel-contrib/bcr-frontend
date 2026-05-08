goog.module("bcr.main");

const BazelFlagDb = goog.require("proto.build.stack.bazel.help.v1.BazelFlagDb");
const ModuleRegistrySymbols = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleRegistrySymbols",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const RegistryApp = goog.require("bcrfrontend.App");
const base64 = goog.require("goog.crypt.base64");
const { gzipDecode } = goog.require("bcrfrontend.common");

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

	const app = new RegistryApp(registry, registryWithSymbols, getBazelFlagDb);
	app.render(document.body);
	app.start();
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
			const response = await fetch("/bazelflagdb.pb.gz");
			if (!response.ok) {
				throw new Error(
					`Failed to fetch bazelflagdb.pb.gz: ${response.status}`,
				);
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
 * Creates a Promise that fetches symbols.pb.gz and decorates the registry.
 * @param {!Registry} registry The base registry to decorate
 * @returns {!Promise<!Registry>} Promise that resolves to decorated registry
 */
function createRegistryWithSymbolsPromise(registry) {
	return (async () => {
		try {
			const response = await fetch("/symbols.pb.gz");
			if (!response.ok) {
				throw new Error(`Failed to fetch symbols.pb.gz: ${response.status}`);
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
