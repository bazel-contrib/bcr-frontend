import init, { fetch as wasmFetch } from './api.js';

// Import WASM module - in Cloudflare Workers this is a WebAssembly.Module
import wasmModule from './api_bg.wasm';

// Initialize WASM on first request
let wasmInitialized = false;
let wasmInitPromise = null;

async function ensureWasmInit() {
  if (!wasmInitialized) {
    if (!wasmInitPromise) {
      // Pass the WebAssembly.Module to init
      wasmInitPromise = init(wasmModule);
    }
    await wasmInitPromise;
    wasmInitialized = true;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Route /api/* requests to the WASM worker
      if (url.pathname.startsWith('/api/')) {
        await ensureWasmInit();
        return await wasmFetch(request, env, ctx);
      }

      // All other requests go to static assets with SPA support
      // This is handled by the ASSETS binding configured in the deployment
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(`Internal Server Error: ${error.message}\n${error.stack}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
};
