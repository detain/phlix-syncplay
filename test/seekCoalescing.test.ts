/**
 * seekCoalescing.test — command-repeat protection for sendSeek.
 *
 * Fix lane M-SYNCPLAY-09 (review `syncplay__gameux` M2): a TV remote holding
 * Right on the seek bar key-repeats at 10–30 events/s, and the pre-fix
 * `sendSeek` was a bare synchronous dispatch — every repeat became a
 * `syncplay_playback_seek` that the server rebroadcasts to EVERY member
 * (phlix-server `SyncPlayManager.php:1182` `broadcastToGroup`; the server
 * absorbs ZERO of this: its only WS limiter is `ws_connect` — 30
 * connections/60s on the handshake, `RateLimitProfiles.php:137` — its
 * `JoinPasswordThrottle` guards wrong join passwords only, and its
 * `queue_limit_exceeded` (`SyncPlayManager.php:1256`) caps media-QUEUE depth,
 * not command rate).
 *
 * Shipped stance: a leading + trailing COALESCING THROTTLE, default-on
 * (250 ms). Latest-wins is the semantically right merge for seeks — an
 * intermediate seek target is meaningless, only the last position matters.
 * The leading edge dispatches SYNCHRONOUSLY so single-press UX (every
 * existing consumer call pattern: phlix-ui `src/api/syncplay.ts`
 * `sendSyncPlayCommand` case 'seek', phlix-tizen store `sendSeek(0, …)`) is
 * byte-identical to the unthrottled path. `seekThrottleMs: 0` is the
 * documented escape hatch: pure passthrough, zero timers owned.
 *
 * Time control follows the house idiom: the injected `now` clock stays manual
 * (as in client.test.ts); only the coalescer's flush timer is driven, via
 * vitest fake timers.
 *
 * phlix-syncplay-025 extension: the pre-existing suite delivered GROUP_STATE
 * inbound only — no test ever landed a rebroadcast `syncplay_playback_seek`
 * WHILE a local coalescing window was open. The final block pins that
 * collision: remote authoritative target vs pending local flush ordering,
 * ship count, and the no-stale-flush / no-wire-pollution laws.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncPlayClient, type FrameDropReason, type PlaybackCommand } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage } from '../src/messages';

/** Ordered log of everything the client surfaced: outbound frames and callbacks. */
type HarnessEvent =
  | { kind: 'send'; message: RawMessage }
  | { kind: 'command'; command: PlaybackCommand }
  | { kind: 'drop'; reason: FrameDropReason; frame: unknown };

/** Fake transport + manual clock, in a group with this member as host. */
function makeHarness(seekThrottleMs?: number) {
  const sent: RawMessage[] = [];
  const commands: PlaybackCommand[] = [];
  const events: HarnessEvent[] = [];
  let t = 1000;
  const clock = {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
  const client = new SyncPlayClient({
    send: (m) => {
      sent.push(m);
      events.push({ kind: 'send', message: m });
    },
    now: clock.now,
    memberId: 'me',
    memberName: 'Tester',
    onPlaybackCommand: (command) => {
      commands.push(command);
      events.push({ kind: 'command', command });
    },
    onFrameDropped: (reason, frame) => {
      events.push({ kind: 'drop', reason, frame });
    },
    ...(seekThrottleMs === undefined ? {} : { seekThrottleMs }),
  });
  client.handleIncoming({
    type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
    protocol_version: 1,
    your_id: 'me',
    group: {
      group_id: 'sp_abc',
      group_name: 'Movie Night',
      member_count: 1,
      host_id: 'me',
      playback_position: 0,
      playback_state: 'playing',
      members: [{ id: 'me', name: 'Tester', is_host: true, joined_at: 1 }],
    },
  });
  sent.length = 0;
  events.length = 0;
  return { client, sent, clock, commands, events };
}

/** The seek frames currently on the wire, in order. */
function sentSeeks(sent: RawMessage[]): RawMessage[] {
  return sent.filter((m) => m.type === SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SyncPlayClient.sendSeek — coalescing throttle (M-SYNCPLAY-09)', () => {
  it('dispatches the first seek of a burst SYNCHRONOUSLY (leading edge keeps single-press UX unchanged)', () => {
    const h = makeHarness();
    h.client.sendSeek(1000, 5000);
    expect(sentSeeks(h.sent)).toHaveLength(1);
    expect(sentSeeks(h.sent)[0]).toMatchObject({
      group_id: 'sp_abc',
      member_id: 'me',
      from_position: 1000,
      to_position: 5000,
      server_time: 1000,
    });
  });

  it('coalesces repeats within the window latest-wins — intermediate targets never reach the wire', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading — on the wire
    h.client.sendSeek(0, 6000); // merged away
    h.client.sendSeek(0, 7000); // latest — this is what must flush
    expect(sentSeeks(h.sent)).toHaveLength(1);
    vi.advanceTimersByTime(250);
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2);
    expect(seeks[1]).toMatchObject({ from_position: 0, to_position: 7000 });
    // The discarded intermediate value appears nowhere on the wire.
    expect(seeks.map((m) => m.to_position)).not.toContain(6000);
  });

  it('flushes exactly ONE trailing send per window — no ghost repeats after the burst settles', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000);
    h.client.sendSeek(0, 7000);
    vi.advanceTimersByTime(250);
    expect(sentSeeks(h.sent)).toHaveLength(2);
    vi.advanceTimersByTime(10_000);
    expect(sentSeeks(h.sent)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('default window is exactly 250 ms when the option is absent (249 silent, 250 flushes)', () => {
    const h = makeHarness(); // no seekThrottleMs → default
    h.client.sendSeek(0, 5000);
    vi.advanceTimersByTime(10);
    h.client.sendSeek(0, 9000); // pending
    vi.advanceTimersByTime(239); // total 249 — window still open
    expect(sentSeeks(h.sent)).toHaveLength(1);
    vi.advanceTimersByTime(1); // 250 — trailing flush
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2);
    expect(seeks[1].to_position).toBe(9000);
  });

  it('caps a sustained key-repeat (29 events over 280 ms) at 3 frames with the exact latest-wins selections', () => {
    const h = makeHarness(250);
    for (let i = 0; i <= 28; i++) {
      vi.advanceTimersByTime(10);
      h.client.sendSeek(0, i * 100);
    }
    // Leading at t=10 (to=0); window boundary 260 flushes the ≤250 pending
    // (to=2400) and reopens; boundary 510 flushes the rest (to=2800).
    vi.advanceTimersByTime(1000);
    const toPositions = sentSeeks(h.sent).map((m) => m.to_position);
    expect(toPositions).toEqual([0, 2400, 2800]);
  });

  it('off-mode (seekThrottleMs: 0) is a pure passthrough — every call dispatches synchronously and no timer is scheduled', () => {
    const h = makeHarness(0);
    h.client.sendSeek(0, 5000);
    h.client.sendSeek(0, 6000);
    h.client.sendSeek(0, 7000);
    expect(sentSeeks(h.sent)).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesced trailing frames carry the SAME flat wire shape as leading frames (no marker fields)', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000);
    h.client.sendSeek(0, 7000);
    vi.advanceTimersByTime(250);
    const seeks = sentSeeks(h.sent);
    expect(Object.keys(seeks[1]).sort()).toEqual(Object.keys(seeks[0]).sort());
  });

  it('the trailing send stamps server_time at flush time, not at call time', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading at t=1000
    h.client.sendSeek(0, 7000); // pending
    h.clock.set(1120); // wall clock moves inside the window
    vi.advanceTimersByTime(250); // flush happens "now"
    const seeks = sentSeeks(h.sent);
    expect(seeks[1].server_time).toBe(1120);
    expect(seeks[0].server_time).toBe(1000);
  });

  it('leaveGroup during the window cancels the pending trailing send', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading
    h.client.sendSeek(0, 7000); // pending
    h.client.leaveGroup();
    // EAGER cancel: the window's timer is gone AT the leave itself (later
    // silence alone could also be produced by the flush-time group guard —
    // this pins that leaveGroup actually disarmed it).
    expect(vi.getTimerCount()).toBe(0);
    expect(h.sent.some((m) => m.type === SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(sentSeeks(h.sent)).toHaveLength(1); // only the leading frame ever shipped
    expect(vi.getTimerCount()).toBe(0);
  });

  it('onDisconnect during the window drops the pending seek and cancels its timer', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000);
    h.client.sendSeek(0, 7000);
    h.client.onDisconnect();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(sentSeeks(h.sent)).toHaveLength(1);
  });

  it('sendSeek stays a no-op with no group when the throttle is enabled', () => {
    const h = makeHarness(250);
    h.client.onDisconnect(); // forgets the group
    h.sent.length = 0;
    h.client.sendSeek(0, 7000);
    expect(h.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SyncPlayClient — seekThrottleMs boundary parsing (M-SYNCPLAY-09)', () => {
  const base = () => ({
    send: () => {},
    now: () => 1000,
    memberId: 'me',
  });

  it('rejects a negative window at the constructor with a descriptive TypeError', () => {
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: -1 })).toThrow(TypeError);
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: -1 })).toThrow(/seekThrottleMs/);
  });

  it('rejects non-finite windows (NaN, ±Infinity) at the constructor', () => {
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: NaN })).toThrow(/seekThrottleMs/);
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: Infinity })).toThrow(/seekThrottleMs/);
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: -Infinity })).toThrow(/seekThrottleMs/);
  });

  it('accepts 0 (off) and positive windows without throwing', () => {
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: 0 })).not.toThrow();
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: 250 })).not.toThrow();
  });
});

describe('SyncPlayClient — group replacement cancels the open seek window (R-SYNCPLAY-03)', () => {
  /** Deliver a GROUP_STATE for a different room (what joinGroup(B) mid-A lands as). */
  function enterOtherRoom(h: { client: SyncPlayClient; sent: RawMessage[] }): void {
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_other',
        group_name: 'Second Room',
        member_count: 1,
        host_id: 'me',
        playback_position: 0,
        playback_state: 'playing',
        members: [{ id: 'me', name: 'Tester', is_host: true, joined_at: 1 }],
      },
    });
  }

  it('a pending target from room A NEVER flushes stamped with room B group_id', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading — legitimately on the wire for sp_abc
    h.client.sendSeek(0, 7000); // pending in the open window
    enterOtherRoom(h);
    vi.advanceTimersByTime(10_000);
    const seeks = sentSeeks(h.sent);
    // Exactly the leading frame survives; the coalesced A-target is dropped.
    expect(seeks).toHaveLength(1);
    expect(seeks[0]).toMatchObject({ group_id: 'sp_abc', to_position: 5000 });
    // Nothing was ever dispatched against the new room's id.
    expect(seeks.map((m) => m.group_id)).not.toContain('sp_other');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a re-delivered SAME-group GROUP_STATE keeps the window open (state refresh is not a room change)', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading
    h.client.sendSeek(0, 7000); // pending
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_abc',
        group_name: 'Movie Night',
        member_count: 1,
        host_id: 'me',
        playback_position: 0,
        playback_state: 'playing',
        members: [{ id: 'me', name: 'Tester', is_host: true, joined_at: 1 }],
      },
    });
    vi.advanceTimersByTime(250);
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2);
    expect(seeks[1]).toMatchObject({ group_id: 'sp_abc', to_position: 7000 });
  });

  it('seeks sent after the room change belong to the new room', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000);
    enterOtherRoom(h);
    h.client.sendSeek(0, 9000); // new leading edge in sp_other
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2);
    expect(seeks[1]).toMatchObject({ group_id: 'sp_other', to_position: 9000 });
    // Its window owns only the new room's leading frame; advancing time with
    // nothing pending closes cleanly (no ghost, no re-arm).
    vi.advanceTimersByTime(10_000);
    expect(sentSeeks(h.sent)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SyncPlayClient — remote seek landing mid coalescing window (phlix-syncplay-025)', () => {
  /**
   * The server's rebroadcast of ANOTHER member's seek, shaped like the live
   * wire frame the client actually receives (member_id is the authenticated
   * sender per SPEC §9.1; the epoch-ms stamp is the plausible-accepted arm).
   */
  function remoteSeek(overrides: Record<string, unknown> = {}) {
    return {
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      group_id: 'sp_abc',
      member_id: 'other',
      from_position: 5000,
      to_position: 9000,
      server_time: 1700000000000,
      ...overrides,
    };
  }

  it('remote seek mid-window: consumer sees it exactly once, window untouched — local pending still flushes and the remote target never reaches OUR outbound wire', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading — on the wire
    h.client.sendSeek(0, 7000); // merged-latest pending in the open window

    h.client.handleIncoming(remoteSeek());

    // Inbound authority is surfaced through the callback, normalized ms stamp
    // accepted as-is...
    expect(h.commands).toEqual([{ type: 'seek', position: 9000, serverTime: 1700000000000 }]);
    // ...while adding NOTHING to the outbound wire and leaving the window's
    // machinery standing: still one owned flush timer, pending intact.
    expect(sentSeeks(h.sent)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(250); // boundary arrives on its ORIGINAL schedule
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2);
    expect(seeks[1]).toMatchObject({
      group_id: 'sp_abc',
      member_id: 'me',
      from_position: 0,
      to_position: 7000, // the LOCAL latest-wins target — inbound never overwrites it
    });
    // No wire pollution: the remote target never echoes back out under our id.
    expect(seeks.map((m) => m.to_position)).not.toContain(9000);

    // No stale flush: after the local trailing frame the window ships nothing
    // further (its empty re-arm closes silently).
    vi.advanceTimersByTime(10_000);
    expect(sentSeeks(h.sent)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);

    // Lawful order: the consumer sees the remote target BEFORE the local
    // trailing frame ships; the settle emits no ghost events.
    expect(h.events.map((e) => e.kind)).toEqual(['send', 'command', 'send']);
  });

  it('the echo of OUR OWN seek arriving mid-window stays silent (echo-suppression law) and cancels nothing', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000); // leading
    h.client.sendSeek(0, 7000); // pending
    h.client.handleIncoming(remoteSeek({ member_id: 'me', to_position: 5000 }));
    // Self-echo: no callback (a second application of our own intent), no
    // drop (suppression is law, not garbage — the option docblock's own list).
    expect(h.commands).toHaveLength(0);
    expect(h.events.filter((e) => e.kind === 'drop')).toHaveLength(0);
    expect(sentSeeks(h.sent)).toHaveLength(1);
    vi.advanceTimersByTime(250);
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2); // the echo cancelled nothing
    expect(seeks[1].to_position).toBe(7000); // latest-wins local pending survived
    expect(h.events.map((e) => e.kind)).toEqual(['send', 'send']);
  });

  it('a malformed remote seek (garbage to_position) mid-window drops through the existing malformed law and leaves the window intact', () => {
    const h = makeHarness(250);
    h.client.sendSeek(0, 5000);
    h.client.sendSeek(0, 7000);
    h.client.handleIncoming(remoteSeek({ to_position: 'nine-thousand' }));
    // Handler-refused garbage: one drop, zero commands...
    expect(h.commands).toHaveLength(0);
    expect(h.events.filter((e) => e.kind === 'drop')).toHaveLength(1);
    expect(h.events.map((e) => e.kind)).toEqual(['send', 'drop']);
    // ...and the window neither lost its timer nor lost the pending target.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(250);
    const seeks = sentSeeks(h.sent);
    expect(seeks).toHaveLength(2);
    expect(seeks[1].to_position).toBe(7000);
    expect(h.events.filter((e) => e.kind === 'drop')).toHaveLength(1); // no window-side drop either
  });

  it('the same remote seek with NO window open behaves identically at the callback — collision posture is inbound-only, not window-dependent', () => {
    const h = makeHarness(250);
    h.client.handleIncoming(remoteSeek());
    expect(h.commands).toEqual([{ type: 'seek', position: 9000, serverTime: 1700000000000 }]);
    expect(sentSeeks(h.sent)).toHaveLength(0); // inbound traffic never ships outbound...
    expect(vi.getTimerCount()).toBe(0); // ...and never opens a window
  });
});
