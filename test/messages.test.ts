/**
 * messages.test.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect } from 'vitest';
import {
  SYNCPLAY_MESSAGE_TYPES,
  ALL_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  isValidMessageType,
  type PlaybackState,
} from '../src/messages';
import {
  encodeMessage,
  decodeMessage,
  serializeMessage,
} from '../src/framing';

describe('SYNCPLAY_MESSAGE_TYPES', () => {
  it('contains exactly the 19 server message types', () => {
    expect(ALL_MESSAGE_TYPES).toHaveLength(19);
  });

  it('matches the server TYPE_* strings byte-for-byte', () => {
    expect(SYNCPLAY_MESSAGE_TYPES).toEqual({
      GROUP_CREATE: 'syncplay_group_create',
      GROUP_JOIN: 'syncplay_group_join',
      GROUP_LEAVE: 'syncplay_group_leave',
      GROUP_STATE: 'syncplay_group_state',
      GROUP_LIST: 'syncplay_group_list',
      PLAYBACK_PLAY: 'syncplay_playback_play',
      PLAYBACK_PAUSE: 'syncplay_playback_pause',
      PLAYBACK_SEEK: 'syncplay_playback_seek',
      PLAYBACK_QUEUE: 'syncplay_playback_queue',
      PLAYBACK_SYNC: 'syncplay_playback_sync',
      CHAT: 'syncplay_chat',
      TYPING: 'syncplay_typing',
      HOST_TRANSFER: 'syncplay_host_transfer',
      HOST_ELECT: 'syncplay_host_elect',
      TIME_PING: 'syncplay_time_ping',
      TIME_PONG: 'syncplay_time_pong',
      TIME_SYNC: 'syncplay_time_sync',
      ERROR: 'syncplay_error',
      INFO: 'syncplay_info',
    });
  });

  it('uses the underscore syncplay_ prefix on every type (never the dot prefix)', () => {
    for (const type of ALL_MESSAGE_TYPES) {
      expect(type.startsWith('syncplay_')).toBe(true);
      expect(type.startsWith('syncplay.')).toBe(false);
    }
  });

  it('has no duplicate type strings', () => {
    expect(new Set(ALL_MESSAGE_TYPES).size).toBe(ALL_MESSAGE_TYPES.length);
  });

  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('PlaybackState includes all four GroupState STATE_* values incl. buffering', () => {
    // Compile-time + run-time check that every server STATE_* string is a valid
    // PlaybackState (mirrors GroupState::STATE_PLAYING/PAUSED/BUFFERING/STOPPED).
    const states: PlaybackState[] = ['playing', 'paused', 'buffering', 'stopped'];
    expect(states).toContain('buffering');
    expect(states).toHaveLength(4);
  });

  it('isValidMessageType accepts known and rejects unknown / divergent types', () => {
    expect(isValidMessageType('syncplay_group_create')).toBe(true);
    expect(isValidMessageType('syncplay_time_pong')).toBe(true);
    // Tizen inventions — NOT part of the canonical protocol.
    expect(isValidMessageType('syncplay_member_joined')).toBe(false);
    expect(isValidMessageType('syncplay_member_left')).toBe(false);
    // Windows-only extra — not a server type.
    expect(isValidMessageType('syncplay_position_report')).toBe(false);
    // Roku dot prefix.
    expect(isValidMessageType('syncplay.group_create')).toBe(false);
    expect(isValidMessageType('nonsense')).toBe(false);
  });
});

describe('framing — encodeMessage', () => {
  const now = () => 1700000000000;

  it('produces a flat RAW object with type, protocol_version, timestamp + payload', () => {
    const msg = encodeMessage(
      SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE,
      { group_name: 'Movie Night', member_id: 'm1' },
      now,
    );
    expect(msg).toEqual({
      type: 'syncplay_group_create',
      protocol_version: 1,
      timestamp: 1700000000000,
      group_name: 'Movie Night',
      member_id: 'm1',
    });
  });

  it('does NOT produce the deprecated { type, data, timestamp } wrapper', () => {
    const msg = encodeMessage(SYNCPLAY_MESSAGE_TYPES.TIME_PING, { client_time: 5 }, now);
    expect(msg).not.toHaveProperty('data');
    expect(msg.client_time).toBe(5);
  });

  it('uses the injected clock for timestamp', () => {
    let t = 42;
    const msg = encodeMessage(SYNCPLAY_MESSAGE_TYPES.INFO, { message: 'hi' }, () => t);
    expect(msg.timestamp).toBe(42);
    t = 99;
    const msg2 = encodeMessage(SYNCPLAY_MESSAGE_TYPES.INFO, { message: 'hi' }, () => t);
    expect(msg2.timestamp).toBe(99);
  });
});

describe('framing — decodeMessage', () => {
  it('round-trips a flat message through serialize/decode', () => {
    const original = encodeMessage(
      SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
      { group_id: 'g1', member_id: 'm1', position: 5000, server_time: 1700000000123 },
      () => 1700000000200,
    );
    const json = serializeMessage(original);
    const decoded = decodeMessage(json);
    expect(decoded).toEqual(original);
  });

  it('accepts an already-parsed object', () => {
    const decoded = decodeMessage({ type: 'syncplay_info', protocol_version: 1, message: 'hi' });
    expect(decoded).toEqual({ type: 'syncplay_info', protocol_version: 1, message: 'hi' });
  });

  it('unwraps the deprecated Tizen { type, data, timestamp } envelope to flat', () => {
    const tizen = {
      type: 'syncplay_playback_play',
      data: { group_id: 'g1', member_id: 'm1', position: 9000 },
      timestamp: 1700000000000,
    };
    const decoded = decodeMessage(tizen);
    expect(decoded).toEqual({
      type: 'syncplay_playback_play',
      group_id: 'g1',
      member_id: 'm1',
      position: 9000,
      timestamp: 1700000000000,
    });
    expect(decoded).not.toHaveProperty('data');
  });

  it('returns null for invalid JSON', () => {
    expect(decodeMessage('{not json')).toBeNull();
  });

  it('returns null for non-object / array / missing type', () => {
    expect(decodeMessage('123')).toBeNull();
    expect(decodeMessage('[1,2,3]')).toBeNull();
    expect(decodeMessage({ protocol_version: 1 })).toBeNull();
    expect(decodeMessage(null)).toBeNull();
  });
});
