/**
 * specUnitLaw.test — the §4 single time-unit law (review `syncplay__writer` MAJ-1).
 *
 * The defect this pin kills is a CONTRACT-TEXT hazard, not a runtime one:
 * §4 ("Message payloads") is where implementers live, and the same
 * `server_time` field used to carry two different unit stories across §4,
 * §8.4 and the §2 footnote — the exact ambiguity that shipped phlix-mobile's
 * 2×-undercorrect time-sync bug class. §4 now states THE law once: ms is the
 * rule, `server_time` on the `:8097` server-stamped arms is the NAMED
 * per-carrier exception, and the delivery policy (what the library hands
 * consumers) names its one verbatim arm — the `time_sync` advisory's
 * `serverTimeSec`.
 *
 * The pins below therefore lock FOUR things:
 *  1. §4 contains the law heading, the named exception, and the delivery
 *     policy; the retired docs-lie ("normalizes every delivered server_time"
 *     — false for `time_sync`, see `handleTimeSync`) must never return.
 *  2. No second authority: §8.4 and the §2 footnote reference §4 and restate
 *     no law ("single authority" appears exactly twice in the whole spec —
 *     the §4 heading and §8.4's pointer to it).
 *  3. Every §4 `server_time` mention-site carries the law inline, and the
 *     library's actual parse behavior matches the documented policy —
 *     playback arms normalized to ms, `time_sync` delivered VERBATIM seconds.
 *  4. (r2, review RF-1) The §2 footnote BODY is roster-consistent: the
 *     retired hub-wide "every server stamp is milliseconds" universal —
 *     disproved by §4 (ii) and the hub's own `SyncPlayRelayWorker.php:1367`
 *     bytes — never returns, and the body carries the delegated roster
 *     (hub `server_time` ms, family-(ii) stamps seconds, JWT `exp` seconds).
 *
 * Red-on-parent: at a09506f §4's heading, exception clause and delivery
 * policy do not exist, §8.4 still states its own law, and the mention-sites
 * point at §8.4 instead of §4. The r2 body pin is additionally red at the
 * r1 head 3672447, whose footnote kept the universal.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SyncPlayClient } from '../src/client';
import {
  SYNCPLAY_MESSAGE_TYPES,
  type TimeSyncState,
} from '../src/messages';

const SPEC_PATH = fileURLToPath(new URL('../SPEC.md', import.meta.url));
const SPEC = readFileSync(SPEC_PATH, 'utf8');

/** Slice one `## N.` section (headline to the next `##` headline). */
function section(headline: string, nextHeadline: string): string {
  const start = SPEC.indexOf(headline);
  const end = SPEC.indexOf(nextHeadline);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`SPEC section not found: ${headline}`);
  }
  return SPEC.slice(start, end);
}

const SEC4 = section('## 4. Message payloads', '## 5.');
const SEC84 = section('### 8.4 WebSocket credential carrier', '## 9.');

describe('SPEC §4 — the single time-unit law with the named :8097 exception', () => {
  it('§4 states the law once, as the authority', () => {
    expect(SEC4).toContain('> **§4 UNIT LAW — the single authority on wire time units.**');
    expect(SEC4).toContain(
      '> **Named exception — `server_time` in UNIX SECONDS (`:8097` only).**',
    );
    expect(SEC4).toContain(
      '> **Delivery policy — what `@phlix/syncplay` consumers see.**',
    );
  });

  it('the exception names every :8097 server-stamped arm and excludes time_pong', () => {
    // Stamped seconds: playback_sync echo + nudge, time_sync, command-echo
    // fallback. Stamped ms everywhere else — pong explicitly ruled in.
    expect(SEC4).toContain('playback_sync` group echo and the S446 nudge unicast');
    expect(SEC4).toContain('`time_sync` advisory reply');
    expect(SEC4).toContain('play/pause/seek echo FALLBACK');
    expect(SEC4).toContain('`time_pong`\'s `server_time` is ms on BOTH');
  });

  it('the retired docs-lie never returns: the library does NOT normalize EVERY server_time', () => {
    // Pre-amendment §4 claimed "normalizes every delivered `server_time` to
    // milliseconds" — wire-false for the `time_sync` advisory, which
    // `handleTimeSync` delivers VERBATIM as `serverTimeSec`. A re-land of the
    // blanket claim would re-open the same contract-text hazard.
    expect(SEC4).not.toContain('normalizes every delivered');
    expect(SEC4).toContain('surfaces its seconds stamp');
    expect(SEC4).toContain('`serverTimeSec`');
  });

  it('every server_time mention-site in §4 carries the law inline', () => {
    const lines = SEC4.split('\n');
    const sites = lines
      .map((line, i) => ({ line, tail: lines.slice(i, i + 3).join(' ') }))
      .filter((s) => /^server_time: number/.test(s.line));
    // Five documented field lines: play/pause, seek, playback_sync, time_pong,
    // time_sync. A sixth without a §4 reference (or a dropped one) reds here.
    expect(sites).toHaveLength(5);
    for (const s of sites) {
      expect(s.tail).toContain('§4');
    }
  });
});

describe('SPEC — no second unit authority outside §4', () => {
  it('§8.4 defers to §4 instead of restating the law', () => {
    expect(SEC84).toContain('§4 is the single authority');
    // The old standalone law-statement ("per the §2 footnote's hub-wide ms
    // law, whereas the :8097 producer keeps a legacy seconds quirk") is gone.
    expect(SEC84).not.toContain("per the §2 footnote's hub-wide ms law");
    expect(SEC84).toContain('the hub arm of the §4 unit law\'s named exception');
  });

  it('the §2 footnote defers to §4 and keeps only its issued_at detail', () => {
    const sec2 = section('## 2. Framing', '## 3.');
    expect(sec2).toContain('the §4 unit law, hub-relay detail site');
    expect(sec2).toContain('not a second authority');
  });

  it('the §2 footnote BODY is roster-consistent — no hub-wide-ms universal (r2, RF-1)', () => {
    // The r1 cure re-pointed the footnote's delegation SENTENCE but left its
    // body asserting "every server stamp is in milliseconds except issued_at"
    // — a live contradiction of §4 family (ii) (roster/lifecycle stamps are
    // UNIX SECONDS on every carrier, hub `SyncPlayRelayWorker.php:1367`) and
    // of the RFC 7519 seconds scale of a JWT `exp`. §2's body must never
    // state an independent wire-unit universal again.
    const sec2 = section('## 2. Framing', '## 3.');
    expect(sec2).not.toMatch(/every server stamp is/);
    expect(sec2).not.toContain('(all ms)');
    // Positive body teeth: the delegated roster is actually restated here.
    expect(sec2).toContain('the hub never stamps a seconds'); // §4 (i): ms server_time on :8804
    expect(sec2).toContain('SyncPlayRelayWorker.php:1367'); // §4 (ii): hub seconds roster, cited
    expect(sec2).toContain('UNIX');
    expect(sec2).toContain('RFC 7519 seconds'); // `exp` is seconds scale
    expect(sec2).toContain('out-of-§4-scope'); // issued_at is metadata, not a §4 wire unit
  });

  it('"single authority" appears exactly twice in the whole spec', () => {
    // §4's own heading + §8.4's pointer to it. A third occurrence means some
    // section has started claiming law-making power for itself.
    const hits = SPEC.match(/single authority/g) ?? [];
    expect(hits).toHaveLength(2);
  });
});

describe('the documented delivery policy is the actual parse behavior', () => {
  const EPOCH_SEC = 1761900000; // whole-second epoch, `< 1e12` → seconds arm

  it('playback_sync seconds stamp arrives as ms (normalized at parse)', () => {
    const seen: number[] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => EPOCH_SEC * 1000,
      memberId: 'me',
      onPlaybackSync: (_m, _p, _i, serverTime) => seen.push(serverTime),
    });
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      server_time: EPOCH_SEC,
    });
    expect(seen).toEqual([EPOCH_SEC * 1000]);
  });

  it('time_sync seconds stamp arrives VERBATIM as serverTimeSec (the named verbatim arm)', () => {
    const states: TimeSyncState[] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => EPOCH_SEC * 1000,
      memberId: 'me',
      onTimeSync: (s) => states.push(s),
    });
    // Producer bytes: phlix-server SyncPlayManager.php:1652-1660.
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
      protocol_version: 1,
      member_id: 'user-1',
      group_id: 'group-1',
      server_time: EPOCH_SEC,
      offset_ms: 42,
      latency_ms: 7,
      drift_rate: 1.0,
      is_stable: true,
    });
    expect(states).toHaveLength(1);
    expect(states[0].serverTimeSec).toBe(EPOCH_SEC);
    // The ×1000 promotion would make this 1000× too LARGE for a consumer
    // comparing against its own seconds-scaled clock; §4 names it as the one
    // arm delivered unchanged.
    expect(states[0].serverTimeSec).toBeLessThan(1e12);
  });
});
