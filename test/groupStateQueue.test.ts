/**
 * M-SYNCPLAY-06 — `handleGroupState` delivers the producer's `queue`.
 *
 * SPEC §4 calls the nested `group` block "verbatim GroupState::getState()",
 * and getState() emits `queue` (`phlix-server`
 * `src/Session/SyncPlay/GroupState.php:970` — `'queue' => $this->playbackQueue`).
 * The library rebuilt the group field-by-field and silently dropped the
 * field: a queue UI built to SPEC read `undefined` through `onState` while
 * the wire carried the array.
 *
 * Fixture provenance (fixtures = producer bytes law):
 *  - SERVER_CAPTURE_GROUP is COPIED VERBATIM from phlix-contracts
 *    `test/fixtures/syncplay-envelope-vectors.json` rail `groupState.state`
 *    ("two-members-with-queue-and-playing-state") — the real
 *    `GroupState::getState()` capture whose item shape traces to
 *    `GroupState::addToQueue()` :812-817
 *    (`media_id`, `media_info`, `added_at` unix seconds, `added_by`).
 *  - HUB_RELAY_GROUP mirrors the `:8804` relay's synthesized payload
 *    (`phlix-hub` `src/SyncPlay/SyncPlayRelayWorker.php`
 *    `canonicalGroupPayload()` :1387-1404) with queue items exactly as
 *    `handleCanonicalQueueUpdate()` parses them (:1713-1747): the hub narrows
 *    items to `media_id` + `media_info` — on that carrier `added_at` /
 *    `added_by` are ABSENT, never zeroed.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect } from 'vitest';
import { SyncPlayClient } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage, type SyncPlayGroup } from '../src/messages';

function makeClient(memberId = 'me') {
  const states: SyncPlayGroup[] = [];
  const client = new SyncPlayClient({
    send: () => {},
    now: () => 1000,
    memberId,
    memberName: 'Tester',
    onState: (group) => states.push(group),
  });
  return { client, states };
}

function feed(client: SyncPlayClient, group: unknown, yourId?: string): void {
  const frame: RawMessage = {
    type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
    protocol_version: 1,
    ...(yourId !== undefined ? { your_id: yourId } : {}),
    group,
  };
  client.handleIncoming(frame);
}

/** Verbatim contracts capture — see provenance header. */
const SERVER_CAPTURE_GROUP = {
  group_id: 'sp_vectorhost',
  group_name: 'Vector Group',
  member_count: 2,
  members: {
    alpha: { id: 'alpha', name: 'Alpha', is_host: true, joined_at: 1788300111 },
    beta: { id: 'beta', name: 'Beta', is_host: false, joined_at: 1788300111 },
  },
  host_id: 'alpha',
  current_media_id: 'media_42',
  current_media_duration: 3600000,
  playback_position: 90000,
  playback_state: 'playing',
  queue: [
    {
      media_id: 'media_43',
      media_info: { title: 'Queued Feature', kind: 'movie' },
      added_at: 1788300111,
      added_by: 'alpha',
    },
  ],
  created_at: 1788300111,
  last_activity_at: 1788300111,
};

/** Hub relay truth — items lack added_at/added_by (SyncPlayRelayWorker.php:1747). */
const HUB_RELAY_GROUP = {
  group_id: 'living-room',
  group_name: 'living-room',
  member_count: 1,
  members: {
    'hub-client-1': { id: 'hub-client-1', name: 'Remote', is_host: true, joined_at: 1788300111 },
  },
  host_id: 'hub-client-1',
  current_media_id: null,
  current_media_duration: 0,
  playback_position: 0,
  playback_state: 'stopped',
  queue: [
    { media_id: 'media_7', media_info: { title: 'Queued Relay Item' } },
    { media_id: 'media_8', media_info: {} },
  ],
  created_at: 1788300111,
  last_activity_at: 1788300111,
};

describe('M-SYNCPLAY-06 — group_state.queue is delivered, not dropped', () => {
  it('the server-captured frame delivers its full four-field queue item via onState', () => {
    const { client, states } = makeClient('beta');
    feed(client, SERVER_CAPTURE_GROUP, 'beta');

    expect(states).toHaveLength(1);
    const group = client.getGroup()!;
    // RED before the fix: handleGroupState never copied group.queue.
    expect(group.queue, 'queue was silently dropped (M-SYNCPLAY-06)').toBeDefined();
    expect(group.queue).toHaveLength(1);
    expect(group.queue![0]).toEqual({
      media_id: 'media_43',
      media_info: { title: 'Queued Feature', kind: 'movie' },
      added_at: 1788300111,
      added_by: 'alpha',
    });
    // The delivery reaches the CALLBACK, not only the cached group.
    expect(states[0].queue![0]!.media_id).toBe('media_43');
    // Carry-through must not disturb the S416 member normalization.
    expect(group.members.map((m) => m.id).sort()).toEqual(['alpha', 'beta']);
    expect(group.playback_state).toBe('playing');
  });

  it('hub-relay items keep per-carrier truth: media_id + media_info, added_* absent (never zeroed)', () => {
    const { client } = makeClient('hub-client-1');
    feed(client, HUB_RELAY_GROUP);
    const queue = client.getGroup()!.queue!;

    expect(queue).toHaveLength(2);
    expect(queue[0]).toEqual({ media_id: 'media_7', media_info: { title: 'Queued Relay Item' } });
    expect(queue[0]!.added_at).toBeUndefined();
    expect(queue[0]!.added_by).toBeUndefined();
    // Empty media_info survives as an (empty) object, media_8 has no added_* either.
    expect(queue[1]!.media_info).toEqual({});
    expect(queue[1]!.added_at).toBeUndefined();
  });

  it('an empty queue from the producer arrives as [] — absent and empty never mix', () => {
    const { client } = makeClient();
    feed(client, { ...SERVER_CAPTURE_GROUP, queue: [] });
    const group = client.getGroup()!;
    expect(Array.isArray(group.queue)).toBe(true);
    expect(group.queue).toHaveLength(0);
  });

  it('a frame WITHOUT queue leaves the model field undefined (no fabricated empty queue)', () => {
    const { client } = makeClient();
    feed(client, { ...SERVER_CAPTURE_GROUP, queue: undefined });
    expect(client.getGroup()!.queue).toBeUndefined();
  });

  it('a non-array queue on a hand-built frame degrades to undefined, not a throw', () => {
    const { client } = makeClient();
    feed(client, { ...SERVER_CAPTURE_GROUP, queue: 'nope' });
    expect(client.getGroup()!.queue).toBeUndefined();
    // And the rest of the group still normalizes (drop-the-garbage, keep-the-state).
    expect(client.getGroup()!.group_id).toBe('sp_vectorhost');
  });

  it('garbage items narrow per-field like normalizeMembers (defensive, nothing thrown)', () => {
    const { client } = makeClient();
    feed(client, {
      ...SERVER_CAPTURE_GROUP,
      queue: [
        { media_id: 42, media_info: 'str', added_at: 'soon', added_by: 7 },
        { media_id: 'real', added_by: null },
      ],
    });
    const queue = client.getGroup()!.queue!;
    expect(queue).toHaveLength(2);
    expect(queue[0]).toEqual({
      media_id: '',
      media_info: undefined,
      added_at: undefined,
      added_by: undefined,
    });
    expect(queue[1]!.media_id).toBe('real');
    // added_by null is a legal producer value (GroupState.php:816 nullable hostId).
    expect(queue[1]!.added_by).toBeNull();
  });
});
