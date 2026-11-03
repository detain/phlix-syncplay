/**
 * vite.config.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Framework-agnostic lib build — NO framework plugins, NO runtime externals.
// Emits ES + UMD so the package is consumable from RN/Metro, Electron renderer,
// the Tizen widget (Vite), plain <script> tags (window.PhlixSyncPlay), and
// Node/CJS (the UMD wrapper's CommonJS branch) alike. There is no WebSocket or
// DOM dependency: the transport and clock are injected by the consumer.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'PhlixSyncPlay',
      // 'umd' (not 'cjs'): the published file is named .umd.cjs and a true UMD
      // wrapper delivers on that name — require(), import, AND a browser global.
      formats: ['es', 'umd'],
      fileName: (format) => `phlix-syncplay.${format === 'es' ? 'js' : 'umd.cjs'}`,
    },
    // Transpile down to ES2017: the estate runtimes that cannot be assumed to
    // parse modern syntax (older Tizen/WebOS WebViews, stock RN Hermes, Electron
    // renderers pinned to legacy Chromium) are all ES2017-capable, and the
    // bundle has no optional-chaining/nullish/class-field constructs leaking.
    target: 'es2017',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      // 'lcov' is REQUIRED: it is the only reporter here that writes
      // ./coverage/lcov.info, which CI uploads to Codacy. Without it the
      // upload step runs, finds no file, and reports success having sent
      // nothing.
      reporter: ['text-summary', 'text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/index.ts'],
    },
  },
});
