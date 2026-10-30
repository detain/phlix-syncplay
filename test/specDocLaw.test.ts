/**
 * specDocLaw.test — tripwires for the documentation laws cured by the
 * syncplay minors vein (W-min119 / W-min120, review personas
 * `syncplay__writer`, `syncplay__docmaint`, `syncplay__crossfe`,
 * `syncplay__secnet`, `syncplay__gameux`).
 *
 * Each pin asserts the PRESENCE of a doc claim that was false at dispatch
 * (or the ABSENCE of the mislabel), so a future edit that silently reverts
 * the cure reddens here instead of re-spawning the review finding. Text
 * quotes from `SPEC.md` / `README.md` / `CHANGELOG.md` on disk — the docs
 * themselves are the contract surface these items claimed against.
 *
 * Red-on-parent: every W-min119 pin is red at `0a05ecc` (the §3 TIME_SYNC
 * row read `server → client`; the CHANGELOG carried two `## [Unreleased]`
 * headings, no dated `[0.1.5]`, an undated `[0.1.0]`, no
 * fallback re-add note; the README backoff recipe made no
 * purity reconciliation); every W-min120 pin is red at the W-min119 head
 * (§5 stated the stability threshold with no honest units and no integer
 * claim; §1 had no coordinate-era law; the §4 gate cluster carried
 * drifted un-stamped server cites; the §4 `password_hash` field line
 * omitted "unsalted"; `onHostTransfer` was announced without its
 * zero-live-producer caveat on either surface).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SPEC = readFileSync(fileURLToPath(new URL('../SPEC.md', import.meta.url)), 'utf8');
const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const CHANGELOG = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');

/** Count of headings exactly matching `## [X]` (prefix-tolerant on the date suffix). */
function headingCount(md: string, prefix: string): number {
  return md.split('\n').filter((line) => line.startsWith(prefix)).length;
}

describe('SPEC §3 direction column (W-min119 M-SYNCPLAY-24, review writer MIN-4)', () => {
  it('labels syncplay_time_sync `both` — the server registers an inbound handler and answers it (§4 unicast reply)', () => {
    const row = SPEC.split('\n').find((line) => line.includes('| `syncplay_time_sync` '));
    expect(row).toBeDefined();
    // Pre-cure this row read `server → client` only, hiding the request arm
    // (§4's unicast-reply law + the server's inbound registration).
    expect(row).toContain('| both');
  });

  it('the §4 time_sync block states the inbound arm explicitly (what a request buys)', () => {
    const start = SPEC.indexOf('`syncplay_time_sync` (server → client)');
    expect(start).toBeGreaterThan(-1);
    const block = SPEC.slice(start, start + 1200);
    expect(block).toContain('inbound');
  });
});

describe('CHANGELOG structure (W-min119 M-SYNCPLAY-26/27, review writer MIN-7/MIN-8)', () => {
  it('carries exactly one `## [Unreleased]` heading (the stray mid-history twin is gone)', () => {
    expect(headingCount(CHANGELOG, '## [Unreleased]')).toBe(1);
  });

  it('cuts a dated [0.1.5] section at the release bullet, above [0.1.4]', () => {
    const v15 = CHANGELOG.indexOf('## [0.1.5] - ');
    const v14 = CHANGELOG.indexOf('## [0.1.4] - ');
    const v15tagCommit = /^## \[0\.1\.5\] - 2026-09-14$/m;
    expect(v15).toBeGreaterThan(-1);
    expect(CHANGELOG).toMatch(v15tagCommit);
    expect(v14).toBeGreaterThan(v15);
    // The release bullet belongs to the [0.1.5] section now.
    expect(CHANGELOG.slice(v15, v14)).toContain('Release @phlix/syncplay v0.1.5');
  });

  it('dates [0.1.0] and keeps [0.1.1]..[0.1.4] dated', () => {
    expect(CHANGELOG).toMatch(/^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m);
    for (const v of ['0.1.1', '0.1.2', '0.1.3', '0.1.4']) {
      expect(CHANGELOG).toMatch(new RegExp(`^## \\[${v.replace('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    }
  });

  it('names the fallback re-add forward-dated (the 0.1.3 removal claim no longer stands alone)', () => {
    // The cure is additive: the historical 0.1.3 entry stays verbatim and a
    // forward entry in [Unreleased] records the re-add and why.
    expect(CHANGELOG).toMatch(/M-SYNCPLAY-27/);
    expect(CHANGELOG).toContain('?? 0');
    expect(CHANGELOG).toMatch(/re-add|re-add/i);
    // Historical text untouched: the original 0.1.3 claim is still there verbatim.
    expect(CHANGELOG).toContain('Removed the redundant `?? 0` / `?? \'stopped\'` fallbacks');
  });
});

describe('README backoff recipe (W-min119 M-SYNCPLAY-11, review docmaint minor 9)', () => {
  it('names the consumer-side Math.random against the module-scope purity claim and points at the §10 ordering law', () => {
    // Purity claim intact...
    expect(README).toContain('`Date.now()` / `Math.random()` at module scope');
    // ...and the recipe reconciles: Math.random() is consumer-side, and the
    // load-bearing ordering cites SPEC §10.
    expect(README).toMatch(/Math\.random\(\)[^\n]*(consumer|purity)/i);
    expect(README).toMatch(/§10/);
    expect(README).toMatch(/load-bearing/);
  });
});
