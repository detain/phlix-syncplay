/**
 * packageManifest.test — pins the package.json contracts-peer and manifest
 * posture:
 *
 *  - @phlix/contracts is a REQUIRED (non-optional) `"*"` peer
 *    (phlix-syncplay-035, branch-(a) ruling landed by S-syncplay-30):
 *    `dist/messages.d.ts` re-exports `SyncPlayErrorCode` from contracts, so
 *    type-checking consumers must install it; the runtime bundle never
 *    imports it (pure `export type`, erased at build — see
 *    test/errorCodeUnion.test.ts L1/L2/L3). The absence of
 *    `peerDependenciesMeta` is the pinned posture: a plant re-adding
 *    `optional: true` reddens the required-peer test below.
 *  - The `//peerDependencies` comment names `dist/messages.d.ts` as the
 *    re-export carrier and never the wrong `dist/index.d.ts`
 *    (phlix-syncplay-036 — the filename drift this pin makes unfalsifiable
 *    in both directions).
 *  - The contracts devDependency pin is `github:detain/phlix-contracts#v0.5.8`
 *    (phlix-syncplay-060; bumped by df84236 at S-contracts-21, pinned here so
 *    silent drift reddens). The next contracts re-anchor rotates this literal
 *    IN THE SAME COMMIT as the manifest bump (df84236 precedent) — never by
 *    weakening the test.
 *  - No `engines` field is declared (SPY-S9, phlix-syncplay-038 — the full
 *    posture note is in the second block below and mirrored in the manifest's
 *    `//engines` comment; KEEP this pin true).
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
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

  it('declares the @phlix/contracts peer REQUIRED — no optional meta', () => {
    // phlix-syncplay-035 branch (a): an optional meta would tell npm that
    // type-checking consumers can skip contracts, which the d.ts graph
    // contradicts (TS2307 without skipLibCheck). peerDependenciesMeta must
    // stay absent; if the posture ever flips back, rotate this pin in the
    // SAME commit with a stated reason — never delete it silently.
    expect(pkg).not.toHaveProperty('peerDependenciesMeta');
  });

  it('points //peerDependencies at dist/messages.d.ts, the real carrier', () => {
    // phlix-syncplay-036: the re-export line lives in dist/messages.d.ts
    // (src/messages.ts `export type { SyncPlayErrorCode } ...`); the old
    // comment named dist/index.d.ts and misled maintainers.
    const comment = pkg['//peerDependencies'];
    expect(typeof comment).toBe('string');
    expect(comment as string).toContain('dist/messages.d.ts');
    expect(comment as string).not.toContain('dist/index.d.ts');
    expect(comment as string).toContain('non-optional');
  });

  it('pins the contracts devDependency to the #v0.5.8 era', () => {
    // phlix-syncplay-060: stale-pin tripwire. Rotate with the next contracts
    // bump, in the same commit.
    const devDeps = pkg.devDependencies as Record<string, string>;
    expect(devDeps['@phlix/contracts']).toBe('github:detain/phlix-contracts#v0.5.8');
  });

  it('declares no engines field', () => {
    // Deliberate absence — full posture note in the file header
    // (phlix-syncplay-038). If engines is ever added to package.json,
    // rotate this pin in the SAME commit; never delete it silently.
    expect(pkg).not.toHaveProperty('engines');
  });
});

/*
 * ENGINES POSTURE (phlix-syncplay-038 — documented, deliberately unchanged).
 * The absence pinned above is a choice from SPY-S9 (1a566bc), not an
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
 * absence pin above in the SAME commit (SPY-S9 discipline).
 * Never weaken this test to accommodate a new field silently.
 */
