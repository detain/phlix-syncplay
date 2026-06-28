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
