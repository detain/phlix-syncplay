/**
 * packageManifest.test — pins the package.json peerDependency contract
 * (SPY-S9): @phlix/contracts is an OPTIONAL "*" peer (the runtime bundle never
 * imports it; dist/index.d.ts only re-exports types), and no `engines` field
 * is declared.
 *
 * ENGINES POSTURE (phlix-syncplay-038 — documented, deliberately unchanged).
 * The absence pinned below is a choice from SPY-S9 (1a566bc), not an
 * oversight, and the cross-reference note this finding owed is here:
 *
 *  - What a consumer installs is the committed dist/ bundle, transpiled to
 *    ES2017 (vite.config.ts build.target) for the estate's legacy runtimes
 *    — older Tizen/WebOS WebViews, stock RN Hermes, legacy-Chromium Electron.
 *    None of those is "a Node version"; npm enforces `engines` against the
 *    installer's Node, so a declared floor would misstate the constraint
 *    rather than describe it. ci.yml's matrix docblock is the canonical
 *    wording: "the BUILD toolchain matrix, not the runtime floor".
 *  - The Node floor this repo really has is development-only: vite engines
 *    "^20.19.0 || >=22.12.0" AND vitest engines "^22.12.0 || ^24.0.0 ||
 *    >=26.0.0 (effective dev floor Node 22.12+), built on CI with the
 *    Node 22/24 matrix (.github/workflows/ci.yml).
 *  - The sibling @phlix/ui DOES declare engines (">=18.0.0" in its
 *    package.json). The asymmetry is intentional: a bare @phlix/syncplay
 *    install states no consumer floor — the package description's contract
 *    ("No framework deps; WebSocket and clock are injected") is what a
 *    consumer must satisfy, not a Node version.
 *
 * If the posture ever changes: add the `engines` block AND rotate the
 * absence pin in the test below in the SAME commit (SPY-S9 discipline).
 * Never weaken this test to accommodate a new field silently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('package.json manifest', () => {
  it('declares @phlix/contracts as a "*" peerDependency', () => {
    expect(pkg.peerDependencies).toEqual({ '@phlix/contracts': '*' });
  });

  it('marks the @phlix/contracts peer optional', () => {
    expect(pkg.peerDependenciesMeta).toEqual({
      '@phlix/contracts': { optional: true },
    });
  });

  it('declares no engines field', () => {
    // Deliberate absence — full posture note in the file header
    // (phlix-syncplay-038). If engines is ever added to package.json,
    // rotate this pin in the SAME commit; never delete it silently.
    expect(pkg).not.toHaveProperty('engines');
  });
});
