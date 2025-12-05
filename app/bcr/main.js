goog.module("bcr.main");

const Registry = goog.require("proto.build.stack.bazel.bzlmod.v1.Registry");
const RegistryApp = goog.require("centrl.App");
const base64 = goog.require("goog.crypt.base64");


/**
 * Main entry point for the browser application.
 *
 * @param {string} registryDataBase64 the raw base64 encoded registry protobuf data
*/
async function main(registryDataBase64) {
    const registry = Registry.deserializeBinary(await base64GzDecode(registryDataBase64));
    setupRegistry(registry);
    const app = new RegistryApp(registry);
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
 * 
 * @param {string} b64 The base64-encoded gzipped data
 * @returns {!Promise<!Uint8Array>}
 * @suppress {reportUnknownTypes, missingProperties, checkTypes}
 */
async function base64GzDecode(b64) {
    const binaryString = base64.decodeToBinaryString(b64);
    const binaryData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        binaryData[i] = binaryString.charCodeAt(i);
    }
    const decompressor = new DecompressionStream('gzip');
    const input = new ReadableStream({
        /**
         * @param {!ReadableStreamDefaultController} controller 
         */
        start(controller) {
            controller.enqueue(binaryData);
            controller.close();
        }
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
 * Export the entry point.
 */
goog.exportSymbol('bcr.main', main);
