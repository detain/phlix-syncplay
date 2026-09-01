/**
 * s416 dict members test.
 *
 * Pins S416: `handleGroupState` must fold the server's REAL `members` spelling
 * — a DICTIONARY keyed by member id (what `GroupState::getState()` has emitted
 * since the initial SyncPlay commit) — into the library's array model, AND
 * still tolerate the array spelling (the library's own normalized output,
 * re-fed by tests/consumers). The old array-only branch silently dropped every
 * live-wire member to `[]`.
 *
 * The DICT vector below is COPIED VERBATIM from phlix-contracts
 * `test/fixtures/syncplay-envelope-vectors.json` rail `joinGroup` — the real
 * `{success, group}` response captured from phlix-server `01340633` by
 * `scripts/dump-server-syncplay-vectors.php`. It is the S416 bug in its native
 * habitat: those two members MUST survive decode as a non-empty array. This
 * dict fixture is RED against the pre-fix client (array-only branch → `[]`)
 * and GREEN after.
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

/**
 * The live server frame. `group.members` is the getState() DICT — keys are the
 * member ids and the dict values carry id/name/is_host/joined_at. Values are
 * verbatim from the S415 golden vector.
 */
const LIVE_DICT_FRAME: RawMessage = {
  type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
  protocol_version: 1,
  your_id: 'member_guest',
  group: {
    group_id: 'sp_cca927fbf4ba11f9',
    group_name: 'Movie Night',
    member_count: 2,
    members: {
      member_host: { id: 'member_host', name: 'Host One', is_host: true, joined_at: 1788300111 },
      member_guest: { id: 'member_guest', name: 'Guest Two', is_host: false, joined_at: 1788300111 },
    },
    host_id: 'member_host',
    current_media_id: null,
    current_media_duration: 0,
    playback_position: 0,
    playback_state: 'stopped',
    created_at: 1788300111,
    last_activity_at: 1788300111,
  },
};

describe('S416 — handleGroupState folds the wire members DICT into the array model', () => {
  it('a dict-shaped group_state yields NON-EMPTY members (the S416 fix)', () => {
    const { client, states } = makeClient('member_guest');
    client.handleIncoming(LIVE_DICT_FRAME);

    expect(states).toHaveLength(1);
    const group = client.getGroup();
    expect(group).not.toBeNull();
    const members = group!.members;

    // RED before the fix: the array-only branch returned [] for a dict.
    expect(Array.isArray(members), 'normalized members must be an array').toBe(true);
    expect(members.length, 'dict members were silently dropped to [] (S416)').toBe(2);
    expect(members.map((m) => m.id).sort()).toEqual(['member_guest', 'member_host']);
  });

  it('dict members keep the wire fields and derive is_host from host_id (authoritative)', () => {
    const { client } = makeClient('member_guest');
    client.handleIncoming(LIVE_DICT_FRAME);
    const members = client.getGroup()!.members;

    const host = members.find((m) => m.id === 'member_host')!;
    expect(host.name).toBe('Host One');
    expect(host.is_host).toBe(true);
    expect(host.joined_at).toBe(1788300111);

    const guest = members.find((m) => m.id === 'member_guest')!;
    expect(guest.name).toBe('Guest Two');
    expect(guest.is_host).toBe(false);
  });

  it('the entry KEY is authoritative for id even if the dict value omits it', () => {
    const { client } = makeClient('x');
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      group: {
        group_id: 'g',
        group_name: 'G',
        host_id: 'a',
        playback_position: 0,
        playback_state: 'playing',
        members: { a: { name: 'A' }, b: { name: 'B' } },
      },
    });
    const members = client.getGroup()!.members;
    expect(members.map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(members.find((m) => m.id === 'a')!.is_host).toBe(true);
  });

  it("the ARRAY spelling is still tolerated (library's own model re-fed)", () => {
    const { client } = makeClient('me');
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      group: {
        group_id: 'g',
        group_name: 'G',
        host_id: 'host1',
        playback_position: 0,
        playback_state: 'playing',
        members: [
          { id: 'host1', name: 'Host', is_host: true, joined_at: 1 },
          { id: 'me', name: 'Tester', is_host: false, joined_at: 2 },
        ],
      },
    });
    const members = client.getGroup()!.members;
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.id === 'host1')!.is_host).toBe(true);
    expect(members.find((m) => m.id === 'me')!.is_host).toBe(false);
  });

  it('a genuinely non-collection members value (string) still falls back to [] (defence intact)', () => {
    const { client } = makeClient('me');
    client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
      protocol_version: 1,
      group: {
        group_id: 'g',
        group_name: 'G',
        host_id: 'm1',
        playback_position: 0,
        playback_state: 'stopped',
        members: 'not-a-collection',
      },
    });
    expect(client.getGroup()!.members).toEqual([]);
  });
});
