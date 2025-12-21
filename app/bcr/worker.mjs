import init, { fetch as wasmFetch } from './api.js';
import wasm from './api_bg.wasm';

// Initialize WASM on first request
let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await init({ module_or_path: wasm });
    initialized = true;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Route /api/* requests to the WASM worker
      if (url.pathname.startsWith('/api/')) {
        await ensureInit();
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
