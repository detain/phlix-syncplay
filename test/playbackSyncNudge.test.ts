/**
 * M-SYNCPLAY-08 — `handlePlaybackSync` delivers the producer's S446 `nudge`.
 *
 * The server's owner-ruled soft-desync correction ("a rate-limited NUDGE —
 * never a seek", phlix-server `src/Session/SyncPlay/GroupState.php:39`)
 * rides the existing `syncplay_playback_sync` frame family as an ADDITIVE
 * object (S417 outbound rule). The library extracted exactly four fields
 * (`member_id`, `position`, `is_playing`, `server_time`) and dropped the
 * object on the floor: embedders could not nudge playRate at all without
 * sniffing raw frames around `handleIncoming`, stranding the policy on the
 * wire's last hop.
 *
 * Fixture provenance (fixtures = producer bytes law):
 *  - DIRECTED_NUDGE_* frames are copied from `sendOutOfSyncNudge()` —
 *    phlix-server `src/Session/SyncPlay/SyncPlayManager.php:1569-1585`
 *    (@84e55800): payload keys member_id(:1570) group_id(:1571)
 *    current_media_id(:1572) position(:1573) is_playing(:1574)
 *    server_time(:1575, `time()` — the :8097 seconds quirk, §8.4)
 *    nudge(:1576-1584); envelope keys type/protocol_version/timestamp
 *    stamped by `Messages::frame()` (`src/Session/SyncPlay/Messages.php`).
 *    Values follow the constants the emitter interpolates: suggested_rate
 *    1 ± `GroupState::NUDGE_RATE_STEP` 0.1 (`GroupState.php:167`),
 *    tolerance_ms `POSITION_TOLERANCE` 2000 (`GroupState.php:124`),
 *    cooldown_ms `NUDGE_COOLDOWN_MS` 1000 (`GroupState.php:145`).
 *  - GROUP_ECHO_FRAME mirrors the UNCHANGED broadcast to the whole group,
 *    `SyncPlayManager.php:1517-1524` — same type, HOST-stamped, NO nudge.
 *  - HUB_ECHO_FRAME mirrors the `:8804` relay's canonical reply,
 *    phlix-hub `src/SyncPlay/SyncPlayRelayWorker.php:1673-1680`
 *    (@f85f48ec) — `server_time` in ms (:1679); the hub produces no
 *    nudge at all (SPEC §8.4), so `nudge` is ABSENT, never zeroed.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect } from 'vitest';
import { SyncPlayClient } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type PlaybackSyncNudge } from '../src/messages';

interface SyncDelivery {
  memberId: string;
  position: number;
  isPlaying: boolean;
  serverTime: number;
  /** Arity probe: whether the producer frame carried a `nudge` key at all. */
  nudgeReceived: boolean;
  nudge: PlaybackSyncNudge | undefined;
}

function makeClient(memberId = 'me') {
  const syncs: SyncDelivery[] = [];
  const client = new SyncPlayClient({
    send: () => {},
    now: () => 1000,
    memberId,
    memberName: 'Tester',
    onPlaybackSync: (mid, position, isPlaying, serverTime, nudge) =>
      syncs.push({
        memberId: mid,
        position,
        isPlaying,
        serverTime,
        nudgeReceived: nudge !== undefined,
        nudge,
      }),
  });
  return { client, syncs };
}

function feed(client: SyncPlayClient, frame: Record<string, unknown>): void {
  client.handleIncoming(frame);
}

/** Envelope `Messages::frame()` owns: type + protocol_version + ms timestamp. */
function envelope(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, protocol_version: 1, timestamp: 1788300111222, ...fields };
}

/** Verbatim `sendOutOfSyncNudge()` bytes — member behind (drift_ms > 0). */
const DIRECTED_NUDGE_BEHIND = envelope({
  member_id: 'drifter-1',
  group_id: 'sp_nudge_room',
  current_media_id: 'media_42',
  position: 90000,
  is_playing: true,
  server_time: 1788300111,
  nudge: {
    drift_ms: 3500,
    direction: 'behind',
    suggested_rate: 1.1,
    tolerance_ms: 2000,
    cooldown_ms: 1000,
  },
});

/** Same emitter, ahead branch: drift < 0 → 'ahead', rate 1 − 0.1 (`:1579-1581`). */
const DIRECTED_NUDGE_AHEAD = envelope({
  member_id: 'drifter-1',
  group_id: 'sp_nudge_room',
  current_media_id: 'media_42',
  position: 90000,
  is_playing: true,
  server_time: 1788300111,
  nudge: {
    drift_ms: -2800,
    direction: 'ahead',
    suggested_rate: 0.9,
    tolerance_ms: 2000,
    cooldown_ms: 1000,
  },
});

/** Group echo (`SyncPlayManager.php:1517-1524`): host-stamped, NO nudge key. */
const GROUP_ECHO_FRAME = envelope({
  member_id: 'host-1',
  group_id: 'sp_nudge_room',
  current_media_id: 'media_42',
  position: 90000,
  is_playing: true,
  server_time: 1788300111,
});

/** Hub relay reply (`SyncPlayRelayWorker.php:1673-1680`): ms stamp, NO nudge. */
const HUB_ECHO_FRAME = envelope({
  member_id: 'hub-client-1',
  group_id: 'living-room',
  current_media_id: null,
  position: 0,
  is_playing: false,
  server_time: 1788300111222,
});

describe('M-SYNCPLAY-08 — the S446 nudge payload survives the library boundary', () => {
  it('the directed frame delivers the full nudge object as the 5th onPlaybackSync argument', () => {
    const { client, syncs } = makeClient('drifter-1');
    feed(client, DIRECTED_NUDGE_BEHIND);

    expect(syncs).toHaveLength(1);
    const delivery = syncs[0]!;
    // RED before the fix: handlePlaybackSync extracted only 4 fields.
    expect(delivery.nudgeReceived, 'nudge was silently dropped (M-SYNCPLAY-08)').toBe(true);
    expect(delivery.nudge).toEqual({
      drift_ms: 3500,
      direction: 'behind',
      suggested_rate: 1.1,
      tolerance_ms: 2000,
      cooldown_ms: 1000,
    });
    // The frame's own state fields keep flowing exactly as before.
    expect(delivery.memberId).toBe('drifter-1');
    expect(delivery.position).toBe(90000);
    expect(delivery.isPlaying).toBe(true);
    // :8097 seconds quirk normalized to ms at the boundary (M-SYNCPLAY-04 law).
    expect(delivery.serverTime).toBe(1788300111000);
  });

  it('the ahead branch carries negative drift and rate 1−0.1 verbatim', () => {
    const { client, syncs } = makeClient('drifter-1');
    feed(client, DIRECTED_NUDGE_AHEAD);

    expect(syncs[0]!.nudge).toEqual({
      drift_ms: -2800,
      direction: 'ahead',
      suggested_rate: 0.9,
      tolerance_ms: 2000,
      cooldown_ms: 1000,
    });
  });

  it('the group echo carries NO nudge — undefined, never a fabricated object (absent ≠ empty)', () => {
    const { client, syncs } = makeClient('host-1');
    feed(client, GROUP_ECHO_FRAME);

    expect(syncs).toHaveLength(1);
    expect(syncs[0]!.nudgeReceived).toBe(false);
    expect(syncs[0]!.nudge).toBeUndefined();
    // Echo law untouched: host-stamped state still delivered, seconds → ms.
    expect(syncs[0]!.memberId).toBe('host-1');
    expect(syncs[0]!.serverTime).toBe(1788300111000);
  });

  it('hub-relay frames keep §8.4 truth: ms passthrough and nudge always undefined', () => {
    const { client, syncs } = makeClient('hub-client-1');
    feed(client, HUB_ECHO_FRAME);

    expect(syncs).toHaveLength(1);
    expect(syncs[0]!.nudge).toBeUndefined();
    // Hub ms stamp passes through serverTimeToMs untouched.
    expect(syncs[0]!.serverTime).toBe(1788300111222);
  });

  it('a present-but-partial nudge narrows per-field like normalizeQueue (nothing invented)', () => {
    const { client, syncs } = makeClient('drifter-1');
    feed(
      client,
      envelope({
        member_id: 'drifter-1',
        position: 1000,
        is_playing: false,
        server_time: 1788300111,
        nudge: { drift_ms: 2500, direction: 'sideways', suggested_rate: 'fast' },
      }),
    );

    const nudge = syncs[0]!.nudge!;
    expect(syncs[0]!.nudgeReceived).toBe(true);
    expect(nudge.drift_ms).toBe(2500);
    // Literal-pair validated: a foreign direction is dropped, not passed through.
    expect(nudge.direction).toBeUndefined();
    expect(nudge.suggested_rate).toBeUndefined();
    expect(nudge.tolerance_ms).toBeUndefined();
    expect(nudge.cooldown_ms).toBeUndefined();
    // And the state half of the frame still delivered (drop-garbage-keep-state).
    expect(syncs[0]!.position).toBe(1000);
  });

  it('a non-object nudge on a hand-built frame degrades to undefined, not a throw', () => {
    const { client, syncs } = makeClient('drifter-1');
    feed(client, { ...GROUP_ECHO_FRAME, member_id: 'drifter-1', nudge: 'nope' });

    expect(syncs[0]!.nudge).toBeUndefined();
    expect(syncs[0]!.memberId).toBe('drifter-1');
  });

  it('legacy 4-argument consumers keep working untouched (additive, BREAKING-free)', () => {
    const seen: Array<[string, number, boolean, number]> = [];
    const client = new SyncPlayClient({
      send: () => {},
      now: () => 1000,
      memberId: 'drifter-1',
      memberName: 'Tester',
      // Exactly the pre-fix signature — typechecks against the widened hook.
      onPlaybackSync: (memberId, position, isPlaying, serverTime) =>
        seen.push([memberId, position, isPlaying, serverTime]),
    });
    feed(client, DIRECTED_NUDGE_BEHIND);

    expect(seen).toEqual([['drifter-1', 90000, true, 1788300111000]]);
  });
});
