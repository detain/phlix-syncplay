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
  type BaseMessage,
  type PlaybackState,
  type RawMessage,
  type TimeSyncPayload,
  type HostElectPayload,
} from '../src/messages';
import {
  encodeMessage,
  decodeMessage,
  isCanonicalFrame,
  serializeMessage,
} from '../src/framing';

describe('SYNCPLAY_MESSAGE_TYPES', () => {
  it('contains exactly the 19 server message types', () => {
    expect(ALL_MESSAGE_TYPES).toHaveLength(19);
  });

  it('ALL_MESSAGE_TYPES is frozen at runtime, not just typed readonly', () => {
    expect(Object.isFrozen(ALL_MESSAGE_TYPES)).toBe(true);
    expect(() => (ALL_MESSAGE_TYPES as unknown as string[]).push('x')).toThrow(TypeError);
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

  it('MUST NOT hoist-or-delete `data` on a CANONICAL frame that legitimately carries it (M-SYNCPLAY-02)', () => {
    // `syncplay_info` has a documented top-level `data` payload field (SPEC §4;
    // server `Messages::info()` stamps `$info['data'] = $data`). Because the
    // frame carries `protocol_version` it is NOT the deprecated Tizen wrapper,
    // so decodeMessage must pass it through UNTOUCHED. Pre-fix the heuristic
    // keyed on any object `data` beside `type`, hoisting-and-deleting the
    // legitimate field and silently mutating canonical frames on their way to
    // `onUnknownFrame` consumers (who are promised "no mutation").
    const canonical = {
      type: 'syncplay_info',
      protocol_version: 1,
      timestamp: 1700000000000,
      message: 'syncplay.join_success',
      data: { group_id: 'g1', role: 'member' },
    };
    const decoded = decodeMessage(canonical);
    expect(decoded).toEqual(canonical);
    expect(decoded).toHaveProperty('data');
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

  it('S-syncplay-39 (phlix-syncplay-050): a planted `__proto__` key rides the legacy unwrap as an OWN inert data property — never through the [[Set]] prototype setter', () => {
    // Legacy Tizen { type, data, timestamp } wrapper with a forged OWN
    // `__proto__` key. JSON.parse DOES create `__proto__` as an own data
    // property, so the old `rest[key] = record[key]` copy invoked the
    // Object.prototype.__proto__ SETTER: rest's prototype was swapped to the
    // attacker object and the key silently vanished from the copy — harmless
    // today only because the trailing spread re-collects own keys (fragile
    // by construction). Post-cure the copy is Object.defineProperty-based:
    // no setter is ever invoked, and the planted key survives exactly as it
    // does on the canonical pass-through path.
    const polluted =
      '{"type":"syncplay_playback_play","data":{"group_id":"g1"},"timestamp":1700000000000,"__proto__":{"polluted":"yes"}}';
    const decoded = decodeMessage(polluted);
    expect(decoded).not.toBeNull();
    const rec = decoded as unknown as Record<string, unknown>;
    // (a) nothing on the global prototype chain moved
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // (b) the decoded frame itself carries a pristine prototype
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    // (c) the planted key was COPIED, not consumed by the setter: own inert
    //     data property. RED pre-cure — the [[Set]] copy dropped it.
    expect(Object.prototype.hasOwnProperty.call(rec, '__proto__')).toBe(true);
    expect(rec['__proto__']).toEqual({ polluted: 'yes' });
    // (d) the legitimate unwrap still happened alongside it
    expect(rec.type).toBe('syncplay_playback_play');
    expect(rec.group_id).toBe('g1');
    expect(rec.timestamp).toBe(1700000000000);
    expect(rec).not.toHaveProperty('data');
  });

  it('S-syncplay-39: `constructor`/`prototype` keys ride the unwrap unchanged (own-shadowed before and after — the cure must not regress them)', () => {
    const frame =
      '{"type":"syncplay_playback_play","data":{"group_id":"g1"},"timestamp":1700000000000,"constructor":"c","prototype":"p"}';
    const rec = decodeMessage(frame) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(rec, 'constructor')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(rec, 'prototype')).toBe(true);
    expect(rec.constructor).toBe('c');
    expect(rec.prototype).toBe('p');
    expect(rec.group_id).toBe('g1');
  });

  it('S-syncplay-39: canonical frames (protocol_version present) pass a planted `__proto__` through untouched — the byte-compat law both paths share', () => {
    const canonical =
      '{"type":"syncplay_info","protocol_version":1,"timestamp":1700000000000,"message":"m","__proto__":{"x":1}}';
    const rec = decodeMessage(canonical) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(rec, '__proto__')).toBe(true);
    expect(rec['__proto__']).toEqual({ x: 1 });
    expect(rec.message).toBe('m');
  });
});

describe('TimeSyncPayload — server wire-shape pin (M-SYNCPLAY-03)', () => {
  // Server wire truth: phlix-server src/Session/SyncPlay/SyncPlayManager.php:1650-1658
  // (@ bc3b9b33; SPEC §1 item 6 — era-pinned cite, names are the durable anchors).
  // (handleTimeSync). This fixture is typed AS the interface, so any drift
  // between the model and the real emit site reddens `tsc` — and its key set
  // is pinned at runtime, so the never-emitted `client_time` of the old
  // fabricated model can never sneak back into the contract.
  const serverWireFrame: TimeSyncPayload = {
    member_id: 'user-1',
    group_id: 'group-1',
    server_time: 1761900000, // UNIX seconds — the :8097 quirk (time())
    offset_ms: 42,
    latency_ms: 7,
    drift_rate: 1.0002,
    is_stable: true,
    protocol_version: 1,
  };

  it('carries exactly the fields the server emits, in the server spelling', () => {
    expect(Object.keys(serverWireFrame).sort()).toEqual(
      [
        'drift_rate',
        'group_id',
        'is_stable',
        'latency_ms',
        'member_id',
        'offset_ms',
        'protocol_version',
        'server_time',
      ].sort(),
    );
  });

  it('does not carry the fabricated client_time field', () => {
    expect(serverWireFrame).not.toHaveProperty('client_time');
  });
});

describe('HostElectPayload — SPEC §4 field-roster pin (M-SYNCPLAY-08)', () => {
  // SPEC §4 lists `group_id?: string` on syncplay_host_elect. Before the fix
  // `HostElectPayload` omitted it, so the model disagreed with the documented
  // roster and multi-group consumers had nothing to disambiguate by. This
  // fixture is typed AS the interface WITH the optional field, so removing
  // `group_id?: string` reddens `tsc` (excess-property on a fresh literal).
  // It is TYPE-ONLY — `handleHostElect` still does not read it (the live
  // broadcasts omit it; only the legacy Messages::hostElect factory stamps it).
  const legacyFactoryFrame: HostElectPayload = {
    group_id: 'g1',
    elected_id: 'm2',
    elected_by: 'm1',
  };
  const liveBroadcastFrame: HostElectPayload = {
    elected_id: 'm2',
    elected_by: 'm1',
  };

  it('admits the SPEC-documented optional group_id', () => {
    expect(legacyFactoryFrame.group_id).toBe('g1');
  });

  it('still parses the live two-field broadcast (group_id absent)', () => {
    expect(liveBroadcastFrame).not.toHaveProperty('group_id');
    expect(liveBroadcastFrame.elected_id).toBe('m2');
    expect(liveBroadcastFrame.elected_by).toBe('m1');
  });
});

describe('S-syncplay-07 — honest WireEnvelope typing (phlix-syncplay-007)', () => {
  it('decodes a legacy-wrapped stamp-less frame as a RawMessage that honestly lacks the key', () => {
    const decoded = decodeMessage(
      '{"type":"syncplay_group_leave","data":{"group_id":"g1"}}',
    ) as RawMessage;
    expect(decoded.type).toBe(SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE);
    expect(decoded).not.toHaveProperty('protocol_version');
    expect(decoded.protocol_version).toBeUndefined();
  });

  it('COMPILE WITNESS: an un-stamped frame literal is assignable to RawMessage', () => {
    // tsc must accept a decoded-shape frame WITHOUT the stamp. If the typing
    // is ever laundered back to required on the receiver side, this line is
    // the TS2741 conviction `npm run build` reports.
    const unstamped: RawMessage = {
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE,
      group_id: 'g1',
    };
    expect(unstamped.protocol_version).toBeUndefined();
  });

  it('COMPILE WITNESS: BaseMessage (the producer envelope) still REQUIRES the stamp', () => {
    // @ts-expect-error — S-syncplay-07 split the shapes: WireEnvelope makes the
    // stamp optional for receivers; BaseMessage keeps it required for senders.
    // If the required arm is ever relaxed, the unused directive reddens tsc.
    const missingStamp: BaseMessage = { type: SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE };
    expect(missingStamp.type).toBe(SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE);
  });

  it('isCanonicalFrame routes canonicity without a cast — both branches at runtime', () => {
    const canonical = decodeMessage('{"type":"syncplay_group_state","protocol_version":1,"group_id":"g1"}');
    const foreign = decodeMessage('{"type":"pending_command","id":7}');
    expect(canonical).not.toBeNull();
    expect(foreign).not.toBeNull();
    if (canonical !== null && isCanonicalFrame(canonical)) {
      // Compile witness: the narrowed branch exposes the wire stamp as
      // `number | undefined` (WireEnvelope), not a laundered `number`.
      const stamp: number | undefined = canonical.protocol_version;
      expect(stamp).toBe(1);
    } else {
      expect.unreachable('canonical vocabulary must narrow to RawMessage');
    }
    expect(foreign !== null && isCanonicalFrame(foreign)).toBe(false);
    if (foreign !== null && !isCanonicalFrame(foreign)) {
      const rawType: string = foreign.type;
      expect(rawType).toBe('pending_command');
    }
  });

  it('encodeMessage still stamps PROTOCOL_VERSION on every outbound frame', () => {
    const outbound = encodeMessage(SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE, {}, () => 1234);
    expect(outbound.protocol_version).toBe(PROTOCOL_VERSION);
  });
});
