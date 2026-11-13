/**
 * SPY-S12 — listGroups / sendQueue / transferHost frame goldens + guards.
 * Frames ride existing wire codes (SPEC §4.1 / §4.2 / §4.4).
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
import { describe, it, expect } from 'vitest';
import { SyncPlayClient } from '../src/client';
import { SYNCPLAY_MESSAGE_TYPES, type RawMessage } from '../src/messages';

function make(): { client: SyncPlayClient; sent: RawMessage[] } {
  const sent: RawMessage[] = [];
  const client = new SyncPlayClient({ send: (m) => sent.push(m), now: () => 1000, memberId: 'me' });
  return { client, sent };
}

function join(h: { client: SyncPlayClient; sent: RawMessage[] }): void {
  h.client.handleIncoming({
    type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
    protocol_version: 1,
    timestamp: 1,
    your_id: 'me',
    group: {
      group_id: 'sp_abc',
      group_name: 'G',
      member_count: 1,
      host_id: 'me',
      current_media_id: 'media_1',
      current_media_duration: 0,
      playback_position: 0,
      playback_state: 'paused',
      created_at: 1700000000,
      last_activity_at: 1700000000,
      members: [{ id: 'me', name: 'Tester', is_host: true, joined_at: 1 }],
    },
  });
  h.sent.length = 0;
}

describe('SPY-S12 listGroups', () => {
  it('emits a bare group_list frame, outside a group', () => {
    const h = make();
    expect(h.client.listGroups()).toBe(true);
    expect(h.sent).toEqual([{ type: 'syncplay_group_list', protocol_version: 1, timestamp: 1000 }]);
  });
  it('is inert after destroy', () => {
    const h = make();
    h.client.destroy();
    expect(h.client.listGroups()).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});

describe('SPY-S12 sendQueue', () => {
  it('emits the client-shape queue frame (media_id + media_info only)', () => {
    const h = make();
    join(h);
    const q = [{ media_id: 'm1', media_info: { title: 'T' } }, { media_id: 'm2' }];
    expect(h.client.sendQueue(q)).toBe(true);
    expect(h.sent).toEqual([
      {
        type: 'syncplay_playback_queue',
        protocol_version: 1,
        timestamp: 1000,
        group_id: 'sp_abc',
        queue: [{ media_id: 'm1', media_info: { title: 'T' } }, { media_id: 'm2' }],
      },
    ]);
  });
  it('strips server-only item fields and allows an empty queue', () => {
    const h = make();
    join(h);
    h.client.sendQueue([{ media_id: 'm1', added_at: 5, added_by: 'x' } as never]);
    expect((h.sent[0] as unknown as { queue: unknown }).queue).toEqual([{ media_id: 'm1' }]);
    h.client.sendQueue([]);
    expect((h.sent[1] as unknown as { queue: unknown }).queue).toEqual([]);
  });
  it('returns false with no group; throws on malformed input', () => {
    const h = make();
    expect(h.client.sendQueue([{ media_id: 'a' }])).toBe(false);
    expect(h.sent).toHaveLength(0);
    expect(() => h.client.sendQueue('x' as never)).toThrow(TypeError);
    expect(() => h.client.sendQueue([{ media_id: 3 } as never])).toThrow(TypeError);
    expect(() => h.client.sendQueue([null as never])).toThrow(TypeError);
  });
});

describe('SPY-S12 transferHost', () => {
  it('emits the host_transfer frame', () => {
    const h = make();
    join(h);
    expect(h.client.transferHost('bob')).toBe(true);
    expect(h.sent).toEqual([
      {
        type: 'syncplay_host_transfer',
        protocol_version: 1,
        timestamp: 1000,
        group_id: 'sp_abc',
        current_host_id: 'me',
        new_host_id: 'bob',
      },
    ]);
  });
  it('returns false with no group; throws on empty/non-string id', () => {
    const h = make();
    expect(h.client.transferHost('bob')).toBe(false);
    expect(() => h.client.transferHost('')).toThrow(TypeError);
    expect(() => h.client.transferHost(7 as never)).toThrow(TypeError);
  });
});
