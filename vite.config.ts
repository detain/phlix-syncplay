/**
 * vite.config.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Framework-agnostic lib build — NO framework plugins, NO runtime externals.
// Emits ES + CJS so the package is consumable from RN/Metro, Electron renderer,
// Tizen webpack, and Node/CJS alike. There is no WebSocket or DOM dependency:
// the transport and clock are injected by the consumer.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'PhlixSyncPlay',
      formats: ['es', 'cjs'],
      fileName: (format) => `phlix-syncplay.${format === 'es' ? 'js' : 'umd.cjs'}`,
    },
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
      reporter: ['text-summary', 'text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/index.ts'],
    },
  },
});
