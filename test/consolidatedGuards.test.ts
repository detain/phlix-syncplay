/**
 * consolidatedGuards.test — law pins for the CONSOLIDATED review fix wave 1.
 *
 * Covers, one describe per item: M10 (array-fold element guards), m1 (the two
 * M-SYNCPLAY-19 guard gaps), m2 (nudge domain + position law), m3 (epoch-zero
 * stamps), m4 (sender boolean law), m5 (onFrameDropped seam), m9 (error
 * details carry), m16 (host-eviction onMemberLeft), m17 (timer-flush throw
 * isolation), m18 (destroy), m19 (decodeMessage honest type), m22
 * (backward-step ping wedge). Source:
 * .reviews/phlix-syncplay__CONSOLIDATED.md via the syncplay fix lane.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect, vi } from 'vitest';
import { SyncPlayClient, type FrameDropReason } from '../src/client';
import { decodeMessage, isValidMessageType, SYNCPLAY_MESSAGE_TYPES } from '../src';
import type { RawMessage, SyncPlayMessageType, UnknownFrame } from '../src/messages';

interface Harness {
  client: SyncPlayClient;
  sent: RawMessage[];
  t: { value: number };
  drops: Array<{ reason: FrameDropReason; frame: unknown }>;
  left: Array<{ id: string; name: string }>;
  hostChanges: Array<string | null>;
  seq: string[];
  errors: Array<{ code: string; message: string; details: unknown }>;
  typing: Array<{ id: string; isTyping: boolean }>;
  commands: Array<{ type: string; position: number; serverTime: number }>;
  syncs: Array<{ position: number; serverTime: number; nudge: Record<string, unknown> | undefined }>;
  groups: unknown[];
  states: number;
  disconnects: number;
  unknown: UnknownFrame[];
}

function makeHarness(opts: Partial<{ seekThrottleMs: number; sendThrowsAfter: number }> = {}): Harness {
  const h: Harness = {
    client: undefined as unknown as SyncPlayClient,
    sent: [],
    t: { value: 1000 },
    drops: [],
    left: [],
    hostChanges: [],
    seq: [],
    errors: [],
    typing: [],
    commands: [],
    syncs: [],
    groups: [],
    states: 0,
    disconnects: 0,
    unknown: [],
  };
  let sends = 0;
  h.client = new SyncPlayClient({
    send: (m) => {
      sends += 1;
      if (opts.sendThrowsAfter !== undefined && sends > opts.sendThrowsAfter) {
        throw new Error('sink exploded');
      }
      h.sent.push(m);
    },
    now: () => h.t.value,
    memberId: 'me',
    memberName: 'Tester',
    seekThrottleMs: opts.seekThrottleMs,
    onFrameDropped: (reason, frame) => h.drops.push({ reason, frame }),
    onMemberLeft: (m) => {
      h.left.push(m);
      h.seq.push(`left:${m.id}`);
    },
    onHostChanged: (id) => {
      h.hostChanges.push(id);
      h.seq.push('hostChanged');
    },
    onError: (code, message, details) => h.errors.push({ code, message, details }),
    onMemberTyping: (id, isTyping) => h.typing.push({ id, isTyping }),
    onPlaybackCommand: (c) => h.commands.push(c as { type: string; position: number; serverTime: number }),
    onPlaybackSync: (_memberId, position, _isPlaying, serverTime, nudge) =>
      h.syncs.push({ position, serverTime, nudge: nudge as Record<string, unknown> | undefined }),
    onGroupList: (rows) => h.groups.push(rows),
    onState: () => {
      h.states += 1;
    },
    onDisconnect: () => {
      h.disconnects += 1;
    },
    onUnknownFrame: (f) => h.unknown.push(f),
  });
  return h;
}

const JOINED_GROUP: RawMessage = {
  type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
  protocol_version: 1,
  your_id: 'me',
  group: {
    group_id: 'sp_abc',
    group_name: 'Movie Night',
    member_count: 2,
    host_id: 'host1',
    current_media_id: 'media_1',
    current_media_duration: 100000,
    playback_position: 4000,
    playback_state: 'playing',
    members: [
      { id: 'host1', name: 'Host', is_host: true, joined_at: 1 },
      { id: 'me', name: 'Tester', is_host: false, joined_at: 2 },
    ],
  },
};

// Typed helper: RawMessage.group is `unknown` on the envelope type, so build
// variants through a Record view (the fold guards are the runtime subject).
function groupStateWith(groupOverrides: Record<string, unknown>): RawMessage {
  return {
    ...JOINED_GROUP,
    group: { ...(JOINED_GROUP.group as Record<string, unknown>), ...groupOverrides },
  };
}

// ---------------------------------------------------------------- M10

describe('M10 — array folds drop non-object ELEMENTS instead of throwing', () => {
  it('members: [null, 3] folds only the object rows (no throw mid-fold)', () => {
    const h = makeHarness();
    h.client.handleIncoming(
      groupStateWith({ members: [null, 3, { id: 'ok1', name: 'Ok', joined_at: 5 }] }),
    );
    const group = h.client.getGroup()!;
    expect(group.members.map((m) => m.id)).toEqual(['ok1']);
  });

  it('dict members with a null value row drops that row', () => {
    const h = makeHarness();
    h.client.handleIncoming(
      groupStateWith({ members: { a: null, b: { name: 'Bee' }, c: 7 } }),
    );
    const group = h.client.getGroup()!;
    expect(group.members.map((m) => m.id)).toEqual(['b']);
    expect(group.members[0]!.name).toBe('Bee');
  });

  it('queue: [null] items are dropped, surviving items keep order', () => {
    const h = makeHarness();
    h.client.handleIncoming(
      groupStateWith({ queue: [null, { media_id: 'm1' }, 'x', { media_id: 'm2' }] }),
    );
    expect(h.client.getGroup()!.queue?.map((q) => q.media_id)).toEqual(['m1', 'm2']);
  });

  it('group_list rows: [null, row] survives as one clean row (used to throw)', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: [null, { id: 'g1', name: 'One', member_count: 1, has_password: false, current_media: null, is_playing: false }],
      count: 2,
    });
    expect(h.groups).toHaveLength(1);
    expect((h.groups[0] as Array<{ id: string }>).map((r) => r.id)).toEqual(['g1']);
  });

  it('queue broadcast with a null element folds the survivors only', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE,
      protocol_version: 1,
      queue: [undefined, { media_id: 'next' }],
    });
    expect(h.client.getGroup()!.queue?.map((q) => q.media_id)).toEqual(['next']);
  });
});

// ---------------------------------------------------------------- m1

describe('m1 — host_elect / typing guard gaps closed', () => {
  it('elected_id: 42 cannot poison host_id — it reads as null (no host)', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 42,
      elected_by: 'host1',
    });
    expect(h.client.getGroup()!.host_id).toBeNull();
    expect(h.client.isHost()).toBe(false);
  });

  it('is_typing: 1 (number) does not ride the typed boolean', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TYPING,
      protocol_version: 1,
      member_id: 'host1',
      is_typing: 1,
    });
    expect(h.typing).toEqual([{ id: 'host1', isTyping: false }]);
  });
});

// ---------------------------------------------------------------- m2

describe('m2 — nudge numerics carry domains; positions are ≥0 + duration-clamped', () => {
  it('suggested_rate 1e9 / tolerance -5 / cooldown -1 drop to undefined', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP); // LW-044: room-scoped fan-out — the nudge domain law is measured inside a room
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'me',
      position: 1000,
      is_playing: true,
      server_time: 1788300111,
      nudge: { drift_ms: 2500, direction: 'behind', suggested_rate: 1e9, tolerance_ms: -5, cooldown_ms: -1 },
    });
    const nudge = h.syncs[0]!.nudge!;
    expect(nudge.drift_ms).toBe(2500);
    expect(nudge.direction).toBe('behind');
    expect(nudge.suggested_rate).toBeUndefined();
    expect(nudge.tolerance_ms).toBeUndefined();
    expect(nudge.cooldown_ms).toBeUndefined();
  });

  it('in-band rates pass: 0.9 and 1.1 are the law’s edges', () => {
    const h = makeHarness();
    for (const rate of [0.9, 1.1]) {
      h.client.handleIncoming(JOINED_GROUP); // LW-044: see above — grouped premise
      h.client.handleIncoming({
        type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
        protocol_version: 1,
        member_id: 'me',
        position: 1000,
        is_playing: true,
        server_time: 1788300111,
        nudge: { suggested_rate: rate },
      });
    }
    expect(h.syncs.map((s) => s.nudge?.suggested_rate)).toEqual([0.9, 1.1]);
  });

  it('negative play position refuses the frame and reports malformed', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      position: -500,
      server_time: 1788300111000,
    });
    expect(h.commands).toHaveLength(0);
    expect(h.drops).toEqual([{ reason: 'malformed', frame: expect.objectContaining({ position: -500 }) }]);
  });

  it('position beyond cached duration clamps to duration (M6 consumer law made executable)', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 47_000_000,
      is_playing: true,
      server_time: 1788300111,
    });
    expect(h.syncs[0]!.position).toBe(100000);
  });

  it('without a cached duration the position passes untouched (no invented clamp)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateWith({ current_media_duration: null })); // LW-044: grouped premise kept honest — duration null so no clamp is invented
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 47_000_000,
      is_playing: true,
      server_time: 1788300111,
    });
    expect(h.syncs[0]!.position).toBe(47_000_000);
  });
});

// ---------------------------------------------------------------- m3

describe('m3 — epoch-zero stamps take the clock-estimate fallback', () => {
  it('server_time: 0 is garbage; serverTime falls back to the (unsynced) clock', () => {
    const h = makeHarness();
    h.t.value = 5000;
    h.client.handleIncoming(JOINED_GROUP); // LW-044: grouped premise (position 1000 < duration 100000: untouched)
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 1000,
      is_playing: true,
      server_time: 0,
    });
    expect(h.syncs[0]!.serverTime).toBe(5000);
  });

  it('server_time: -1 same law', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP); // LW-044: grouped premise
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 1000,
      is_playing: true,
      server_time: -1,
    });
    expect(h.syncs[0]!.serverTime).toBe(1000);
  });
});

// ---------------------------------------------------------------- m4

describe('m4 — the sender boolean law', () => {
  it('every guarded sender reports refusal with false and success with true', () => {
    const h = makeHarness();
    expect(h.client.sendPlay(1000)).toBe(false);
    expect(h.client.sendPause(1000)).toBe(false);
    expect(h.client.sendSeek(0, 1000)).toBe(false);
    expect(h.client.reportPosition(1000, true)).toBe(false);
    expect(h.client.sendChat('hi')).toBe(false);
    expect(h.client.sendTyping(true)).toBe(false);
    expect(h.client.leaveGroup()).toBe(false);
    expect(h.sent).toHaveLength(0);

    h.client.handleIncoming(JOINED_GROUP);
    expect(h.client.sendPlay(1000)).toBe(true);
    expect(h.client.sendPause(1000)).toBe(true);
    expect(h.client.sendSeek(0, 1000)).toBe(true);
    expect(h.client.sendSeek(0, 1500)).toBe(true); // merged into open window — accepted
    expect(h.client.reportPosition(1000, true)).toBe(true);
    expect(h.client.sendChat('hi')).toBe(true);
    expect(h.client.sendTyping(true)).toBe(true);
    expect(h.client.leaveGroup()).toBe(true);
  });

  it('a coalesced duplicate never double-ships but still reports acceptance', () => {
    const h = makeHarness({ seekThrottleMs: 10 });
    h.client.handleIncoming(JOINED_GROUP);
    expect(h.client.sendSeek(0, 1000)).toBe(true);
    expect(h.client.sendSeek(1000, 2000)).toBe(true);
    const seeks = h.sent.filter((m) => m.type === 'syncplay_playback_seek');
    expect(seeks).toHaveLength(1); // leading edge only; trailing flush merges
    expect(seeks[0]).toMatchObject({ to_position: 1000 });
  });
});

// ---------------------------------------------------------------- m5

describe('m5 — onFrameDropped observability seam', () => {
  it('undecodable JSON string reports once with the raw value', () => {
    const h = makeHarness();
    h.client.handleIncoming('{not json');
    expect(h.drops).toEqual([{ reason: 'undecodable', frame: '{not json' }]);
  });

  it('canonical frame missing its group object reports malformed', () => {
    const h = makeHarness();
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, protocol_version: 1 });
    expect(h.drops).toHaveLength(1);
    expect(h.drops[0]!.reason).toBe('malformed');
  });

  it('non-canonical vocabulary is NOT a drop — it keeps riding onUnknownFrame', () => {
    const h = makeHarness();
    h.client.handleIncoming({ type: 'pending_command', data: { x: 1 } });
    expect(h.drops).toHaveLength(0);
    expect(h.unknown).toHaveLength(1);
    expect(h.unknown[0]!.type).toBe('pending_command');
  });

  it('lawful protocol drops stay silent: self-echo suppression fires no drop', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'me', // our own echo — suppressed by law, not garbage
      position: 1000,
      server_time: 1788300111000,
    });
    expect(h.drops).toHaveLength(0);
    expect(h.commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- m9

describe('m9 — the error frame’s details object survives the boundary', () => {
  it('plain-object details pass verbatim; arrays and non-objects read as absent', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      error_code: 'syncplay.queue_limit_exceeded',
      message: 'Queue is full',
      details: { limit: 10, size: 11 },
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      error_code: 'NOT_HOST',
      message: 'nope',
      details: [1, 2],
    });
    expect(h.errors[0]).toEqual({
      code: 'syncplay.queue_limit_exceeded',
      message: 'Queue is full',
      details: { limit: 10, size: 11 },
    });
    expect(h.errors[1]!.details).toBeUndefined();
  });

  it('legacy two-argument consumers keep typechecking (additive third arg)', () => {
    const seen: Array<[string, string]> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onError: (code, message) => seen.push([code, message]),
    });
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      code: 'X',
      message: 'm',
      details: { a: 1 },
    });
    expect(seen).toEqual([['X', 'm']]);
  });
});

// ---------------------------------------------------------------- m16

describe('m16 — host-eviction fires onMemberLeft (was silently swallowed)', () => {
  it('departing host removed by host_elect announces left BEFORE hostChanged', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'me',
      elected_by: 'host1',
    });
    expect(h.left).toEqual([{ id: 'host1', name: 'Host' }]);
    expect(h.seq).toEqual(['left:host1', 'hostChanged']);
    expect(h.client.getGroup()!.members.map((m) => m.id)).toEqual(['me']);
  });

  it('self-eviction guard still holds: no left-event for our own id', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'host1',
      elected_by: 'me',
    });
    expect(h.left).toHaveLength(0);
    expect(h.client.getGroup()!.members.map((m) => m.id)).toContain('me');
  });
});

// ---------------------------------------------------------------- m17

describe('m17 — the seek-flush timer cannot surface an uncaught exception', () => {
  it('sink throw at the flush is caught and reported send-failed', async () => {
    const h = makeHarness({ seekThrottleMs: 5, sendThrowsAfter: 1 });
    h.client.handleIncoming(JOINED_GROUP);
    expect(h.client.sendSeek(0, 1000)).toBe(true); // leading edge ships (sink #1)
    expect(h.client.sendSeek(1000, 1300)).toBe(true); // merged — becomes the flush frame
    await new Promise((resolve) => setTimeout(resolve, 25)); // flush: sink #2 THROWS
    expect(h.drops).toEqual([{ reason: 'send-failed', frame: null }]);
    // Window unwound (no armed timer survives) and the DIRECT path still
    // propagates sink throws by law — proving the guard is scoped to the
    // timer flush only.
    h.client.handleIncoming(JOINED_GROUP);
    expect(() => h.client.sendSeek(1300, 2000)).toThrow('sink exploded');
  });
});

// ---------------------------------------------------------------- m18

describe('m18 — destroy() unwinds state without the disconnect callback', () => {
  it('group forgotten, no onDisconnect fire, later sends refuse', () => {
    const h = makeHarness({ seekThrottleMs: 5 });
    h.client.handleIncoming(JOINED_GROUP);
    h.client.sendSeek(0, 1000); // arms the one owned timer
    h.client.destroy();
    expect(h.client.getGroup()).toBeNull();
    expect(h.disconnects).toBe(0);
    expect(h.client.sendChat('after destroy')).toBe(false);
  });

  // SPY-1: the destroyed latch also guards the reconnect lane. A consumer's
  // onDisconnect callback is where reconnect backoff lives (README "Reconnect
  // recovery"): firing it on a destroyed instance armed a consumer timer on a
  // client that promised ZERO timers and routed NO callbacks.
  it('SPY-1: onDisconnect() after a sink-driven destroy() fires no callback and leaves zero timers', () => {
    vi.useFakeTimers();
    try {
      let reconnects = 0;
      let destroyOnSeek = false;
      const client: SyncPlayClient = new SyncPlayClient({
        send: (m) => {
          // Sink callback: the transport tears the screen down mid-dispatch.
          if (destroyOnSeek && m.type === SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK) client.destroy();
        },
        now: () => 1000,
        memberId: 'me',
        seekThrottleMs: 5,
        onDisconnect: () => {
          // A real consumer schedules its reconnect backoff here.
          setTimeout(() => {
            reconnects += 1;
          }, 1000);
        },
      });
      client.handleIncoming(JOINED_GROUP);
      expect(client.sendSeek(0, 1000)).toBe(true); // leading edge; arms the window
      expect(client.sendSeek(1000, 1300)).toBe(true); // coalesced trailing intent
      destroyOnSeek = true;
      vi.advanceTimersByTime(25); // flush -> sink -> destroy() mid-dispatch
      expect(vi.getTimerCount()).toBe(0);
      // The socket-close handler still fires after teardown.
      client.onDisconnect();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(reconnects).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------- m19

describe('m19 — decodeMessage returns the honest type', () => {
  it('foreign vocabulary decodes as UnknownFrame, not a cast RawMessage', () => {
    const decoded = decodeMessage('{"type":"pending_command","data":{"cmd":"x"}}');
    expect(decoded).not.toBeNull();
    expect(isValidMessageType((decoded as { type: string }).type)).toBe(false);
    expect((decoded as UnknownFrame).type).toBe('pending_command');
  });

  it('canonical vocabulary still decodes (guard says so, byte-wise)', () => {
    const decoded = decodeMessage(
      JSON.stringify({ type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE, protocol_version: 1 }),
    ) as RawMessage;
    expect(isValidMessageType(decoded.type)).toBe(true);
    expect(decoded.type satisfies SyncPlayMessageType).toBe(SYNCPLAY_MESSAGE_TYPES.GROUP_STATE);
  });

  it('the deprecated Tizen unwrap still works AND keeps its honest typing', () => {
    const decoded = decodeMessage('{"type":"syncplay_time_ping","data":{"client_time":42}}') as RawMessage;
    expect(decoded.type).toBe(SYNCPLAY_MESSAGE_TYPES.TIME_PING);
    expect(decoded).not.toHaveProperty('data');
    expect((decoded as unknown as Record<string, unknown>).client_time).toBe(42);
  });
});

// ---------------------------------------------------------------- m22

describe('m22 — a backward wall-clock step cannot wedge the single-flight slot', () => {
  it('negative-age outstanding ping is treated lost; the next call re-pings', () => {
    const h = makeHarness();
    h.client.pingTime();
    expect(h.sent.filter((m) => m.type === 'syncplay_time_ping')).toHaveLength(1);

    h.t.value = 500; // clock jumps BACKWARD 500 ms
    h.client.pingTime();
    expect(h.sent.filter((m) => m.type === 'syncplay_time_ping')).toHaveLength(2);
  });

  it('the fresh-window law is intact: a young positive age still single-flights', () => {
    const h = makeHarness();
    h.client.pingTime();
    h.t.value = 1200;
    h.client.pingTime();
    expect(h.sent.filter((m) => m.type === 'syncplay_time_ping')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- SPY-S11

describe('SPY-S11 — boundary coercion sweep', () => {
  const base = () => ({ send: () => {}, memberId: 'me', now: () => 1000 });

  it('SPY-13: non-string your_id folds to undefined (absent-semantic)', () => {
    const states: Array<string | undefined> = [];
    const c = new SyncPlayClient({ ...base(), onState: (_g, id) => states.push(id) });
    c.handleIncoming({ ...JOINED_GROUP, your_id: 42 } as unknown as RawMessage);
    expect(states).toEqual([undefined]);
  });

  it('SPY-14: password refusal never states a length', () => {
    let msg = '';
    try {
      new SyncPlayClient(base()).createGroup('G', 'abc');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('Got a string.');
    expect(msg).not.toContain('length');
  });

  it('SPY-15: seekThrottleMs ceiling 2^31-1 (dataset rows)', () => {
    for (const v of [2147483648, 1e12]) {
      expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: v })).toThrow(TypeError);
    }
    expect(() => new SyncPlayClient({ ...base(), seekThrottleMs: 2147483647 })).not.toThrow();
  });

  it('SPY-20: onFrameDropped throwing inside the flush timer is swallowed', async () => {
    let sends = 0;
    const c = new SyncPlayClient({
      send: () => {
        sends += 1;
        if (sends > 1) throw new Error('x');
      },
      memberId: 'me',
      now: () => 1000,
      seekThrottleMs: 5,
      onFrameDropped: () => {
        throw new Error('report exploded');
      },
    });
    c.handleIncoming(JOINED_GROUP);
    c.sendSeek(0, 1);
    c.sendSeek(1, 2);
    await new Promise((r) => setTimeout(r, 25)); // an escape would fail the run
    expect(sends).toBe(2);
  });

  it('SPY-16: outbound positions must be finite and >= 0', () => {
    const h = makeHarness();
    h.client.handleIncoming(JOINED_GROUP);
    for (const bad of [NaN, Infinity, -1, '5' as unknown as number]) {
      expect(() => h.client.sendPlay(bad)).toThrow(TypeError);
      expect(() => h.client.sendPause(bad)).toThrow(TypeError);
      expect(() => h.client.sendSeek(0, bad)).toThrow(TypeError);
      expect(() => h.client.sendSeek(bad, 0)).toThrow(TypeError);
      expect(() => h.client.reportPosition(bad, true)).toThrow(TypeError);
    }
    expect(h.sent.filter((m) => m.type !== 'syncplay_time_ping')).toHaveLength(0);
  });
});
