/**
 * M-SYNCPLAY-11 — `syncplay_chat` and `syncplay_playback_queue` are SURFACED,
 * not swallowed.
 *
 * The review (`syncplay__gameux` M4) caught the dispatch arms routing both
 * canonical types into a silent `break`: chat needed hand-typed frames and
 * zero events, next-up/queue UIs had to sniff raw frames before
 * `handleIncoming` — and the typing indicator WAS wired, so the library
 * shipped "Bob is typing…" with no way for Bob's message to arrive through
 * the public API. The cure adds `onChat` / `onQueueChanged` (typed to
 * PRODUCER BYTES) and the `sendChat` / `sendTyping` sender pair.
 * (`group_state.group.queue` was already cured by d687560 — see
 * groupStateQueue.test.ts; this file covers the standalone broadcast half.)
 *
 * Fixture provenance (fixtures = producer bytes law):
 *  - SERVER_CHAT_FRAME mirrors the `:8097` broadcast bytes exactly:
 *    `SyncPlayManager::handleChatMessage` data array
 *    `phlix-server src/Session/SyncPlay/SyncPlayManager.php:1323-1326`
 *    (`member_id` authenticated — S289, :1297; `member_name` from the group
 *    record :1312; `message`) inside the `Messages::frame` envelope
 *    (`Messages.php:235-250`, timestamp ms :924-927), @84e55800. The
 *    broadcast carries NO `group_id` key.
 *  - HUB_CHAT_FRAME mirrors the `:8804` relay broadcast
 *    `phlix-hub src/SyncPlay/SyncPlayRelayWorker.php:1795-1799` inside
 *    `canonicalFrame` (:1223-1232), @5731fc79.
 *  - SERVER_QUEUE_FRAME mirrors the queue broadcast data array
 *    `SyncPlayManager.php:1271-1273` — `queue` = `getPlaybackQueue()`, full
 *    four-field items per `addToQueue()` (`GroupState.php:812-817`).
 *  - HUB_QUEUE_FRAME mirrors `SyncPlayRelayWorker.php:1763-1765` — items
 *    narrowed to `media_id` + `media_info` (:1713-1747); on that carrier
 *    `added_at`/`added_by` are ABSENT, never zeroed.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect, vi } from 'vitest';
import { SyncPlayClient } from '../src/client';
import {
  SYNCPLAY_MESSAGE_TYPES,
  type PlaybackQueueItem,
  type RawMessage,
  type SyncPlayGroup,
  type UnknownFrame,
} from '../src/messages';

type ChatCall = [memberId: string, memberName: string, message: string, timestampMs: number | undefined];

interface Harness {
  client: SyncPlayClient;
  sent: RawMessage[];
  chats: ChatCall[];
  queues: PlaybackQueueItem[][];
  states: SyncPlayGroup[];
  unknown: UnknownFrame[];
}

function makeHarness(memberId = 'me'): Harness {
  const sent: RawMessage[] = [];
  const chats: ChatCall[] = [];
  const queues: PlaybackQueueItem[][] = [];
  const states: SyncPlayGroup[] = [];
  const unknown: UnknownFrame[] = [];
  const client = new SyncPlayClient({
    send: (m) => sent.push(m),
    now: () => 1000,
    memberId,
    memberName: 'Tester',
    onState: (group) => states.push(group),
    onChat: (id, name, message, ts) => chats.push([id, name, message, ts]),
    onQueueChanged: (queue) => queues.push(queue),
    onUnknownFrame: (frame) => unknown.push(frame),
  });
  return { client, sent, chats, queues, states, unknown };
}

/** Minimal server-shape group_state (dict members, S416) carrying `queue`. */
function feedGroupState(h: Harness, queue: unknown): void {
  h.client.handleIncoming({
    type: SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
    protocol_version: 1,
    timestamp: 1788300111000,
    your_id: h.client.getMemberId(),
    group: {
      group_id: 'sp_1',
      group_name: 'Vector Group',
      member_count: 2,
      members: {
        alpha: { id: 'alpha', name: 'Alpha', is_host: true, joined_at: 1788300111 },
        me: { id: 'me', name: 'Tester', is_host: false, joined_at: 1788300111 },
      },
      host_id: 'alpha',
      current_media_id: 'media_42',
      current_media_duration: 3600000,
      playback_position: 90000,
      playback_state: 'playing',
      queue,
      created_at: 1788300111,
      last_activity_at: 1788300111,
    },
  });
}

/** :8097 broadcast bytes (SyncPlayManager.php:1323-1326 + Messages::frame). */
const SERVER_CHAT_FRAME = {
  type: 'syncplay_chat' as const,
  protocol_version: 1,
  member_id: 'beta',
  member_name: 'Beta',
  message: 'popcorn tonight?',
  timestamp: 1788300222137,
};

/** :8804 relay broadcast bytes (SyncPlayRelayWorker.php:1795-1799). */
const HUB_CHAT_FRAME = {
  type: 'syncplay_chat' as const,
  protocol_version: 1,
  member_id: 'hub-client-2',
  member_name: 'Remote Two',
  message: 'relay hello',
  timestamp: 1788300222137,
};

/** :8097 queue broadcast (SyncPlayManager.php:1271-1273, full items). */
const SERVER_QUEUE_FRAME = {
  type: 'syncplay_playback_queue' as const,
  protocol_version: 1,
  queue: [
    {
      media_id: 'media_43',
      media_info: { title: 'Queued Feature', kind: 'movie' },
      added_at: 1788300111,
      added_by: 'alpha',
    },
    {
      media_id: 'media_44',
      media_info: {},
      added_at: 1788300222,
      added_by: null,
    },
  ],
  timestamp: 1788300222137,
};

/** :8804 relay queue broadcast (SyncPlayRelayWorker.php:1763-1765, narrowed). */
const HUB_QUEUE_FRAME = {
  type: 'syncplay_playback_queue' as const,
  protocol_version: 1,
  queue: [
    { media_id: 'media_7', media_info: { title: 'Queued Relay Item' } },
    { media_id: 'media_8', media_info: {} },
  ],
  timestamp: 1788300222137,
};

describe('M-SYNCPLAY-11 — inbound syncplay_chat fires onChat', () => {
  it('a server-byte chat frame delivers id/name/text and the envelope ms timestamp', () => {
    const h = makeHarness();
    h.client.handleIncoming(SERVER_CHAT_FRAME);

    // RED before the fix: the CHAT arm was `break;` — the frame died there.
    expect(h.chats, 'syncplay_chat was silently ignored (M-SYNCPLAY-11)').toHaveLength(1);
    expect(h.chats[0]).toEqual(['beta', 'Beta', 'popcorn tonight?', 1788300222137]);
    // A canonical type must NEVER leak to the non-canonical hook.
    expect(h.unknown).toHaveLength(0);
  });

  it('the hub-carrier frame (same three broadcast keys) lands identically', () => {
    const h = makeHarness();
    h.client.handleIncoming(HUB_CHAT_FRAME);

    expect(h.chats).toHaveLength(1);
    expect(h.chats[0]).toEqual(['hub-client-2', 'Remote Two', 'relay hello', 1788300222137]);
  });

  it('the chat SELF-ECHO arrives — both carriers fan out including the sender (wire law)', () => {
    const h = makeHarness('me');
    // The broadcast the server sends BACK TO ME after my sendChat (no
    // exclusion list: SyncPlayManager.php:1932 default, chat call :1323
    // passes none; hub :1795 omits the exclusion).
    h.client.handleIncoming({ ...SERVER_CHAT_FRAME, member_id: 'me' });

    // The library suppresses NOTHING here — rendering from onChat only is
    // the documented consumer law (rationale: the unreconciled
    // ctor-vs-stamped identity, SPEC §9 / review M5 class).
    expect(h.chats).toHaveLength(1);
    expect(h.chats[0]![0]).toBe('me');
  });

  it('absent member_name coerces to the empty string — never an invented "Unknown"', () => {
    const h = makeHarness();
    // Hand-built frame omitting the adjacent name + envelope timestamp.
    // The server's 'Unknown' fallback (:1312) is RECORD-level law for
    // member lookups, not a wire value the library may fabricate.
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.CHAT,
      protocol_version: 1,
      member_id: 'beta',
      message: 'no name frame',
    });

    expect(h.chats).toHaveLength(1);
    expect(h.chats[0]).toEqual(['beta', '', 'no name frame', undefined]);
  });

  it('garbage chat frames are refused, not defaulted into visible UX (m1-class law)', () => {
    const h = makeHarness();
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.CHAT, protocol_version: 1, member_id: 'beta' });
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.CHAT, protocol_version: 1, message: 'orphan text' });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.CHAT,
      protocol_version: 1,
      member_id: 42,
      message: 'numeric speaker',
    });

    expect(h.chats).toHaveLength(0);
    expect(h.unknown).toHaveLength(0);
  });
});

describe('M-SYNCPLAY-11 — inbound syncplay_playback_queue fires onQueueChanged', () => {
  it('a server-byte queue broadcast delivers full four-field items verbatim', () => {
    const h = makeHarness();
    h.client.handleIncoming(SERVER_QUEUE_FRAME);

    // RED before the fix: the PLAYBACK_QUEUE arm shared the silent `break;`.
    expect(
      h.queues,
      'syncplay_playback_queue was silently ignored (M-SYNCPLAY-11)',
    ).toHaveLength(1);
    expect(h.queues[0]).toEqual([
      {
        media_id: 'media_43',
        media_info: { title: 'Queued Feature', kind: 'movie' },
        added_at: 1788300111,
        added_by: 'alpha',
      },
      { media_id: 'media_44', media_info: {}, added_at: 1788300222, added_by: null },
    ]);
    expect(h.unknown).toHaveLength(0);
  });

  it('hub-relay items keep per-carrier truth: media_id + media_info only, added_* absent', () => {
    const h = makeHarness();
    h.client.handleIncoming(HUB_QUEUE_FRAME);

    expect(h.queues[0]).toHaveLength(2);
    expect(h.queues[0]![0]).toEqual({ media_id: 'media_7', media_info: { title: 'Queued Relay Item' } });
    expect(h.queues[0]![0]!.added_at).toBeUndefined();
    expect(h.queues[0]![0]!.added_by).toBeUndefined();
    expect(h.queues[0]![1]!.media_info).toEqual({});
  });

  it('the broadcast FOLDS the cached group (next-up stays current) and does not re-fire onState', () => {
    const h = makeHarness();
    feedGroupState(h, [
      {
        media_id: 'media_OLD',
        media_info: { title: 'Outdated' },
        added_at: 1788300111,
        added_by: 'alpha',
      },
    ]);
    expect(h.client.getGroup()!.queue).toHaveLength(1);

    h.client.handleIncoming(SERVER_QUEUE_FRAME);

    // The host-change precedent (handleHostElect): mutate the model, fire the
    // dedicated event, do NOT re-fire onState (identity/members unchanged).
    expect(h.states).toHaveLength(1);
    expect(h.queues).toHaveLength(1);
    expect(h.client.getGroup()!.queue!.map((i) => i.media_id)).toEqual(['media_43', 'media_44']);
    // Nothing else about the group moved.
    expect(h.client.getGroup()!.playback_position).toBe(90000);
    expect(h.client.getGroup()!.host_id).toBe('alpha');
  });

  it('a CLEARED queue arrives as [] and still fires — [] and "no frame" never mix', () => {
    const h = makeHarness();
    feedGroupState(h, [
      { media_id: 'media_43', media_info: {}, added_at: 1788300111, added_by: 'alpha' },
    ]);
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE,
      protocol_version: 1,
      queue: [],
    });

    expect(h.queues).toHaveLength(1);
    expect(h.queues[0]).toEqual([]);
    expect(h.client.getGroup()!.queue).toEqual([]);
  });

  it('a frame whose queue is absent or not an array is dropped whole: no event, no fold, no hook', () => {
    const h = makeHarness();
    feedGroupState(h, [
      { media_id: 'media_43', media_info: {}, added_at: 1788300111, added_by: 'alpha' },
    ]);

    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE, protocol_version: 1 });
    h.client.handleIncoming({ type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE, protocol_version: 1, queue: 'garbage' });
    h.client.handleIncoming({
      type: SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE,
      protocol_version: 1,
      queue: { '0': { media_id: 'dict-shaped' } },
    });

    // handleGroupList precedent: a state report failing its real shape is
    // dropped — half-applied (or fabricated-empty) queue state makes next-up
    // UIs lie silently.
    expect(h.queues).toHaveLength(0);
    expect(h.unknown).toHaveLength(0);
    expect(h.client.getGroup()!.queue).toHaveLength(1);
    expect(h.client.getGroup()!.queue![0]!.media_id).toBe('media_43');
  });

  it('a queue frame outside a group still surfaces (wire truth) without a cached fold', () => {
    const h = makeHarness();
    h.client.handleIncoming(SERVER_QUEUE_FRAME);

    expect(h.queues).toHaveLength(1);
    expect(h.client.getGroup()).toBeNull();
  });
});

describe('M-SYNCPLAY-11 — sendChat / sendTyping reach the wire', () => {
  it('sendChat dispatches the Messages::chatMessage outbound shape inside the envelope', () => {
    const h = makeHarness();
    feedGroupState(h, []);
    h.client.sendChat('hello party');

    expect(h.sent).toHaveLength(1);
    // Outbound byte shape: phlix-server `Messages.php:564-574`
    // (group_id + self-asserted member_id + message) + framing envelope.
    expect(h.sent[0]).toEqual({
      group_id: 'sp_1',
      member_id: 'me',
      message: 'hello party',
      type: 'syncplay_chat',
      protocol_version: 1,
      timestamp: 1000,
    });
  });

  it('sendTyping dispatches the Messages::chatTyping shape with a real boolean', () => {
    const h = makeHarness();
    feedGroupState(h, []);
    h.client.sendTyping(true);
    h.client.sendTyping(false);

    expect(h.sent).toHaveLength(2);
    // `Messages.php:590-600`; producers accept `=== true` / legacy '1'
    // (SyncPlayManager.php:1375) — a real boolean passes cleanly.
    expect(h.sent[0]).toEqual({
      group_id: 'sp_1',
      member_id: 'me',
      is_typing: true,
      type: 'syncplay_typing',
      protocol_version: 1,
      timestamp: 1000,
    });
    expect(h.sent[1]!.is_typing).toBe(false);
  });

  it('both senders are no-ops outside a group (sendPlay precedent)', () => {
    const h = makeHarness();
    h.client.sendChat('shouted into the void');
    h.client.sendTyping(true);

    expect(h.sent).toHaveLength(0);
  });

  it('leaveGroup / onDisconnect leave nothing chat-related to leak — zero timers, stray frames still safe', () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      feedGroupState(h, []);
      h.client.sendChat('bye');
      h.client.leaveGroup();
      h.client.onDisconnect();

      // This cure owns NO timers (chat/queue handlers are synchronous folds +
      // dispatches; the library's one timer exception stays the sendSeek
      // flush). A stray broadcast after teardown must neither throw nor
      // resurrect state.
      expect(vi.getTimerCount()).toBe(0);
      expect(h.sent).toHaveLength(2); // sendChat + leaveGroup's own group_leave
      h.client.handleIncoming(SERVER_CHAT_FRAME);
      h.client.handleIncoming(SERVER_QUEUE_FRAME);
      expect(h.chats).toHaveLength(1);
      expect(h.queues).toHaveLength(1);
      expect(h.client.getGroup()).toBeNull();
      vi.advanceTimersByTime(10_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(h.sent).toHaveLength(2); // stray frames dispatch nothing post-teardown
    } finally {
      vi.useRealTimers();
    }
  });
});
