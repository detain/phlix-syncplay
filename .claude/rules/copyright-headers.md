---
description: Every source, test, and config file opens with a JSDoc copyright header
globs: ["src/**/*.ts", "test/**/*.ts", "vite.config.ts", "eslint.config.js"]
---

# Copyright headers

Every `src/*.ts`, `test/*.ts`, `vite.config.ts`, and `eslint.config.js` file
opens with a JSDoc header, above any other comment or code:

```ts
/**
 * time sync.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
```

- The first line is the file basename as lowercase words without the `.ts`
  extension (`src/time-sync.ts` → `time sync.`, `test/client.test.ts` →
  `client.test.`).
- This header is separate from — and sits above — the module-level JSDoc block
  that documents the file.
- Files in `dist/` also carry the header, but `dist/` is build output: run
  `npm run build` instead of hand-editing `dist/phlix-syncplay.js` or
  `dist/*.d.ts`.
