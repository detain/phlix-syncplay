/**
 * SPEC/README tripwire for M-SYNCPLAY-17 — who may SEND `playback_sync`.
 *
 * Review `syncplay__writer` MAJ-3: §9 item 2 used to declare
 * `syncplay_playback_sync` a host-only COMMAND while §9.1 three lines later
 * called it a STATE REPORT the server broadcasts to EVERY member. The live
 * producers settle it: the `NOT_HOST` gates sit on play / pause / seek /
 * QUEUE / host_transfer (phlix-server `SyncPlayManager.php:1071, :1123,
 * :1169, :1219, :1413` @ 3cfd26c2; hub `SyncPlayRelayWorker.php:1605,
 * :1707, :1873` @ 34ae8e3e) and NOT on `handlePlaybackSync` (:1483, whose own
 * docblock states "Any member can request a playback sync"). The old list was
 * doubly wrong: it gated `_sync` AND omitted `_queue`. A server team
 * implementing the old §9 MUST-language would 4xx every non-host member's
 * position report, breaking the S294 re-anchor design and starving the S446
 * per-member drift policy — both of which exist ONLY because non-hosts report.
 *
 * Legs:
 *  1. §9 item 2's gated list names the producer set exactly — includes
 *     `_queue`, excludes the sync type — and carries the affirmative
 *     member-permitted clause with a "not a server gap" ruling sentence.
 *  2. §9.1's STATE-REPORT sentence holds (guard against curing the
 *     contradiction from the wrong side — the invariant is §9 ≡ §9.1 ≡
 *     producer).
 *  3. §4's "Playback control" heading names the member-permitted exception
 *     and the retired blanket claim ("host-only on the server" as an
 *     unscoped umbrella) never returns.
 *  4. README quick-start: `reportPosition` does not sit in the Host-only
 *     controls block (it moved in the cure; the pre-cure example — the exact
 *     copy-paste a client team follows — listed it there).
 *  5. (M17 rider, this-lane src cure) `src/client.ts` doc-comments carry the
 *     same truth: the playback section banner no longer over-claims "host
 *     only" across `reportPosition`, and the `reportPosition` docblock states
 *     member-permission instead of the "typically host-driven" hedge — the
 *     docblock ships verbatim in `dist/client.d.ts`, so the wrong side
 *     reached every JS consumer's IDE, not just this repo's readers.
 *
 * Red-on-parent: at 72e8aac leg 1 trips on `_sync` in the item-2 list (and
 * the absent `_queue`/ruling clauses), leg 3 on the blanket heading, leg 4 on
 * `reportPosition` inside the Host-only block. Legs 2 is the held-side pin,
 * green on both sides by design. Leg 5 is red at the cure head `eff7fec`
 * (that lane left the src fiction as a named rider) and green only where the
 * banner/docblock cure coexists.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const SPEC_PATH = fileURLToPath(new URL('../SPEC.md', import.meta.url));
const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));
const CLIENT_TS_PATH = fileURLToPath(new URL('../src/client.ts', import.meta.url));
const SPEC = readFileSync(SPEC_PATH, 'utf8');
const README = readFileSync(README_PATH, 'utf8');
const CLIENT_TS = readFileSync(CLIENT_TS_PATH, 'utf8');

/** Slice one headline-delimited section body. */
function between(text: string, startMark: string, endMark: string): string {
  const start = text.indexOf(startMark);
  const end = text.indexOf(endMark);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`section not found: ${startMark}`);
  }
  return text.slice(start, end);
}

const SEC9 = between(SPEC, '## 9. Server-derived identity contract', '## 10.');
const ITEM2 = between(SEC9, '2. **Authorize host-only actions', '3. **Set the true sender id');

describe('SPEC §9 item 2 — the host-only command list equals the producer gate set (M-SYNCPLAY-17)', () => {
  it('names the five gated commands and NOT the state report', () => {
    for (const gated of [
      'syncplay_playback_play',
      '`_pause`',
      '`_seek`',
      '`_queue`',
      'syncplay_host_transfer',
    ]) {
      expect(ITEM2).toContain(gated);
    }
    // The list sentence itself must not brand the sync type host-only: the
    // only legal `_sync` mentions are inside the correction prose saying it
    // is NOT in the set.
    const listSentence = ITEM2.slice(0, ITEM2.indexOf('each MUST be authorized'));
    expect(listSentence).toContain('`_queue` and');
    expect(listSentence).not.toContain('_sync');
    expect(listSentence).not.toContain('playback_sync');
  });

  it('states affirmatively that playback_sync is a member-permitted state report', () => {
    expect(ITEM2).toContain('member-permitted');
    expect(ITEM2).toContain('STATE REPORT');
    expect(ITEM2).toContain('handlePlaybackSync()');
    expect(ITEM2).toContain('handleCanonicalPlaybackSync()');
    // The review asked whether the ungated arm is law or gap — the doc must
    // carry the ruled answer, not a hedge.
    expect(ITEM2).toContain('intentional law, not a server gap');
  });

  it('§9.1 keeps the matching law (cure may not flip the true side)', () => {
    const sec91 = between(SEC9, '### 9.1 Echo-suppression', '### 9.2');
    expect(sec91).toContain('STATE REPORT');
    expect(sec91).toContain('EVERY member including the sender');
  });
});

describe('SPEC §4 and README repeat-sites agree with the producer (M-SYNCPLAY-17)', () => {
  it('the §4 Playback control heading scopes the host-only claim and names the exception', () => {
    const heading = between(SPEC, '### Playback control', '`syncplay_playback_play` / `syncplay_playback_pause`');
    expect(heading).toContain('play/pause/seek/queue host-only');
    expect(heading).toContain('member-permitted state report');
    // The retired blanket (an umbrella over the whole subsection, sync block
    // included) must never return.
    expect(heading).not.toContain('control (host-only on the server;');
  });

  it('the README quick-start does not list reportPosition as host-only', () => {
    const hostBlock = between(README, '// Host-only controls', 'client.reportPosition');
    expect(hostBlock).not.toContain('reportPosition');
    const reportLead = between(README, '// Position report', 'client.reportPosition');
    expect(reportLead).toContain('ANY authenticated member');
    // The gated-set comment must name the producer set, not the old list.
    expect(hostBlock).toContain('play/pause/seek/queue/transfer');
  });
});

describe('src/client.ts doc-comments carry the roster truth (M17 rider)', () => {
  it('the playback banner names the real gate set and exempts the report', () => {
    const banner = between(CLIENT_TS, '// --- Playback', 'sendPlay(position: number)');
    // The retired over-claim (an unscoped "host only" banner sitting above
    // reportPosition too) must never return — in the old wording it shipped
    // verbatim into dist/client.d.ts and taught the fiction to consumers.
    expect(banner).not.toContain('host only; server rejects non-hosts');
    expect(banner).toContain('NOT on that roster');
    expect(banner).toContain('STATE REPORT');
    expect(banner).toContain('§9 item 2');
  });

  it('the reportPosition docblock states member-permission, not host convention', () => {
    const doc = between(CLIENT_TS, '   * Periodic position report', 'reportPosition(position: number');
    expect(doc).not.toContain('typically host-driven');
    expect(doc).toContain('Member-permitted on both producers');
    expect(doc).toContain('never an authorization precondition');
  });
});
