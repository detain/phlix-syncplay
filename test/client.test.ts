/**
 * client.test.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect, vi } from 'vitest';
import { SyncPlayClient, type PlaybackCommand } from '../src/client';
import { encodeMessage, serializeMessage } from '../src/framing';
import { SYNCPLAY_MESSAGE_TYPES, type GroupListSummaryRow, type RawMessage, type SyncPlayGroup, type TimeSyncPayload, type TimeSyncState, type UnknownFrame } from '../src/messages';

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
    onHostChanged: (h) => hostChanges.push(h),
    onDisconnect: () => disconnects.push(1),
    onUnknownFrame: (frame) => unknown.push(frame),
  });

  return { client, sent, clock, states, syncs, commands, errors, joined, hostChanges, disconnects, unknown };
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

describe('SyncPlayClient — group management sends', () => {
  it('createGroup emits a flat group_create with member fields', () => {
    const h = makeHarness();
    h.client.createGroup('Movie Night', 'deadbeef');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toEqual({
      type: 'syncplay_group_create',
      protocol_version: 1,
      timestamp: 1000,
      group_name: 'Movie Night',
      member_id: 'me',
      member_name: 'Tester',
      password_hash: 'deadbeef',
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

  // S294 control — the pair that distinguishes a fix from deleting the guard
  // wholesale: playback_sync from self is CONSUMED (above) but command frames
  // from self are STILL DROPPED (below). If any of these ever fires, the
  // self-echo guard was deleted for the wrong frame types and the AC is unmet.
  it('still drops a play command echoed back from ourselves (real wire frame)', () => {
    const h = makeHarness();
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

describe('SyncPlayClient — joinGroup with password hash', () => {
  it('joinGroup includes password_hash when provided (line 190)', () => {
    const h = makeHarness();
    h.client.joinGroup('sp_abc', 'deadbeef');
    expect(h.sent[0]).toMatchObject({
      type: 'syncplay_group_join',
      protocol_version: 1,
      timestamp: 1000,
      group_id: 'sp_abc',
      member_id: 'me',
      member_name: 'Tester',
      password_hash: 'deadbeef',
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

describe('SyncPlayClient — handleGroupList type coercion defaults (producer keys)', () => {
  // Every coercion is asserted on the REAL producer key names; the row that
  // carries the OLD fabricated `{group_id, group_name}` spelling is pinned to
  // decode into EMPTY defaults — the exact silent-`''` bug class this fix
  // lane kills, now test-permanent.
  it('coerces every non-conforming producer field to its total default', () => {
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
          id: 123, // non-string id
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
      id: '',
      name: '',
      member_count: 0,
      has_password: false,
      current_media: null,
      is_playing: false,
    });
  });

  it('a fabricated-shape row (group_id/group_name) yields empty producer fields', () => {
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

    // The pre-fix reader would have seen 'g1'/'Group One' here; on the fixed
    // boundary the invented IDENTITY names are absent data. `has_password`
    // survives — it is a REAL producer key that happened to share the old
    // fixture's spelling.
    expect(lists[0][0]).toEqual({
      id: '',
      name: '',
      member_count: 0,
      has_password: true,
      current_media: null,
      is_playing: false,
    });
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

  it('does NOT route any of the 19 canonical types to the hook', () => {
    const h = makeHarness();
    h.client.handleIncoming(groupStateMessage('host1', 'me'));
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.INFO,
      protocol_version: 1,
      message: 'Guest joined the group',
      member_id: 'guest1',
      member_name: 'Guest',
    });
    // Since M-SYNCPLAY-11 EVERY canonical type — chat and playback_queue
    // included — is orchestrated by its own handler; all 19 still route
    // BEFORE the default arm, so none may reach this hook either.
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

    // Canonical types go through their own handlers only — no double-routing.
    expect(h.unknown).toHaveLength(0);
    expect(h.states).toHaveLength(1);
    expect(h.joined).toEqual([{ id: 'guest1', name: 'Guest' }]);
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
    // on 'host1' until the next group_state).
    expect(group?.members.map((m) => [m.id, m.is_host])).toEqual([
      ['host1', false],
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
