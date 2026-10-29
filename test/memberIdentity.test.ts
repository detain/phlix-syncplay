/**
 * memberIdentity.test — the M-SYNCPLAY-12 identity coupling (review
 * `syncplay__gameux` M5).
 *
 * Pins the law documented on `SyncPlayClientOptions.memberId` / SPEC §9.2:
 * the constructor `memberId`, the `your_id` the server stamps on
 * `syncplay_group_state` (phlix-server `SyncPlayManager.php:1799`/`:1855` —
 * `$connection->getUserId()`), and the `member_id`/`host_id` stamped on every
 * rebroadcast are ONE identity, and `isHost()` + the command echo
 * suppressions only function when the consumer actually passes it.
 *
 * Fake frames below mirror PRODUCER BYTES: the join ack nests the group and
 * carries `your_id`; rebroadcast commands carry the server-derived sender id
 * (SPEC §9 item 3), seconds `server_time` on the `:8097` carrier.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect } from 'vitest';
import { SyncPlayClient, type PlaybackCommand } from '../src/client';
import { encodeMessage, serializeMessage } from '../src/framing';
import {
  SYNCPLAY_MESSAGE_TYPES,
  type RawMessage,
  type SyncPlayGroup,
  type SyncPlayMessageType,
} from '../src/messages';

/** The authenticated user id the server would stamp (JWT subject shape). */
const REAL_ID = '8f2a4d61-0d3e-4a55-9b7c-1e6f2a8c4d90';
/** A second member's server-stamped id. */
const PEER_ID = 'b1d0c9f7-6e5a-4d3c-8b2a-190715e3d2c1';

interface Harness {
  client: SyncPlayClient;
  sent: RawMessage[];
  states: Array<{ group: SyncPlayGroup; yourId: string | undefined }>;
  commands: PlaybackCommand[];
}

function makeHarness(memberId: string): Harness {
  const sent: RawMessage[] = [];
  const states: Array<{ group: SyncPlayGroup; yourId: string | undefined }> = [];
  const commands: PlaybackCommand[] = [];
  const client = new SyncPlayClient({
    send: (m) => sent.push(m),
    now: () => 1000,
    memberId,
    memberName: 'Alice',
    onState: (group, yourId) => states.push({ group, yourId }),
    onPlaybackCommand: (c) => commands.push(c),
  });
  return { client, sent, states, commands };
}

/** The create/join ack as phlix-server `SyncPlayManager.php:1799`/`:1855` frames it. */
function groupStateAck(hostId: string, yourId: string): RawMessage {
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
        { id: PEER_ID, name: 'Bob', is_host: false, joined_at: 2 },
      ],
    },
  };
}

/** A rebroadcast command carrying the SERVER-DERIVED sender id (§9 item 3). */
function stampedCommand(
  type: SyncPlayMessageType,
  senderId: string,
  extra: Record<string, unknown>,
): string {
  return serializeMessage(
    encodeMessage(type, { member_id: senderId, ...extra }, () => 1000),
  );
}

describe('identity coupling — isHost() is keyed on the JOIN-STAMPED id', () => {
  it('isHost() is true ONLY when the ctor id equals the host_id the server stamped for this connection', () => {
    const h = makeHarness(REAL_ID);
    h.client.handleIncoming(groupStateAck(REAL_ID, REAL_ID));

    expect(h.states).toHaveLength(1);
    expect(h.states[0].yourId).toBe(REAL_ID);
    expect(h.client.getMemberId()).toBe(REAL_ID);
    expect(h.client.isHost()).toBe(true);
  });

  it('a member whose ctor id is NOT the stamped host id is never host', () => {
    const h = makeHarness(REAL_ID);
    h.client.handleIncoming(groupStateAck(PEER_ID, REAL_ID));

    expect(h.states[0].yourId).toBe(REAL_ID);
    expect(h.client.isHost()).toBe(false);
  });

  it('dead-host class (mobile precedent): fabricated ctor id keeps isHost() false while the server stamps THIS connection as host', () => {
    // The consumer's auth user is the host; the server says so — your_id AND
    // host_id carry the derived identity. The fabricated ctor value can never
    // match, so a true host reads itself as a guest: permanently false.
    const h = makeHarness('member_123');
    h.client.handleIncoming(groupStateAck(REAL_ID, REAL_ID));

    expect(h.client.isHost()).toBe(false);
    // The coupling is SURFACED unreconciled by design: onState hands the
    // consumer the stamped identity to assert against getMemberId().
    expect(h.states[0].yourId).toBe(REAL_ID);
    expect(h.states[0].yourId).not.toBe(h.client.getMemberId());

    // It stays false across the whole session — host election to this
    // connection cannot revive it either.
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
      protocol_version: 1,
      elected_id: REAL_ID,
      elected_by: PEER_ID,
    });
    expect(h.client.getGroup()?.host_id).toBe(REAL_ID);
    expect(h.client.isHost()).toBe(false);
  });
});

describe('identity coupling — echo suppression is self-vs-other on the stamped id', () => {
  it('suppresses play/pause/seek frames stamped with MY id and surfaces peer-stamped ones', () => {
    const h = makeHarness(REAL_ID);
    h.client.handleIncoming(groupStateAck(REAL_ID, REAL_ID));

    h.client.handleIncoming(
      stampedCommand(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, REAL_ID, {
        position: 5000,
        server_time: 1761900000,
      }),
    );
    h.client.handleIncoming(
      stampedCommand(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK, REAL_ID, {
        from_position: 1000,
        to_position: 9000,
        server_time: 1761900000,
      }),
    );
    expect(h.commands).toHaveLength(0); // own echoes: already applied locally

    h.client.handleIncoming(
      stampedCommand(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, PEER_ID, {
        position: 7000,
        server_time: 1761900000,
      }),
    );
    expect(h.commands).toEqual([
      { type: 'play', position: 7000, serverTime: 1761900000000 },
    ]);
  });

  it('ghost-identity class: with a mismatched ctor id, the host echo stamped with the REAL id survives suppression and double-applies', () => {
    // handlePlay already applied the command locally when the host SENT it;
    // the server re-broadcasts it stamped with the DERIVED id (§9 item 3).
    // Ctor id 'member_123' !== that stamp, so the suppression misses and the
    // consumer sees its own command as a foreign one — the second observable
    // defect of the mismatch documented on SyncPlayClientOptions.memberId.
    const h = makeHarness('member_123');
    h.client.handleIncoming(groupStateAck(REAL_ID, REAL_ID));

    h.client.handleIncoming(
      stampedCommand(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, REAL_ID, {
        position: 5000,
        server_time: 1761900000,
      }),
    );
    expect(h.commands).toEqual([
      { type: 'play', position: 5000, serverTime: 1761900000000 },
    ]);
  });
});

describe('identity coupling — the README example works as code', () => {
  it('join-response identity flow: auth-sourced memberId, reconciliation via onState yourId, live host controls', async () => {
    // Mirrors README "Usage" + "Identity contract" step for step (the ws is
    // replaced by the injected send sink; the awaited read stands in for the
    // sync `authSession.userId` of the example — the consumer's auth layer
    // holding the JWT subject).
    const auth = { getUserId: async () => REAL_ID };

    const memberId = await auth.getUserId(); // = JWT subject
    const h = makeHarness(memberId);

    // ws.onopen → createGroup (the server will answer with the ack below).
    h.client.createGroup('Movie Night');
    expect(h.sent[0]).toMatchObject({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE,
      member_id: REAL_ID,
    });

    // The create/join ack carries `your_id` — assert the coupling holds.
    h.client.handleIncoming(groupStateAck(REAL_ID, REAL_ID));
    const { group, yourId } = h.states[0];
    expect(yourId).toBeDefined();
    expect(yourId).toBe(h.client.getMemberId());

    // Host controls are ALIVE: isHost() true, own echo suppressed,
    // peer commands applied.
    expect(h.client.isHost()).toBe(true);
    h.client.sendPlay(5000);
    h.client.handleIncoming(
      stampedCommand(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, group.host_id ?? '', {
        position: 5000,
        server_time: 1761900000,
      }),
    );
    expect(h.commands).toHaveLength(0);

    h.client.handleIncoming(
      stampedCommand(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK, PEER_ID, {
        from_position: 5000,
        to_position: 8000,
        server_time: 1761900000,
      }),
    );
    expect(h.commands).toEqual([
      { type: 'seek', position: 8000, serverTime: 1761900000000 },
    ]);
  });
});
