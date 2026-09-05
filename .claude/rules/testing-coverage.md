---
description: Vitest suite layout and the coverage contract CI enforces
globs: ["test/**/*.ts", "vite.config.ts", ".github/workflows/ci.yml"]
---

# Tests and coverage

Tests live in `test/*.test.ts` and run under Vitest (`globals: true`,
`environment: 'node'`). Config lives in the `test` block of `vite.config.ts`.

- `test/client.test.ts` builds every client through the local `makeHarness()`
  helper — a fake `send` collector plus an injectable clock. Never construct a
  real `WebSocket` or call `Date.now()` in a test; the transport and clock are
  injected.
- One `describe()` per behaviour area (e.g. `SyncPlayClient — time sync`),
  named after the method or handler under test.
- A regression pinned to a captured server envelope gets its own ticket-named
  file (e.g. `test/s416DictMembers.test.ts`), with the vector's provenance in
  the file header and the fixture verified RED against the pre-fix code.
- Coverage is `provider: 'v8'`, `include: ['src/**/*.ts']`, excluding
  `**/*.test.ts` and `src/index.ts`.
- The `lcov` reporter is REQUIRED — it is the only one that writes
  `./coverage/lcov.info`, which CI uploads to Codacy. Dropping it makes the
  upload step silently send nothing.

Run locally:

```bash
npm run test:run                 # vitest, no coverage
npm run test:run -- --coverage   # writes ./coverage/lcov.info
```

CI (`.github/workflows/ci.yml`) runs `lint` → `typecheck` → `build` →
`test:run -- --coverage`, then uploads to Codacy with `continue-on-error: true`.
That flag makes a FAILED upload report "success" — check the step log for
"Coverage data uploaded", not the step conclusion.
