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
const CLIENT = readFileSync(fileURLToPath(new URL('../src/client.ts', import.meta.url)), 'utf8');
const MESSAGES = readFileSync(fileURLToPath(new URL('../src/messages.ts', import.meta.url)), 'utf8');
const TIMESYNC = readFileSync(fileURLToPath(new URL('../src/time-sync.ts', import.meta.url)), 'utf8');
const MSGTEST = readFileSync(fileURLToPath(new URL('./messages.test.ts', import.meta.url)), 'utf8');
const CLIENTTEST = readFileSync(fileURLToPath(new URL('./client.test.ts', import.meta.url)), 'utf8');

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

describe('SPEC §5 stability units (W-min120 M-SYNCPLAY-25, review writer MIN-6)', () => {
  it('labels the variance threshold with honest units — ms² in the table and the rule', () => {
    expect(SPEC).toMatch(/\|\s*stability variance\s+\|\s*`< 50` ms² \|/);
    // The rule text states the statistic (population variance of the recent
    // integer-ms offsets) and the unit (ms², variance of ms).
    expect(SPEC).toMatch(/population[\s\S]{0,80}variance/);
    expect(SPEC).toMatch(/variance of ms/);
  });

  it('retires the bare "50ms" root-unit mislabel from every synced surface', () => {
    // The server's own docblock still carries it (TimeSync.php:39) — that leg
    // is owed to the server vein. In SPEC.md the token may occur exactly
    // once: inside the quoted mislabel sentence that names it as one.
    expect(SPEC.match(/50ms/g) ?? []).toHaveLength(1);
    expect(SPEC).toContain('a mislabel owed');
    expect(README).not.toContain('50ms');
    expect(TIMESYNC).not.toContain('50ms');
    expect(README).toContain('ms²');
    expect(TIMESYNC).toContain('ms²');
  });
});

describe('SPEC §1 coordinate-era law + §4 server cite re-anchors (W-min120 M-SYNCPLAY-28, review writer MIN-9)', () => {
  it('declares server/hub coordinates era-pinned snapshots governed by @ <sha> stamps', () => {
    expect(SPEC).toMatch(/era-pinned/);
    expect(SPEC).toMatch(/`@ <sha>` stamp/);
  });

  it('re-anchors the password-gate cluster to the verified server tree', () => {
    expect(SPEC).toContain('SyncPlayManager.php:2157-2178');
    expect(SPEC).toContain('create at `:1779` and join at `:1832`');
    expect(SPEC).toMatch(/createGroup` `:158`\/`:164`/);
    expect(SPEC).toMatch(/joinGroup` `:252`\/`:262`/);
    expect(SPEC).toContain('bc3b9b33');
    // The drifted cites are gone, not merely re-labelled.
    expect(SPEC).not.toContain(':2035-2071');
    expect(SPEC).not.toContain('called for create at `:1695`');
    expect(SPEC).not.toContain('`SyncPlayController::createGroup` `:127`');
  });

  it('rotates the drifted handleTimeSync emit cite on every surface that carries it', () => {
    // At bc3b9b33 the emit block is SyncPlayManager.php:1650-1658; the old
    // :1653-1659 predates the server's own drift.
    for (const [surface, text] of [
      ['SPEC.md', SPEC],
      ['src/client.ts', CLIENT],
      ['src/messages.ts', MESSAGES],
      ['test/messages.test.ts', MSGTEST],
      ['test/client.test.ts', CLIENTTEST],
    ] as const) {
      expect(text, surface).not.toContain('1653-1659');
    }
    expect(SPEC).toContain('1650-1658');
    expect(MSGTEST).toContain('1650-1658');
  });
});

describe('SPEC §4 group_create field line (W-min120 M-SYNCPLAY-33)', () => {
  it('names password_hash unsalted SHA-256 hex at first definition', () => {
    expect(SPEC).toMatch(/password_hash\?: string\s+\(unsalted SHA-256 hex of the password\)/);
  });
});

describe('onHostTransfer defensive-only law (W-min120 M-SYNCPLAY-05, review gameux minor)', () => {
  it('client.ts docblock states the zero-live-producer caveat next to the callback', () => {
    expect(CLIENT).toMatch(/host transferred[\s\S]{0,700}?(?:DEFENSIVE|defensive)[\s\S]{0,400}?producer/);
  });

  it('README event row carries the same caveat and is no longer a bare no-op row', () => {
    expect(README).toMatch(/onHostTransfer:[^\n]*defensive-only[^\n]*producer/i);
    expect(README).not.toMatch(/^ {2}onHostTransfer: \(currentHostId, newHostId\) => \{\},$/m);
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

describe('framing deprecated-envelope gate (W-min121 M-SYNCPLAY-02, review crossfe m2)', () => {
  it('framing.ts states the unwrap fires ONLY while the envelope lacks protocol_version', () => {
    const FRAMING = readFileSync(fileURLToPath(new URL('../src/framing.ts', import.meta.url)), 'utf8');
    expect(FRAMING).toMatch(/backward compatibility ONLY[\s\S]{0,8}?while the envelope lacks `protocol_version`/);
    // The runtime gate itself: the unwrap arm is guarded by the protocol_version test.
    expect(FRAMING).toMatch(/!\('protocol_version' in record\)/);
  });
});

describe('SPEC §4 host_elect group_id annotation (W-min121 M-SYNCPLAY-08, review docmaint minor 6 / writer MIN-5)', () => {
  it('annotates group_id as the legacy factory field the live broadcasts omit', () => {
    expect(SPEC).toMatch(/group_id\?: string\s+\(legacy `Messages::hostElect` factory ONLY/);
    expect(SPEC).toMatch(/the live\s*\n?\s*\*?\s*\n?.*broadcasts on BOTH carriers omit it/);
  });

  it('HostElectPayload carries the SPEC-documented optional group_id', () => {
    expect(MESSAGES).toMatch(/export interface HostElectPayload \{\s*\n\s*\/\*\*[\s\S]*?\*\/\s*\n\s*group_id\?: string;/);
  });
});

describe('normative keyword discipline (W-min121 M-SYNCPLAY-23, review writer MIN-3)', () => {
  it('§1 declares an RFC 2119 keyword-discipline law', () => {
    expect(SPEC).toMatch(/\*\*Keyword discipline\.\*\* Uppercase `MUST`/);
    expect(SPEC).toMatch(/carry their RFC 2119 meanings/);
  });

  it('the load-bearing normative lines are uppercased (source-of-truth, RTT derivation)', () => {
    expect(SPEC).toMatch(/Clients MUST follow the shapes/);
    expect(SPEC).toMatch(/The client MUST derive RTT from t1 and t4 only/);
    expect(SPEC).toMatch(/MUST NOT be added to new\s*\n?code paths/);
  });

  it('the error-field fallback is spoken in MUST voice (split emitters)', () => {
    expect(SPEC).toMatch(/Clients MUST read `error_code` first, then fall back to `code`/);
  });
});

describe('typing doc-comment names a real constant (W-min121 M-SYNCPLAY-30, review writer MIN-11)', () => {
  it('client.ts references the TS `TYPING` enum member, not the phantom TYPE_CHAT_TYPING as the client name', () => {
    // Pre-fix the option docblock read "(TYPE_CHAT_TYPING / syncplay_typing)" —
    // TYPE_CHAT_TYPING is the PHP server constant, never a name a d.ts reader
    // finds in this package (whose member is `TYPING`).
    expect(CLIENT).toMatch(/`TYPING` in `SYNCPLAY_MESSAGE_TYPES`/);
    expect(CLIENT).not.toMatch(/\(TYPE_CHAT_TYPING \/ syncplay_typing\)/);
  });
});

describe('SPEC group/room terminology discipline (W-min122 M-SYNCPLAY-22, review writer MIN-2)', () => {
  it('normative prose names the server object `group`; `room` survives only as hub dialect', () => {
    // Pre-fix the doc ran three words for one object: the §4 group_list scope
    // prose and the §9.1 S294 exception said "room" for the SERVER's group,
    // outside the §8.4 hub bare-room dialect that legitimately owns the word.
    expect(SPEC).not.toMatch(/one-member room/);
    expect(SPEC).not.toMatch(/foreign room/);
    expect(SPEC).not.toMatch(/rooms the\s+requester/);
    expect(SPEC).toMatch(/the wire object for a synced session is a \*\*group\*\*/);
    // The hub's legacy dialect keeps its name where it is the subject:
    expect(SPEC).toMatch(/Room-vocabulary dialect on `:8804`/);
  });
});

describe('README badge inventory matches real CI uploads (W-min122 M-SYNCPLAY-29, review writer MIN-10)', () => {
  it('carries no codecov badge — coverage uploads to Codacy only', () => {
    // ci.yml:31-41 (`.github/workflows/ci.yml`) uses
    // codacy/codacy-coverage-reporter-action and there is no codecov step
    // anywhere, so the graph badge pointed at a permanently-gray service.
    expect(README).not.toMatch(/codecov\.io/);
    expect(README).toMatch(/actions\/workflows\/ci\.yml\/badge\.svg/);
  });
});
