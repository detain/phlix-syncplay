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
    // Maps ship — a size decision, recorded (phlix-syncplay-037). package.json
    // 'files' publishes dist wholesale, so both .map files ride in the tarball:
    // 396,417 B together (198,350 + 198,067), larger than the ES (28,248 B) and
    // UMD (23,068 B) payloads they cover — measured 2026-11-27 at base 96ab313f;
    // the maps grow with src, so the figures are dated, not invariants:
    // re-measure from `ls -l dist/*.map` before quoting them. Deliberate:
    // every runtime this bundle targets
    // (older Tizen/WebOS WebViews, stock RN Hermes, legacy-Chromium Electron)
    // debugs from stack traces produced against the ES2017 transpile above, and
    // a browser only fetches a .map when a reader opens devtools — consumers
    // pay install bytes, never load cost. The alternative (drop maps for a
    // smaller tarball) is also defensible; if taken, flip this flag AND adjust
    // RELEASE.md: its step-3 dist-identity recipe carries a PRIMARY all-files
    // aggregate — which today enumerates the map blobs, and CI's rebuild-
    // equality check is exactly `git diff --exit-code -- dist/` — plus a
    // documented "! -name '*.map'" non-map variant; the ritual records BOTH
    // aggregates and the per-file md5s in the CHANGELOG, so every one of them
    // must be re-derived once the maps retire.
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
      // No `thresholds` — coverage floors are intentionally NOT enforced in
      // vitest (phlix-syncplay-046). CI runs this suite with --coverage purely
      // to write ./coverage/lcov.info for the Codacy upload; the step comment
      // in .github/workflows/ci.yml states the advisory-only law and pins the
      // procedure for any future ratchet (introduce it deliberately HERE, not
      // by editing that step). Recorded posture — first taken Nov 2026 at the
      // decision, re-measured at the S-syncplay-31 close (2026-11-27, base
      // 96ab313f): 99.28% statements (553/557) / 97.67% branches (421/431) /
      // 100% functions (101/101) / 99.27% lines (545/549), v8 text-summary
      // All-files row; while any suite is red vitest 5 (5.1.x: the option is
      // `reportOnFailure`, the old `reportOnFailedTests` name is gone)
      // suppresses the table unless --coverage.reportOnFailure is passed, e.g.
      // during the S-syncplay-13 dialectSsot re-aim window. Coverage is high
      // enough that no floor is currently load-bearing; the absence of a
      // thresholds key is a decision on record, not an oversight.
    },
  },
});
