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

describe('time-sync Algorithm header names the pong echo arm (W-min123 M-SYNCPLAY-06, review docmaint minor-4)', () => {
  it('the t2 line states the server echoes the client t1 back as client_time', () => {
    // Pre-fix the quad table said only "(server_time in the pong)", so a
    // reader could not see where t1's echo leg lives — the very field
    // handleTimePong's straggler guard matches on.
    expect(TIMESYNC).toMatch(/server_time in the pong; the server echoes the/);
    expect(TIMESYNC).toMatch(/client's own t1 back on the pong as client_time/);
  });
});

describe('SPEC §5 owns the rtt<0 honesty note (W-min123 M-SYNCPLAY-10, review docmaint minor-8)', () => {
  it('states the negative-rtt arm is client hardening the server reject omits', () => {
    // The library rejects on BOTH bounds; TimeSync.php bounds rtt above only.
    // §5 previously implied shared law without saying so (the drift-clamp
    // honesty-note idiom this vein established was missing here).
    expect(SPEC).toMatch(/The `rtt < 0`\s+arm is client-side hardening that the server's own rejection in/);
    expect(SPEC).toMatch(/never from an honest measurement/);
  });
});

describe('SPEC internal anchors point at real sections (W-min123 M-SYNCPLAY-21, review writer MIN-1)', () => {
  it('the §2 source-of-truth law cites §7 divergences, not §6', () => {
    expect(SPEC).toContain('not invent their own (see §7 divergences)');
    expect(SPEC).not.toMatch(/§6 divergences/);
  });

  it('the §9.1 echo-suppression caveat cites §9 item 3, not a phantom Step B6', () => {
    expect(SPEC).not.toMatch(/Step B6/);
    expect(SPEC).toMatch(/see also the host-recompute flow,\nwhich trusts the same server-set ids \(§9 item 3\)/);
  });
});

describe('SPEC §10.1 + code agree on ping pacing (W-min123 M-SYNCPLAY-12/-13, reviews gameux m1/m2)', () => {
  it('§10.1 carries the single-flight pacing paragraph', () => {
    expect(SPEC).toMatch(/Pacing while connected is likewise client law/);
    expect(SPEC).toMatch(/with a ping outstanding MUST be ignored/);
  });

  it('client.ts implements both cures behind named M-SYNCPLAY markers', () => {
    expect(CLIENT).toMatch(/M-SYNCPLAY-12 \(parse-don't-validate\)/);
    expect(CLIENT).toMatch(/M-SYNCPLAY-13 \(single-flight\)/);
    // The slot release must precede the server_time gate (no-wedge law).
    // Needle carries the W-min124 M-SYNCPLAY-19 finite-guard re-shape of the
    // t2 line; the ORDER law itself is unchanged.
    expect(CLIENT).toMatch(/const t1 = echoed \?\? outstanding;[\s\S]*?this\.lastPingSendTime = null;[\s\S]*?const t2 =\s*\n\s*typeof pong\.server_time === 'number' && Number\.isFinite/);
  });
});

describe('SPEC TOC + §4 subsection numbering (W-min124 M-SYNCPLAY-32, review writer MIN-13)', () => {
  it('a Contents list anchors the ten normative sections', () => {
    expect(SPEC).toMatch(/^## Contents$/m);
    expect(SPEC).toMatch(/\[Canonical decisions \(read these first\)\]\(#1-canonical-decisions-read-these-first\)/);
    expect(SPEC).toMatch(/\[Reconnect & resume recovery\]\(#10-reconnect--resume-recovery\)/);
  });

  it('§4 numbers its six payload subsections 4.1–4.6', () => {
    for (let i = 1; i <= 6; i++) {
      expect(SPEC.split('\n').some((l) => l.startsWith(`### 4.${i} `))).toBe(true);
    }
    // The old bare H3 spellings must not return unnumbered (the §-refs the
    // review complained about needed NAMES because these were anonymous).
    expect(SPEC).not.toMatch(/^### Group management$/m);
    expect(SPEC).not.toMatch(/^### Informational$/m);
  });
});

describe('W-min124 observability + hygiene markers are named where consumers can find them', () => {
  it('§5 carries the freshness/degradation client-observability law', () => {
    expect(SPEC).toMatch(/\*\*Freshness and degradation \(client observability\)\.\*\*/);
    expect(SPEC).toMatch(/getSampleAgeMs\(\)/);
    expect(SPEC).toMatch(/onSyncDegraded\(consecutiveRejections\)/);
  });

  it('time-sync.ts implements the accessor behind its named marker', () => {
    expect(TIMESYNC).toMatch(/M-SYNCPLAY-14/);
    expect(TIMESYNC).toMatch(/getSampleAgeMs\(\): number \| null/);
  });

  it('client.ts carries the W-min124 markers and README advertises both new hooks', () => {
    expect(CLIENT).toMatch(/M-SYNCPLAY-03/);
    expect(CLIENT).toMatch(/M-SYNCPLAY-14/);
    expect(CLIENT).toMatch(/M-SYNCPLAY-16/);
    expect(CLIENT).toMatch(/M-SYNCPLAY-19/);
    expect(README).toMatch(/onMemberLeft: \(\{ id, name \}\)/);
    expect(README).toMatch(/onSyncDegraded: \(consecutiveRejections\)/);
  });
});

describe('release hygiene: the README install example pins a released tag (CONSOLIDATED M17)', () => {
  it('README github: pin equals the package version — mobile S181-era tag-form law', () => {
    const pkgVersion: string = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ).version;
    const pins = [...README.matchAll(/github:detain\/phlix-syncplay#v([\d.]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin).toBe(pkgVersion);
    }
  });
});

describe('CONSOLIDATED batch-3 SPEC laws (C1 M2 M4 M6 M9 M13 M14 M15 m6 m21 m31 m37)', () => {
  it('§3 table rules syncplay_group_list bidirectional (M14 — §4.1 documents the server reply)', () => {
    const row = SPEC.split('\n').find((l) => l.includes('`syncplay_group_list`') && l.startsWith('|'));
    expect(row).toBeDefined();
    expect(row).toContain('| both');
  });
  it('§10.2 carries the join catch-up clause: adoption truth + OPEN decision marker (C1)', () => {
    expect(SPEC).toContain('Joiner position catch-up — observed law, OPEN decision');
    expect(SPEC).toContain('neither requires nor forbids it');
  });
  it('§4 delivery policy carries the clamp law naming positionOrDrop (M6)', () => {
    expect(SPEC).toContain('**Clamping law.**');
    expect(SPEC).toContain('positionOrDrop');
  });
  it('§4.6 rules the registry SSOT + two code families + localize-by-code (M2)', () => {
    expect(SPEC).toContain('Code vocabulary — registry SSOT, two families on the wire');
    expect(SPEC).toContain('MUST localize BY');
    expect(SPEC).toContain('CODE, never by the English');
  });
  it('§8.4 is normative for dial paths + credential hygiene (m21/m37)', () => {
    expect(SPEC).toContain('/api/v1/syncplay/ws');
    expect(SPEC).toContain('syncplay/{server_id}');
    expect(SPEC).toContain('MUST scrub');
    expect(SPEC).toContain('MUST NOT log a dial URL');
  });
  it('§6 rules the per-carrier leave truth and names the open server duty (M4)', () => {
    expect(SPEC).toContain('The hub relay `:8804` differs: membership churn');
    expect(SPEC).toContain('server behavior decision (wire-visible;');
    expect(SPEC).toContain('tracked for the cascade) — not ruled here');
  });
  it('§4.4 states the moderation catalog truth (M9) and the full elected_id null law (m6)', () => {
    expect(SPEC).toContain('machine-enforced');
    expect(SPEC).toContain('moderation is out of v1 scope');
    expect(SPEC).toContain('never as a roster mutation on its own');
    expect(SPEC).toContain('today that frequency is zero');
  });
  it('§8.2 states the group-id provenance facts (M13)', () => {
    expect(SPEC).toContain('`sp_` plus a 64-bit CSPRNG hex');
    expect(SPEC).toContain('JoinPasswordThrottle');
  });
  it('§8.4 fleet paragraph is era-restamped, not stale law (M15)', () => {
    expect(SPEC).toContain('`v0.99.13` cascade (disk-verified 2026-11-03)');
  });
  it('§9 item 1 promotes the self-reference permission to a MAY cap (m31)', () => {
    expect(SPEC).toContain('the client-supplied');
    expect(SPEC).toContain('MAY be used only for obvious self-reference detection');
  });
});

describe('CONSOLIDATED batch-3b SPEC prose (M7 m7 m8 m11 m12 m13 m14 m15 m20 m34 m35 m36)', () => {
  it('SPEC carries a rotatable revision stamp (m36)', () => {
    // The pin asserts the stamp is DATE-SHAPED, not a hard date — a literal
    // date here would fight the very "rotatable" the title names (it was
    // red-edited on 2026-11-03 when the deferred-lane normalization wave added
    // normative text and legitimately rotated the stamp). The concrete
    // "this lane advanced it" proof lives in the deferred-lane stamp-currency
    // describe below.
    expect(SPEC).toMatch(/\*\*Document revision:\*\* \d{4}-\d{2}-\d{2}/);
  });
  it('§7 declares the shorthand convention (m34)', () => {
    expect(SPEC).toContain('Shorthand convention (declared once here');
  });
  it('§8 lead-in bold respects sentence boundaries (m35)', () => {
    expect(SPEC).toContain('orchestrator**. It performs');
  });
  it('§8.3 rules member_name as claimed display data, identity keyed on member_id (M7)', () => {
    expect(SPEC).toContain('claimed display data, not identity');
    expect(SPEC).toContain('never on `member_name`, which any member may rewrite');
  });
  it('§4.3 states chat ephemerality + echo-only receipt (m7/m12)', () => {
    expect(SPEC).toContain('Chat is ephemeral, and the echo is the only receipt');
    expect(SPEC).toContain('no message id and no delivery acknowledgement');
  });
  it('§4.3 rules the typing cleanup floor as consumer duty (m13)', () => {
    expect(SPEC).toContain('Typing has no protocol-level cleanup floor');
    expect(SPEC).toContain('Consumers MUST expire stale');
  });
  it('§4.2 rules media_info opaque + defensive rendering (m14)', () => {
    expect(SPEC).toContain('opaque host-supplied payload');
    expect(SPEC).toContain('minimum-key profile, not even `title`');
  });
  it('§4.2 documents the play/pause/seek echo shapes per direction (m11)', () => {
    expect(SPEC).toContain('Echo shapes (both directions, per type');
    expect(SPEC).toContain('The echo omits `group_id`');
  });
  it('§8.4 states the hub-lane drift-blindness consequence (m15)', () => {
    expect(SPEC).toContain('consumer self-monitors');
  });
  it('§10.2 states returning-host + credential-custody facts (m8)', () => {
    expect(SPEC).toContain('Returning host & rejoin credentials');
    expect(SPEC).toContain('NEVER stores a');
  });
  it('§10 lead + §10.3 use the periodic-timer qualifier (m20)', () => {
    expect(SPEC).toContain('no socket and no periodic timers');
    expect(SPEC).toContain('schedules no periodic timers');
  });
});

describe('CONSOLIDATED batch-4 README currency (m25 m32 m33)', () => {
  it('README names the Tizen stack as Vite, and keyword-cases per SPEC (m25/m32)', () => {
    expect(README).toContain('tizen / Vite');
    expect(README).not.toContain('webpack');
    expect(README).toContain('the handshake MUST\ncarry your credential');
    expect(README).toContain('MUST NOT be added to new code paths');
  });
  it('README obeys the §2 terminology law — no bare room/party labels for the group (m33)', () => {
    expect(README).not.toMatch(/same-room|costs the room|seek a room|Party surface|Party chat/);
    expect(README).toContain('you never seek a group you just left');
  });
});

// ── Deferred-lane normalization wave (2026-11-03) ──────────────────────────────
// Each block below pins a NORMALIZATION of already-shipped wire truth recorded
// by the `sp-def` deferred lane: SPEC prose tightened to the disk-verified
// server/hub behavior at `phlix-server @ 98d7f691`, so a future edit that lets
// the prose drift off observed reality (or deletes the OPEN marker for a part
// that was deferred to the contracts wave) reddens here. These are red-on-parent
// at the pre-lane tip: the phrases they assert did not exist before this lane.

describe('SPEC §2 protocol_version receive law (deferred M5, review secnet/exploiter)', () => {
  it('records the observed :8097 value-refusal with its registry `legacy` code', () => {
    expect(SPEC).toContain('receive law (observed; era');
    expect(SPEC).toContain('PROTOCOL_VERSION_MISMATCH');
    expect(SPEC).toMatch(/MessageHandler\.php:187-197/);
    // The refusal is additive-safe: it drops ONE frame, socket survives.
    expect(SPEC).toMatch(/socket SURVIVES the refusal/);
  });

  it('states the HUB truth honestly — :8804 does not value-validate inbound', () => {
    expect(SPEC).toContain('value-validate an inbound');
    // and that hub.protocol_unsupported is the time_sync arm, NOT a version gate
    expect(SPEC).toMatch(/STATUS-QUERY refusal/);
  });

  it('pins the library decode as PRESENCE-keyed (current actual behavior)', () => {
    expect(SPEC).toContain('keys on `protocol_version` PRESENCE');
    // ...and the framing.ts gate it describes is still the presence test
    const FRAMING = readFileSync(fileURLToPath(new URL('../src/framing.ts', import.meta.url)), 'utf8');
    expect(FRAMING).toMatch(/!\('protocol_version' in record\)/);
  });

  it('defers the negotiation path to the contracts wave (no wire mint here)', () => {
    expect(SPEC).toContain('R-SP-W2-01');
    // No new dotted error code was invented for the version lane.
    expect(SPEC).not.toContain('syncplay.protocol_version');
  });
});

describe('SPEC §9.3 concurrent-connection law (deferred m10, review asphp/exploiter)', () => {
  it('documents the observed S289 :8097 last-wins re-home, citing the server tests', () => {
    expect(SPEC).toContain('one-seat-per-identity, last-wins');
    expect(SPEC).toContain('SyncPlayManager.php:791-812');
    expect(SPEC).toContain('testIdempotentJoinRepointsToNewestConnection');
  });

  it('records the survivor-safe close and corrects the stale evict claim', () => {
    expect(SPEC).toContain('close does not evict the survivor');
    expect(SPEC).toMatch(/PRE-S289 state/);
  });

  it('contrasts the hub per-connection-uuid model and defers true fan-out', () => {
    expect(SPEC).toMatch(/Hub relay `:8804` is the opposite/);
    expect(SPEC).toContain('R-SP-W2-02');
    // explicitly framed as observation that adds no new client requirement
    expect(SPEC).toContain('adds no new client requirement');
  });
});

describe('SPEC §8.5 enforced-bounds subsection (deferred M1, review exploiter)', () => {
  it('names the caps the server already enforces, with sites + error codes', () => {
    expect(SPEC).toMatch(/^### 8\.5 Bounds the server actually enforces today/m);
    expect(SPEC).toContain('MAX_MEMBERS');
    expect(SPEC).toContain('MAX_QUEUE_SIZE');
    expect(SPEC).toContain('syncplay.queue_limit_exceeded');
    expect(SPEC).toMatch(/RateLimitProfiles\.php:137/);
  });

  it('is explicitly descriptive (adds no new client requirement) and defers the missing matrix', () => {
    expect(SPEC).toContain('descriptive observations of shipped behavior');
    expect(SPEC).toContain('absorbs every inbound command');
    expect(SPEC).toContain('R-SP-W2-03');
  });
});

describe('SPEC §8.4 transport-encryption note (deferred M12, review secnet)', () => {
  it('states the plaintext-worker reality as a deployment concern, minting no MUST', () => {
    expect(SPEC).toContain('Transport encryption is a deployment concern');
    expect(SPEC).toMatch(/websocket:\/\/` listener/);
    expect(SPEC).toContain('put TLS in front of');
    // owner call: no "wss:// required" normative text is added
    expect(SPEC).toMatch(/OPEN owner\+transport decision/);
  });
});

describe('SPEC §4.2 nudge exit-side law (deferred M3, review gameux/asphp)', () => {
  it('records that no rate-reset frame exists and the only signal is nudge absence', () => {
    expect(SPEC).toContain('Nudge exit-side law');
    expect(SPEC).toContain('no rate RESET frame');
    expect(SPEC).toMatch(/absence/);
  });

  it('records that the reporter is_playing is never consulted (paused members ARE nudged)', () => {
    expect(SPEC).toContain('reporter');
    expect(SPEC).toContain('locally PAUSED');
  });

  it('defers all four convergence sub-laws to the contracts wave', () => {
    expect(SPEC).toContain('R-SP-W2-04');
  });
});

describe('SPEC §4.1 playback_state emitter matrix (deferred M8, review docmaint/gameux)', () => {
  it('documents which of the four states have live producers', () => {
    expect(SPEC).toContain('emitter matrix');
    expect(SPEC).toMatch(/handlePlaybackPlay` → `STATE_PLAYING/);
    // buffering is declared-but-unproduced; media-end and disband are absent
    expect(SPEC).toMatch(/no `group_disbanded`/);
    expect(SPEC).toContain('no "media ended" producer');
  });

  it('defers the new frames to the contracts wave and the lib redesign to owner', () => {
    expect(SPEC).toContain('R-SP-W2-05');
    expect(SPEC).toMatch(/OWNER design call/);
    // the current lib degrade-to-stopped law is still the shipped behavior
    expect(CLIENT).toMatch(/\? value\s*\n?\s*:\s*'stopped'/);
  });
});

describe('deferred-lane era-cite + TOC currency', () => {
  it('stamps every observed block to the disk-verified server era', () => {
    expect((SPEC.match(/98d7f691/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('advances the document-revision stamp (a normative surface was touched)', () => {
    // Deliberate literal — this is the stamp-rotation TRIPWIRE: any future
    // normative edit must rotate the SPEC stamp and consciously re-bless this
    // pin from its measured red (the m36 pin above guards the date SHAPE, so
    // rotatability itself never fights a lane). 2026-11-04 → 2026-11-03: the
    // forward-dated stamp was a disclosed date fiction (review minor m6; all
    // author/commit dates in the range are 2026-11-03).
    expect(SPEC).toMatch(/\*\*Document revision:\*\* 2026-11-03/);
  });

  it('keeps the Contents TOC in step with the added subsections', () => {
    expect(SPEC).toMatch(/Security model[\s\S]{0,60}8\.5/);
    expect(SPEC).toMatch(/identity contract[\s\S]{0,140}9\.3/);
    expect(SPEC).toMatch(/^### 9\.3 Concurrent connections/m);
  });
});

// ── Review-cure tripwires (REVIEW-CHANGES/syncplay.md Majors 1–2, minors 3–6,
// all cured 2026-11-03). Each pin asserts the CURED phrasing is present and the
// false claim stays deleted, so a revert reddens here. Red-on-parent: every
// negative pin below was green BEFORE this lane (it asserts absence of text
// that existed at 1a80b1d1) and every positive phrase absent there.

describe('review-cure: SPEC §4.6 error-field truth (Major 1)', () => {
  it('states error_code as the only field live emitters set', () => {
    expect(SPEC).toContain('the ONLY field live emitters set');
    expect(SPEC).toMatch(/`SyncPlayManager\.php:2025-2028`/);
    // The MUST itself is operative consumer law (client.ts reads the pair in
    // this order) and survives the cure verbatim:
    expect(SPEC).toMatch(/Clients MUST read `error_code` first, then fall back to `code`/);
  });

  it('keeps the false two-field split retired, on SPEC and in the shipped types', () => {
    expect(SPEC).not.toContain('SyncPlayManager::sendError uses code');
    expect(SPEC).not.toContain('splits its error emitters across the two fields');
    expect(SPEC).not.toContain('silently drops every frame from the other');
    expect(MESSAGES).not.toContain('sendError uses `code`');
  });
});

describe('review-cure: SPEC §4.3 chat retention truth (Major 2)', () => {
  it('says REPLAYS (consumer law) instead of stores (false storage claim)', () => {
    expect(SPEC).toContain('No carrier REPLAYS');
    expect(SPEC).toContain('snapshot-persisted');
    // Server-side retention now named with its verified coordinates:
    expect(SPEC).toMatch(/GroupState\.php:986-1000/);
    expect(SPEC).not.toContain('No carrier stores');
    // The consumer-observable lead sentence m7/m12 pinned is intact:
    expect(SPEC).toContain('Chat is ephemeral, and the echo is the only receipt');
  });
});

describe('review-cure: cite currency (minors 3–5)', () => {
  it('pins updatePlayback to its measured window (GroupState.php:720-726)', () => {
    expect(SPEC).toContain('(`GroupState.php:720-726`)');
    expect(SPEC).not.toContain('GroupState.php:714-722');
  });

  it('names the file for the joinGroup capacity cite (SyncPlayManager.php:840)', () => {
    expect(SPEC).toContain('joinGroup `SyncPlayManager.php:840`');
    expect(SPEC).not.toContain('`joinGroup` :838');
  });

  it('stamps the §2 hub cites to the verified hub tree', () => {
    expect(SPEC).toContain('era `phlix-hub` @ `3c4723f4`');
  });
});

describe('review-cure: no forward-dated stamps in live surfaces (minor 6)', () => {
  it('retires the forward-dated stamp fiction from SPEC and this test file', () => {
    // The [0.1.7] CHANGELOG section keeps its (sp-def, 2026-11-04) bullet
    // VERBATIM — tagged release history is never rewritten (rok05 precedent);
    // the fiction is forward-recorded in the [Unreleased] cure entry instead.
    // Assembled without a contiguous literal so this line cannot self-trip.
    const stale = '2026-11' + '-04';
    expect(SPEC).not.toContain(stale);
    const self = readFileSync(fileURLToPath(new URL('./specDocLaw.test.ts', import.meta.url)), 'utf8');
    const offenders = self
      .split('\n')
      .filter((line) => line.includes(stale) && !line.trimStart().startsWith('//'));
    expect(offenders).toEqual([]);
  });
});

describe('LW-042/LW-043/LW-044 law text on the contract surfaces (fix wave w02-L10)', () => {
  it('SPEC §4 carries the state-fold clamping alignment with its §10.2 rationale (LW-042)', () => {
    expect(SPEC).toContain('**State-fold alignment (LW-042).**');
    expect(SPEC).toContain('CLAMPS instead of drops');
  });

  it('SPEC §4 carries the grouped-delivery law with its named exception list (LW-044)', () => {
    expect(SPEC).toContain('**Grouped-delivery law (LW-044).**');
    expect(SPEC).toContain('unattributable');
  });

  it('the onSyncDegraded contract names the no-usable-server_time class and the reset law (LW-043)', () => {
    expect(CLIENT).toContain('no usable server_time');
    expect(CLIENT).toContain('this.consecutiveSyncRejections = 0;');
  });
});
