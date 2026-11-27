/**
 * client.test.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect, vi } from 'vitest';
import { SyncPlayClient, type PlaybackCommand } from '../src/client';
import { encodeMessage, serializeMessage } from '../src/framing';
import { SYNCPLAY_MESSAGE_TYPES, type GroupListSummaryRow, type PlaybackQueueItem, type RawMessage, type SyncPlayGroup, type TimeSyncPayload, type TimeSyncState, type UnknownFrame } from '../src/messages';

/** A fake transport + clock harness. */
function makeHarness(memberId = 'me') {
  const sent: RawMessage[] = [];
  let t = 1000;
  const clock = {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
  const states: Array<{ group: SyncPlayGroup; yourId: string | undefined }> = [];
  const syncs: Array<{ offset: number; latency: number; isStable: boolean }> = [];
  const commands: PlaybackCommand[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const joined: Array<{ id: string; name: string }> = [];
  const left: Array<{ id: string; name: string }> = [];
  const degraded: number[] = [];
  const hostChanges: Array<string | null> = [];
  const disconnects: number[] = [];
  const unknown: UnknownFrame[] = [];

  const client = new SyncPlayClient({
    send: (m) => sent.push(m),
    now: clock.now,
    memberId,
    memberName: 'Tester',
    onState: (group, yourId) => states.push({ group, yourId }),
    onSync: (s) => syncs.push(s),
    onPlaybackCommand: (c) => commands.push(c),
    onError: (code, message) => errors.push({ code, message }),
    onMemberJoined: (m) => joined.push(m),
    onMemberLeft: (m) => left.push(m),
    onSyncDegraded: (streak) => degraded.push(streak),
    onHostChanged: (h) => hostChanges.push(h),
    onDisconnect: () => disconnects.push(1),
    onUnknownFrame: (frame) => unknown.push(frame),
  });

  return { client, sent, clock, states, syncs, commands, errors, joined, left, degraded, hostChanges, disconnects, unknown };
}

function groupStateMessage(hostId: string, yourId: string): RawMessage {
  return {
    type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
    protocol_version: 1,
    your_id: yourId,
    group: {
      group_id: 'sp_abc',
      group_name: 'Movie Night',
      member_count: 2,
      host_id: hostId,
      current_media_id: 'media_1',
      current_media_duration: 0,
      playback_position: 0,
      playback_state: 'paused',
      created_at: 1700000000,
      last_activity_at: 1700000000,
      members: [
        { id: hostId, name: 'Host', is_host: true, joined_at: 1 },
        { id: 'me', name: 'Tester', is_host: false, joined_at: 2 },
      ],
    },
  };
}

/** Same GROUP_STATE shape, with an explicit non-zero cached playback_position. */
function groupStateMessageAt(hostId: string, yourId: string, playbackPosition: number): RawMessage {
  const frame = groupStateMessage(hostId, yourId);
  return { ...frame, group: { ...(frame.group as SyncPlayGroup), playback_position: playbackPosition } };
}

describe('SyncPlayClient — group management sends', () => {
  it('createGroup emits a flat group_create with member fields', () => {
    const h = makeHarness();
    // LW-045-era fixture move (disclosed): the shape gate now refuses the old
    // 8-char 'deadbeef' stand-in, which was never a wire-usable value — the
    // server gate is /^([0-9a-f]{64})$/ + hash_equals. sha256('') below.
    h.client.createGroup('Movie Night', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      type: 'syncplay_group_create',
      protocol_version: 1,
      timestamp: 1000,
      group_name: 'Movie Night',
      member_id: 'me',
      member_name: 'Tester',
      password_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });

  it('joinGroup emits a flat group_join', () => {
    const h = makeHarness();
    h.client.joinGroup('sp_abc');
    expect(h.sent[0]).toMatchObject({
      type: 'syncplay_group_join',
      group_id: 'sp_abc',
      member_id: 'me',
    });
    expect(h.sent[0]).not.toHaveProperty('data');
  });

  it('leaveGroup is a no-op until a group is known, then sends group_leave', () => {
    const h = makeHarness();
    h.client.leaveGroup();
    expect(h.sent).toHaveLength(0);

    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.leaveGroup();
    expect(h.sent.at(-1)).toMatchObject({
      type: 'syncplay_group_leave',
      group_id: 'sp_abc',
      member_id: 'me',
    });
    expect(h.client.getGroup()).toBeNull();
  });
});

describe('SyncPlayClient — handleIncoming group_state', () => {
  it('routes nested group + your_id to onState and derives is_host from host_id', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    expect(h.states).toHaveLength(1);
    const { group, yourId } = h.states[0];
    expect(yourId).toBe('me');
    expect(group.group_id).toBe('sp_abc');
    expect(group.group_name).toBe('Movie Night');
    expect(group.host_id).toBe('host1');
    expect(group.members.find((m) => m.id === 'host1')?.is_host).toBe(true);
    expect(group.members.find((m) => m.id === 'me')?.is_host).toBe(false);
    expect(h.client.isHost()).toBe(false);
  });

  it('isHost is true when host_id matches our member id', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('me', 'me'));
    expect(h.client.isHost()).toBe(true);
  });

  it('preserves the buffering playback_state and group_id/group_name on the group', () => {
    const h = makeHarness();
    const msg = groupStateMessage('host1', 'me');
    (msg.group as { playback_state: string }).playback_state = 'buffering';
    h.client.handleIncoming(msg);

    const group = h.client.getGroup();
    expect(group?.group_id).toBe('sp_abc');
    expect(group?.group_name).toBe('Movie Night');
    expect(group?.playback_state).toBe('buffering');
    expect(group?.member_count).toBe(2);
    expect(group?.current_media_duration).toBe(0);
  });
});

describe('SyncPlayClient — time sync', () => {
  it('pingTime sends a time_ping and handleIncoming(pong) updates offset', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    expect(h.sent[0]).toEqual({
      type: 'syncplay_time_ping',
      protocol_version: 1,
      timestamp: 1000,
      client_time: 1000,
    });

    // Server pong: echoes client_time t1=1000, server_time t2=1100. Client
    // receives at t4=1001 → rtt 1, oneWay 0, offset 100 (weight 1, exact).
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1100,
    });

    expect(h.syncs).toHaveLength(1);
    expect(h.syncs[0].offset).toBe(100);
    expect(h.syncs[0].latency).toBe(0);
    expect(h.client.getTimeSync().getOffset()).toBe(100);
  });

  it('falls back to the recorded send time when pong omits client_time', () => {
    const h = makeHarness();
    h.clock.set(2000);
    h.client.pingTime();
    h.clock.set(2001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      server_time: 2100,
    });
    // rtt = 2001 - 2000 = 1, oneWay 0, offset = 2100 - 2000 + 0 = 100 (weight 1).
    expect(h.client.getTimeSync().getOffset()).toBe(100);
  });
});

describe('SyncPlayClient — playback commands inbound', () => {
  it('routes play/pause/seek from another member to onPlaybackCommand', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      // :8097 wire truth: the echo fallback stamps UNIX SECONDS
      // (SyncPlayManager.php:1076 `?? time()`) — consumers must receive ms.
      server_time: 1761900000,
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1',
      from_position: 5000,
      to_position: 9000,
      // hub wire truth: ms pass-through (SyncPlayRelayWorker.php:1535
      // canonicalInt of the sender's ms stamp) — must arrive UNTOUCHED.
      server_time: 1761900000123,
    });

    expect(h.commands).toEqual([
      { type: 'play', position: 5000, serverTime: 1761900000000 },
      { type: 'seek', position: 9000, serverTime: 1761900000123 },
    ]);
  });

  it('ignores playback commands echoed back from ourselves', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('me', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE,
      protocol_version: 1,
      member_id: 'me',
      position: 1,
      server_time: 1,
    });
    expect(h.commands).toHaveLength(0);
  });
});

describe('SyncPlayClient — host election, info (member joins), errors', () => {
  it('host_elect updates host_id and fires onHostChanged', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'me',
      elected_by: 'host1',
    });
    expect(h.hostChanges).toEqual(['me']);
    expect(h.client.getGroup()?.host_id).toBe('me');
    expect(h.client.isHost()).toBe(true);
  });

  it('treats an INFO carrying member_id + member_name as a member join', () => {
    const h = makeHarness();
    // LW-044: join announcements are room-scoped — seed the group the honest
    // server fan-out presumes (ungrouped refusal pinned separately).
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO,
      protocol_version: 1,
      message: 'Guest joined the group',
      member_id: 'guest1',
      member_name: 'Guest',
    });
    expect(h.joined).toEqual([{ id: 'guest1', name: 'Guest' }]);
  });

  it('routes errors using error_code then code, with message', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      code: 'NOT_HOST',
      message: 'Only the host can control playback',
    });
    expect(h.errors).toEqual([{ code: 'NOT_HOST', message: 'Only the host can control playback' }]);
  });

  it('ignores undecodable frames', () => {
    const h = makeHarness();
    const spy = vi.fn();
    h.client.handleIncoming('{garbage');
    h.client.handleIncoming(null);
    expect(spy).not.toHaveBeenCalled();
    expect(h.states).toHaveLength(0);
  });
});

describe('SyncPlayClient — onDisconnect / reconnect reset (B4)', () => {
  it('clears time-sync samples, group, and outstanding ping, and fires onDisconnect', () => {
    const h = makeHarness();

    // Seed an established session: a group + a couple of accepted time samples.
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1100,
    });
    expect(h.client.getGroup()).not.toBeNull();
    expect(h.client.getTimeSync().getSampleCount()).toBe(1);

    h.client.onDisconnect();

    // (1) group forgotten, (2) samples + drift reset, (3) callback fired.
    expect(h.client.getGroup()).toBeNull();
    expect(h.client.getTimeSync().getSampleCount()).toBe(0);
    expect(h.client.getTimeSync().getDriftRate()).toBe(1.0);
    expect(h.disconnects).toEqual([1]);
  });

  it('clears lastPingSendTime so a stray pong from the dead connection is ignored', () => {
    const h = makeHarness();

    // An outstanding ping is in flight when the socket drops.
    h.clock.set(1000);
    h.client.pingTime();

    h.client.onDisconnect();

    // A late pong that omits client_time would, with a live lastPingSendTime,
    // fall back to it and seed a sample. After onDisconnect cleared it, t1 is
    // null and the pong is dropped — no sample, no onSync.
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      server_time: 1100,
    });
    expect(h.client.getTimeSync().getSampleCount()).toBe(0);
    expect(h.syncs).toHaveLength(0);
  });

  it('ignores a LIVE-shaped (echoed client_time) pong that arrives after onDisconnect', () => {
    // SPEC §10.1.3 guard, exercised on the shape the live server actually
    // emits. The pre-existing stray-pong test above omits `client_time` — the
    // NON-live shape — so it only exercised the dead fallback branch. The real
    // wire (`Messages::timePong`, phlix-server) ALWAYS echoes `client_time`, so
    // the pre-fix `pong.client_time === 'number'` branch trusted a still-
    // buffered pong from the torn-down socket and seeded a corrupt sample.
    const h = makeHarness();

    h.clock.set(1000);
    h.client.pingTime(); // outstanding ping, send time = 1000

    h.client.onDisconnect(); // drops lastPingSendTime (the liveness signal)

    // Late pong from the dead connection, real wire shape (carries the echo),
    // arriving well inside MAX_ACCEPTABLE_RTT so the estimator would accept it
    // if it were ever reached.
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1100,
    });

    expect(h.client.getTimeSync().getSampleCount()).toBe(0);
    expect(h.syncs).toHaveLength(0);
  });

  it('is safe to call with no group and no callback configured', () => {
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 0,
      memberId: 'me',
    });
    expect(() => client.onDisconnect()).not.toThrow();
    expect(client.getGroup()).toBeNull();
    expect(client.getTimeSync().getSampleCount()).toBe(0);
  });

  it('SPY-1: onDisconnect() on a destroyed instance is a no-op — no callback, no state touch', () => {
    // destroy() is TERMINAL (LW-046). A consumer whose socket-close handler
    // still runs after screen teardown calls onDisconnect() on the dead
    // instance; pre-fix that fired the consumer's disconnect callback (the
    // "reconnecting…" lane) on a client that promised it routes nothing.
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.destroy();
    expect(h.disconnects).toEqual([]);
    h.client.onDisconnect();
    expect(h.disconnects).toEqual([]);
    expect(h.client.getGroup()).toBeNull();
    // The reconnect lane stays closed: re-join still ships nothing.
    h.sent.length = 0;
    h.client.joinGroup('sp_abc');
    expect(h.sent).toHaveLength(0);
  });

  it('supports the documented re-join recovery sequence after a reset', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.onDisconnect();
    expect(h.client.getGroup()).toBeNull();

    // Recovery: re-join, then resume pinging.
    h.sent.length = 0;
    h.client.joinGroup('sp_abc');
    expect(h.sent.at(-1)).toMatchObject({
      type: 'syncplay_group_join',
      group_id: 'sp_abc',
      member_id: 'me',
    });
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    expect(h.client.getGroup()).not.toBeNull();
  });
});

describe('SyncPlayClient — host playback sends', () => {
  it('sendPlay/sendPause/sendSeek emit flat messages with synchronized server_time', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('me', 'me'));
    // Give a known offset of 100 so server_time is predictable (rtt 1 quad).
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1100,
    });

    h.clock.set(2000); // synchronized = 2000 + 100 = 2100
    h.sent.length = 0;
    h.client.sendPlay(7000);
    expect(h.sent[0]).toEqual({
      type: 'syncplay_playback_play',
      protocol_version: 1,
      timestamp: 2000,
      group_id: 'sp_abc',
      member_id: 'me',
      position: 7000,
      server_time: 2100,
    });
  });
});

describe('SyncPlayClient — outbound playback (reportPosition)', () => {
  it('reportPosition emits PLAYBACK_SYNC with synchronized server_time', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('me', 'me'));
    // Seed time sync with offset 100.
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1100,
    });

    h.clock.set(2000); // synchronized = 2000 + 100 = 2100
    h.sent.length = 0;
    h.client.reportPosition(7000, true);
    expect(h.sent[0]).toEqual({
      type: 'syncplay_playback_sync',
      protocol_version: 1,
      timestamp: 2000,
      group_id: 'sp_abc',
      member_id: 'me',
      position: 7000,
      is_playing: true,
      server_time: 2100,
    });
  });

  it('reportPosition is a no-op when not in a group', () => {
    const h = makeHarness();
    h.client.reportPosition(5000, true);
    expect(h.sent).toHaveLength(0);
  });
});

describe('SyncPlayClient — sendPlay/sendPause/sendSeek early returns', () => {
  it('sendPlay is a no-op when not in a group', () => {
    const h = makeHarness();
    h.client.sendPlay(5000);
    expect(h.sent).toHaveLength(0);
  });

  it('sendPause is a no-op when not in a group', () => {
    const h = makeHarness();
    h.client.sendPause(5000);
    expect(h.sent).toHaveLength(0);
  });

  it('sendSeek is a no-op when not in a group', () => {
    const h = makeHarness();
    h.client.sendSeek(1000, 5000);
    expect(h.sent).toHaveLength(0);
  });
});

describe('SyncPlayClient — createGroup/joinGroup without password', () => {
  it('createGroup omits password_hash when not provided', () => {
    const h = makeHarness();
    h.client.createGroup('Movie Night');
    expect(h.sent[0]).toEqual({
      type: 'syncplay_group_create',
      protocol_version: 1,
      timestamp: 1000,
      group_name: 'Movie Night',
      member_id: 'me',
      member_name: 'Tester',
    });
    expect(h.sent[0]).not.toHaveProperty('password_hash');
  });

  it('joinGroup omits password_hash when not provided', () => {
    const h = makeHarness();
    h.client.joinGroup('sp_abc');
    expect(h.sent[0]).toEqual({
      type: 'syncplay_group_join',
      protocol_version: 1,
      timestamp: 1000,
      group_id: 'sp_abc',
      member_id: 'me',
      member_name: 'Tester',
    });
    expect(h.sent[0]).not.toHaveProperty('password_hash');
  });
});

describe('SyncPlayClient — handleIncoming inbound handlers', () => {
  it('handlePlaybackSync routes position/is_playing from another member', () => {
    const syncs: Array<{ memberId: string; position: number; isPlaying: boolean; serverTime: number }> = [];
    // Re-create client with the onPlaybackSync hook
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onPlaybackSync: (memberId, position, isPlaying, serverTime) =>
        syncs.push({ memberId, position, isPlaying, serverTime }),
    });

    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      // :8097 wire truth: the group echo stamps UNIX SECONDS
      // (SyncPlayManager.php:1506 `time()` → broadcast :1523).
      server_time: 1761900000,
    });

    expect(syncs).toEqual([
      { memberId: 'host1', position: 5000, isPlaying: true, serverTime: 1761900000000 },
    ]);
  });

  it('handlePlaybackSync consumes a playback_sync echoed back to ourselves (host re-anchor)', () => {
    const syncs: Array<{ memberId: string; position: number; isPlaying: boolean; serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onPlaybackSync: (memberId, position, isPlaying, serverTime) =>
        syncs.push({ memberId, position, isPlaying, serverTime }),
    });

    // REAL wire path: the field set the PHP server broadcasts in a one-member
    // room (SyncPlayManager::handlePlaybackSync stamps member_id with the HOST
    // id and excludes nobody from the broadcast; encodeMessage adds the
    // protocol_version/timestamp envelope, which decodeMessage tolerates). It
    // is encoded + serialized through the library's own framing — the same
    // functions the transport layer uses — then decoded back through
    // handleIncoming. The stamp is UNIX seconds per the :8097 producer; the
    // host's re-anchor callback must still receive MILLISECONDS.
    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming(
      serializeMessage(
        encodeMessage(
          SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
          {
            member_id: 'me',
            group_id: 'sp_abc',
            current_media_id: 'media_1',
            position: 5000,
            is_playing: true,
            server_time: 1761900000,
          },
          () => 1000,
        ),
      ),
    );

    expect(syncs).toEqual([
      { memberId: 'me', position: 5000, isPlaying: true, serverTime: 1761900000000 },
    ]);
  });

  // phlix-syncplay-034 (S-syncplay-29): REAL wire-path refusal of a frame the
  // transport genuinely carries with a sub-1 `protocol_version`. We encode
  // through the library's own framing (which stamps `1`), then rewrite the
  // envelope value on the serialized JSON — the bytes a mis-stamping producer
  // would actually put on the wire — and feed THAT through handleIncoming. The
  // frame passes framing's presence-keyed unwrap untouched and dies at the
  // receiver-side value law, surfacing as a `malformed` drop.
  it('real wire bytes with protocol_version 0 are refused at the value law (malformed drop)', () => {
    const drops: Array<{ reason: string; frame: unknown }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onFrameDropped: (reason, frame) => drops.push({ reason, frame }),
    });

    const wire = JSON.stringify(
      { ...JSON.parse(serializeMessage(groupStateMessage('host1', 'me'))), protocol_version: 0 },
    );
    client.handleIncoming(wire);

    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('malformed');
    expect(client.getGroup()).toBeNull();
  });

  // S294 control — the pair that distinguishes a fix from deleting the guard
  // wholesale: playback_sync from self is CONSUMED (above) but command frames
  // from self are STILL DROPPED (below). If any of these ever fires, the
  // self-echo guard was deleted for the wrong frame types and the AC is unmet.
  it('still drops a play command echoed back from ourselves (real wire frame)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    h.client.handleIncoming(
      serializeMessage(
        encodeMessage(
          SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
          { member_id: 'me', position: 5000, server_time: 12345 },
          () => 1000,
        ),
      ),
    );
    expect(h.commands).toHaveLength(0);
  });

  it('still drops a pause command echoed back from ourselves (real wire frame)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    h.client.handleIncoming(
      serializeMessage(
        encodeMessage(
          SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE,
          { member_id: 'me', position: 5000, server_time: 12345 },
          () => 1000,
        ),
      ),
    );
    expect(h.commands).toHaveLength(0);
  });

  it('still drops a seek command echoed back from ourselves (real wire frame)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    h.client.handleIncoming(
      serializeMessage(
        encodeMessage(
          SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
          { member_id: 'me', from_position: 1000, to_position: 9000, server_time: 12345 },
          () => 1000,
        ),
      ),
    );
    expect(h.commands).toHaveLength(0);
  });

  it('handleTimeSync maps the real server frame to the TimeSyncState model', () => {
    const states: TimeSyncState[] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onTimeSync: (state) => states.push(state),
    });

    // Server wire truth — copied field-for-field from
    // phlix-server src/Session/SyncPlay/SyncPlayManager.php:1650-1658
    // (handleTimeSync → Messages::frame). Seven fields, NO `client_time`;
    // `server_time` is UNIX seconds, `offset_ms`/`latency_ms` are ms.
    const serverFrame: TimeSyncPayload = {
      member_id: 'user-1',
      group_id: 'group-1',
      server_time: 1761900000,
      offset_ms: 42,
      latency_ms: 7,
      drift_rate: 1.0002,
      is_stable: true,
      protocol_version: 1,
    };
    client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC, ...serverFrame });

    expect(states).toEqual([
      {
        memberId: 'user-1',
        groupId: 'group-1',
        serverTimeSec: 1761900000,
        offsetMs: 42,
        latencyMs: 7,
        driftRate: 1.0002,
        isStable: true,
      },
    ]);
  });

  // FIXTURE PROVENANCE (re-vendored from the LIVE PRODUCERS, M-SYNCPLAY-05):
  // rows below are byte-shaped copies of what `:8097` `phlix-server`
  // `SyncPlayManager.php` `groupSummary()` :1740-1750 and `:8804` `phlix-hub`
  // `SyncPlayRelayWorker.php` `handleCanonicalGroupList()` :1938-1943 send
  // inside the `{groups, count}` reply envelope (send :1686-1689 / :1947-1950).
  // The pre-fix fixtures encoded a FABRICATED `{group_id, group_name,
  // has_password?}` row that existed on no socket — the estate's
  // fabricated-field-hidden-by-fixture class, this time in our own tests.
  it('handleGroupList maps live-producer summary rows to onGroupList', () => {
    const lists: GroupListSummaryRow[][] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onGroupList: (groups) => lists.push(groups),
    });

    // Server carrier: all six keys, current_media set.
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: [
        {
          id: 'g1',
          name: 'Group One',
          member_count: 3,
          has_password: true,
          current_media: 'media-7',
          is_playing: true,
        },
        // Hub carrier truths: has_password is the constant false,
        // current_media the null sentinel (GroupState.php:565 `?string`).
        {
          id: 'g2',
          name: 'g2',
          member_count: 1,
          has_password: false,
          current_media: null,
          is_playing: false,
        },
      ],
      count: 2,
    });

    expect(lists).toEqual([
      [
        {
          id: 'g1',
          name: 'Group One',
          member_count: 3,
          has_password: true,
          current_media: 'media-7',
          is_playing: true,
        },
        {
          id: 'g2',
          name: 'g2',
          member_count: 1,
          has_password: false,
          current_media: null,
          is_playing: false,
        },
      ],
    ]);
  });

  it('handleGroupList ignores non-array groups', () => {
    const lists: Array<unknown> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onGroupList: (groups) => lists.push(groups),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: 'not-an-array',
      count: 0,
    });

    expect(lists).toHaveLength(0);
  });

  it('handleTyping fires onMemberTyping callback', () => {
    const typing: Array<{ memberId: string; isTyping: boolean }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onMemberTyping: (memberId, isTyping) => typing.push({ memberId, isTyping }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TYPING,
      protocol_version: 1,
      member_id: 'host1',
      is_typing: true,
    });

    expect(typing).toEqual([{ memberId: 'host1', isTyping: true }]);
  });

  it('handleTyping ignores when member_id is missing', () => {
    const typing: Array<{ memberId: string; isTyping: boolean }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onMemberTyping: (memberId, isTyping) => typing.push({ memberId, isTyping }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TYPING,
      protocol_version: 1,
      is_typing: true,
    });

    expect(typing).toHaveLength(0);
  });

  it('handleHostTransfer fires onHostTransfer callback and updates group', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    const transfers: Array<{ currentHostId: string; newHostId: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onHostTransfer: (currentHostId, newHostId) => transfers.push({ currentHostId, newHostId }),
    });
    client.handleIncoming(groupStateMessage('host1', 'me'));

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 'host1',
      new_host_id: 'me',
    });

    expect(transfers).toEqual([{ currentHostId: 'host1', newHostId: 'me' }]);
    expect(client.getGroup()?.host_id).toBe('me');
  });

  it('handleHostTransfer ignores when current_host_id or new_host_id is missing', () => {
    const transfers: Array<{ currentHostId: string; newHostId: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onHostTransfer: (currentHostId, newHostId) => transfers.push({ currentHostId, newHostId }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 'host1',
      // missing new_host_id
    });

    expect(transfers).toHaveLength(0);
  });

  it('handleInfo with only message (not member join) fires onInfo', () => {
    const infos: string[] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onInfo: (message) => infos.push(message),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO,
      protocol_version: 1,
      message: 'Server is going down for maintenance',
    });

    expect(infos).toEqual(['Server is going down for maintenance']);
  });

  it('handleInfo ignores when neither member fields nor message are present', () => {
    const infos: string[] = [];
    const joined: Array<{ id: string; name: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onInfo: (message) => infos.push(message),
      onMemberJoined: (m) => joined.push(m),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO,
      protocol_version: 1,
    });

    expect(infos).toHaveLength(0);
    expect(joined).toHaveLength(0);
  });

  it('handleError uses error_code then code, falling back to UNKNOWN', () => {
    const errors: Array<{ code: string; message: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onError: (code, message) => errors.push({ code, message }),
    });

    // Test error_code field
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      error_code: 'ERR_FORBIDDEN',
      message: 'Action not allowed',
    });
    expect(errors).toEqual([{ code: 'ERR_FORBIDDEN', message: 'Action not allowed' }]);

    // Test code field (when error_code absent)
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      code: 'ERR_LIMIT',
      message: 'Rate limit exceeded',
    });
    expect(errors[1]).toEqual({ code: 'ERR_LIMIT', message: 'Rate limit exceeded' });

    // Test missing code → 'UNKNOWN'
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      message: 'Something went wrong',
    });
    expect(errors[2]).toEqual({ code: 'UNKNOWN', message: 'Something went wrong' });
  });

  it('handleError falls back to message text when message is missing', () => {
    const errors: Array<{ code: string; message: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onError: (code, message) => errors.push({ code, message }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR,
      protocol_version: 1,
      code: 'ERR_NO_MESSAGE',
    });

    expect(errors).toEqual([{ code: 'ERR_NO_MESSAGE', message: 'Unknown error' }]);
  });
});

describe('SyncPlayClient — getSynchronizedTime', () => {
  it('returns local time plus offset', () => {
    const h = makeHarness();
    // Seed offset of 100.
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1100,
    });

    h.clock.set(5000);
    expect(h.client.getSynchronizedTime()).toBe(5100);
  });
});

describe('SyncPlayClient — getMemberId', () => {
  it('returns the member id set in constructor', () => {
    const h = makeHarness('my-custom-id');
    expect(h.client.getMemberId()).toBe('my-custom-id');
  });
});

describe('SyncPlayClient — handleGroupState edge cases', () => {
  it('ignores group_state when group is missing or null', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      group: null,
    });
    expect(h.client.getGroup()).toBeNull();

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      group: undefined,
    });
    expect(h.client.getGroup()).toBeNull();
  });

  it('handles group_state with missing optional fields', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'g1',
        group_name: 'Minimal Group',
        members: [],
        host_id: null,
        playback_position: 0,
        playback_state: 'stopped',
        // member_count, current_media_id, current_media_duration, created_at,
        // last_activity_at are all optional
      },
    });
    const group = h.client.getGroup();
    expect(group?.group_id).toBe('g1');
    expect(group?.member_count).toBeUndefined();
    expect(group?.current_media_id).toBeNull();
    expect(group?.current_media_duration).toBeNull();
    expect(group?.created_at).toBeUndefined();
    expect(group?.last_activity_at).toBeUndefined();
  });

  it('normalizes members with missing joined_at to 0', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'g1',
        group_name: 'Group',
        members: [{ id: 'm1', name: 'Member 1', is_host: true }],
        host_id: 'm1',
        playback_position: 0,
        playback_state: 'stopped',
      },
    });
    const group = h.client.getGroup();
    expect(group?.members[0].joined_at).toBe(0);
  });

  it('normalizes non-array members to empty array', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'g1',
        group_name: 'Group',
        members: 'not-an-array',
        host_id: 'm1',
        playback_position: 0,
        playback_state: 'stopped',
      },
    });
    const group = h.client.getGroup();
    expect(group?.members).toEqual([]);
  });
});

describe('SyncPlayClient — handleTimePong edge cases', () => {
  it('ignores pong when t1 (client_time) and lastPingSendTime are both missing', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.client.onDisconnect(); // clears lastPingSendTime

    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      // no client_time
      server_time: 1100,
    });

    expect(h.syncs).toHaveLength(0);
  });

  it('uses lastPingSendTime when pong omits client_time', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    // No client_time in pong, relies on lastPingSendTime
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      server_time: 1100,
    });
    // rtt = 1001 - 1000 = 1, offset 100, accepted
    expect(h.syncs).toHaveLength(1);
    expect(h.syncs[0].offset).toBe(100);
  });

  it('SPY-S7: refuses a non-echo pong whose send time is from an older connection generation; accepts within-epoch legacy shape', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.client.onDisconnect();
    // Force a cross-generation outstanding slot (stamp from generation 0).
    const priv = h.client as unknown as { lastPingSendTime: number | null };
    priv.lastPingSendTime = 1000;
    h.clock.set(1050);
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, server_time: 1100 });
    expect(h.client.getTimeSync().getSampleCount()).toBe(0);
    expect(priv.lastPingSendTime).toBe(1000);

    // Within-epoch legacy shape (no echo) still accepted.
    h.client.onDisconnect();
    h.clock.set(2000);
    h.client.pingTime();
    h.clock.set(2001);
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, server_time: 2100 });
    expect(h.client.getTimeSync().getSampleCount()).toBe(1);
  });

  it('rejects a dead-connection straggler arriving while a fresh ping is outstanding, then still accepts the matching pong', () => {
    // Fast-reconnect regime (SPEC §10.2 recovery: onDisconnect → reconnect →
    // resume pingTime). A new ping is already outstanding on connection B when
    // a straggler from the torn-down connection A lands, so the null-send-time
    // check alone misses it — only the echo-match rejects it.
    const h = makeHarness();

    h.clock.set(1000);
    h.client.pingTime(); // connection A ping, send time 1000
    h.client.onDisconnect(); // drops ping + resets window

    h.clock.set(1100);
    h.client.pingTime(); // connection B ping, send time 1100 now outstanding

    // Straggler from DEAD connection A: echoes A's t1 (1000), server_time 1200.
    // rtt = 1150 - 1000 - (1200 - 1200) = 150 ms < MAX_ACCEPTABLE_RTT, so the
    // estimator would ACCEPT the cross-connection quad (offset 1200 - 1000 + 75
    // = 275) were it ever reached; the echo-match guard rejects it first.
    h.clock.set(1150);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1200,
    });
    expect(h.client.getTimeSync().getSampleCount()).toBe(0);
    expect(h.syncs).toHaveLength(0);

    // The reject must NOT consume the outstanding (connection B) ping: its real
    // pong, echoing 1100, still lands and seeds exactly one sample.
    h.clock.set(1151);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1100,
      server_time: 1200,
    });
    expect(h.client.getTimeSync().getSampleCount()).toBe(1);
    expect(h.syncs).toHaveLength(1);
  });
});

describe('SyncPlayClient — handleSeek inbound from another member', () => {
  it('routes seek from another member to onPlaybackCommand', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1',
      from_position: 1000,
      to_position: 5000,
      // :8097 seconds echo fallback (SyncPlayManager.php:1175 `?? time()`) —
      // the library must deliver ms.
      server_time: 1761900000,
    });

    expect(h.commands).toEqual([
      { type: 'seek', position: 5000, serverTime: 1761900000000 },
    ]);
  });
});

describe('SyncPlayClient.serverTimeToMs — per-carrier wire-unit normalization (M-SYNCPLAY-04)', () => {
  // The `:8097` producer stamps `server_time` with UNIX seconds
  // (SyncPlayManager.php:1506/:1575 `time()`); the hub relay stamps ms
  // (SyncPlayRelayWorker.php:1105/:1603 `nowMs()`). The library's consumer
  // contract is all-ms (SPEC §4); the decode boundary reconciles (§8.4).

  it('promotes an epoch-seconds stamp to ms', () => {
    expect(SyncPlayClient.serverTimeToMs(1761900000)).toBe(1761900000000);
  });

  it('passes an epoch-ms stamp through untouched', () => {
    expect(SyncPlayClient.serverTimeToMs(1761900000123)).toBe(1761900000123);
  });

  it('treats one below the epoch-magnitude boundary as seconds', () => {
    expect(SyncPlayClient.serverTimeToMs(1e12 - 1)).toBe((1e12 - 1) * 1000);
  });

  it('treats the boundary value itself as ms (2001-09-09 epoch-ms)', () => {
    expect(SyncPlayClient.serverTimeToMs(1e12)).toBe(1e12);
  });

  it('delivers playback_sync as ms on BOTH carriers and keeps the ms fallback un-scaled', () => {
    const syncs: Array<{ position: number; isPlaying: boolean; serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onPlaybackSync: (_m, position, isPlaying, serverTime) =>
        syncs.push({ position, isPlaying, serverTime }),
    });

    // hub carrier — ms echo must arrive untouched
    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      server_time: 1761900000123,
    });
    // no server_time on the frame — local synchronized time (already ms)
    // must be delivered WITHOUT the ×1000 promotion.
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 6000,
      is_playing: false,
    });

    expect(syncs).toEqual([
      { position: 5000, isPlaying: true, serverTime: 1761900000123 },
      { position: 6000, isPlaying: false, serverTime: 1000 },
    ]);
  });

  it('a seconds-stamped :8097 re-anchor frame no longer teleports getAdjustedPosition', () => {
    const syncs: Array<{ position: number; serverTime: number }> = [];
    const clock = { t: 1761900000000 };
    const client = new SyncPlayClient({
      send: () => {},
      now: () => clock.t,
      memberId: 'me',
      onPlaybackSync: (_m, position, _p, serverTime) => syncs.push({ position, serverTime }),
    });

    // Seed one ping/pong quad exactly like the live handshake (client_time
    // echoed verbatim by Messages::timePong()).
    client.pingTime();
    clock.t = 1761900000002;
    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1761900000000,
      server_time: 1761900000100,
    });
    const syncNow = client.getSynchronizedTime();

    // The `:8097` echo for the SAME instant carries UNIX seconds of syncNow.
    const secondsStamp = Math.floor(syncNow / 1000);
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      server_time: secondsStamp,
    });

    expect(syncs).toHaveLength(1);
    expect(syncs[0].serverTime).toBe(secondsStamp * 1000);

    // Pre-fix, the raw seconds stamp fed getAdjustedPosition an elapsed of
    // syncNow − 1.76e9 ≈ +56 years of ms → playhead ≈ 1.76e12. Post-fix the
    // elapsed is only the sub-second floor remainder: position + [0,1000).
    const adjusted = client
      .getTimeSync()
      .getAdjustedPosition(5000, syncs[0].serverTime, clock.t);
    expect(adjusted).toBeGreaterThanOrEqual(5000);
    expect(adjusted).toBeLessThan(6000);
  });
});

describe('SyncPlayClient — playback_sync echo carrier-pair scale law (M-SYNCPLAY-10 close-out)', () => {
  // The review (`syncplay__gameux` M3) counted THREE unlabeled scales at this
  // one decode site: `:8097` UNIX-seconds echoes (phlix-server
  // `SyncPlayManager.php:1506` `$serverTime = time();` → broadcast field
  // `:1523`), hub-relay ms echoes (phlix-hub `SyncPlayRelayWorker.php:1679`
  // `self::nowMs()` — review-era cite `:1603`, drift @f85f48ec noted), and the
  // handler's own already-ms fallback when the frame carries no stamp.
  // M-SYNCPLAY-04 normalized the wire stamps; these pins lock the law the
  // item names: both carriers describing the SAME instant land in consumer
  // hands as the SAME ms stamp — identical age against the synchronized clock,
  // no playhead teleport on either leg. Mutation-toothed: stripping
  // `serverTimeToMs` in `handlePlaybackSync` lands the seconds leg 1000× low
  // (age ≈ −1.76e12 ms) → red.
  it('seconds-carrier and ms-carrier echoes of one instant deliver identical ms stamps and ages', () => {
    // Whole-second instant: `time()` floor-truncation is exact, so both
    // carriers genuinely describe the same millisecond.
    const instantMs = 1761900000000;
    const clock = { t: instantMs + 500 };
    const syncs: Array<{ serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => clock.t,
      memberId: 'me',
      onPlaybackSync: (_m, _p, _i, serverTime) => syncs.push({ serverTime }),
    });

    // Carrier 1 — `:8097`: the group echo stamps UNIX SECONDS.
    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      server_time: Math.floor(instantMs / 1000),
    });
    // Carrier 2 — hub relay: the same echo for the SAME instant stamps ms.
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      server_time: instantMs,
    });

    expect(syncs).toHaveLength(2);
    // The all-ms consumer contract (SPEC §4) holds whichever producer stamped.
    expect(syncs[0].serverTime).toBe(instantMs);
    expect(syncs[1].serverTime).toBe(instantMs);

    // Age and extrapolation are carrier-indifferent: 500 ms elapsed on both
    // legs → playhead 5500 on both. A raw seconds stamp would teleport this.
    const timeSync = client.getTimeSync();
    for (const { serverTime } of syncs) {
      expect(clock.t - serverTime).toBe(500);
      expect(timeSync.getAdjustedPosition(5000, serverTime, clock.t)).toBe(5500);
    }
  });

  it('the no-stamp fallback arm keeps the same ms age law (the third scale the review named)', () => {
    // Small fake clock: an epoch-scale stamp would make a wrongful ×1000
    // promotion of the fallback a no-op (≥ 1e12 passes the heuristic
    // untouched), so the mutation teeth here REQUIRE a sub-1e12 clock —
    // scaling the fallback yields 1000 × 1000 = 1000000 → red, and dropping
    // the ms-passthrough of the fallback likewise reds the age assertions.
    const clock = { t: 1000 };
    const syncs: Array<{ serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => clock.t,
      memberId: 'me',
      onPlaybackSync: (_m, _p, _i, serverTime) => syncs.push({ serverTime }),
    });

    // Stripped frame (hand-built / legacy relay): no `server_time` — the
    // handler substitutes `getSynchronizedTime()`, ALREADY ms; the ×1000
    // promotion must not touch it.
    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
    });

    expect(syncs[0].serverTime).toBe(1000);
    expect(
      client.getTimeSync().getAdjustedPosition(5000, syncs[0].serverTime, clock.t),
    ).toBe(5000);
  });
});

describe('SyncPlayClient — switch default case (unknown message type)', () => {
  it('unknown message types are ignored when no onUnknownFrame hook is registered (no crash, no state change)', () => {
    const states: Array<{ group: SyncPlayGroup; yourId: string | undefined }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onState: (group, yourId) => states.push({ group, yourId }),
    });

    // Without an onUnknownFrame hook, an unknown type is dropped (no crash, no
    // state change); with a hook registered, the same frame would be surfaced.
    client.handleIncoming({
      type: 'syncplay_unknown_type',
      protocol_version: 1,
      some_field: 'value',
    });

    expect(states).toHaveLength(0);

    // A valid group_state after the unknown type should still work
    client.handleIncoming(groupStateMessage('host1', 'me'));
    expect(states).toHaveLength(1);
  });
});

describe('SyncPlayClient — leaveGroup early return when not in a group', () => {
  it('leaveGroup sends nothing when group is null (early return covered)', () => {
    const h = makeHarness();
    // Verify we start with no group
    expect(h.client.getGroup()).toBeNull();
    // Call leaveGroup when not in a group - early return
    h.client.leaveGroup();
    // Nothing should have been sent
    expect(h.sent).toHaveLength(0);
  });
});

describe('SyncPlayClient — leaveGroup unwind-before-send (SPY-5)', () => {
  it('clears the cached group even when the send sink throws', () => {
    const client = new SyncPlayClient({
      send: () => {
        throw new Error('socket closed');
      },
      now: () => 1000,
      memberId: 'me',
      memberName: 'Tester',
    });
    client.handleIncoming(groupStateMessage('host1', 'me'));
    expect(client.getGroup()).not.toBeNull();
    expect(() => client.leaveGroup()).toThrow('socket closed');
    expect(client.getGroup()).toBeNull();
    // no-group bool law unchanged
    expect(client.leaveGroup()).toBe(false);
  });
});

describe('SyncPlayClient — joinGroup with password hash', () => {
  it('joinGroup includes password_hash when provided (line 190)', () => {
    const h = makeHarness();
    // LW-045-era fixture move (disclosed): 64-lowercase-hex shape, see the
    // createGroup fixture above for the gate law.
    h.client.joinGroup('sp_abc', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(h.sent[0]).toMatchObject({
      type: 'syncplay_group_join',
      protocol_version: 1,
      timestamp: 1000,
      group_id: 'sp_abc',
      member_id: 'me',
      member_name: 'Tester',
      password_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
  });
});

describe('SyncPlayClient — sendPause when in a group', () => {
  it('sendPause dispatches PLAYBACK_PAUSE when in a group (line 232)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.clock.set(2000);
    h.client.sendPause(5000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE,
      group_id: 'sp_abc',
      member_id: 'me',
      position: 5000,
      server_time: 2000, // synchronized time (no offset set)
    });
  });
});

describe('SyncPlayClient — sendSeek when in a group', () => {
  it('sendSeek dispatches PLAYBACK_SEEK when in a group (line 244)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.clock.set(3000);
    h.client.sendSeek(1000, 5000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      group_id: 'sp_abc',
      member_id: 'me',
      from_position: 1000,
      to_position: 5000,
      server_time: 3000, // synchronized time (no offset set)
    });
  });
});

describe('SyncPlayClient — seekTo convenience (phlix-syncplay-059)', () => {
  it('seekTo dispatches PLAYBACK_SEEK with from_position = the cached group position', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessageAt('host1', 'me', 12345));
    h.clock.set(3000);
    expect(h.client.seekTo(9000)).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      group_id: 'sp_abc',
      member_id: 'me',
      from_position: 12345,
      to_position: 9000,
      server_time: 3000, // synchronized time (no offset set)
    });
  });

  it('seekTo reads the CURRENT cached position each call (a newer GROUP_STATE re-anchors the origin)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessageAt('host1', 'me', 12345));
    h.client.handleIncoming(groupStateMessageAt('host1', 'me', 222));
    expect(h.client.seekTo(9000)).toBe(true);
    expect(h.sent).toHaveLength(1);
    // Stale-capture mutation teeth: a from fixed at first sight would send
    // 12345 here; the live cached read sends 222.
    expect(h.sent[0]).toMatchObject({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      from_position: 222,
      to_position: 9000,
    });
  });

  it('seekTo is a no-op returning false with no cached group', () => {
    const h = makeHarness();
    expect(h.client.seekTo(5000)).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  it('seekTo throws TypeError on non-finite or negative toPosition, grouped or not (sendSeek assert law)', () => {
    const h = makeHarness();
    expect(() => h.client.seekTo(Number.NaN)).toThrow(TypeError);
    expect(() => h.client.seekTo(-1)).toThrow(TypeError);
    h.client.handleIncoming(groupStateMessageAt('host1', 'me', 12345));
    expect(() => h.client.seekTo(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(h.sent).toHaveLength(0); // the asserts precede any dispatch
  });

  it('seekTo REFUSES rather than fabricate from = 0 if a stored group ever violates the clamp invariant', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessageAt('host1', 'me', 12345));
    // No wire path mints this (every store-site folds through clampedPosition)
    // — injected past the boundary to pin the defensive arm itself: refuse,
    // never substitute the origin 059 names as the consumer's lie.
    (h.client as unknown as { group: SyncPlayGroup | null }).group = Object.freeze({
      ...(h.client.getGroup() as SyncPlayGroup),
      playback_position: Number.NaN,
    });
    expect(h.client.seekTo(9000)).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});

describe('SyncPlayClient — handleSeek self-echo suppression', () => {
  it('ignores seek echoed back from ourselves (line 445)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('me', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'me',
      from_position: 1000,
      to_position: 5000,
      server_time: 123,
    });
    // Self-echo should be suppressed - no command should be emitted
    expect(h.commands).toHaveLength(0);
  });
});

describe('SyncPlayClient — handlePlaybackSync type coercion defaults', () => {
  it('drops a playback_sync whose position is not a number (W-min123 M-SYNCPLAY-12)', () => {
    const syncs: Array<{ memberId: string; position: number; isPlaying: boolean; serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onPlaybackSync: (memberId, position, isPlaying, serverTime) =>
        syncs.push({ memberId, position, isPlaying, serverTime }),
    });

    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 'not-a-number', // wrong type
      is_playing: true,
      server_time: 12345,
    });

    // M-SYNCPLAY-12: pre-fix this defaulted to position 0 — a fabricated
    // re-anchor to 00:00 from a frame no server emits. The boundary refuses it.
    expect(syncs).toHaveLength(0);
  });

  it('uses default is_playing when not a boolean (line 506)', () => {
    const syncs: Array<{ memberId: string; position: number; isPlaying: boolean; serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onPlaybackSync: (memberId, position, isPlaying, serverTime) =>
        syncs.push({ memberId, position, isPlaying, serverTime }),
    });

    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: 'yes', // wrong type
      server_time: 12345,
    });

    expect(syncs[0].isPlaying).toBe(false); // default
  });

  it('uses default server_time when not a number (line 507-508)', () => {
    const syncs: Array<{ memberId: string; position: number; isPlaying: boolean; serverTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 5000, // now returns 5000, synchronized time = 5000 + offset
      memberId: 'me',
      onPlaybackSync: (memberId, position, isPlaying, serverTime) =>
        syncs.push({ memberId, position, isPlaying, serverTime }),
    });

    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: 5000,
      is_playing: true,
      server_time: 'not-a-number', // wrong type
    });

    // Should use getSynchronizedTime() as default
    expect(typeof syncs[0].serverTime).toBe('number');
    expect(syncs[0].serverTime).toBe(5000); // synchronized time with no offset
  });
});

describe('SyncPlayClient — malformed position drops (W-min123 M-SYNCPLAY-12, review gameux m1)', () => {
  // Companion to the two flipped coercion tests: the parse-don't-validate
  // boundary now refuses every malformed `position` shape across the three
  // position-carrying frame types — missing key, NaN, numeric string, and
  // overflowed non-finite (1e999 lands as Infinity through JSON.parse).
  // A genuine 0 must still flow: the guard is type/presence, not truthiness.

  it('drops a play frame with a missing position instead of jumping the group to 00:00', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      server_time: 123,
    });
    expect(h.commands).toHaveLength(0);
  });

  it('drops a pause frame whose position is NaN', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE,
      protocol_version: 1,
      member_id: 'host1',
      position: Number.NaN,
      server_time: 123,
    });
    expect(h.commands).toHaveLength(0);
  });

  it('drops a seek whose to_position is a numeric string', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1',
      from_position: 1000,
      to_position: '5000',
      server_time: 123,
    });
    expect(h.commands).toHaveLength(0);
  });

  it('drops a non-finite seek position (1e999 → Infinity)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1',
      from_position: 1000,
      to_position: Number.POSITIVE_INFINITY, // what a JSON `1e999` decodes to
      server_time: 123,
    });
    expect(h.commands).toHaveLength(0);
  });

  it('drops a playback_sync whose position is NaN', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'host1',
      position: Number.NaN,
      is_playing: true,
      server_time: 12345,
    });
    expect(h.syncs).toHaveLength(0);
  });

  it('still delivers position 0 — a genuine 00:00 is a legal value (control)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'host1',
      position: 0,
      server_time: 123,
    });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].type).toBe('play');
    expect(h.commands[0].position).toBe(0);
  });
});

describe('SyncPlayClient — pingTime single-flight (W-min123 M-SYNCPLAY-13, review gameux m2)', () => {
  const pings = (sent: RawMessage[]) => sent.filter((m) => m.type === SYNCPLAY_MESSAGE_TYPES.TIME_PING);
  function pong(echo: number | undefined, serverTime: number | undefined): RawMessage {
    return {
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      ...(echo === undefined ? {} : { client_time: echo }),
      ...(serverTime === undefined ? {} : { server_time: serverTime }),
    };
  }

  it('ignores a second pingTime while one is outstanding', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1010);
    h.client.pingTime();
    expect(pings(h.sent)).toHaveLength(1);
  });

  it('a matched pong releases the slot for the next round', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming(pong(1000, 1100));
    h.clock.set(1050);
    h.client.pingTime();
    const rounds = pings(h.sent);
    expect(rounds).toHaveLength(2);
    expect(rounds[1].client_time).toBe(1050);
  });

  it('a consumed pong that omits server_time still releases the slot', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming(pong(1000, undefined)); // the round completed; no sample possible
    expect(h.syncs).toHaveLength(0);
    h.clock.set(1050);
    h.client.pingTime();
    expect(pings(h.sent)).toHaveLength(2);
  });

  it('a mismatched straggler does not release the outstanding slot', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming(pong(999, 1100)); // belongs to a different round — refused, slot kept
    h.clock.set(1050);
    h.client.pingTime();
    expect(pings(h.sent)).toHaveLength(1);
    h.clock.set(1051);
    h.client.handleIncoming(pong(1000, 1100));
    expect(h.syncs).toHaveLength(1);
    h.clock.set(1052);
    h.client.pingTime(); // freed by the matched pong
    expect(pings(h.sent)).toHaveLength(2);
  });

  it('an unanswered ping ages out at MAX_ACCEPTABLE_RTT and the next call re-pings', () => {
    const h = makeHarness();
    h.clock.set(1000);
    h.client.pingTime();
    h.clock.set(2000); // exactly MAX_ACCEPTABLE_RTT (1000) old — still in flight
    h.client.pingTime();
    expect(pings(h.sent)).toHaveLength(1);
    h.clock.set(2001); // one ms past: its pong could only be rtt-rejected → re-ping
    h.client.pingTime();
    expect(pings(h.sent)).toHaveLength(2);
  });
});

describe('SyncPlayClient — handleTimeSync drops frames that miss the server shape', () => {
  const realFrame = {
    // Server wire truth: phlix-server SyncPlayManager.php:1650-1658.
    member_id: 'user-1',
    group_id: 'group-1',
    server_time: 1761900000,
    offset_ms: 42,
    latency_ms: 7,
    drift_rate: 1.0002,
    is_stable: true,
    protocol_version: 1,
  };

  const wireTruthClient = (sink: (s: TimeSyncState) => void) =>
    new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onTimeSync: sink,
    });

  it('a non-numeric server_time drops the frame (no defaulted 0 reaches the consumer)', () => {
    const states: TimeSyncState[] = [];
    wireTruthClient((s) => states.push(s)).handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
      ...realFrame,
      server_time: 'seventeen-six',
    });
    expect(states).toHaveLength(0);
  });

  it('a non-boolean is_stable drops the frame', () => {
    const states: TimeSyncState[] = [];
    wireTruthClient((s) => states.push(s)).handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
      ...realFrame,
      is_stable: 'yes',
    });
    expect(states).toHaveLength(0);
  });

  it('the historic FABRICATED shape (server_time + client_time only) is dropped', () => {
    // Regression pin for the M-SYNCPLAY-03 cure: the pre-fix handler accepted
    // this never-emitted frame and called back (server_time, 0) — a client
    // time that never existed on any socket. Real wire frames carry no
    // `client_time`; anything missing the seven server fields dies at parse.
    const states: TimeSyncState[] = [];
    wireTruthClient((s) => states.push(s)).handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
      protocol_version: 1,
      server_time: 50000,
      client_time: 40000,
    });
    expect(states).toHaveLength(0);
  });
});

describe('SyncPlayClient — handleGroupList boundary law (producer keys + id-drop)', () => {
  // S-syncplay-27 (finding phlix-syncplay-032): every coercion below is
  // asserted on the REAL producer key names, and the IDENTITY key is now a
  // DROP law, not a default: the only source of a non-string `id` is wire
  // garbage — server `groupSummary()` folds a typed string `$id` into the
  // row and hub `handleCanonicalGroupList()` substr-derives theirs, so both
  // always emit a string — and minting `''` handed consumers a joinable
  // nameless room (the LW-041a hazard, one layer up). The pre-fix pins here
  // asserted exactly that mint (`id: ''` surfacing from garbage); they are
  // converted to the stricter drop law, disclosed in the commit body.
  it('coerces every non-conforming NON-identity field of a string-id row to its total default', () => {
    const lists: GroupListSummaryRow[][] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onGroupList: (groups) => lists.push(groups),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: [
        {
          id: 'g1', // string id — the row SURVIVES; only its other fields are garbage
          name: { text: 'nope' }, // non-string name
          member_count: 'three', // non-number
          has_password: 'yes', // non-bool
          current_media: 42, // non-string, non-null
          is_playing: 'playing', // non-bool
        },
      ],
      count: 1,
    });

    expect(lists[0][0]).toEqual({
      id: 'g1',
      name: '',
      member_count: 0,
      has_password: false,
      current_media: null,
      is_playing: false,
    });
  });

  it('drops forged non-string-id rows (number, null, object, missing) and keeps valid rows in order', () => {
    const lists: GroupListSummaryRow[][] = [];
    const drops: Array<{ reason: string; frame: unknown }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onGroupList: (groups) => lists.push(groups),
      onFrameDropped: (reason, frame) => drops.push({ reason, frame }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: [
        { id: 123, name: 'num-id', member_count: 1, has_password: false, current_media: null, is_playing: false },
        { id: null, name: 'null-id', member_count: 1, has_password: false, current_media: null, is_playing: false },
        { id: { nested: 'obj' }, name: 'obj-id', member_count: 1, has_password: false, current_media: null, is_playing: false },
        { name: 'missing-id', member_count: 1, has_password: false, current_media: null, is_playing: false },
        { id: 'keep-1', name: 'Keep One', member_count: 2, has_password: true, current_media: 'm1', is_playing: true },
        { id: 'keep-2', name: 'keep-2', member_count: 1, has_password: false, current_media: null, is_playing: false },
      ],
      count: 6,
    });

    // Exactly the two string-id rows survive, order unchanged, fields as sent.
    expect(lists).toHaveLength(1);
    expect(lists[0]).toEqual([
      { id: 'keep-1', name: 'Keep One', member_count: 2, has_password: true, current_media: 'm1', is_playing: true },
      { id: 'keep-2', name: 'keep-2', member_count: 1, has_password: false, current_media: null, is_playing: false },
    ]);
    // The frame itself is well-formed ({groups: array}); element-level drops
    // are silent, sharing the normalizeMembers M10 precedent — no bogus frame-
    // level onFrameDropped, and never a `''`-id row.
    expect(drops).toHaveLength(0);
    expect(lists[0].some((r) => r.id === '')).toBe(false);
  });

  it('a fabricated-shape row (group_id/group_name) is dropped whole — its has_password never surfaces', () => {
    const lists: GroupListSummaryRow[][] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onGroupList: (groups) => lists.push(groups),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: [{ group_id: 'g1', group_name: 'Group One', has_password: true }],
      count: 1,
    });

    // Pre-fix this row surfaced as `{id: '', ..., has_password: true}` — the
    // joinable-empty-id mint AND a half-truth about a room that has no id.
    // On the drop law the garbage row belongs to NO summary the consumer
    // can render or join.
    expect(lists).toHaveLength(1);
    expect(lists[0]).toEqual([]);
  });

  it('an empty-string id is a STRING — the row survives verbatim (drop law is type-scoped, LW-041a parity)', () => {
    const lists: GroupListSummaryRow[][] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onGroupList: (groups) => lists.push(groups),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
      protocol_version: 1,
      groups: [{ id: '', name: 'emitted-empty', member_count: 0, has_password: false, current_media: null, is_playing: false }],
      count: 1,
    });

    // The step law is "drop NON-STRING-id rows"; `''` is a string, so a
    // producer-supplied one is surfaced honestly as the producer's data.
    // What the fix kills is the library MINTING `''` from type-garbage —
    // mirrored by handleGroupState's LW-041a gate, which refuses a
    // non-string group_id and admits the empty string.
    expect(lists[0]).toEqual([
      { id: '', name: 'emitted-empty', member_count: 0, has_password: false, current_media: null, is_playing: false },
    ]);
  });
});

describe('SyncPlayClient — handleHostElect when group is null', () => {
  it('handleHostElect updates host even when not in a group (line 456)', () => {
    const hostChanges: Array<string | null> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onHostChanged: (h) => hostChanges.push(h),
    });

    // Not in a group - group is null
    expect(client.getGroup()).toBeNull();

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'host2',
      elected_by: 'host1',
    });

    // Should still fire onHostChanged even without a group
    expect(hostChanges).toEqual(['host2']);
    expect(client.getGroup()).toBeNull(); // group remains null
  });

  it('handleHostElect uses null when elected_id is missing (line 455)', () => {
    const hostChanges: Array<string | null> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onHostChanged: (h) => hostChanges.push(h),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_by: 'host1',
      // elected_id is missing - triggers ?? null
    });

    expect(hostChanges).toEqual([null]);
  });
});

describe('SyncPlayClient — handleTyping missing is_typing', () => {
  it('defaults is_typing to false when not provided (line 486)', () => {
    const typing: Array<{ memberId: string; isTyping: boolean }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onMemberTyping: (memberId, isTyping) => typing.push({ memberId, isTyping }),
    });

    // is_typing is not provided at all
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TYPING,
      protocol_version: 1,
      member_id: 'host1',
    });

    expect(typing).toEqual([{ memberId: 'host1', isTyping: false }]);
  });
});

describe('SyncPlayClient — handleHostTransfer branches', () => {
  it('ignores when current_host_id is not a string', () => {
    const transfers: Array<{ from: string; to: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onHostTransfer: (from, to) => transfers.push({ from, to }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 123, // wrong type
      new_host_id: 'host2',
    });

    expect(transfers).toHaveLength(0);
  });

  it('ignores when new_host_id is not a string', () => {
    const transfers: Array<{ from: string; to: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onHostTransfer: (from, to) => transfers.push({ from, to }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 'host1',
      new_host_id: { id: 'host2' }, // wrong type
    });

    expect(transfers).toHaveLength(0);
  });

  it('handleHostTransfer updates group and fires callback when in group', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 'host1',
      new_host_id: 'host2',
    });

    expect(h.client.getGroup()?.host_id).toBe('host2');
  });
});

describe('SyncPlayClient — handleSeek refuses a malformed to_position (W-min123 M-SYNCPLAY-12)', () => {
  it('drops the seek instead of defaulting position to 0', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1', // different member - not suppressed
      from_position: 1000,
      to_position: 'not-a-number', // wrong type
      server_time: { value: 123 }, // wrong type
    });

    // Pre-fix this emitted { type: 'seek', position: 0, ... } — rewinding the
    // group to 00:00 on a frame with no honest producer.
    expect(h.commands).toHaveLength(0);
  });
});

describe('SyncPlayClient — onUnknownFrame (S298 phantom-hook decision)', () => {
  it('surfaces a frame with a type outside the 19 canonical types instead of silently dropping it', () => {
    const h = makeHarness();
    h.client.handleIncoming({
      type: 'pending_command',
      command: 'play_media',
      server_id: 'srv-A',
      media_id: 'm-9',
      title: 'Inception',
    });

    // The S345 guard: if a future refactor silently drops unknown frames again,
    // this test fails — the hub relay's pending_command push must reach consumers.
    expect(h.unknown).toHaveLength(1);
    // The frame arrives UNTOUCHED — same shape as sent, no fields added or removed.
    expect(h.unknown[0]).toEqual({
      type: 'pending_command',
      command: 'play_media',
      server_id: 'srv-A',
      media_id: 'm-9',
      title: 'Inception',
    });
  });

  it('surfaces an unknown frame arriving as a JSON string', () => {
    const h = makeHarness();
    h.client.handleIncoming(JSON.stringify({ type: 'hub_room_state', room: 'r1' }));

    expect(h.unknown).toHaveLength(1);
    expect(h.unknown[0]).toEqual({ type: 'hub_room_state', room: 'r1' });
  });

  it('does not double-route the orchestrated canonical types to the hook', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO,
      protocol_version: 1,
      message: 'Guest joined the group',
      member_id: 'guest1',
      member_name: 'Guest',
    });
    // The 15 canonical types that HAVE an inbound handler are routed by their
    // own case arm before the default — chat and playback_queue included
    // (M-SYNCPLAY-11). The four with no inbound handler (group_create,
    // group_join, group_leave, time_ping) DO reach the hook through the
    // default arm — pinned by the next test, per the option docblock law.
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.CHAT,
      protocol_version: 1,
      group_id: 'g1',
      member_id: 'm1',
      message: 'hi',
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE,
      protocol_version: 1,
      group_id: 'g1',
      queue: [{ media_id: 'm-1' }],
    });

    // Orchestrated types go through their own handlers only — no double-routing.
    expect(h.unknown).toHaveLength(0);
    expect(h.states).toHaveLength(1);
    expect(h.joined).toEqual([{ id: 'guest1', name: 'Guest' }]);
  });

  it('routes the four canonical types with no inbound arm to the hook (doc-law pin)', () => {
    const h = makeHarness();
    // Neither carrier emits group_create / group_join / group_leave / time_ping
    // inbound (all four are outbound-only per SPEC §4), but an echo or an
    // off-dialect frame carrying one of these types must be surfaced —
    // unknown-to-this-client — rather than silently dropped. This test pins
    // the routing law stated in SyncPlayClientOptions.onUnknownFrame and the
    // UnknownFrame type docblock; if a future arm absorbs one of these types,
    // it must update this pin and the docblocks together.
    const unarmed = [
      SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE,
      SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN,
      SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE,
      SYNCPLAY_MESSAGE_TYPES.TIME_PING,
    ];
    for (const type of unarmed) {
      h.client.handleIncoming({ type, protocol_version: 1 });
    }
    expect(h.unknown).toHaveLength(4);
    expect(h.unknown.map((f) => f.type)).toEqual(unarmed);
  });

  it('unknown frames are still ignored (not thrown) when no hook is provided', () => {
    const sent: RawMessage[] = [];
    const client = new SyncPlayClient({
      send: (m) => sent.push(m),
      now: () => 1000,
      memberId: 'me',
    });

    expect(() => client.handleIncoming({ type: 'pending_command', media_id: 'm-1' })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('malformed input still yields nothing', () => {
    const h = makeHarness();
    expect(() => h.client.handleIncoming('{garbage')).not.toThrow();
    expect(() => h.client.handleIncoming(null)).not.toThrow();

    expect(h.unknown).toHaveLength(0);
  });
});

// W-min119 M-SYNCPLAY-15 (review `syncplay__gameux` m4): the elect/transfer
// folds MUST recompute the cached members[].is_host flags from the new
// host_id — the cached model's own normalization law (client.ts
// normalizeMembers: "host_id is authoritative") must not be allowed to lie
// between group_state deliveries.
describe('SyncPlayClient — host changes recompute cached is_host flags (M-SYNCPLAY-15)', () => {
  it('host_elect demotes the outgoing host and promotes the elected member in the cached roster', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    // Pre-condition: the fold derived flags at group_state time.
    expect(h.client.getGroup()?.members.map((m) => [m.id, m.is_host])).toEqual([
      ['host1', true],
      ['me', false],
    ]);

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'me',
      elected_by: 'host1',
    });

    const group = h.client.getGroup();
    expect(group?.host_id).toBe('me');
    // The crown MUST move in the same mutation as host_id (was: stale true
    // on 'host1' until the next group_state). From W-min124 M-SYNCPLAY-03
    // the elected_by ghost is dropped from the cached roster entirely on
    // this frame shape (both live producers name the departing host there),
    // so the surviving model is the single crowned member.
    expect(group?.members.map((m) => [m.id, m.is_host])).toEqual([
      ['me', true],
    ]);
  });

  it('host_transfer recomputes is_host flags in the cached roster', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 'host1',
      new_host_id: 'me',
    });

    const group = h.client.getGroup();
    expect(group?.host_id).toBe('me');
    expect(group?.members.map((m) => [m.id, m.is_host])).toEqual([
      ['host1', false],
      ['me', true],
    ]);
  });

  it('host_elect with a null elected id clears every cached is_host flag', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));

    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: null,
      elected_by: 'host1',
    });

    const group = h.client.getGroup();
    expect(group?.host_id).toBeNull();
    expect(group?.members.every((m) => !m.is_host)).toBe(true);
  });
});

// --- W-min124 clusters -------------------------------------------------------

describe('SyncPlayClient — host_elect drops the departed host (W-min124 M-SYNCPLAY-03, review syncplay__crossfe m3)', () => {
  it('removes elected_by from the cached roster and moves the crown in the same fold', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'me',
      elected_by: 'host1',
    });
    const group = h.client.getGroup();
    expect(group?.members.map((m) => m.id)).toEqual(['me']);
    expect(group?.host_id).toBe('me');
    expect(group?.members.every((m) => m.is_host === (m.id === 'me'))).toBe(true);
    expect(h.hostChanges).toEqual(['me']);
  });

  it('a frame naming MY OWN id as departing never evicts me from my own roster', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'host2',
      elected_by: 'me',
    });
    const group = h.client.getGroup();
    expect(group?.members.map((m) => m.id)).toContain('me');
    expect(h.hostChanges).toEqual(['host2']);
  });

  it('a frame WITHOUT elected_by (hand-built/legacy shape) folds the crown and keeps the roster', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'me',
    });
    const group = h.client.getGroup();
    // No departing-host truth exists in the frame — the library invents none.
    expect(group?.members.map((m) => m.id)).toEqual(['host1', 'me']);
    expect(group?.members[0]?.is_host).toBe(false);
    expect(group?.members[1]?.is_host).toBe(true);
  });

  it('a NON-STRING elected_by is treated as absent (M-SYNCPLAY-19 discipline at the same boundary)', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: 'me',
      elected_by: 42,
    });
    expect(h.client.getGroup()?.members.map((m) => m.id)).toEqual(['host1', 'me']);
  });
});

describe('SyncPlayClient — degraded time-sync is observable (W-min124 M-SYNCPLAY-14, review syncplay__gameux m3)', () => {
  it('fires onSyncDegraded per rejected round with the streak; acceptance resets it', () => {
    const h = makeHarness();
    // Round 1: sent at t1=1000, received at 3000 → rtt 2000 > 1000 → REJECT.
    h.client.pingTime();
    h.clock.set(3000);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 2000,
    });
    expect(h.degraded).toEqual([1]);
    expect(h.syncs).toHaveLength(0);

    // Round 2: accepted (rtt 1) → onSync fires, streak resets, nothing
    // "degraded" is announced for the success.
    h.client.pingTime();
    h.clock.set(3001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 3000,
      server_time: 3000,
    });
    expect(h.syncs).toHaveLength(1);
    expect(h.degraded).toEqual([1]);

    // Round 3: rejected again → streak is 1 (NOT 2): acceptance reset it.
    h.client.pingTime();
    h.clock.set(6001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 3001,
      server_time: 4001,
    });
    expect(h.degraded).toEqual([1, 1]);
    expect(h.syncs).toHaveLength(1);
  });

  it('a rejected round still releases the M-SYNCPLAY-13 single-flight slot', () => {
    const h = makeHarness();
    h.client.pingTime();
    h.clock.set(3000);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 2000,
    });
    h.sent.length = 0;
    h.client.pingTime();
    expect(h.sent).toHaveLength(1);
  });

  it('a NON-FINITE pong server_time samples nothing and counts as a rejection (round consumed; LW-043)', () => {
    const h = makeHarness();
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: Number.POSITIVE_INFINITY,
    });
    expect(h.syncs).toHaveLength(0);
    // LW-043 (review syncplay__asphp #3): no usable server_time measures
    // nothing — the same rejected-round class the RTT bound produces, so it
    // now rides onSyncDegraded instead of the old silence.
    expect(h.degraded).toEqual([1]);
    expect(h.client.getTimeSync().getOffset()).toBe(0);
    h.sent.length = 0;
    h.client.pingTime(); // slot was released before the t2 gate (M-SYNCPLAY-13 law)
    expect(h.sent).toHaveLength(1);
  });
});

describe('SyncPlayClient — onMemberLeft roster diff (W-min124 M-SYNCPLAY-16, review syncplay__gameux m5)', () => {
  function rosterState(roster: Array<{ id: string; name: string }>, groupId = 'sp_abc'): RawMessage {
    return {
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: groupId,
        host_id: roster[0]?.id ?? null,
        members: roster.map((m, i) => ({ ...m, is_host: i === 0, joined_at: i })),
      },
    };
  }

  it('a member vanishing from the SAME room fires onMemberLeft once with their last known name', () => {
    const h = makeHarness();
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'a', name: 'Ann' }, { id: 'me', name: 'Tester' }]));
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'me', name: 'Tester' }]));
    expect(h.left).toEqual([{ id: 'a', name: 'Ann' }]);
  });

  it('a room SWITCH fires no left events — the old roster belonged to the room we left', () => {
    const h = makeHarness();
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'a', name: 'Ann' }, { id: 'me', name: 'Tester' }], 'sp_1'));
    h.client.handleIncoming(rosterState([{ id: 'host2', name: 'H2' }, { id: 'me', name: 'Tester' }], 'sp_2'));
    expect(h.left).toHaveLength(0);
  });

  it('arrivals are NOT diffed here — joins ride INFO frames; double-announcing is forbidden', () => {
    const h = makeHarness();
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'me', name: 'Tester' }]));
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'me', name: 'Tester' }, { id: 'a', name: 'Ann' }]));
    expect(h.left).toHaveLength(0);
    expect(h.joined).toHaveLength(0);
  });

  it('an unchanged re-broadcast fires nothing (refresh, not churn)', () => {
    const h = makeHarness();
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'me', name: 'Tester' }]));
    h.client.handleIncoming(rosterState([{ id: 'host1', name: 'Host' }, { id: 'me', name: 'Tester' }]));
    expect(h.left).toHaveLength(0);
  });
});

// ------------------------------------------------ phlix-syncplay-029 (S-syncplay-24, 2026-11-27)

describe('SyncPlayClient — group_state WITHOUT the members key is refused whole (phlix-syncplay-029, LW-041a precedent)', () => {
  /** Three-member seeded room (the M-SYNCPLAY-16 roster-diff shape): the
   *  defect was a SAME-room members-omitting frame emptying exactly this
   *  model via the fold-to-[] arm plus the diff below it. */
  function membersKeyAbsentHarness() {
    const drops: Array<{ reason: string; frame: unknown }> = [];
    const states: SyncPlayGroup[] = [];
    const left: Array<{ id: string; name: string }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      memberName: 'Tester',
      onFrameDropped: (reason, frame) => drops.push({ reason, frame }),
      onState: (group) => states.push(group),
      onMemberLeft: (m) => left.push(m),
    });
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_abc',
        host_id: 'host1',
        members: [
          { id: 'host1', name: 'Host', is_host: true, joined_at: 0 },
          { id: 'a', name: 'Ann', is_host: false, joined_at: 1 },
          { id: 'me', name: 'Tester', is_host: false, joined_at: 2 },
        ],
      },
    });
    drops.length = 0;
    states.length = 0;
    left.length = 0;
    return { client, drops, states, left };
  }

  /** Same-room group_state literal WITHOUT the members key (+ overrides). */
  function frameWithoutMembers(overrides: Record<string, unknown>): RawMessage {
    return {
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: { group_id: 'sp_abc', host_id: 'host1', playback_position: 77777, ...overrides },
    };
  }

  it('a SAME-room frame omitting the members key is drop-reported with ZERO onMemberLeft — the diff baseline never runs', () => {
    const h = membersKeyAbsentHarness();
    const frame = frameWithoutMembers({});
    h.client.handleIncoming(frame);
    expect(h.drops.map((d) => d.reason)).toEqual(['malformed']);
    expect(h.drops[0]?.frame).toBe(frame); // the refusal hands back the ORIGINAL frame
    // Defect: previously host1/a/me all fired onMemberLeft (empty fold vs
    // seeded roster). The acceptance law of this step: zero left events.
    expect(h.left).toHaveLength(0);
    expect(h.states).toHaveLength(0);
  });

  it('the refusal is pure — cached group keeps its full roster and untouched fields', () => {
    const h = membersKeyAbsentHarness();
    h.client.handleIncoming(frameWithoutMembers({ playback_position: 77777 }));
    const group = h.client.getGroup();
    expect(group?.group_id).toBe('sp_abc');
    expect(group?.members.map((m) => m.id)).toEqual(['host1', 'a', 'me']);
    // The seed's fold (position 0), NOT the refused frame's 77777 — the store
    // never ran (and the frozen group forbids in-place mutation anyway).
    expect(group?.playback_position).toBe(0);
  });

  it('a members-omitting frame for ANOTHER room is refused with no room change — the seek-cancel/store path is never reached', () => {
    const h = membersKeyAbsentHarness();
    h.client.handleIncoming(frameWithoutMembers({ group_id: 'sp_other' }));
    expect(h.drops.map((d) => d.reason)).toEqual(['malformed']);
    expect(h.client.getGroup()?.group_id).toBe('sp_abc'); // no adoption of sp_other
    expect(h.states).toHaveLength(0);
    expect(h.left).toHaveLength(0);
  });

  it('present-but-wrong-type members keep the ratified fold-to-empty law (null folds [], no refusal)', () => {
    const h = membersKeyAbsentHarness();
    h.client.handleIncoming(frameWithoutMembers({ members: null }));
    // The KEY is present — not this step's refusal class. normalizeMembers
    // folds null to [] (ratified at 'normalizes non-array members to empty
    // array'), so the fold legitimately lands an empty roster…
    expect(h.drops).toHaveLength(0);
    expect(h.states).toHaveLength(1);
    expect(h.states[0]?.members).toEqual([]);
    // …and the M-SYNCPLAY-16 same-room diff then announces each seeded
    // member as left — honest per-code behavior for an EMPTY new roster
    // claim, pinned so the refusal boundary (missing KEY) stays distinguish-
    // able from the fold boundary (wrong-type value).
    expect(h.left.map((m) => m.id)).toEqual(['host1', 'a', 'me']);
  });

  it('the honest zero-member spellings [] and {} are present keys — accepted, no refusal', () => {
    const h = membersKeyAbsentHarness();
    h.client.handleIncoming(frameWithoutMembers({ members: [] }));
    h.client.handleIncoming(frameWithoutMembers({ members: {} }));
    expect(h.drops).toHaveLength(0);
    expect(h.states).toHaveLength(2);
    expect(h.states[1]?.members).toEqual([]);
  });
});

describe('SyncPlayClient — typed boundary guards (W-min124 M-SYNCPLAY-19, review syncplay__secnet MINOR-3)', () => {
  it('group_state fields that are not their declared type fall back like absent ones', () => {
    const h = makeHarness();
    // LW-041a moved a NON-STRING group_id to whole-frame refusal (pinned in
    // the LW-041..044 block), so this adjacent-field sweep keeps its premise
    // with a valid room id and pins the per-field fallbacks around it.
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_abc',
        group_name: 7,
        host_id: 123,
        current_media_id: [],
        current_media_duration: Number.POSITIVE_INFINITY,
        playback_position: Number.POSITIVE_INFINITY,
        playback_state: 'zzz',
        member_count: 'two',
        created_at: Number.NaN,
        members: [{ id: 'me', name: 'Tester' }],
      },
    });
    const group = h.states[0]?.group;
    expect(group?.group_id).toBe('sp_abc');
    expect(group?.group_name).toBe('');
    expect(group?.host_id).toBeNull();
    expect(group?.current_media_id).toBeNull();
    expect(group?.current_media_duration).toBeNull();
    // M-SYNCPLAY-19 ratified fallback, re-pinned through the LW-042 clamp
    // fold: non-finite position → 0 (no ceiling invented for null duration).
    expect(group?.playback_position).toBe(0);
    expect(group?.playback_state).toBe('stopped');
    expect(group?.member_count).toBeUndefined();
    expect(group?.created_at).toBeUndefined();
  });

  it('every canonical playback_state passes the membership guard untouched', () => {
    const h = makeHarness();
    for (const st of ['playing', 'paused', 'buffering', 'stopped'] as const) {
      h.client.handleIncoming({
        type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
        protocol_version: 1,
        your_id: 'me',
        group: { group_id: 'sp_abc', host_id: 'host1', playback_state: st, members: [] },
      });
    }
    expect(h.states.map((s) => s.group.playback_state)).toEqual(['playing', 'paused', 'buffering', 'stopped']);
  });

  it('handleError only forwards STRING codes (first string candidate wins, else UNKNOWN)', () => {
    const h = makeHarness();
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.ERROR, protocol_version: 1, code: 42, message: 'm' });
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.ERROR, protocol_version: 1, error_code: {}, code: 'OK_CODE' });
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.ERROR, protocol_version: 1, error_code: 'ERR_X', code: 'Y' });
    expect(h.errors).toEqual([
      { code: 'UNKNOWN', message: 'm' },
      { code: 'OK_CODE', message: 'Unknown error' },
      { code: 'ERR_X', message: 'Unknown error' },
    ]);
  });

  it('playback commands with non-finite server_time take the clock-estimate fallback', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      protocol_version: 1,
      member_id: 'other',
      position: 5,
      server_time: Number.POSITIVE_INFINITY,
    });
    expect(h.commands).toHaveLength(1);
    expect(Number.isFinite(h.commands[0]?.serverTime)).toBe(true);
  });

  it('time_sync advisory frames with non-finite numerics are dropped whole', () => {
    const states: TimeSyncState[] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onTimeSync: (s) => states.push(s),
    });
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
      protocol_version: 1,
      member_id: 'm1',
      group_id: 'sp_abc',
      server_time: 1700000000,
      offset_ms: Number.POSITIVE_INFINITY,
      latency_ms: 5,
      drift_rate: 1,
      is_stable: true,
    });
    expect(states).toHaveLength(0);
  });

  it('queue-broadcast nudge numerics non-finite degrade to undefined, never Infinity', () => {
    const syncs: Array<{ position: number; nudge: unknown }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onPlaybackSync: (_m, position, _p, _s, nudge) => syncs.push({ position, nudge }),
    });
    client.handleIncoming(groupStateMessage('host1', 'me')); // LW-044: seed the room the honest fan-out producer broadcasts into
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
      protocol_version: 1,
      member_id: 'other',
      position: 10,
      is_playing: true,
      server_time: 1000,
      nudge: { drift_ms: Number.POSITIVE_INFINITY, direction: 'behind', suggested_rate: Number.POSITIVE_INFINITY },
    });
    expect(syncs).toHaveLength(1);
    expect(syncs[0]?.nudge).toEqual({
      drift_ms: undefined,
      direction: 'behind',
      suggested_rate: undefined,
      tolerance_ms: undefined,
      cooldown_ms: undefined,
    });
  });
});

// ------------------------------------------------ LW-041..LW-044 (fix wave w02-L10, 2026-11-06)

describe('SyncPlayClient — identity refusal, state clamps, streak reset, grouped delivery (LW-041..LW-044)', () => {
  function guardGroupState(overrides: Record<string, unknown>): RawMessage {
    return {
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_abc',
        host_id: 'host1',
        current_media_duration: 100000,
        playback_position: 4000,
        members: [{ id: 'host1', name: 'Host', is_host: true, joined_at: 1 }],
        ...overrides,
      },
    };
  }

  function guardHarness(grouped: boolean) {
    const drops: Array<{ reason: string; frame: unknown }> = [];
    const states: SyncPlayGroup[] = [];
    const commands: PlaybackCommand[] = [];
    const syncs: Array<{ memberId: string; position: number }> = [];
    const queues: unknown[] = [];
    const joined: Array<{ id: string; name: string }> = [];
    const infos: string[] = [];
    const errors: string[] = [];
    const hostChanges: Array<string | null> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      memberName: 'Tester',
      onFrameDropped: (reason, frame) => drops.push({ reason, frame }),
      onState: (group) => states.push(group),
      onPlaybackCommand: (c) => commands.push(c),
      onPlaybackSync: (memberId, position) => syncs.push({ memberId, position }),
      onQueueChanged: (q) => queues.push(q),
      onMemberJoined: (m) => joined.push(m),
      onInfo: (message) => infos.push(message),
      onError: (code) => errors.push(code),
      onHostChanged: (h) => hostChanges.push(h),
    });
    if (grouped) client.handleIncoming(guardGroupState({}));
    return { client, drops, states, commands, syncs, queues, joined, infos, errors, hostChanges };
  }

  it('LW-041a: group_state with a non-string group_id is refused whole — cached group and onState untouched', () => {
    const h = guardHarness(true);
    h.client.handleIncoming(guardGroupState({ group_id: { nested: true }, playback_position: 77777 }));
    expect(h.drops.map((d) => d.reason)).toEqual(['malformed']);
    expect(h.states).toHaveLength(1);
    expect(h.client.getGroup()?.group_id).toBe('sp_abc');
    expect(h.client.getGroup()?.playback_position).toBe(4000);
  });

  it('LW-041b: playback_sync without a string member_id is refused, never delivered as the empty speaker', () => {
    const h = guardHarness(true);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, protocol_version: 1,
      position: 5000, is_playing: true, server_time: 1000,
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, protocol_version: 1,
      member_id: 42, position: 5000, is_playing: true, server_time: 1000,
    });
    expect(h.syncs).toHaveLength(0);
    expect(h.drops.map((d) => d.reason)).toEqual(['malformed', 'malformed']);
  });

  it('LW-042: the group_state fold CLAMPS playback_position (floor 0, ceiling the same fold\'s duration)', () => {
    const h = guardHarness(false);
    h.client.handleIncoming(guardGroupState({ playback_position: 47_000_000 }));
    expect(h.states[0]?.playback_position).toBe(100000);
    h.client.handleIncoming(guardGroupState({ playback_position: -5000 }));
    expect(h.states[1]?.playback_position).toBe(0);
  });

  it('phlix-syncplay-048: a forged negative current_media_duration folds to null — the clamp-disarming sentinel is never stored', () => {
    const h = guardHarness(false);
    // `-1` used to pass the finite-only guard and land in the model: every
    // ceiling law is keyed `duration > 0`, so the fold silently ran
    // clamp-disarmed AND advertised a negative duration to onState.
    h.client.handleIncoming(guardGroupState({ current_media_duration: -1, playback_position: 47_000_000 }));
    expect(h.states[0]?.current_media_duration).toBeNull();
    expect(h.client.getGroup()?.current_media_duration).toBeNull();
    // null is the documented "unknown duration" (LW-042): no ceiling invented,
    // so the position passes — the REFUSAL changes the field, not the fold.
    expect(h.states[0]?.playback_position).toBe(47_000_000);
    // Fractional negatives take the same arm; the floor clamp is duration-
    // independent and stays armed.
    h.client.handleIncoming(guardGroupState({ current_media_duration: -0.5, playback_position: -5000 }));
    expect(h.states[1]?.current_media_duration).toBeNull();
    expect(h.states[1]?.playback_position).toBe(0);
    // Honest arms whole: positive duration still clamps at the ceiling, and
    // zero remains the real value a fresh room reports.
    h.client.handleIncoming(guardGroupState({ current_media_duration: 100000, playback_position: 47_000_000 }));
    expect(h.states[2]?.current_media_duration).toBe(100000);
    expect(h.states[2]?.playback_position).toBe(100000);
    h.client.handleIncoming(guardGroupState({ current_media_duration: 0 }));
    expect(h.states[3]?.current_media_duration).toBe(0);
  });

  it('LW-043a: a matched pong with a missing or non-finite server_time counts as a rejection (streak; slot still released)', () => {
    const h = makeHarness();
    h.client.pingTime();
    h.clock.set(1001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, client_time: 1000,
    });
    expect(h.degraded).toEqual([1]);
    expect(h.syncs).toHaveLength(0);
    expect(h.client.getTimeSync().getOffset()).toBe(0);
    h.sent.length = 0;
    h.client.pingTime(); // M-SYNCPLAY-13 slot release stays: consumed at match, before the gate
    expect(h.sent).toHaveLength(1);
    h.clock.set(4001);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1,
      client_time: 1001, server_time: Number.POSITIVE_INFINITY,
    });
    expect(h.degraded).toEqual([1, 2]); // a `1e999` t2 is the same no-measurement class
  });

  it('LW-043b: onDisconnect resets the rejection streak — it is per-connection measurement history', () => {
    const h = makeHarness();
    h.client.pingTime();
    h.clock.set(3000);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, client_time: 1000, server_time: 2000,
    });
    expect(h.degraded).toEqual([1]); // rtt 2000 > bound: rejected
    h.client.onDisconnect();
    h.client.pingTime();
    h.clock.set(5000);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, client_time: 3000, server_time: 4000,
    });
    expect(h.degraded).toEqual([1, 1]); // NOT [1, 2] — the fresh connection starts honest at zero
  });

  it('LW-043c: destroy() is TERMINAL — nothing after it runs (the observable-reset law is LW-043b; w11 L10 reshaped the probe)', () => {
    const h = makeHarness();
    h.client.pingTime();
    h.clock.set(3000);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, client_time: 1000, server_time: 2000,
    });
    expect(h.degraded).toEqual([1]);
    h.client.destroy();
    // LW-046 (review wave w11 L10, review asphp #6): destroy is TERMINAL —
    // the pre-wave probe re-pinged after destroy and read the reset off that
    // round, which is exactly the "do not use a destroyed instance" usage
    // the m18 docblock always forbade. The observable-streak-reset law lives
    // on the sanctioned reconnect lane (LW-043b, directly above); destroy's
    // law now is that NOTHING after it runs.
    expect(h.client.getGroup()).toBeNull();
    h.sent.length = 0;
    h.client.pingTime();
    expect(h.sent).toHaveLength(0);
    h.clock.set(5000);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG, protocol_version: 1, client_time: 3000, server_time: 4000,
    });
    expect(h.degraded).toEqual([1]); // no second round ever reaches the estimator
  });

  it('LW-044a: an ungrouped client refuses room-scoped fan-out as malformed — no state without a room', () => {
    const h = guardHarness(false);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, protocol_version: 1, member_id: 'host1', position: 5000, server_time: 1000,
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK, protocol_version: 1, member_id: 'host1', to_position: 6000, server_time: 1000,
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, protocol_version: 1, member_id: 'host1', position: 7000, server_time: 1000,
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE, protocol_version: 1, queue: [{ media_id: 'm1' }],
    });
    expect(h.commands).toHaveLength(0);
    expect(h.syncs).toHaveLength(0);
    expect(h.queues).toHaveLength(0);
    expect(h.drops.map((d) => d.reason)).toEqual(['malformed', 'malformed', 'malformed', 'malformed']);

    // Per-frame refusal, not a poisoned client: after joining, the same shapes deliver.
    h.client.handleIncoming(guardGroupState({}));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, protocol_version: 1, member_id: 'host1', position: 5000, server_time: 1000,
    });
    expect(h.commands).toHaveLength(1);
    expect(h.drops).toHaveLength(4);
  });

  it('LW-044b: the named ungrouped exceptions keep firing — host_elect, INFO message, ERROR', () => {
    const h = guardHarness(false);
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT, protocol_version: 1, elected_id: 'host2' });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO, protocol_version: 1, message: 'Server is going down for maintenance',
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.ERROR, protocol_version: 1, error_code: 'ERR_X', message: 'm',
    });
    expect(h.hostChanges).toEqual(['host2']);
    expect(h.infos).toEqual(['Server is going down for maintenance']);
    expect(h.errors).toEqual(['ERR_X']);
    expect(h.drops).toHaveLength(0);
  });

  it('LW-044c: a join announcement received while ungrouped names nobody; the message part still rides', () => {
    const h = guardHarness(false);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO, protocol_version: 1,
      member_id: 'newbie', member_name: 'New Bie', message: 'Newbie joined',
    });
    expect(h.joined).toHaveLength(0);
    expect(h.infos).toEqual(['Newbie joined']);

    const g = guardHarness(true);
    g.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO, protocol_version: 1, member_id: 'newbie', member_name: 'New Bie',
    });
    expect(g.joined).toEqual([{ id: 'newbie', name: 'New Bie' }]);
  });
});

describe('SyncPlayClient — integer-ms time-sync symmetry (SPY-2)', () => {
  it('a fractional now() clock round-trips: t1 is truncated, the int echo matches, a sample lands', () => {
    const h = makeHarness();
    h.clock.set(1000.7);
    h.client.pingTime();
    const ping = h.sent.at(-1) as unknown as { client_time: number };
    expect(ping.client_time).toBe(1000);
    h.clock.set(1050.4);
    // Server int-casts the echo (same integer we sent) and answers.
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
      protocol_version: 1,
      client_time: 1000,
      server_time: 1125,
    });
    expect(h.syncs).toHaveLength(1);
    // t4 = 1050 (truncated): rtt 50, oneWay 25; the server answered 25 ms into
    // the round trip, so a true +100 ms skew stamps t2 = 1000 + 100 + 25 =
    // 1125 and classical θ (S-syncplay-01) recovers offset = 1125 - 1000 - 25 = 100.
    expect(h.syncs[0]!.offset).toBe(100);
    expect(h.syncs[0]!.latency).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// phlix-syncplay-008 — frozen group hand-out.
// Finding: getGroup() and onState handed out the LIVE internal group object;
// a consumer writing into it mutated the library's model AND the next fold's
// `previous` roster-diff baseline (a renamed member surfaced as a false
// onMemberLeft payload). Cure: every store site freezes (all internal changes
// are whole-object replaces, so freezing is internal-cost-free). The pins
// assert the documented scope EXACTLY — no deep-freeze overclaim: each queue
// item's media_info stays an open island the library never reads.
// ---------------------------------------------------------------------------
describe('SyncPlayClient — frozen group hand-out (phlix-syncplay-008)', () => {
  it('getGroup() and the onState argument are the SAME object, frozen through the consumer model', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    const g = h.client.getGroup();
    expect(g).not.toBeNull();
    expect(h.states).toHaveLength(1);
    expect(h.states[0]!.group).toBe(g);
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g!.members)).toBe(true);
    expect(g!.members.every((m) => Object.isFrozen(m))).toBe(true);
  });

  it('mutation attempts on a handed-out group are REFUSED (strict-mode TypeError) and the model stays pristine', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    const g = h.client.getGroup()!;
    // Top-level field write (the TS type stays mutable — the refusal is the
    // runtime law, asserted with a cast because compiling the write is the
    // whole hazard this cure closes).
    expect(() => {
      (g as unknown as { group_name: string }).group_name = 'hijacked';
    }).toThrow(TypeError);
    // Ghost roster push (frozen array rejects growth).
    expect(() => {
      g.members.push({ id: 'ghost', name: 'Ghost', is_host: false, joined_at: 9 });
    }).toThrow(TypeError);
    // Element write on a live member row.
    expect(() => {
      (g.members[0] as unknown as { name: string }).name = 'hijacked';
    }).toThrow(TypeError);
    // Nothing landed: the stored model is byte-identical to the fold.
    expect(g.group_name).toBe('Movie Night');
    expect(g.members).toHaveLength(2);
    expect(g.members[0]!.name).toBe('Host');
  });

  it('diff-baseline immunity: a refused hostile write cannot poison the NEXT fold’s onMemberLeft event', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    const g = h.client.getGroup()!;
    // Pre-cure this write SUCCEEDED and the leaving-member event below would
    // have carried name 'HACKED' — the exact corruption the finding names.
    try {
      (g.members[1] as unknown as { name: string }).name = 'HACKED';
    } catch {
      // strict-mode refusal — the cure under test; the catch keeps the pin
      // honest under BOTH documented refusal modes (throws/ignored).
    }
    // Same room, follow-up state WITHOUT 'me' — fires the roster diff.
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_abc',
        group_name: 'Movie Night',
        member_count: 1,
        host_id: 'host1',
        current_media_id: 'media_1',
        current_media_duration: 0,
        playback_position: 0,
        playback_state: 'paused',
        members: [{ id: 'host1', name: 'Host', is_host: true, joined_at: 1 }],
      },
    });
    expect(h.left).toEqual([{ id: 'me', name: 'Tester' }]);
    expect(h.client.getGroup()!.members).toHaveLength(1);
  });

  it('queue surfaces: stored queue and the onQueueChanged array are the SAME frozen reference; media_info is the documented open island', () => {
    const queues: PlaybackQueueItem[][] = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      memberName: 'Tester',
      onQueueChanged: (q) => queues.push(q),
    });
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      your_id: 'me',
      group: {
        group_id: 'sp_abc',
        group_name: 'Movie Night',
        member_count: 1,
        host_id: 'host1',
        current_media_id: null,
        current_media_duration: 0,
        playback_position: 0,
        playback_state: 'paused',
        members: [{ id: 'host1', name: 'Host', is_host: true, joined_at: 1 }],
        queue: [{ media_id: 'm1', media_info: { title: 'A' } }],
      },
    });
    const g = client.getGroup()!;
    expect(Object.isFrozen(g.queue)).toBe(true);
    expect(Object.isFrozen(g.queue![0])).toBe(true);
    // Disclosed boundary: media_info is opaque consumer content the library
    // never reads — freezing it would reach into shared decoded-frame bytes.
    expect(Object.isFrozen(g.queue![0]!.media_info!)).toBe(false);
    expect(() => {
      g.queue!.push({ media_id: 'm2' });
    }).toThrow(TypeError);

    // Queue broadcast replaces the store: new array frozen, identical to the
    // callback argument (both hand-outs sealed at once).
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE,
      protocol_version: 1,
      queue: [{ media_id: 'm2', media_info: { title: 'B' }, added_by: 'host1' }],
    });
    expect(queues).toHaveLength(1);
    expect(Object.isFrozen(queues[0])).toBe(true);
    expect(client.getGroup()!.queue).toBe(queues[0]);
    expect(() => {
      (queues[0]![0] as unknown as { media_id: string }).media_id = 'tampered';
    }).toThrow(TypeError);
  });

  it('foldHostId paths re-freeze the rebuilt roster (host_transfer store stays sealed)', () => {
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      memberName: 'Tester',
    });
    client.handleIncoming(groupStateMessage('host1', 'me'));
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
      protocol_version: 1,
      current_host_id: 'host1',
      new_host_id: 'me',
    });
    const g = client.getGroup()!;
    expect(g.host_id).toBe('me');
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g.members)).toBe(true);
    // The remapped member objects are NEW builds — they need their own freeze.
    expect(g.members.every((m) => Object.isFrozen(m))).toBe(true);
    expect(() => {
      (g.members.find((m) => m.id === 'me') as unknown as { is_host: boolean }).is_host = false;
    }).toThrow(TypeError);
  });
});

/**
 * S-syncplay-03 (finding phlix-syncplay-003, High) — the `your_id`
 * reconciliation seam: `onIdentityMismatch` NAMES, `adoptServerIdentity`
 * ENFORCES. SPEC §9.2 law preserved end-to-end: the library reconciles
 * nothing on its own initiative — a contradicting stamp changes no state
 * until the consumer acts; the seam only replaces the hand-rolled compare
 * every platform was doing on its own. Order law mirrors c14
 * (dedicated hook fires AFTER the general hook for the SAME frame).
 */
describe('S-syncplay-03 — adoptServerIdentity / onIdentityMismatch seam', () => {
  type SeamEvent =
    | { hook: 'state'; yourId: string | undefined }
    | { hook: 'mismatch'; serverYourId: string; clientMemberId: string }
    | { hook: 'dropped'; reason: string };

  const OMIT = Symbol('omit-your_id');

  function makeSeamHarness(memberId = 'ghost-1', withMismatchHook = true) {
    const sent: RawMessage[] = [];
    const events: SeamEvent[] = [];
    const client = new SyncPlayClient({
      send: (m) => sent.push(m),
      now: () => 1000,
      memberId,
      memberName: 'Tester',
      onState: (_g, yourId) => events.push({ hook: 'state', yourId }),
      onFrameDropped: (reason) => events.push({ hook: 'dropped', reason }),
      ...(withMismatchHook
        ? {
            onIdentityMismatch: (serverYourId: string, clientMemberId: string) =>
              events.push({ hook: 'mismatch', serverYourId, clientMemberId }),
          }
        : {}),
    });
    return { client, sent, events };
  }

  /** group_state with an EXACT your_id value (OMIT symbol = key truly absent). */
  function seamStateFrame(yourId: unknown, hostId: string, memberIds: string[]): RawMessage {
    const frame: Record<string, unknown> = {
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      group: {
        group_id: 'sp_seam',
        group_name: 'Seam',
        host_id: hostId,
        playback_position: 0,
        playback_state: 'paused',
        members: memberIds.map((id) => ({
          id,
          name: id,
          is_host: id === hostId,
          joined_at: 1,
        })),
      },
    };
    if (yourId !== OMIT) {
      frame.your_id = yourId;
    }
    return frame as RawMessage;
  }

  const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('names the contradiction: mismatch fires per contradicting frame, AFTER that frames onState, (serverYourId, clientMemberId)', () => {
    const h = makeSeamHarness('ghost-1');
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.events).toEqual([
      { hook: 'state', yourId: 'hub-uuid-9' },
      { hook: 'mismatch', serverYourId: 'hub-uuid-9', clientMemberId: 'ghost-1' },
    ]);
    // Per-redelivery law (streamed frames): every contradicting frame names it.
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.events.filter((e) => e.hook === 'mismatch')).toHaveLength(2);
  });

  it('equal, non-string, or absent your_id are NOT contradictions; onState still gets the verbatim/undefined law', () => {
    const h = makeSeamHarness('ghost-1');
    h.client.handleIncoming(seamStateFrame('ghost-1', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.events).toEqual([{ hook: 'state', yourId: 'ghost-1' }]);
    h.client.handleIncoming(seamStateFrame(42, 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    // Non-string never reaches the mismatch arm (no compare against garbage)
    // and the EXISTING onState law stands: surfaced as undefined.
    expect(h.events).toEqual([
      { hook: 'state', yourId: 'ghost-1' },
      { hook: 'state', yourId: undefined },
    ]);
    h.client.handleIncoming(seamStateFrame(OMIT, 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.events.filter((e) => e.hook === 'mismatch')).toHaveLength(0);
    expect(h.events).toHaveLength(3);
  });

  it('adoption installs the stamped id — getMemberId/isHost/outbound stamps flip live, mismatch stops; store stays a frozen snapshot', () => {
    const h = makeSeamHarness('ghost-1');
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.client.isHost()).toBe(false); // pre-adoption: true host, ghost id
    expect(h.client.adoptServerIdentity('hub-uuid-9')).toBe(true);
    expect(h.client.getMemberId()).toBe('hub-uuid-9');
    expect(h.client.isHost()).toBe(true); // live read, no reconfiguration
    // Outbound stamps use the adopted id (member_id stamp sites read live).
    h.client.createGroup('Seam', SHA_EMPTY);
    const frame = h.sent[h.sent.length - 1] as Record<string, unknown>;
    expect(frame.member_id).toBe('hub-uuid-9');
    // Reconciled now: the same frame no longer contradicts.
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.events.filter((e) => e.hook === 'mismatch')).toHaveLength(1);
    // The store after the fold is the frozen delivered snapshot; adoption did
    // NOT write into it (c08 replace-only law — the field swap is identity,
    // never a mutation of delivered group bytes).
    const store = h.client.getGroup();
    expect(store).not.toBeNull();
    expect(Object.isFrozen(store)).toBe(true);
    expect(store?.host_id).toBe('hub-uuid-9');
  });

  it('REFUSED group_state fires neither onState nor onIdentityMismatch (c24 refusal purity, even with a contradicting stamp)', () => {
    const h = makeSeamHarness('ghost-1');
    const bad = seamStateFrame('hub-uuid-9', 'hub-uuid-9', []);
    delete (bad.group as Record<string, unknown>).members; // c24: undefined members = refuse whole frame
    h.client.handleIncoming(bad);
    expect(h.events).toEqual([{ hook: 'dropped', reason: 'malformed' }]);
    expect(h.client.getGroup()).toBeNull();
    expect(h.client.getMemberId()).toBe('ghost-1'); // refusal never adopted anything
  });

  it('absent onIdentityMismatch option: contradicting frame handled with zero observable change, no throw (additive default)', () => {
    const h = makeSeamHarness('ghost-1', false);
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.events).toEqual([{ hook: 'state', yourId: 'hub-uuid-9' }]);
    expect(h.client.getMemberId()).toBe('ghost-1'); // nothing self-adopted
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.client.getMemberId()).toBe('ghost-1');
  });

  it('boundary law: bad shape THROWS TypeError even post-destroy (LW-045 parse-before-latch); destroyed is inert false; equal id false', () => {
    const h = makeSeamHarness('ghost-1');
    expect(() => h.client.adoptServerIdentity('')).toThrow(TypeError);
    expect(() => h.client.adoptServerIdentity(7 as unknown as string)).toThrow(TypeError);
    expect(() => h.client.adoptServerIdentity(null as unknown as string)).toThrow(TypeError);
    expect(h.client.adoptServerIdentity('ghost-1')).toBe(false); // equal = no-op
    h.client.destroy();
    expect(() => h.client.adoptServerIdentity('')).toThrow(TypeError); // shape gate precedes latch
    expect(h.client.adoptServerIdentity('hub-uuid-9')).toBe(false); // LW-046 inert
    expect(h.client.getMemberId()).toBe('ghost-1'); // destroyed adoption changed nothing
  });

  it('onDisconnect does NOT revert an adoption; a fresh hub uuid surfaces a fresh mismatch; re-adoption is the consumers call', () => {
    const h = makeSeamHarness('ghost-1');
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    expect(h.client.adoptServerIdentity('hub-uuid-9')).toBe(true);
    h.client.onDisconnect();
    expect(h.client.getMemberId()).toBe('hub-uuid-9'); // identity is not transport history
    h.client.handleIncoming(seamStateFrame('hub-uuid-NEW', 'hub-uuid-NEW', ['hub-uuid-NEW', 'hub-uuid-9']));
    expect(h.events.filter((e) => e.hook === 'mismatch')).toEqual([
      { hook: 'mismatch', serverYourId: 'hub-uuid-9', clientMemberId: 'ghost-1' },
      { hook: 'mismatch', serverYourId: 'hub-uuid-NEW', clientMemberId: 'hub-uuid-9' },
    ]);
    expect(h.client.adoptServerIdentity('hub-uuid-NEW')).toBe(true);
  });

  it('replace-only discipline: second adoption swaps the field; every previously delivered snapshot keeps its own bytes', () => {
    const h = makeSeamHarness('ghost-1');
    h.client.handleIncoming(seamStateFrame('hub-uuid-9', 'hub-uuid-9', ['hub-uuid-9', 'ghost-1']));
    h.client.adoptServerIdentity('hub-uuid-9');
    const snapshotOne = h.client.getGroup() as SyncPlayGroup;
    h.client.handleIncoming(seamStateFrame('hub-uuid-10', 'hub-uuid-10', ['hub-uuid-10', 'hub-uuid-9']));
    h.client.adoptServerIdentity('hub-uuid-10');
    expect(h.client.getMemberId()).toBe('hub-uuid-10');
    expect(snapshotOne.host_id).toBe('hub-uuid-9'); // old snapshot unchanged
    expect(Object.isFrozen(snapshotOne)).toBe(true);
    expect(h.client.getGroup()?.host_id).toBe('hub-uuid-10'); // new store object
  });
});
