/**
 * client.test.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect, vi } from 'vitest';
import { SyncPlayClient, type PlaybackCommand } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage, type SyncPlayGroup } from '../src/messages';

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
  });

  return { client, sent, clock, states, syncs, commands, errors, joined, hostChanges, disconnects };
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
      server_time: 123,
    });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
      protocol_version: 1,
      member_id: 'host1',
      from_position: 5000,
      to_position: 9000,
      server_time: 456,
    });

    expect(h.commands).toEqual([
      { type: 'play', position: 5000, serverTime: 123 },
      { type: 'seek', position: 9000, serverTime: 456 },
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
      server_time: 12345,
    });

    expect(syncs).toEqual([{ memberId: 'host1', position: 5000, isPlaying: true, serverTime: 12345 }]);
  });

  it('handlePlaybackSync ignores sync from ourselves', () => {
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
      member_id: 'me',
      position: 5000,
      is_playing: true,
      server_time: 12345,
    });

    expect(syncs).toHaveLength(0);
  });

  it('handleTimeSync fires onTimeSync callback', () => {
    const timeSyncs: Array<{ serverTime: number; clientTime: number }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onTimeSync: (serverTime, clientTime) => timeSyncs.push({ serverTime, clientTime }),
    });

    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
      protocol_version: 1,
      server_time: 50000,
      client_time: 40000,
    });

    expect(timeSyncs).toEqual([{ serverTime: 50000, clientTime: 40000 }]);
  });

  it('handleGroupList maps groups array to onGroupList callback', () => {
    const lists: Array<Array<{ group_id: string; group_name: string; has_password?: boolean }>> = [];
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
        { group_id: 'g1', group_name: 'Group One', has_password: true },
        { group_id: 'g2', group_name: 'Group Two' },
      ],
    });

    expect(lists).toEqual([
      [
        { group_id: 'g1', group_name: 'Group One', has_password: true },
        { group_id: 'g2', group_name: 'Group Two' },
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
      server_time: 123,
    });

    expect(h.commands).toEqual([{ type: 'seek', position: 5000, serverTime: 123 }]);
  });
});

describe('SyncPlayClient — switch default case (unknown message type)', () => {
  it('ignores unknown message types without error', () => {
    const states: Array<{ group: SyncPlayGroup; yourId: string | undefined }> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'me',
      onState: (group, yourId) => states.push({ group, yourId }),
    });

    // An unknown type should be silently ignored (no crash, no state change)
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
