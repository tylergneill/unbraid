import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Single source of truth for the version: package.json. Injected at build
// time so the app can display it without a second file to keep in sync.
const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The `demucs` package (instrument separation) imports onnxruntime-node.
    // In the browser that must be onnxruntime-web, and the very same module
    // instance src/audio/stems.ts configures. package.json's "overrides"
    // already installs onnxruntime-web under that name; this alias makes both
    // imports resolve to one copy.
    alias: { 'onnxruntime-node': 'onnxruntime-web' },
  },
  optimizeDeps: {
    // ONNX Runtime loads its WebAssembly glue (.mjs) and binary (.wasm) from
    // next to its own module URL. The dev server's dependency pre-bundling
    // moves the module into node_modules/.vite/deps, where those files do
    // not exist, so it must be served from node_modules as-is. That includes
    // `demucs`, which imports it: pre-bundling demucs would pull ONNX Runtime
    // into the bundle with it, and so would pre-bundling its import under the
    // aliased name. (Production builds are unaffected.)
    exclude: ['onnxruntime-web', 'onnxruntime-node', 'demucs'],
  },
  server: { port: 5173 },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
});
