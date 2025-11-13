goog.module("centrl.main");

const Registry = goog.require("proto.build.stack.bazel.bzlmod.v1.Registry");
const RegistryApp = goog.require("centrl.App");
const base64 = goog.require("goog.crypt.base64");


/**
 * Main entry point for the browser application.
 *
 * @param {string} registryDataBase64 the raw base64 encoded registry protobuf data
 */
function main(registryDataBase64) {
    const registryData = base64.decodeStringToUint8Array(registryDataBase64);
    const registry = Registry.deserializeBinary(registryData);
    const app = new RegistryApp(registry);
    app.render(document.body);
    app.start();
}

/**
 * Export the entry point.
 */
goog.exportSymbol('centrl.main', main);
