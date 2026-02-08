goog.module("bcr.main");

const ModuleRegistrySymbols = goog.require(
	"proto.build.stack.bazel.symbol.v1.ModuleRegistrySymbols",
);
const ModuleVersion = goog.require(
	"proto.build.stack.bazel.registry.v1.ModuleVersion",
);
const Registry = goog.require("proto.build.stack.bazel.registry.v1.Registry");
const RegistryApp = goog.require("bcrfrontend.App");
const base64 = goog.require("goog.crypt.base64");

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

	const app = new RegistryApp(registry, registryWithSymbols);
	app.render(document.body);
	app.start();
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
 * Decompress gzip data using DecompressionStream API.
 * @param {!Uint8Array} gzipData The gzipped data
 * @returns {!Promise<!Uint8Array>}
 * @suppress {reportUnknownTypes, missingProperties, checkTypes}
 */
async function gzipDecode(gzipData) {
	const decompressor = new DecompressionStream("gzip");
	const input = new ReadableStream({
		/**
		 * @param {!ReadableStreamDefaultController} controller
		 */
		start(controller) {
			controller.enqueue(gzipData);
			controller.close();
		},
	});
	const output = input.pipeThrough(decompressor);
	const reader = output.getReader();
	const chunks = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
	const decompressed = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		decompressed.set(chunk, offset);
		offset += chunk.length;
	}
	return decompressed;
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
