import { describe, expect, it } from 'vitest';
import { SyncPlayClient } from '../src/client';
import type { RawMessage } from '../src/messages';

describe('memberName default (SPY-S13)', () => {
  it("defaults to 'Host' on create and join when omitted", () => {
    const sent: RawMessage[] = [];
    const client = new SyncPlayClient({
      send: (m) => sent.push(m),
      now: () => 1000,
      memberId: 'm1',
    });
    client.createGroup('g');
    client.joinGroup('gid');
    expect(sent.map((m) => (m as Record<string, unknown>)['member_name'])).toEqual(['Host', 'Host']);
  });
});
