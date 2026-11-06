/**
 * Review wave w11 L10 — LW-045..LW-050 (registers
 * `.reviews/2026-11-04/syncplay__{secnet,crossfe,asphp}.md`).
 *
 * Written RED-FIRST against the `9268b66` parent: every behavior test below
 * fails until its cure lands; the pins marked (holding) pass before and after
 * and exist to freeze the ratified sides of the same laws (grouped-delivery
 * exception LW-047, legacy fall-through LW-049, untouched `serverTimeToMs`
 * math LW-050). Time control follows the house idiom: manual `now` clock plus
 * vitest fake timers for the library's one owned timer (`openSeekWindow`).
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SyncPlayClient } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage } from '../src/messages';

const SPEC = readFileSync(fileURLToPath(new URL('../SPEC.md', import.meta.url)), 'utf8');

/** sha256('') — the canonical well-formed lowercase-64-hex gate value. */
const VALID_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface Harness {
  client: SyncPlayClient;
  sent: RawMessage[];
  commands: Array<{ type: string; position: number; serverTime: number }>;
  syncs: Array<{ position: number; isPlaying: boolean; serverTime: number }>;
  drops: Array<{ reason: string; frame: unknown }>;
  hostChanges: Array<string | null>;
  memberLeft: Array<{ id: string; name: string }>;
  unknownFrames: unknown[];
  clock: { now: () => number; set: (v: number) => void };
  /** Fold the standard group-state frame (member 'me' in group 'sp_1'). */
  join: () => void;
}

/** Fake transport + manual clock at t=1000; `sendHook` re-enters mid-dispatch. */
function makeHarness(seekThrottleMs?: number, sendHook?: (m: RawMessage, h: Harness) => void): Harness {
  const h = {} as Harness;
  h.sent = [];
  h.commands = [];
  h.syncs = [];
  h.drops = [];
  h.hostChanges = [];
  h.memberLeft = [];
  h.unknownFrames = [];
  let t = 1000;
  h.clock = { now: () => t, set: (v: number) => { t = v; } };
  const options = {
    send: (m: RawMessage) => {
      h.sent.push(m);
      sendHook?.(m, h);
    },
    now: h.clock.now,
    memberId: 'me',
    memberName: 'Tester',
    onPlaybackCommand: (c: { type: string; position: number; serverTime: number }) => h.commands.push(c),
    onPlaybackSync: (_m: string | undefined, position: number, isPlaying: boolean, serverTime: number) =>
      h.syncs.push({ position, isPlaying, serverTime }),
    onFrameDropped: (reason: string, frame: unknown) => h.drops.push({ reason, frame }),
    onHostChanged: (id: string | null) => h.hostChanges.push(id),
    onMemberLeft: (member: { id: string; name: string }) => h.memberLeft.push(member),
    onUnknownFrame: (frame: unknown) => h.unknownFrames.push(frame),
    ...(seekThrottleMs === undefined ? {} : { seekThrottleMs }),
  } as ConstructorParameters<typeof SyncPlayClient>[0];
  h.client = new SyncPlayClient(options);
  h.join = () =>
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_1',
        group_name: 'Movie Night',
        member_count: 2,
        host_id: 'host1',
        playback_position: 0,
        playback_state: 'playing',
        members: [
          { id: 'host1', name: 'Host', is_host: true, is_playing: true },
          { id: 'me', name: 'Tester', is_host: false, is_playing: false },
        ],
      },
    } as RawMessage);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// LW-045 (review syncplay__secnet #3 class): passwordHash shape gate.
// TRUTH (w11 L10 re-review cure, register REVIEW-w11L10syncplay.md Major):
// the server gate (phlix-server `SyncPlayManager::groupPasswordGate` @
// 4a30962600 :2238-2250) `strtolower`s the raw value BEFORE matching
// /^([0-9a-f]{64})$/ and compares with hash_equals — an uppercase 64-hex
// copy case-folds and DOES authenticate on :8097. Short/long/non-hex/
// plaintext legs cannot survive the server's own regex, but the uppercase
// leg is where THIS library is STRICTER-THAN-SERVER: canonical wire form is
// lowercase and this client refuses non-canonical shapes as a local
// fail-fast, never shipping a value it would first have to normalize. The
// refusal itself stands — at the call boundary, fail-fast, without echoing
// the value (it may be a plaintext password the caller mis-passed).
// ---------------------------------------------------------------------------
describe('LW-045 — createGroup/joinGroup refuse malformed passwordHash at the boundary', () => {
  const malformed: Array<[string, string]> = [
    ['8-char fake hash', 'deadbeef'],
    ['plaintext password mis-passed', 'hunter2-super-secret'],
    ['uppercase hex (stricter-than-server: the server case-folds it)', VALID_HASH.toUpperCase()],
    ['63 hex chars', VALID_HASH.slice(0, 63)],
    ['65 hex chars', VALID_HASH + 'a'],
    ['non-hex 64 chars', 'g'.repeat(64)],
  ];

  for (const [label, value] of malformed) {
    it(`createGroup throws TypeError on a malformed hash (${label}) and ships nothing`, () => {
      const h = makeHarness();
      expect(() => h.client.createGroup('Movie Night', value)).toThrow(TypeError);
      expect(h.sent).toHaveLength(0);
    });
    it(`the refusal message does not echo the value (${label})`, () => {
      const h = makeHarness();
      try {
        h.client.createGroup('Movie Night', value);
        throw new Error('expected createGroup to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
        expect((e as TypeError).message).not.toContain(value);
      }
    });
    it(`joinGroup throws TypeError on a malformed hash (${label}) and ships nothing`, () => {
      const h = makeHarness();
      expect(() => h.client.joinGroup('sp_1', value)).toThrow(TypeError);
      expect(h.sent).toHaveLength(0);
    });
  }

  it('accepts the exact 64-lowercase-hex shape and stamps it byte-identical (holding)', () => {
    const h = makeHarness();
    h.client.createGroup('Movie Night', VALID_HASH);
    expect(h.sent[0]).toMatchObject({ password_hash: VALID_HASH });
    h.sent.length = 0;
    h.client.joinGroup('sp_1', VALID_HASH);
    expect(h.sent[0]).toMatchObject({ password_hash: VALID_HASH });
  });

  it('undefined stays the documented absent-password lane — no key on the frame (holding)', () => {
    const h = makeHarness();
    h.client.createGroup('Movie Night');
    expect(h.sent[0]).not.toHaveProperty('password_hash');
    h.sent.length = 0;
    h.client.joinGroup('sp_1');
    expect(h.sent[0]).not.toHaveProperty('password_hash');
  });

  // w11 L10 RE-REVIEW cure (register REVIEW-w11L10syncplay.md Minor): the
  // refusal MESSAGE BUILDER must not crash — or fabricate — on values the
  // type forbids, since runtime garbage is exactly what this gate is for.
  // Register adjudication, measured on disk (node v24): `String(symbol)`
  // does NOT throw (explicit String() is the legal symbol→string conversion;
  // the register's stated mechanism was off), so the old code printed a
  // fabricated "length of 'Symbol(desc)'" fact — and echoed the description,
  // which may BE the mis-passed secret. The true crash class is uncoercible
  // garbage: `String(Object.create(null))` throws 'Cannot convert object to
  // primitive value', silently REPLACING the curated message with an engine
  // one. Both legs pinned here, red-first at 930a0d4; the cure reports
  // length only on the string arm and never coerces unknown input.
  function refusalMessage(client: SyncPlayClient, value: unknown): string {
    try {
      client.createGroup('Movie Night', value as string);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      return (e as TypeError).message;
    }
    throw new Error('expected createGroup to refuse the value');
  }

  it('the refusal message survives uncoercible garbage — curated, never the engine message', () => {
    const h = makeHarness();
    const message = refusalMessage(h.client, Object.create(null));
    expect(message.startsWith('SyncPlayClient: passwordHash must be undefined')).toBe(true);
    expect(message).not.toContain('Cannot convert');
    expect(message).toContain('Got a object.');
    expect(h.sent).toHaveLength(0);
  });

  it('a symbol refusal discloses typeof only — no "length of Symbol()" fiction, no description echo', () => {
    const h = makeHarness();
    const message = refusalMessage(h.client, Symbol('hunter2'));
    expect(message).toContain('Got a symbol.');
    expect(message).not.toContain('of length');
    expect(message).not.toContain('hunter2');
    expect(h.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LW-046 (review syncplay__asphp #6 class): destroy() terminality.
// destroy() promises INERTY (m18). Pre-wave it was a state reset with a
// memory hole: inbound frames still fired callbacks, senders still shipped
// frames, and a re-entrant sendSeek during a synchronous dispatch could
// orphan a second coalescing timer (its handle overwritten before
// cancelSeekCoalescing ever saw it). A `destroyed` latch closes all three.
// ---------------------------------------------------------------------------
describe('LW-046 — destroy() is terminal: inert senders, silent inbound, zero timers', () => {
  it('inbound frames after destroy() fire NO callback and are not even drop-reported', () => {
    const h = makeHarness();
    h.join();
    h.client.destroy();
    h.commands.length = 0;
    h.drops.length = 0;
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      server_time: 1761900000,
    } as RawMessage);
    expect(h.commands).toHaveLength(0);
    expect(h.drops).toHaveLength(0);
  });

  it('createGroup/joinGroup/pingTime after destroy() ship nothing; boolean senders keep the false law', () => {
    const h = makeHarness();
    h.join();
    h.client.destroy();
    h.sent.length = 0;
    h.client.createGroup('Ghost Room');
    h.client.joinGroup('sp_1');
    h.client.pingTime();
    expect(h.sent).toHaveLength(0);
    expect(h.client.sendPlay(100)).toBe(false);
    expect(h.client.sendSeek(0, 100)).toBe(false);
  });

  it('a re-entrant sendSeek inside a synchronous leading dispatch owns exactly ONE timer', () => {
    let reentered = false;
    const h = makeHarness(undefined, (m, hh) => {
      if (m.type === SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK && !reentered) {
        reentered = true;
        hh.client.sendSeek(0, 11);
      }
    });
    h.join();
    h.sent.length = 0;
    h.client.sendSeek(0, 10);
    // Pre-wave: the outer leading edge overwrote the inner window's handle —
    // two armed timers, one cancellable. The invariant is exactly one.
    expect(vi.getTimerCount()).toBe(1);
    h.client.destroy();
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroy() called synchronously from the trailing-flush sink leaves zero live timers', () => {
    let armed = false;
    const h = makeHarness(undefined, (m, hh) => {
      if (armed && m.type === SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK) hh.client.destroy();
    });
    h.join();
    h.client.sendSeek(0, 10); // leading edge, opens the window
    h.client.sendSeek(0, 20); // coalesced trailing intent
    armed = true;
    vi.advanceTimersByTime(250); // flush -> sink -> destroy() mid-dispatch
    // Pre-wave: closeSeekWindow re-armed blindly after the dispatch returned,
    // arming a window on a destroyed client.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.sent.filter((m) => m.type === SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK)).toHaveLength(2);
  });

  it('onDisconnect (reconnect lane) keeps the instance usable after reset (holding)', () => {
    const h = makeHarness();
    h.join();
    h.client.onDisconnect();
    h.client.joinGroup('sp_1');
    expect(h.sent.some((m) => m.type === SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LW-047 (review syncplay__crossfe): ungrouped host_elect stays LIVE.
// 9268b66/LW-044 ratified host_elect as the NAMED EXCEPTION to the grouped-
// delivery law (SPEC §4): banner-style consumers act on the host id alone,
// the frame carries no group_id to scope by, and there is no cached group to
// fold. This pin freezes the ratified side so a future "consistency" sweep
// cannot silence it. Cure for the finding is the docblock + this pin.
// ---------------------------------------------------------------------------
describe('LW-047 — ungrouped host_elect fires ONLY onHostChanged (ratified exception, holding)', () => {
  it('announces the elected host with no cached group, without touching roster callbacks', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'someone',
      elected_by: 'ghost',
    } as RawMessage);
    expect(h.hostChanges).toEqual(['someone']);
    expect(h.client.getGroup()).toBeNull();
    expect(h.memberLeft).toHaveLength(0);
    expect(h.drops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LW-049 (review syncplay__secnet #4): protocol_version VALUE gate on
// canonical inbound frames. Server truth mirrored (:8097 MessageHandler
// refuses > PROTOCOL_VERSION and, since it is `is_int`-keyed, lets absent and
// stale integer stamps fall through; hub :8804 gates nothing). Pre-wave the
// LIBRARY also checked presence only — a protocol_version-2 frame drove the
// v1 decoder's full state machine. Absent / 0 / negative fall through exactly
// like the server's arms; foreign vocabulary is untouched (unknown-frame law).
// ---------------------------------------------------------------------------
describe('LW-049 — handleIncoming mirrors the server protocol_version value law on canonical frames', () => {
  const badVersions: Array<[string, unknown]> = [
    ['a higher integer', 2],
    ['a string version', '1'],
    ['a fractional version', 1.5],
  ];
  for (const [label, version] of badVersions) {
    it(`refuses a canonical frame carrying ${label} — drop-reported, not applied (group_state)`, () => {
      const h = makeHarness();
      h.client.handleIncoming({
        type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
        protocol_version: version,
        your_id: 'me',
        group: { group_id: 'sp_evil', group_name: 'X', member_count: 1, host_id: 'host1', playback_position: 0, playback_state: 'playing' },
      } as unknown as RawMessage);
      expect(h.client.getGroup()).toBeNull();
      expect(h.drops).toHaveLength(1);
      expect(h.drops[0].reason).toBe('malformed');
    });
    it(`refuses a canonical frame carrying ${label} — drop-reported, not applied (playback)`, () => {
      const h = makeHarness();
      h.join();
      h.commands.length = 0;
      h.drops.length = 0;
      h.client.handleIncoming({
        type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
        protocol_version: version,
        member_id: 'host1',
        position: 5000,
        server_time: 1761900000,
      } as RawMessage);
      expect(h.commands).toHaveLength(0);
      expect(h.drops).toHaveLength(1);
      expect(h.drops[0].reason).toBe('malformed');
    });
  }

  it('ABSENT protocol_version still falls through accepted — legacy lane mirrors the server (holding)', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      your_id: 'me',
      group: { group_id: 'sp_1', group_name: 'Movie Night', member_count: 1, host_id: 'host1', playback_position: 0, playback_state: 'playing' },
    } as unknown as RawMessage);
    expect(h.client.getGroup()?.group_id).toBe('sp_1');
    expect(h.drops).toHaveLength(0);
  });

  it('stale integer stamps (0, -3) fall through accepted, mirroring the server is_int arm (holding)', () => {
    for (const version of [0, -3]) {
      const h = makeHarness();
      h.client.handleIncoming({
        type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
        protocol_version: version,
        your_id: 'me',
        group: { group_id: 'sp_1', group_name: 'Movie Night', member_count: 1, host_id: 'host1', playback_position: 0, playback_state: 'playing' },
      } as RawMessage);
      expect(h.client.getGroup()?.group_id).toBe('sp_1');
      expect(h.drops).toHaveLength(0);
    }
  });

  it('the version law binds canonical frames only — foreign vocabulary still reaches onUnknownFrame (holding)', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: 'pending_command',
      protocol_version: 99,
      payload: {},
    } as unknown as RawMessage);
    expect(h.unknownFrames).toHaveLength(1);
    expect(h.drops).toHaveLength(0);
  });

  it('SPEC §2 records the receiver-side mirror (doc pin)', () => {
    expect(SPEC).toMatch(/Receiver-side mirror \(LW-049\)[\s\S]{0,160}?value law/);
  });
});

// ---------------------------------------------------------------------------
// LW-050 (review syncplay__secnet #5): serverTimeToMs consumer-bound trust.
// The magnitude heuristic (`< 1e12` ⇒ seconds) is UNTOUCHED math — the bug
// class is that ANY finite ≥ 1000 number was believed. A monotonic-uptime
// clock reading 9e11 "ms" normalized to year-30540 and teleported consumers.
// The cure is trust bounded to plausible wall-clock windows at the ONE shared
// consumer boundary; implausible magnitudes take the same honest fallback an
// absent stamp already gets — no estimate-relative comparison (fake-clock
// safe: goldens pair a fake now()≈1000 with real-epoch stamps).
// ---------------------------------------------------------------------------
describe('LW-050 — implausible server_time magnitudes take the clock-estimate fallback', () => {
  const implausible: Array<[string, number, number]> = [
    ['9e11 (uptime-class) pre-wave normalized to', 9e11, 9e14],
    ['5e9 (between the epoch windows) pre-wave normalized to', 5e9, 5e12],
  ];
  for (const [label, stamp, preWave] of implausible) {
    it(`playback arm refuses ${label} — delivers the fallback`, () => {
      const h = makeHarness();
      h.join();
      h.client.handleIncoming({
        type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
        protocol_version: 1,
        member_id: 'host1',
        position: 5000,
        server_time: stamp,
      } as RawMessage);
      // Fallback = getSynchronizedTime() with an empty sync window at now=1000.
      expect(h.commands).toEqual([{ type: 'play', position: 5000, serverTime: 1000 }]);
      expect(h.commands[0].serverTime).not.toBe(preWave);
    });
  }

  it('seek arm refuses an implausible stamp the same way', () => {
    const h = makeHarness();
    h.join();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1',
      from_position: 0,
      to_position: 9000,
      server_time: 9e11,
    } as RawMessage);
    expect(h.commands).toEqual([{ type: 'seek', position: 9000, serverTime: 1000 }]);
  });

  it('sync arm refuses an implausible stamp the same way', () => {
    const h = makeHarness();
    h.join();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 6000,
      is_playing: true,
      server_time: 9e11,
    } as RawMessage);
    expect(h.syncs).toEqual([{ position: 6000, isPlaying: true, serverTime: 1000 }]);
  });

  it('plausible epoch-seconds and epoch-ms stamps pass through UNTOUCHED (holding)', () => {
    const h = makeHarness();
    h.join();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      position: 1,
      server_time: 1761900000,
    } as RawMessage);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      position: 2,
      server_time: 1761900000123,
    } as RawMessage);
    expect(h.commands).toEqual([
      { type: 'play', position: 1, serverTime: 1761900000000 },
      { type: 'play', position: 2, serverTime: 1761900000123 },
    ]);
  });

  it('serverTimeToMs itself keeps its pure magnitude heuristic — the bound is at the consumer (holding)', () => {
    expect(SyncPlayClient.serverTimeToMs(9e11)).toBe(9e14);
    expect(SyncPlayClient.serverTimeToMs(1761900000)).toBe(1761900000000);
  });

  it('SPEC §4 records the consumer-bound trust window (doc pin)', () => {
    expect(SPEC).toMatch(/consumer-bound trust window \(LW-050\)[\s\S]{0,80}?are not believed/);
  });
});
