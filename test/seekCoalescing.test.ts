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
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncPlayClient } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage } from '../src/messages';

/** Fake transport + manual clock, in a group with this member as host. */
function makeHarness(seekThrottleMs?: number) {
  const sent: RawMessage[] = [];
  let t = 1000;
  const clock = {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
  const client = new SyncPlayClient({
    send: (m) => sent.push(m),
    now: clock.now,
    memberId: 'me',
    memberName: 'Tester',
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
    },
  });
  sent.length = 0;
  return { client, sent, clock };
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
