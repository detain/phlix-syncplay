/**
 * client.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

/**
 * SyncPlayClient — framework-agnostic orchestrator for the SyncPlay protocol.
 *
 * It owns:
 *  - the canonical message framing (encode/decode),
 *  - a {@link TimeSync} instance fed from time_pong responses,
 *  - the current group state derived from server group_state messages,
 *  - the host-only playback command senders (play/pause/seek/queue/host transfer)
 *    plus the `listGroups` request.
 *
 * It has NO dependency on WebSocket, Date, or any framework, and it schedules
 * NO PERIODIC timers. The transport `send` and the clock `now` are injected;
 * the consumer is responsible for opening the socket, calling
 * {@link handleIncoming} on each inbound frame, and scheduling periodic
 * {@link pingTime}/{@link reportPosition}.
 *
 * ONE documented exception (M-SYNCPLAY-09, README "Command repeat policy"):
 * while {@link SyncPlayClient.sendSeek} coalescing is enabled (the default),
 * the client owns at most ONE short ambient `setTimeout` flush timer at a
 * time. {@link SyncPlayClientOptions.seekThrottleMs}: 0 disables it and
 * restores a fully timer-free surface.
 *
 * This is the canonical surface that mobile / windows / tizen wrappers should
 * delegate to instead of re-implementing the protocol (and re-introducing the
 * historical divergences).
 */

import { decodeMessage, encodeMessage, type NowFn } from './framing';
import {
  isValidMessageType,
  PROTOCOL_VERSION,
  SYNCPLAY_MESSAGE_TYPES,
  type ChatBroadcastPayload,
  type ErrorPayload,
  type GroupListResponsePayload,
  type GroupListSummaryRow,
  type GroupStatePayload,
  type HostElectPayload,
  type HostTransferPayload,
  type InfoPayload,
  type PlaybackQueueItem,
  type PlaybackState,
  type PlaybackSyncNudge,
  type QueueBroadcastPayload,
  type RawMessage,
  type SyncPlayGroup,
  type SyncPlayMember,
  type SyncPlayMembersWire,
  type SyncPlayMessageType,
  type TimePongPayload,
  type TimeSyncPayload,
  type TimeSyncState,
  type TypingPayload,
  type UnknownFrame,
} from './messages';
import { MAX_ACCEPTABLE_RTT, TimeSync } from './time-sync';

/** A play/pause/seek command surfaced to the consumer for local application. */
export interface PlaybackCommand {
  type: 'play' | 'pause' | 'seek';
  /** Target position in ms (for seek this is `to_position`). */
  position: number;
  /**
   * Server-synchronized timestamp the command was issued at — ALWAYS ms
   * (wire stamps are normalized per carrier; see `SyncPlayClient.serverTimeToMs`).
   */
  serverTime: number;
}

/** Time-sync status surfaced after each accepted sample. */
export interface TimeSyncStatus {
  offset: number;
  latency: number;
  isStable: boolean;
}

/** Why {@link SyncPlayClientOptions.onFrameDropped} fired (CONSOLIDATED m5/m17). */
export type FrameDropReason = 'undecodable' | 'malformed' | 'send-failed';

/**
 * Constructor options. `send` and `now` are required; everything else is an
 * optional callback. `send` receives the RAW message object (already framed);
 * the consumer serializes and writes it to its transport.
 *
 * THROW LAW (CONSOLIDATED m17, review asphp MINOR-5): every callback here is
 * invoked straight — a consumer callback that throws mid-cascade can abort the
 * remaining events for one frame (roster left-events + `onState`) — so
 * callbacks MUST NOT throw. The one transport exception: a `send` throw inside
 * the coalesced-seek TIMER flush cannot surface to any caller (it would be an
 * uncaught `setTimeout` exception), so it is caught there and reported via
 * {@link SyncPlayClientOptions.onFrameDropped} as `'send-failed'`; every other
 * `send` path lets the sink's own throw propagate to the calling method.
 */
export interface SyncPlayClientOptions {
  /** Transport sink. Receives a framed RAW message object. */
  send: (_message: RawMessage) => void;
  /** Clock source (epoch ms). */
  now: NowFn;
  /**
   * The identity this client presents — AND the value the library matches
   * every server-stamped id against. **It MUST be the id the server derives
   * for this authenticated connection — never a fabricated string**
   * (SPEC §9; the coupling review `syncplay__gameux` M5 names as
   * undocumented, M-SYNCPLAY-12).
   *
   * Why two roles collapse into one value: the outbound `member_id` this
   * id stamps on frames is convenience/echo only — a correct server ignores
   * it for identity (phlix-server `SyncPlayManager.php` re-derives
   * everything from `$connection->getUserId()`; e.g. :1080 play, :1132
   * pause, :1178 seek, :1228 queue, :1321 chat, @c904aa4d).
   * But three LOCAL decisions compare this constructor value against
   * SERVER-STAMPED ids: {@link SyncPlayClient.isHost}
   * (`group.host_id === memberId`) and the play/pause/seek echo
   * suppressions (`msg.member_id === memberId` in `handlePlayback` /
   * `handleSeek`). The constructor id and the stamped id are therefore
   * REQUIRED to be the same identity for those decisions to function.
   *
   * What the server stamps, per carrier (both-sides verified):
   *  - Direct `:8097` (server WS + REST): the authenticated user id — the
   *    JWT subject. The create/join acks echo it as `your_id` on
   *    `syncplay_group_state` (`SyncPlayManager.php:1853`, `:1909` —
   *    `$connection->getUserId()`, @c904aa4d); REST mutations set
   *    `$memberId = $userId` from `$request->userId`
   *    (`SyncPlayController.php:173`, `:267`, `:305` @c904aa4d — S289
   *    "identity is the authenticated JWT subject ONLY"); rebroadcast
   *    commands carry the same derived sender id
   *    (`SyncPlayManager.php:1108-1117` play, `:1206-1211` seek, @c904aa4d).
   *    The consumer knows this id BEFORE dialing — it is what the login /
   *    auth layer holds.
   *  - Hub relay `:8804`: a hub-generated PER-CONNECTION uuid
   *    (phlix-hub `SyncPlayRelayWorker.php:694`, `generateClientId()`
   *    `:2766-2779` @8913ae11), surfaced as `your_id` on the join ack
   *    (`:2059-2061`) and used as `member_id`/`host_id` on every later
   *    frame (`:1954` host_id, `:2186` member_id). It is NOT knowable
   *    before the first `group_state` —
   *    adopt it from `onState`'s `yourId` (the mobile wrapper reconciles
   *    exactly this way: `your_id` is "authoritative for host comparisons",
   *    ctor id is "only the pre-join placeholder claim" — phlix-mobile-client
   *    `src/syncplay/SyncPlayService.ts`, audit H4). On this carrier the
   *    ctor value cannot match the stamped id by construction: until the
   *    adopted id is installed (rebuild the client, or gate host UX on
   *    `group.host_id === yourId` from `onState`), `isHost()` and the
   *    suppressions below are inert — that is the documented cost, not a
   *    silent one.
   *
   * Mismatch failure UX — the estate's "dead-host bug", named precisely
   * (mobile shipped a fabricated `memberId: 'mobile_*'` for exactly this):
   *  1. `isHost()` is permanently FALSE even when this connection IS the
   *     host: host-only controls in the UI go inert, although the server
   *     (authorizing by connection, SPEC §9 item 2) would accept every
   *     command the library sends regardless.
   *  2. Self-echo suppression goes dead the OTHER way: the host's own
   *     echoed play/pause/seek frames arrive stamped with the SERVER id,
   *     fail the `=== memberId` test, and are applied a SECOND time as if
   *     they came from a peer (double-apply loops). A mismatched member
   *     likewise sees its own commands echo as foreign.
   */
  memberId: string;
  /**
   * This client's display name (sent on create/join). Defaults to `'Host'`
   * when omitted (changed from `'User'`, owner ruling 2026-11-13; it applies
   * to joiners too, so pass a real name when joining).
   */
  memberName?: string;

  /**
   * Command-repeat protection for {@link SyncPlayClient.sendSeek} — a
   * leading + trailing COALESCING throttle window in ms
   * (M-SYNCPLAY-09, review `syncplay__gameux` M2).
   *
   * Why the library owns this: the server absorbs ZERO key-repeat spam — its
   * only WebSocket limiter guards the CONNECT handshake (30/60s, phlix-server
   * `RateLimitProfiles.php::WS_CONNECT`), its `JoinPasswordThrottle` guards
   * wrong group passwords only, and its `queue_limit_exceeded`
   * (`SyncPlayManager.php:1256`) caps media-QUEUE depth, not command rate —
   * while `handleSeek` rebroadcasts EVERY `syncplay_playback_seek` frame to
   * the whole group (`SyncPlayManager.php:1182`). A TV remote key-repeats at
   * 10–30 events/s, so each un-coalesced hold = 10-30 full player seeks
   * (HLS segment reload, buffer stall) per second on every screen in the room.
   *
   * Semantics (default 250 ms): the FIRST call of a burst dispatches
   * SYNCHRONOUSLY (leading edge — single-press UX stays byte-identical to the
   * unthrottled path, so every existing consumer call pattern keeps working
   * unchanged); repeats within the window are merged LATEST-WINS (an
   * intermediate seek target is meaningless — only the last position matters),
   * and exactly ONE trailing frame carrying the last target flushes when the
   * window closes. A sustained hold is capped at one frame per window.
   *
   * `0` is the documented escape hatch: pure passthrough — every call
   * dispatches synchronously and this library schedules no timers at all.
   * Negative or non-finite values throw a `TypeError` at construction
   * (parse-don't-validate at the options boundary). Must be a finite number
   * in [0, 2147483647].
   */
  seekThrottleMs?: number;

  /**
   * Every accepted `syncplay_group_state` (create/join ack and each later
   * state broadcast). `yourId` is the payload's `your_id` — the identity
   * THE SERVER stamped for THIS authenticated connection (SPEC §9; per
   * carrier see {@link SyncPlayClientOptions.memberId}). The library
   * SURFACES it and reconciles nothing (the ctor id is immutable by
   * design): consumers MUST compare `yourId === getMemberId()` and treat a
   * mismatch as the ghost-identity class documented on
   * {@link SyncPlayClientOptions.memberId} — `undefined` only on hand-built
   * frames that omitted the field; real producers always stamp it
   * (phlix-server `SyncPlayManager.php:1799`/`:1855`, phlix-hub
   * `SyncPlayRelayWorker.php:1490`).
   */
  onState?: (_group: SyncPlayGroup, yourId: string | undefined) => void;
  onSync?: (_status: TimeSyncStatus) => void;
  /**
   * A matched pong completed its round trip but the sample was REJECTED: by
   * the NTP window (`rtt < 0 || rtt > MAX_ACCEPTABLE_RTT`, SPEC §5), or
   * because the pong carries no usable server_time at all — absent or
   * non-finite t2 measures nothing and now counts as a rejection too
   * (LW-043, review `syncplay__asphp` #3; it used to return in silence).
   * Pre-fix every rejection was silent: a distant member (cellular /
   * intercontinental RTT against a home server, realistic at
   * `MAX_ACCEPTABLE_RTT = 1000`) watched `isStable()` sit `false` forever
   * with no signal to explain it (W-min124 M-SYNCPLAY-14, review
   * `syncplay__gameux` m3). Fires per rejection with the CURRENT
   * consecutive-rejection streak; any accepted sample resets the streak to 0
   * and fires nothing, and {@link SyncPlayClient.onDisconnect}
   * resets it as well — the streak is per-connection measurement history
   * (LW-043): the fresh connection after a reconnect starts honest at zero.
   * {@link SyncPlayClient.destroy} does NOT reset it (every reader sits
   * behind the terminal latch, so a reset there would be unreadable). The
   * library deliberately picks no "degraded" threshold — after N rejections
   * is consumer policy (spinner copy, retry pacing, transport hint).
   * Observes what was already true at the boundary; changes no sync math.
   */
  onSyncDegraded?: (_consecutiveRejections: number) => void;
  onPlaybackCommand?: (_command: PlaybackCommand) => void;
  onMemberJoined?: (_member: { id: string; name: string }) => void;
  /**
   * A member that was in the cached roster of the SAME room is absent from the
   * `group_state` roster just folded (W-min124 M-SYNCPLAY-16, review
   * `syncplay__gameux` m5). Symmetric counterpart of {@link onMemberJoined},
   * closing the "Sam left the party" gap embedders previously hand-rolled with
   * their own set diffs on four platforms. SPEC §6 wire law: a plain leave
   * emits no dedicated frame — membership changes ride the next
   * `syncplay_group_state` — so this diff IS the leave signal, and the
   * join half is deliberately NOT diffed here (joins already arrive as INFO
   * frames; diffing them too would double-announce the same member).
   * Room switches fire nothing: the old roster belonged to the room being
   * left, not to this one.
   */
  onMemberLeft?: (_member: { id: string; name: string }) => void;
  onHostChanged?: (_newHostId: string | null) => void;
  /**
   * A server error frame. `_details` carries the frame's optional `details`
   * object verbatim (CONSOLIDATED m9, review casualgamer Minor 7 — the
   * structured "by how much / what limit" context used to die at this
   * boundary). `undefined` when the frame carried none or the value was not a
   * plain object (drop-the-garbage law; an array reads as garbage).
   * `_code` is typed `string` on the wire-tolerance law (see
   * `ErrorPayload.error_code`); the advertised names are the
   * {@link SyncPlayErrorCode} union re-exported from `messages.ts`
   * (LW-081) — consumers may narrow with it, but `handleError`'s `'UNKNOWN'`
   * fallback sentinel stays outside the union by design.
   */
  onError?: (
    _code: string,
    _message: string,
    _details?: Record<string, unknown>,
  ) => void;
  onInfo?: (_message: string) => void;
  /** A member started or stopped typing (`TYPING` in `SYNCPLAY_MESSAGE_TYPES`
   *  — wire value `syncplay_typing`; the phlix-server constant is
   *  `Messages::TYPE_CHAT_TYPING`).
   *  Unlike chat, this fan-out EXCLUDES the sender on both carriers (phlix-server
   *  `SyncPlayManager.php:1377-1380` passes `[$memberId]`; hub
   *  `SyncPlayRelayWorker.php:1825-1828` passes `$client->clientId`), so your own
   *  indicator never echoes back here. */
  onMemberTyping?: (_memberId: string, isTyping: boolean) => void;
  /**
   * A chat message from a group member (TYPE_CHAT_MESSAGE / syncplay_chat),
   * delivered per the PRODUCER BYTES of the broadcast — wire sites, the S289
   * identity law and the silent-blank rule are documented on
   * {@link ChatBroadcastPayload}. (M-SYNCPLAY-11: before this callback existed
   * the frame hit a silent-ignore arm, so the library shipped "Bob is
   * typing…" without any way for Bob's message to arrive through the public
   * API.)
   *
   * SELF-ECHO ARRIVES — this is wire law, not a leak: both carriers fan chat
   * out INCLUDING the sender (server `broadcastToGroup` default
   * `$excludeIds = []`, `SyncPlayManager.php:1932`, chat call passes none
   * :1323; hub call omits the exclusion, `SyncPlayRelayWorker.php:1795`).
   * The library deliberately does NOT suppress the echo here: command-echo
   * suppression keys on ctor-`memberId` vs stamped id, and that identity is
   * UNRECONCILED (SPEC §9; the review-M5 class — a fabricated ctor id would
   * make a peer's message look like your echo, or your echo look foreign).
   * Consumers render chat from THIS callback only (do not also locally
   * append on {@link SyncPlayClient.sendChat}) and are correct on both
   * carriers by construction.
   *
   * `_timestampMs` is the envelope `timestamp` — the server's send time,
   * authoritative MILLISECONDS on both carriers (S417;
   * `Messages.php:924-927`, `SyncPlayRelayWorker.php:1230`). `undefined`
   * only on hand-built frames that omitted it; the library never fabricates
   * a send time.
   */
  onChat?: (
    _memberId: string,
    memberName: string,
    message: string,
    _timestampMs?: number,
  ) => void;
  /**
   * The group host transferred to another member (TYPE_HOST_TRANSFER /
   * syncplay_host_transfer). DEFENSIVE-ONLY arm: §3 types the frame
   * client → server, and no live producer emits it inbound — the server's
   * `handleHostTransfer` answers with a broadcast `syncplay_group_state` and
   * the hub announces via `syncplay_host_elect` + state. The handler is kept
   * in case a producer ever appears; build transfer UX on `onState` /
   * `onHostChanged` instead (SPEC §3/§4).
   */
  onHostTransfer?: (_currentHostId: string, _newHostId: string) => void;
  /**
   * Periodic playback position sync from a group member (TYPE_PLAYBACK_SYNC /
   * syncplay_playback_sync). Includes this client's own echo when it is the host
   * (the server re-broadcasts the host's frame to every member — the host
   * re-anchor source, see handlePlaybackSync).
   *
   * `_serverTime` is ALWAYS milliseconds: the wire mixes units per carrier
   * (`:8097` stamps UNIX seconds, the hub relay stamps ms) and the decode
   * boundary normalizes via `SyncPlayClient.serverTimeToMs` (SPEC §4/§8.4).
   *
   * `nudge` (M-SYNCPLAY-08) is the S446 soft-desync correction object riding
   * the SAME frame family: defined only on the directed out-of-sync frame the
   * `:8097` server unicasts to the drifting member (phlix-server
   * `SyncPlayManager.php:1569-1585` — its own echo and every hub-relay frame
   * leave it `undefined`, absent ≠ zeroed, SPEC §4/§8.4). On a directed frame
   * `_memberId` is THIS client's id and the four state args carry the same
   * authoritative group state as the echo; apply `nudge.suggested_rate`
   * instead of seeking (the server's "nudge, never seek" policy).
   */
  onPlaybackSync?: (
    _memberId: string,
    position: number,
    isPlaying: boolean,
    _serverTime: number,
    nudge?: PlaybackSyncNudge,
  ) => void;
  /**
   * Advisory server sync-state snapshot (TYPE_TIME_SYNC / syncplay_time_sync):
   * the server's UNICAST reply to a `syncplay_time_sync` request. Units are
   * named per-field — `serverTimeSec` is UNIX seconds (the `:8097` seconds
   * quirk), `offsetMs`/`latencyMs` are ms. Server wire truth:
   * `SyncPlayManager.php:1650-1658`. The pre-fix `(serverTime, clientTime)`
   * signature modeled a fabricated frame: the live wire carries no
   * `client_time`, so consumers silently received a defaulted `0`.
   */
  onTimeSync?: (_state: TimeSyncState) => void;
  /**
   * Group list enumeration reply (TYPE_GROUP_LIST / syncplay_group_list).
   * Rows carry the LIVE producer summary shape — `id`/`name`/`member_count`/
   * `has_password`/`current_media`/`is_playing` (SPEC §4 group_list reply;
   * `GroupListSummaryRow`). The previous invented `{group_id, group_name}`
   * spelling matched no wire byte and handed consumers silent `''`s.
   */
  onGroupList?: (_groups: GroupListSummaryRow[]) => void;
  /**
   * The group's playback queue was REPLACED wholesale
   * (PLAYBACK_QUEUE / syncplay_playback_queue broadcast). Producer bytes and
   * the per-carrier item law (`:8097` full four-field items vs hub-relay
   * items narrowed to `media_id` + `media_info`) are documented on
   * {@link QueueBroadcastPayload}. (M-SYNCPLAY-11: the frame used to hit a
   * silent-ignore arm although SPEC §4 promised "verbatim getState()" queue
   * currency — and the server does NOT rebroadcast `group_state` after a
   * queue update (`SyncPlayManager.php:1271-1278` broadcasts + publishes an
   * internal HTTP snapshot only), so before this callback a next-up UI had
   * either to re-poll or to sniff raw frames around `handleIncoming` — the
   * divergence economy this package exists to abolish.)
   *
   * Delivery model (host-change precedent, `handleHostElect`): the library
   * folds the new queue into the cached group — `getGroup().queue` stays
   * true afterwards — and fires THIS callback; it does NOT re-fire
   * `onState`, because the group identity/members did not change. A cleared
   * queue arrives as `[]` (the producers emit the key always, possibly
   * empty); `[]` and "no frame" are never conflated. Fan-out includes the
   * host, so the sender sees its own accepted update (no suppression — the
   * onChat rationale applies verbatim). Refusals never reach here: an
   * over-cap or non-host submission is answered with an error frame
   * (`syncplay.queue_limit_exceeded` :1253-1263 / `NOT_HOST` :1219, hub
   * `SyncPlayRelayWorker.php:1707` / overflow :1748-1757) and arrives via `onError`, with the
   * live queue left UNTOUCHED.
   */
  onQueueChanged?: (_queue: PlaybackQueueItem[]) => void;
  /**
   * Extension point for non-SyncPlay vocabulary. This library owns ONLY the 19
   * canonical `syncplay_*` types; frames whose type is NOT one of them (e.g.
   * the hub relay's `pending_command`) reach this hook — untouched, no
   * validation, no mutation. The hook ALSO carries the four canonical types
   * that have no inbound case in the dispatcher — `syncplay_group_create`,
   * `syncplay_group_join`, `syncplay_group_leave`, `syncplay_time_ping`:
   * neither carrier emits them inbound, but echoes or off-dialect frames
   * arriving with one of these types are surfaced here as unknown-to-this-
   * client instead of dropped (the default-arm law in `handleIncoming`). The
   * two canonical types that used to be named here as "carried but not
   * orchestrated" — syncplay_chat, syncplay_playback_queue — are ORCHESTRATED
   * since M-SYNCPLAY-11 (they fire {@link SyncPlayClientOptions.onChat} /
   * {@link SyncPlayClientOptions.onQueueChanged}); they still NEVER reach this
   * hook. Consumers route non-SyncPlay vocabulary through it and the library
   * stays protocol-pure.
   */
  onUnknownFrame?: (_frame: UnknownFrame) => void;
  /**
   * CONSOLIDATED m5 (review casualgamer Minor 2): inbound frames the decoder
   * rejects or a handler refuses for garbage fire here instead of vanishing —
   * the "your play didn't start and nothing says so" class.
   *  - `'undecodable'` — {@link decodeMessage} returned null (bad JSON,
   *    non-object, missing string `type`); `_frame` is the raw inbound value.
   *  - `'malformed'` — a canonical frame a handler refused for garbage
   *    (missing/non-finite/negative position, non-string ids, non-object
   *    `group`, non-array `queue`/`groups`) or an unimplementable
   *    `protocol_version` — non-integer or above what this decoder
   *    implements (LW-049; absent/stale integers fall through like the
   *    server's arms do); `_frame` is the decoded message.
   *  - `'send-failed'` — the coalesced-seek timer flush threw at the
   *    consumer `send` sink (browser throws on a CLOSED socket mid-window;
   *    CONSOLIDATED m17); `_frame` is null (the wire frame was never built).
   * Protocol drops BY DESIGN (late/mismatched `time_pong`, self-echo
   * suppression, room-change seek cancellation) do NOT fire here — this hook
   * observes garbage, not law.
   */
  onFrameDropped?: (_reason: FrameDropReason, _frame: unknown) => void;
  /**
   * Invoked by {@link SyncPlayClient.onDisconnect} after the client's transient
   * state has been cleared, so the consumer can update its UI (e.g. show a
   * "reconnecting…" indicator). This library owns no socket; the consumer calls
   * {@link SyncPlayClient.onDisconnect} from its transport's close/error path.
   */
  onDisconnect?: () => void;
}

/**
 * Default {@link SyncPlayClientOptions.seekThrottleMs} window (M-SYNCPLAY-09).
 * 250 ms caps a held TV-remote seek at 4 frames/s — comfortably below the
 * 10–30 events/s raw key-repeat rate, comfortably above human single-intent
 * spacing — while the leading edge keeps the first press felt instant.
 */
const DEFAULT_SEEK_THROTTLE_MS = 250;

export class SyncPlayClient {
  private readonly send: (_message: RawMessage) => void;
  private readonly now: NowFn;
  private readonly memberId: string;
  private readonly memberName: string;
  private readonly options: SyncPlayClientOptions;
  private readonly timeSync: TimeSync;
  /** Coalescing window for sendSeek, ms; 0 = off (passthrough, timer-free). */
  private readonly seekThrottleMs: number;
  /** True while a coalescing window is open (a trailing flush timer is armed). */
  private seekWindowOpen = false;
  /** The LAST (from,to) pair seen during the open window — latest-wins merge. */
  private pendingSeek: { from: number; to: number } | null = null;
  /** The single owned flush timer (present only while {@link seekWindowOpen}). */
  private seekFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private group: SyncPlayGroup | null = null;
  /**
   * LW-046: latch set by {@link SyncPlayClient.destroy}. The m18 docblock
   * already promised INERTY — this is the field that makes it true: inbound
   * routing, the void senders and the coalescer re-arm all consult it, and
   * the instance owns no timers past `destroy()` even when a `send` sink
   * re-enters the class mid-dispatch.
   */
  private destroyed = false;
  /** Local t1 of the most recent outstanding ping, ms. */
  private lastPingSendTime: number | null = null;
  /** SPY-S7: connection generation; bumped by onDisconnect. */
  private connectionEpoch = 0;
  /** SPY-S7: the generation `lastPingSendTime` was stamped in. */
  private pingEpoch = 0;
  /**
   * M-SYNCPLAY-14: consecutive REJECTED (but matched-consumed) time-sync
   * rounds — RTT-window rejections and no-usable-server_time rounds
   * (LW-043); reset by any accepted sample and by the sanctioned per-
   * connection teardown (`onDisconnect` — the streak is measurement history
   * of ONE connection). `destroy()` does NOT reset it: post-LW-046 every
   * reader sits behind the terminal latch, so a reset there was writing
   * history no one could ever read (w11 L10 re-review: the line was retired
   * dead state — the review's executed deletion probe kept the full battery
   * 425/425 green). Feeds `onSyncDegraded` so silence at the sync boundary
   * becomes observable.
   */
  private consecutiveSyncRejections = 0;

  constructor(options: SyncPlayClientOptions) {
    this.options = options;
    this.send = options.send;
    this.now = options.now;
    this.memberId = options.memberId;
    this.memberName = options.memberName ?? 'Host';
    this.timeSync = new TimeSync(options.now);
    this.seekThrottleMs = SyncPlayClient.parseSeekThrottleMs(options.seekThrottleMs);
  }

  /**
   * Parse the seek-throttle window at the constructor boundary: accepted
   * domain = a finite number ≥ 0 (0 = off). Anything else is a
   * misconfiguration that must halt, not a value to silently re-default —
   * a consumer that asked for throttling and got a different number would
   * be tuning against a phantom.
   */
  private static parseSeekThrottleMs(raw: number | undefined): number {
    if (raw === undefined) {
      return DEFAULT_SEEK_THROTTLE_MS;
    }
    // SPY-15: ceiling = 2^31-1 ms — setTimeout coerces larger delays to 1ms
    // (a tight loop instead of a throttle), so refuse them at the boundary.
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 2147483647) {
      throw new TypeError(
        `SyncPlayClient: seekThrottleMs must be a finite number in [0, 2147483647] ` +
          `(0 disables the seek coalescing throttle), got ${String(raw)}`,
      );
    }
    return raw;
  }

  /**
   * LW-045 (review syncplay__secnet): parse the group-gate password hash at
   * the call boundary. Accepted domain = undefined (no password) or the
   * CANONICAL wire form: 64 lowercase hex chars. This is deliberately
   * STRICTER-THAN-SERVER local validation, not a mirrored wire law — the
   * authority, read at phlix-server tip `4a30962600`
   * (`SyncPlayManager::groupPasswordGate` :2238-2250), `strtolower`s the raw
   * value BEFORE matching `/^([0-9a-f]{64})$/` and compares with
   * `hash_equals` against the lowercase store: an uppercase 64-hex copy
   * case-folds and DOES authenticate on `:8097` (`openssl dgst` prints
   * lowercase in the first place — the pre-wave parenthetical here was
   * doubly wrong; forward-corrected in CHANGELOG, never edited in place).
   * The refusal of non-canonical shapes (uppercase, short, long, non-hex,
   * a plaintext password mis-passed) stands as fail-fast law: canonical
   * form is lowercase and this library never ships a value it had to
   * normalize to admit — but the law it enforces is LOCAL. Anything
   * present-but-malformed THROWS; nothing is silently shipped or coerced.
   * The message reports only shape facts (typeof; length for strings —
   * never a coercion of unknown garbage): a mis-passed plaintext secret
   * must not be echoed into logs.
   */
  private static parsePasswordHash(raw: string | undefined): string | undefined {
    if (raw === undefined) {
      return undefined;
    }
    if (typeof raw !== 'string' || !/^([0-9a-f]{64})$/.test(raw)) {
      // Coercion-safe refusal (w11 L10 re-review): the message builder runs
      // on values the TYPE forbids and must not crash — or fabricate — while
      // composing its own text. `String(raw)` throws on uncoercible garbage
      // (e.g. `Object.create(null)`: an engine TypeError would silently
      // replace this curated message), and on a symbol it renders
      // "Symbol(desc)" — reporting the length OF THAT RENDERING is a
      // fabricated shape fact. Length is a property of strings, so only the
      // string arm states it; every other runtime value is disclosed by
      // typeof alone, never coerced.
      // SPY-14: the string arm no longer states its length either — a
      // near-miss credential's length is a secret-shape fact; typeof only.
      throw new TypeError(
        'SyncPlayClient: passwordHash must be undefined or 64 lowercase hex ' +
          'characters (unsalted SHA-256 hex; SPEC §4/§8.2, canonical form of ' +
          'the server gate SyncPlayManager::groupPasswordGate) — this library ' +
          'ships canonical form only: a present-but-malformed value is ' +
          'refused as a local fail-fast (stricter than the server, whose gate ' +
          'case-folds before matching) and is never shipped or coerced. Got a ' +
          `${typeof raw}.`,
      );
    }
    return raw;
  }

  /**
   * SPY-16: outbound position guard (mirror of the inbound finite law) —
   * a position that is not a finite number >= 0 is a caller bug that would
   * serialize to `null` (NaN/Infinity) or a negative on the wire. Throw
   * before any state change or dispatch.
   */
  private static assertPosition(name: string, value: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(
        `SyncPlayClient: ${name} must be a finite number >= 0, got ${typeof value === 'number' ? String(value) : typeof value}`,
      );
    }
  }

  // --- Accessors -----------------------------------------------------------

  /** The TimeSync instance (for status/offset queries). */
  getTimeSync(): TimeSync {
    return this.timeSync;
  }

  /** The current group, or null if not in one. */
  getGroup(): SyncPlayGroup | null {
    return this.group;
  }

  /** This member's id. */
  getMemberId(): string {
    return this.memberId;
  }

  /**
   * True if this member is the current host of the current group — i.e.
   * `group.host_id === this.memberId`, the server-stamped host against the
   * CONSTRUCTOR id. Sound only under the identity coupling documented on
   * {@link SyncPlayClientOptions.memberId}: with a fabricated/mismatched
   * ctor id this is permanently false for a true host (the dead-host bug
   * class, SPEC §9). Server truth: `host_id` is always the derived id
   * (`SyncPlayManager.php` groups key members by `$connection->getUserId()`;
   * hub rooms key by `$client->clientId`, `SyncPlayRelayWorker.php:1396`).
   */
  isHost(): boolean {
    return this.group !== null && this.group.host_id === this.memberId;
  }

  /** Server-synchronized current time (ms). */
  getSynchronizedTime(): number {
    return this.timeSync.getSynchronizedTime(this.now());
  }

  // --- Group management ----------------------------------------------------

  /**
   * Create a group with this member as host. `passwordHash` is SHA-256 hex.
   *
   * SECURITY (see SPEC §8/§9): the `member_id` placed on this frame is
   * **self-asserted** (from the constructor `memberId`) and MUST NOT be trusted
   * for authorization. A correct server derives the effective member/host id
   * from the authenticated connection and ignores the client-supplied value for
   * access control. `passwordHash` is an unsalted, **replayable** SHA-256 group
   * gate — not an identity. The server MUST authenticate the connection before
   * accepting this frame.
   */
  createGroup(groupName: string, passwordHash?: string): void {
    // LW-045: parse (THROWS on malformed) BEFORE any other work — an invalid
    // argument is a caller bug on every lifecycle path. LW-046: a destroyed
    // instance is inert and ships nothing.
    const parsed = SyncPlayClient.parsePasswordHash(passwordHash);
    if (this.destroyed) {
      return;
    }
    const payload: Record<string, unknown> = {
      group_name: groupName,
      member_id: this.memberId,
      member_name: this.memberName,
    };
    if (parsed !== undefined) {
      payload.password_hash = parsed;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE, payload);
  }

  /**
   * Join an existing group by id. `passwordHash` is SHA-256 hex.
   *
   * SECURITY (see SPEC §8/§9): the `member_id` on this frame is **self-asserted**
   * and MUST NOT be trusted for authorization — the server derives the effective
   * id from the authenticated connection. `passwordHash` is an unsalted,
   * **replayable** SHA-256 group gate, not an identity.
   */
  joinGroup(groupId: string, passwordHash?: string): void {
    // LW-045 / LW-046: same parse-before-lifecycle law as {@link createGroup}.
    const parsed = SyncPlayClient.parsePasswordHash(passwordHash);
    if (this.destroyed) {
      return;
    }
    const payload: Record<string, unknown> = {
      group_id: groupId,
      member_id: this.memberId,
      member_name: this.memberName,
    };
    if (parsed !== undefined) {
      payload.password_hash = parsed;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN, payload);
  }

  /**
   * Leave the current group. Returns whether the LEAVE frame actually
   * dispatched — `false` with no cached group (CONSOLIDATED m4: the silent
   * void no-op gave wrappers no way to show "still joining").
   */
  leaveGroup(): boolean {
    if (this.group === null) {
      return false;
    }
    // A coalesced seek that never shipped belongs to the room we are leaving.
    this.cancelSeekCoalescing();
    // SPY-5: unwind BEFORE the send — a throwing sink (closed socket) must not
    // leave the stale group cached; the caller left either way.
    const groupId = this.group.group_id;
    this.group = null;
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE, {
      group_id: groupId,
      member_id: this.memberId,
    });
    return true;
  }

  // --- Playback ------------------------------------------------------------
  //
  // Roster truth (SPEC §9 item 2 / §9.1): the producers NOT_HOST-gate play,
  // pause, seek, queue and host_transfer to the current host. sendPlay/
  // sendPause/sendSeek below are those host commands; reportPosition's
  // PLAYBACK_SYNC frame is NOT on that roster — it is a member-permitted
  // STATE REPORT any authenticated group member may send on both carriers.
  //
  // SECURITY (see SPEC §9): every playback sender below stamps the frame with
  // this client's self-asserted `member_id`. The server MUST authorize the
  // action by the *authenticated connection's* identity (not by the claimed
  // `member_id`) and MUST overwrite the sender id with the authenticated one
  // before rebroadcasting. The echo-suppression in handlePlayback/handleSeek
  // relies on that server-set sender id.

  /**
   * Host command: play at `position` (ms). Returns whether the frame
   * dispatched — `false` with no cached group. The same boolean law covers
   * {@link sendPause}, {@link sendSeek}, {@link reportPosition},
   * {@link sendChat}, {@link sendTyping} and {@link leaveGroup}
   * (CONSOLIDATED m4): "accepted for sending" must be observable, silence is
   * not. `true` means the library handed the frame to the `send` sink, not
   * that the server accepted it — the receipt story is the echo/error lane.
   *
   * @throws TypeError on non-finite or negative position
   */
  sendPlay(position: number): boolean {
    SyncPlayClient.assertPosition('position', position);
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      position,
      server_time: this.getSynchronizedTime(),
    });
    return true;
  }

  /**
   * Host command: pause at `position` (ms). Boolean law per {@link sendPlay}.
   *
   * @throws TypeError on non-finite or negative position
   */
  sendPause(position: number): boolean {
    SyncPlayClient.assertPosition('position', position);
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      position,
      server_time: this.getSynchronizedTime(),
    });
    return true;
  }

  /**
   * Send a seek command, coalesced against key-repeat by the
   * {@link SyncPlayClientOptions.seekThrottleMs} throttle (leading + trailing,
   * latest-wins — see the option's docblock for the full stance).
   *
   * With the throttle OFF (`seekThrottleMs: 0`) this is the original bare
   * dispatch: every call ships one frame synchronously. WITH it on, the first
   * call of a burst ships synchronously and repeats merge into a single
   * trailing frame at the window's close — the wire never sees an
   * intermediate target.
   *
   * Returns whether the intent was ACCEPTED for the wire — `false` with no
   * cached group; `true` both when a frame dispatched synchronously and when
   * the call merged latest-wins into an open window (CONSOLIDATED m4). The
   * one lossy path left is the timer flush whose group vanished (defensive
   * arm in `closeSeekWindow`) or whose `send` threw (guarded —
   * `'send-failed'` on {@link SyncPlayClientOptions.onFrameDropped}).
   *
   * @throws TypeError on non-finite or negative position
   */
  sendSeek(fromPosition: number, toPosition: number): boolean {
    SyncPlayClient.assertPosition('fromPosition', fromPosition);
    SyncPlayClient.assertPosition('toPosition', toPosition);
    if (this.group === null) {
      return false;
    }
    if (this.seekWindowOpen) {
      // Latest-wins: replace the pending target; intermediate seeks are
      // meaningless, so nothing else from the burst survives.
      this.pendingSeek = { from: fromPosition, to: toPosition };
      return true;
    }
    this.dispatchSeek(fromPosition, toPosition);
    // LW-046 (review asphp #6): a `send` sink that re-enters sendSeek during
    // the synchronous dispatch above has ALREADY opened the window — opening
    // unconditionally here overwrote its handle, orphaning a timer that
    // `cancelSeekCoalescing` could never clear. Open only if we still own none.
    if (this.seekThrottleMs > 0 && !this.seekWindowOpen) {
      this.openSeekWindow();
    }
    return true;
  }

  /** The single PLAYBACK_SEEK wire point — leading and trailing edges share it. */
  private dispatchSeek(fromPosition: number, toPosition: number): void {
    if (this.group === null) {
      return;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      from_position: fromPosition,
      to_position: toPosition,
      server_time: this.getSynchronizedTime(),
    });
  }

  /** Arm the window's trailing flush. This is the library's ONLY owned timer. */
  private openSeekWindow(): void {
    this.seekWindowOpen = true;
    this.seekFlushTimer = setTimeout(() => {
      // CONSOLIDATED m17 (review asphp MINOR-5): browsers THROW from `send`
      // on a CLOSED socket, and this call sits on a bare timer — an escaped
      // throw would surface as an uncaught `setTimeout` exception. Catch it
      // and report the loss through the garbage-observability seam. State is
      // already unwound by `closeSeekWindow` before the dispatch attempt
      // (window closed, pending cleared), and the failed re-arm leaves the
      // instance timer-free — a later sendSeek simply opens a fresh window.
      try {
        this.closeSeekWindow();
      } catch {
        // SPY-20: the report seam is consumer code on a bare timer — a throw
        // from it must not escape as an uncaught setTimeout exception.
        try {
          this.options.onFrameDropped?.('send-failed', null);
        } catch {
          // swallowed by design: nowhere left to report.
        }
      }
    }, this.seekThrottleMs);
  }

  /**
   * Window boundary: flush the latest coalesced target as ONE trailing frame
   * and immediately re-arm (a continued hold is then rate-capped at one frame
   * per window); with nothing pending, close cleanly and own no timer.
   */
  private closeSeekWindow(): void {
    this.seekWindowOpen = false;
    this.seekFlushTimer = null;
    const pending = this.pendingSeek;
    if (pending === null) {
      return;
    }
    this.pendingSeek = null;
    if (this.group === null) {
      // Defensive: leaveGroup/onDisconnect cancel the window eagerly, so a
      // vanished group here means a future nulling path forgot to; drop the
      // stale intent rather than send it into nothing.
      return;
    }
    this.dispatchSeek(pending.from, pending.to);
    // LW-046: the dispatch above runs consumer code. If a re-entrant sendSeek
    // already opened a fresh window, or the sink destroyed/left the client
    // (destroy(), onDisconnect() — both null the group), re-arming here would
    // own a timer on an instance that promised zero. Re-arm only when the
    // client is still alive, grouped, and owns no window.
    if (!this.destroyed && this.group !== null && this.seekThrottleMs > 0 && !this.seekWindowOpen) {
      this.openSeekWindow();
    }
  }

  /** Drop any coalesced intent and disarm the window (leave/disconnect). */
  private cancelSeekCoalescing(): void {
    this.pendingSeek = null;
    if (this.seekFlushTimer !== null) {
      clearTimeout(this.seekFlushTimer);
      this.seekFlushTimer = null;
    }
    this.seekWindowOpen = false;
  }

  /**
   * Periodic position report (PLAYBACK_SYNC).
   *
   * Member-permitted on both producers — no `NOT_HOST` gate covers this type
   * (SPEC §9 item 2 / §9.1); on `:8097` each accepted report is additionally
   * ingested for the S446 per-member drift policy (§4 `nudge`). Host-driven
   * pacing is an integration convention, never an authorization precondition.
   *
   * @throws TypeError on non-finite or negative position
   */
  reportPosition(position: number, isPlaying: boolean): boolean {
    SyncPlayClient.assertPosition('position', position);
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      position,
      is_playing: isPlaying,
      server_time: this.getSynchronizedTime(),
    });
    return true;
  }

  // --- Group enumeration / queue / host transfer (SPY-S12) -------------------
  //
  // Senders ride EXISTING wire codes only (SPEC §4.1/§4.2/§4.4): no new types.

  /**
   * Request the group list (`syncplay_group_list`, SPEC §4.1 — bare request,
   * no fields). The reply arrives through
   * {@link SyncPlayClientOptions.onGroupList}. Callable outside a group (that
   * is its point); returns `false` only on a destroyed instance. `true` means
   * the frame was handed to the `send` sink, not that the server answered.
   */
  listGroups(): boolean {
    if (this.destroyed) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.GROUP_LIST, {});
    return true;
  }

  /**
   * Host command: REPLACE the group's playback queue wholesale
   * (`syncplay_playback_queue`, SPEC §4.2, client shape `group_id` + `queue`
   * of `{ media_id, media_info? }`). NOT_HOST-gated by both producers; the
   * accepted queue comes back as the broadcast on
   * {@link SyncPlayClientOptions.onQueueChanged}. Boolean law per
   * {@link sendPlay} (`false` with no cached group).
   *
   * @throws TypeError when `queue` is not an array of items with a string `media_id`
   */
  sendQueue(queue: ReadonlyArray<Pick<PlaybackQueueItem, 'media_id' | 'media_info'>>): boolean {
    if (!Array.isArray(queue)) {
      throw new TypeError('SyncPlayClient: queue must be an array');
    }
    const items: Array<Pick<PlaybackQueueItem, 'media_id' | 'media_info'>> = [];
    for (const item of queue) {
      if (item === null || typeof item !== 'object' || typeof item.media_id !== 'string') {
        throw new TypeError('SyncPlayClient: every queue item needs a string media_id');
      }
      const out: Pick<PlaybackQueueItem, 'media_id' | 'media_info'> = { media_id: item.media_id };
      if (item.media_info !== undefined) {
        out.media_info = item.media_info;
      }
      items.push(out);
    }
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE, {
      group_id: this.group.group_id,
      queue: items,
    });
    return true;
  }

  /**
   * Host command: hand the host role to `newHostId`
   * (`syncplay_host_transfer`, SPEC §4.4: `group_id`, `current_host_id`,
   * `new_host_id`). `current_host_id` is this client's self-asserted
   * `memberId` (the server authorizes by the authenticated connection).
   * NOT_HOST-gated; the answer is a `group_state` broadcast plus
   * {@link SyncPlayClientOptions.onHostTransfer}. Boolean law per
   * {@link sendPlay}.
   *
   * @throws TypeError when `newHostId` is not a non-empty string
   */
  transferHost(newHostId: string): boolean {
    if (typeof newHostId !== 'string' || newHostId === '') {
      throw new TypeError('SyncPlayClient: newHostId must be a non-empty string');
    }
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER, {
      group_id: this.group.group_id,
      current_host_id: this.memberId,
      new_host_id: newHostId,
    });
    return true;
  }

  // --- Chat (any member; both producers derive identity server-side) --------

  /**
   * Send a chat message to the group. Outbound shape mirrors the server's own
   * factory `Messages::chatMessage` (phlix-server
   * `src/Session/SyncPlay/Messages.php:564-574`): `group_id` + this client's
   * self-asserted `member_id` + `message`.
   *
   * Producer law this method deliberately does NOT paper over (each half is
   * documented on {@link ChatBroadcastPayload} with cites):
   *  - the server IGNORES the claimed `member_id` and stamps the
   *    authenticated id on the rebroadcast (S289, `SyncPlayManager.php:1297`);
   *  - a blank/whitespace `message` is dropped IN SILENCE on both carriers
   *    (server :1314-1316, hub :1791-1793) — no error frame, no echo. Gate
   *    your own senders (e.g. disable Send on empty) if you want that UX
   *    signal locally;
   *  - the accepted message ECHOES BACK TO YOU through
   *    {@link SyncPlayClientOptions.onChat} (fan-out includes the sender) —
   *    render chat from the callback only, never twice.
   * Outside a group the frame's `group_id` has no source, so the send is
   * REFUSED and returns `false` (CONSOLIDATED m4 — it used to be silent).
   */
  sendChat(message: string): boolean {
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.CHAT, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      message,
    });
    return true;
  }

  /**
   * Announce typing state (`syncplay_typing`, {@link SyncPlayClientOptions.onMemberTyping}
   * is the inbound arm). Shape mirrors `Messages::chatTyping` (phlix-server
   * `Messages.php:590-600`). Producers read `is_typing` as `=== true` or the
   * legacy `'1'` string (server `SyncPlayManager.php:1375`, hub
   * `SyncPlayRelayWorker.php:1822-1823`) — a real boolean passes cleanly.
   * Identity is again server-derived (S289 :1364). Unlike chat, the typing
   * fan-out EXCLUDES the sender (server `[$memberId]` :1380, hub
   * `$client->clientId` :1828), so your own indicator never echoes back, and
   * guard misses are SILENT for typing on both producers (no error frames for
   * a transient indicator — there is nothing to observe beyond the peers'
   * view).
   */
  sendTyping(isTyping: boolean): boolean {
    if (this.group === null) {
      return false;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.TYPING, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      is_typing: isTyping,
    });
    return true;
  }

  // --- Time sync -----------------------------------------------------------

  /**
   * Send a time_ping. Call periodically (e.g. every 10–30s).
   *
   * M-SYNCPLAY-13 (single-flight): a round is in flight exactly while
   * `lastPingSendTime` is set, and {@link handleTimePong} can only attribute a
   * pong to that ONE recorded send time — stacked pings from a burst would
   * arrive as echoes that mismatch the current slot and get refused, starving
   * the estimator. So a call with a ping outstanding is ignored, with one
   * escape: an unanswered ping older than `MAX_ACCEPTABLE_RTT` could never
   * seed a sample even if its pong still landed (the sample would be rejected
   * on `rtt`), so it is treated as lost and the next call re-pings. A lost
   * pong can therefore never wedge time sync forever; `onDisconnect()` also
   * clears the slot immediately (SPEC §10.1 item 3).
   */
  pingTime(): void {
    // LW-046: a destroyed client owns no connection and no slots — ship nothing.
    if (this.destroyed) {
      return;
    }
    // SPY-2: the quad is INTEGER milliseconds. The server int-casts the
    // `client_time` it echoes (phlix-server/hub TimeSync), so a fractional t1
    // (a performance.now()-style clock) would never equal its own echo and
    // every pong would be refused as a cross-round straggler. Truncate at the
    // source so the sent, recorded, and echoed values are the same integer.
    const t1 = Math.trunc(this.now());
    const outstanding = this.lastPingSendTime;
    // CONSOLIDATED m22 (review asphp MINOR-3): a BACKWARD wall-clock step made
    // the age NEGATIVE, and a negative age passes `<= MAX_ACCEPTABLE_RTT`
    // forever — the single-flight slot wedged, sync froze, stale offsets
    // served with full confidence. A negative age is not a fresh ping: re-ping
    // and let the newest send time own the slot (SPEC §10's "never wedge"
    // intent, finally true under clock steps).
    if (outstanding !== null) {
      const age = t1 - outstanding;
      if (age >= 0 && age <= MAX_ACCEPTABLE_RTT) {
        return;
      }
    }
    this.lastPingSendTime = t1;
    this.pingEpoch = this.connectionEpoch;
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.TIME_PING, { client_time: t1 });
  }

  // --- Connection lifecycle ------------------------------------------------

  /**
   * Reset all transient connection state. The consumer MUST call this when the
   * underlying WebSocket closes or errors, BEFORE attempting to reconnect.
   *
   * It (1) clears the {@link TimeSync} samples + drift (a fresh connection has a
   * new network path, so stale offsets/drift would corrupt the first post-
   * reconnect sync), (2) forgets the current group (the server-side membership
   * is gone once the socket drops), and (3) drops any outstanding ping so a late
   * pong from the dead connection cannot seed a bogus sample.
   *
   * RECOVERY SEQUENCE (see SPEC §10 / README "Reconnect recovery"):
   *   socket close/error → `onDisconnect()` → reconnect → re-`joinGroup(...)`
   *   → resume periodic `pingTime()`. Reconnect *backoff* (the retry timer) is a
   *   transport concern owned by the consumer; this library schedules no
   *   periodic timers (its one owned-timer exception is the sendSeek coalescing
   *   flush — cancelled here, disabled by `seekThrottleMs: 0`; README
   *   "Command repeat policy").
   */
  onDisconnect(): void {
    // SPY-1 / LW-046: destroy() is terminal — a socket-close handler that
    // outlives screen teardown must not fire the consumer's reconnect lane.
    if (this.destroyed) {
      return;
    }
    this.cancelSeekCoalescing();
    // SPY-S7: a new connection generation begins; any send time stamped in an
    // older one is no longer attributable by a non-echo pong.
    this.connectionEpoch += 1;
    this.timeSync.reset();
    // LW-043: the rejection streak is per-connection measurement history —
    // a fresh connection starts honest at zero (mirrors the timeSync.reset
    // two lines above, same rationale).
    this.consecutiveSyncRejections = 0;
    this.group = null;
    this.lastPingSendTime = null;
    this.options.onDisconnect?.();
  }

  /**
   * CONSOLIDATED m18 (review asphp MINOR-6): screen-unmount teardown. Unwinds
   * everything {@link onDisconnect} unwinds that a destroyed instance can
   * still be observed through — coalescing cancelled, TimeSync window
   * cleared, cached group and outstanding ping dropped (the LW-043 streak
   * reset is onDisconnect's ALONE: post-LW-046 no reader of the counter
   * survives the latch, so the reset line here was unpinnable dead state
   * and was deleted in the w11 L10 re-review cure) — but fires NO consumer
   * callback: a component that is tearing down must not be dragged
   * back through its disconnect handler (and the disconnect path's
   * "reconnecting…" UI is the wrong signal for destroy). LW-046 makes the
   * INERT promise literally true: after `destroy()` the instance routes NO
   * inbound callbacks (`handleIncoming` returns before decoding), ships
   * NOTHING from `createGroup`/`joinGroup`/`pingTime` (silently inert), keeps
   * the `group === null` false-law for the boolean senders, and owns ZERO
   * timers — including when a `send` sink re-enters the class mid-dispatch.
   * Do not re-`joinGroup` on a destroyed instance: it is terminal by design
   * (the reconnect lane is {@link onDisconnect}); build the next client fresh.
   */
  destroy(): void {
    // LW-046: latch FIRST — every consulted path below (and any synchronous
    // sink re-entry from cancelSeekCoalescing's clear) sees a destroyed client.
    this.destroyed = true;
    this.cancelSeekCoalescing();
    this.timeSync.reset();
    this.group = null;
    this.lastPingSendTime = null;
  }

  // --- Inbound -------------------------------------------------------------

  /**
   * Route one inbound frame (string or parsed object). Feeds time-sync on pong,
   * applies group_state, surfaces playback commands, host changes, errors, info,
   * chat and queue updates. Frames whose type is outside the 19 canonical
   * `syncplay_*` types are surfaced via {@link SyncPlayClientOptions.onUnknownFrame};
   * the two formerly-ignored canonical types (syncplay_chat,
   * syncplay_playback_queue) are orchestrated since M-SYNCPLAY-11 through
   * {@link SyncPlayClientOptions.onChat} / {@link SyncPlayClientOptions.onQueueChanged}
   * and never reach that hook; undecodable and garbage-refused frames are
   * ignored too, but no longer silently — they surface through
   * {@link SyncPlayClientOptions.onFrameDropped} (CONSOLIDATED m5). A
   * destroyed instance (LW-046) routes nothing at all: `handleIncoming`
   * returns before decoding, firing no callback on any hook.
   */
  handleIncoming(raw: unknown): void {
    // LW-046: a destroyed instance is INERT — route nothing, fire nothing,
    // not even the garbage-observability hook (per m18, a torn-down consumer
    // must not be dragged back through its callbacks).
    if (this.destroyed) {
      return;
    }
    const decoded = decodeMessage(raw);
    if (decoded === null) {
      this.options.onFrameDropped?.('undecodable', raw);
      return;
    }
    if (!isValidMessageType(decoded.type)) {
      // CONSOLIDATED m19: canonicality is now checked honestly, by the
      // exported guard, BEFORE the switch. Foreign vocabulary (hub
      // `pending_command` and any consumer dialect) surfaces on
      // onUnknownFrame untouched — same behavior the old default arm
      // provided, now typed as the honest UnknownFrame instead of a cast
      // that pretended RawMessage.
      this.options.onUnknownFrame?.(decoded);
      return;
    }
    const msg = decoded as RawMessage;

    // LW-049 (review syncplay__secnet #4): the receiver-side mirror of the
    // server's `protocol_version` VALUE law, on canonical frames only. Truth
    // mirrored: `:8097` MessageHandler refuses integer stamps HIGHER than its
    // PROTOCOL_VERSION and (the check being `is_int`-keyed) lets ABSENT and
    // stale integers fall through accepted; the hub :8804 gates nothing. The
    // codec was presence-keyed only (framing unwraps on the key's existence),
    // so a version-2 frame drove the v1 state machine. A non-integer, or an
    // integer above what this decoder implements, is refused through the
    // existing malformed-drop machinery — no new wire vocabulary, and absent/
    // stale integers keep falling through exactly like the server's arms.
    //
    // SPY-S15 (watch note): the enforcement window is deliberately loose —
    // absent `protocol_version` and stale integers are TOLERATED because the
    // legacy Tizen wrapper and older servers still emit them. Tightening this
    // gate breaks that documented tolerance, so any change belongs to a future
    // wire-law revision made together with framing.ts `decodeMessage` unwrap
    // (the presence-keyed `protocol_version` check there; keep the two in sync).
    if ('protocol_version' in msg) {
      const version = (msg as { protocol_version?: unknown }).protocol_version;
      if (typeof version !== 'number' || !Number.isInteger(version) || version > PROTOCOL_VERSION) {
        this.options.onFrameDropped?.('malformed', msg);
        return;
      }
    }

    switch (msg.type) {
      case SYNCPLAY_MESSAGE_TYPES.TIME_PONG:
        this.handleTimePong(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.GROUP_STATE:
        this.handleGroupState(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY:
        this.handlePlayback('play', msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE:
        this.handlePlayback('pause', msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK:
        this.handleSeek(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.HOST_ELECT:
        this.handleHostElect(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.INFO:
        this.handleInfo(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.ERROR:
        this.handleError(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.TYPING:
        this.handleTyping(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER:
        this.handleHostTransfer(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC:
        this.handlePlaybackSync(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.TIME_SYNC:
        this.handleTimeSync(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.GROUP_LIST:
        this.handleGroupList(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.CHAT:
        this.handleChat(msg);
        break;
      case SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE:
        this.handlePlaybackQueueBroadcast(msg);
        break;
      default:
        // S298 (still true) + CONSOLIDATED m19: non-canonical vocabulary now
        // exits handleIncoming through isValidMessageType ABOVE the switch,
        // typed as UnknownFrame. This arm keeps its meaning for canonical
        // types with no honest inbound producer (an echoed outbound-only
        // group_create, a stray time_ping): surfaced as unknown-to-this-client
        // rather than dropped. The library validates nothing here; it stays
        // protocol-pure.
        this.options.onUnknownFrame?.(msg);
        break;
    }
  }

  // --- Inbound handlers ----------------------------------------------------

  private handleTimePong(msg: RawMessage): void {
    // SPEC §10.1.3 (verbatim): "The outstanding ping — a late `time_pong` from
    // the dead connection must not seed a sample, so the recorded send time
    // (`lastPingSendTime`) is dropped." `onDisconnect()` performs that drop, so
    // a pong that arrives with NO outstanding ping recorded is exactly the late
    // frame the clause forbids — refuse it before touching TimeSync.
    //
    // The pre-fix code read `pong.client_time` straight off the frame as t1 and
    // only fell back to `lastPingSendTime` when it was ABSENT. But the live
    // server always echoes `client_time` (`Messages::timePong` /
    // `TimeSync::processPing` in phlix-server), so that fallback was dead
    // against reality and the primary branch trusted the frame unconditionally:
    // after a disconnect the still-buffered pong's echoed t1 (old path) paired
    // with a fresh t4 (new path) seeded a quad spanning two connections,
    // corrupting the clean window §10.1 exists to protect. The dropped send
    // time is therefore the liveness signal — the echoed value is only trusted
    // once a live ping is outstanding to match it against.
    const outstanding = this.lastPingSendTime;
    if (outstanding === null) {
      return;
    }

    const pong = msg as Partial<TimePongPayload>;
    // M-SYNCPLAY-19: a JSON `1e999` echo decodes to Infinity and passes a bare
    // `typeof === 'number'` check. A corrupt echo is treated as an ABSENT one
    // (fall back to the recorded send time) — same honest path as the
    // pre-echo frame shape this library's own callers emit.
    const echoed =
      typeof pong.client_time === 'number' && Number.isFinite(pong.client_time)
        ? pong.client_time
        : null;

    // Fast-reconnect regime: a fresh ping may already be outstanding on the NEW
    // connection when a straggler pong from the torn-down one lands, so the
    // null check alone misses it. The server echoes verbatim the `client_time`
    // we sent, so a pong whose echo does not equal our current outstanding
    // send time belongs to a different round-trip (and — on the integer-ms
    // Date.now() clock this library's contract mandates — a different
    // connection). Refuse it and LEAVE the outstanding ping untouched: its real
    // pong may still arrive.
    if (echoed !== null && echoed !== outstanding) {
      return;
    }

    // SPY-S7: a NON-echo pong carries no t1 of its own, so it is attributable
    // only to a ping stamped in the CURRENT connection generation. A send time
    // from an older generation is refused (slot untouched); the pre-echo legacy
    // shape stays accepted within-epoch.
    if (echoed === null && this.pingEpoch !== this.connectionEpoch) {
      return;
    }

    // SPY-2: t4 on the same integer-ms scale as t1 (see {@link pingTime}).
    const t4 = Math.trunc(this.now());
    // Prefer the matched echo; otherwise fall back to our recorded send time
    // (the pre-echo shape this library's own callers may emit).
    const t1 = echoed ?? outstanding;
    // M-SYNCPLAY-13: the round is consumed the moment its pong matched, so the
    // single-flight slot releases HERE — before the t2 gate below. A pong that
    // answers our ping but omits `server_time` still completes the round trip;
    // holding the slot through that early return would stall pacing until the
    // aging escape in {@link pingTime}.
    this.lastPingSendTime = null;
    // M-SYNCPLAY-19: non-finite t2 would poison the offset average forever —
    // same drop-to-null treatment as a missing one (round stays consumed).
    const t2 =
      typeof pong.server_time === 'number' && Number.isFinite(pong.server_time)
        ? pong.server_time
        : null;

    if (t2 === null) {
      // LW-043 (review syncplay__asphp #3): a matched pong without a usable
      // t2 measures nothing — that is exactly the rejected-round class
      // M-SYNCPLAY-14 made observable. The silent return let a server
      // omitting (or corrupting) `server_time` look "still measuring"
      // forever. The round is still consumed and the slot released above
      // (M-SYNCPLAY-13 untouched); only the silence is cured.
      this.consecutiveSyncRejections += 1;
      this.options.onSyncDegraded?.(this.consecutiveSyncRejections);
      return;
    }

    // The server pong has no separate response timestamp: t3 == t2.
    const accepted = this.timeSync.addSample(t1, t2, t2, t4);

    if (accepted) {
      this.consecutiveSyncRejections = 0;
      this.options.onSync?.({
        offset: this.timeSync.getOffset(),
        latency: this.timeSync.getLatency(),
        isStable: this.timeSync.isStable(),
      });
    } else {
      // M-SYNCPLAY-14: the rejection used to vanish here — `onSync` fires only
      // on acceptance, so a member whose every round trips the RTT bound got
      // no event at all and no way to tell "measuring" from "silently
      // failing". Surface the streak; the consumer owns the threshold.
      this.consecutiveSyncRejections += 1;
      this.options.onSyncDegraded?.(this.consecutiveSyncRejections);
    }
  }

  /**
   * Fold the wire's `members` into the library's array model.
   *
   * The LIVE server spelling is a DICT keyed by member id
   * (`GroupState::getState()` builds `$membersDict[$id]`; V1, unchanged since
   * the initial SyncPlay commit — see S416). The array spelling is also
   * accepted because it is this library's own output model, which re-fed
   * frames and hand-built payloads carry. Any other value (string, number,
   * null) is treated as empty, exactly as before.
   */
  private static normalizeMembers(members: SyncPlayMembersWire | undefined, hostId: string | null): SyncPlayMember[] {
    let list: Array<Partial<SyncPlayMember> & { id?: string }>;
    if (Array.isArray(members)) {
      // CONSOLIDATED M10 (review asphp MAJOR-1): the tolerance this normalizer
      // advertises is for the ARRAY SPELLING — and `[null]`/`[3]` used to
      // throw out of handleIncoming mid-fold with the cached group possibly
      // half-updated, violating the library's own "invalid frames are
      // ignored" law. Element-level drop now mirrors the field-level law:
      // non-object entries are skipped, nothing is defaulted into a member.
      list = members.filter((m) => typeof m === 'object' && m !== null);
    } else if (members && typeof members === 'object') {
      // Dict keyed by member id → array; the entry KEY is authoritative for
      // id. Was only ACCIDENTALLY safe (spreading a primitive yields garbage,
      // not a crash) — now the same explicit law as the array spelling.
      list = Object.entries(members)
        .filter(([, value]) => typeof value === 'object' && value !== null)
        .map(([id, value]) => ({ ...value, id }));
    } else {
      list = [];
    }
    return list.map((m) => ({
      id: typeof m.id === 'string' ? m.id : '',
      name: typeof m.name === 'string' ? m.name : '',
      // is_host is derived from host_id (server also sets is_host, but host_id is authoritative).
      is_host: m.id === hostId,
      // M-SYNCPLAY-19: non-finite timestamps are garbage, not a join time.
      joined_at: typeof m.joined_at === 'number' && Number.isFinite(m.joined_at) ? m.joined_at : 0,
    }));
  }

  /**
   * Patch the cached group's `host_id` **and** recompute `members[].is_host`
   * in the same mutation (W-min119 M-SYNCPLAY-15, review `syncplay__gameux`
   * m4). `normalizeMembers` derives `is_host` from `host_id` at fold time —
   * a fold that spread the old roster after a host change left the crown on
   * the outgoing host until the next `group_state`, so a consumer rendering
   * `members[].is_host` (rather than the authoritative `host_id`) saw a
   * model that contradicted the library's own normalization law. On the
   * `:8097` host-leave path no `group_state` follows the `host_elect`
   * broadcast at all (phlix-server `SyncPlayManager.php` leave path fires
   * HOST_ELECT only), so the stale flags were otherwise permanent for the
   * cached session.
   */
  private static foldHostId(group: SyncPlayGroup, newHostId: string | null): SyncPlayGroup {
    return {
      ...group,
      host_id: newHostId,
      members: group.members.map((m) => ({ ...m, is_host: m.id === newHostId })),
    };
  }

  /**
   * Normalize a wire `server_time` stamp to MILLISECONDS (fix lane M-SYNCPLAY-04).
   *
   * The two carriers stamp the SAME field in DIFFERENT units — a per-carrier
   * split-brain invisible at the API:
   *  - `:8097` (phlix-server `SyncPlayManager`) stamps UNIX **seconds**: the
   *    playback_sync group echo (`SyncPlayManager.php:1506` `$serverTime =
   *    time();` → broadcast `:1523`), the S446 nudge echo (`:1575`), and the
   *    play/pause/seek echo fallback when the sender omitted `server_time`
   *    (`:1076/:1128/:1175` `?? time()`);
   *  - the hub relay stamps **milliseconds** (`SyncPlayRelayWorker.php:1105/
   *    :1603` `self::nowMs()`), and its command echoes pass the sender's own
   *    ms stamp through `canonicalInt` (`:1535`).
   *
   * Handing a raw seconds stamp to the all-ms consumer contract
   * (`TimeSync.getAdjustedPosition`) computes `synchronizedNow − serverTime`
   * ≈ +56 years of elapsed ms and teleports the playhead — phlix-ui was
   * demonstrably burned into discarding the field entirely
   * (`src/api/syncplay.ts` `void serverTime;`).
   *
   * Parse-at-the-boundary (SPEC §4's ms law for the consumer surface, §8.4's
   * per-carrier wire quirk): epoch MAGNITUDE decides the unit. Any stamp
   * `< 1e12` is treated as seconds (×1000) — a plausible wall-clock epoch-ms
   * value has been ≥ 1e12 ever since 2001-09-09, and epoch seconds stay
   * `< 1e12` until the year 33658. Realistic stamps on either carrier decode
   * exactly; ms stamps pass through untouched. Stamps below 1000 are epoch
   * ZERO-ish garbage on either scale: the library refuses them at
   * {@link serverTimeOrNow} (CONSOLIDATED m3) — direct callers should treat a
   * `< 1000` input the same way an absent stamp is treated.
   *
   * LW-050 (review syncplay__secnet #5): this method's heuristic stays PURE
   * and UNTOUCHED — plausibility policing belongs to the single consumer
   * boundary {@link serverTimeOrNow}, where an implausible magnitude has an
   * honest fallback to take.
   */
  static serverTimeToMs(raw: number): number {
    return raw < 1e12 ? raw * 1000 : raw;
  }

  /**
   * The one `server_time` acceptance law shared by the three consumers
   * (playback / seek / playback_sync, M-SYNCPLAY-12 set): a FINITE number is
   * unit-normalized via {@link serverTimeToMs}; anything else (absent,
   * non-numeric, `1e999` → `Infinity`) yields the caller's honest
   * clock-estimate fallback (M-SYNCPLAY-19).
   *
   * LW-050 (review syncplay__secnet #5): the finite gate BELIEVED any
   * magnitude — a monotonic-uptime clock reading 9e11 "ms" normalized to 9e14
   * (year ~30540) and teleported every interpolating consumer. Trust is now
   * bounded to the two plausible wall-clock windows: `≥ 1e12` (epoch ms, real
   * since 2001-09) and `[1e9, 4e9)` (epoch seconds, 2001-09 → 2096-11). A
   * stamp outside both — above the m3 floor of 1000 but no honest carrier
   * would emit it — takes the SAME clock-estimate fallback an absent stamp
   * already gets. Deliberately ABSOLUTE (not estimate-relative): a fake
   * `now`-clock in tests must never change what a real-epoch stamp is worth.
   */
  private static serverTimeOrNow(raw: unknown, fallback: () => number): number {
    // CONSOLIDATED m3 (review gameux m1): epoch-zero / negative stamps are the
    // exact "+56 years teleports the playhead" failure this class's own
    // docblock cites — `server_time: 0` used to fold into 0 ms and poison
    // every interpolation. No honest wall clock on EITHER carrier scale reads
    // below 1000 (that is 1970-01-01T00:16:40Z), so it takes the documented
    // clock-estimate fallback like an absent or non-finite one already did.
    // LW-050 extends the same honesty to implausible MIDDLE magnitudes.
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1000) {
      return fallback();
    }
    const plausible = raw >= 1e12 || (raw >= 1e9 && raw < 4e9);
    return plausible ? SyncPlayClient.serverTimeToMs(raw) : fallback();
  }

  /**
   * Normalize the `group.queue` array a `group_state` frame carries
   * (M-SYNCPLAY-06: this handler used to drop the field entirely). Producer
   * coordinates and per-carrier item fields are documented on
   * {@link PlaybackQueueItem}. The narrowing follows the house idiom of
   * {@link normalizeMembers}: defensive per-field coercion, nothing invented.
   * A frame WITHOUT a `queue` key (only hand-built frames omit it — both live
   * producers always emit it, possibly `[]`) yields `undefined`; the library
   * never fabricates an empty queue for a frame that carried none.
   */
  private static normalizeQueue(
    queue: Array<Partial<PlaybackQueueItem>> | undefined,
  ): PlaybackQueueItem[] | undefined {
    if (!Array.isArray(queue)) {
      return undefined;
    }
    // CONSOLIDATED M10: element-level drop per the normalizeMembers law —
    // surviving items keep their ORDER (a queue is positional).
    const items = queue.filter((item) => typeof item === 'object' && item !== null);
    return items.map((item) => ({
      media_id: typeof item.media_id === 'string' ? item.media_id : '',
      media_info:
        typeof item.media_info === 'object' && item.media_info !== null
          ? (item.media_info as Record<string, unknown>)
          : undefined,
      // M-SYNCPLAY-19: finite-only numerics through the queue normalizer too.
      added_at:
        typeof item.added_at === 'number' && Number.isFinite(item.added_at)
          ? item.added_at
          : undefined,
      added_by:
        typeof item.added_by === 'string' || item.added_by === null ? item.added_by : undefined,
    }));
  }

  /**
   * Narrow the `nudge` object a DIRECTED `playback_sync` frame carries
   * (M-SYNCPLAY-08: this handler used to drop it, stranding the server's
   * S446 soft-correction channel at the library boundary). Producer law and
   * per-field coordinates are documented on {@link PlaybackSyncNudge}; the
   * only emitter is phlix-server `SyncPlayManager.php:1569-1585` (@84e55800).
   * The narrowing follows the house idiom of {@link normalizeQueue}:
   * defensive per-field coercion, nothing invented. A frame WITHOUT the
   * `nudge` key (the group echo and every hub-relay frame) yields
   * `undefined`; the library never fabricates a correction for a frame that
   * carried none. A non-object `nudge` on a hand-built frame degrades to
   * `undefined` too (drop-the-garbage, keep-the-state).
   */
  private static normalizeNudge(
    nudge: unknown,
  ): PlaybackSyncNudge | undefined {
    if (typeof nudge !== 'object' || nudge === null) {
      return undefined;
    }
    const raw = nudge as Partial<PlaybackSyncNudge>;
    // M-SYNCPLAY-19: every numeric here feeds rate/drift math — finite-only.
    // CONSOLIDATED m2 (review exploiter m2 / secnet m2): FINITE is not
    // DOMAIN — `suggested_rate: 1e9` used to flow straight into consumer
    // playRate. Clamp-every-read on the nudge numerics now: the only honest
    // rate band is the server's own `1 ± NUDGE_RATE_STEP(0.1)` law
    // (phlix-server GroupState.php:179 @c904aa4d, @ the cites on
    // PlaybackSyncNudge),
    // and tolerance/cooldown are non-negative ms or they are not those
    // fields. Out-of-domain drops to undefined — the same drop-the-garbage
    // arm a non-finite value already took.
    return {
      drift_ms: SyncPlayClient.finiteOrUndefined(raw.drift_ms),
      direction:
        raw.direction === 'behind' || raw.direction === 'ahead'
          ? raw.direction
          : undefined,
      suggested_rate: SyncPlayClient.nudgeRateOrUndefined(raw.suggested_rate),
      tolerance_ms: SyncPlayClient.nonnegOrUndefined(raw.tolerance_ms),
      cooldown_ms: SyncPlayClient.nonnegOrUndefined(raw.cooldown_ms),
    };
  }

  /**
   * Boundary coercion for wire strings (W-min124 M-SYNCPLAY-19, review
   * `syncplay__secnet` MINOR-3): `?? fallback` only catches null/undefined, so
   * a hub-relay bug or hostile relay could flow a NUMBER or OBJECT into fields
   * typed `string`/`string | null` — the model then lies and every
   * `=== hostId`-style derivation silently breaks. Non-strings fall back
   * exactly like an absent field did before.
   */
  private static strOr(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
  }

  private static strOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  /**
   * Numeric counterpart of {@link strOr} (M-SYNCPLAY-19): `JSON.parse` happily
   * yields `Infinity` for `1e999` and it passes a bare `typeof === 'number'`
   * check, then flows into player sinks (`currentTime = Infinity` throws in
   * browsers) and poisons the TimeSync offset average. Only FINITE numbers
   * are accepted; anything else takes the documented fallback.
   */
  private static finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private static finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private static finiteOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /**
   * Nudge rate domain (CONSOLIDATED m2): the server's only emitted values are
   * `1 ± 0.1`, so anything outside `[0.9, 1.1]` has no honest producer and
   * reads as absent. A future band change is a WIRE-LAW edit: widen here only
   * together with the SPEC §4 nudge section (never silently).
   */
  private static nudgeRateOrUndefined(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.9 || value > 1.1) {
      return undefined;
    }
    return value;
  }

  /** Finite AND non-negative ms (CONSOLIDATED m2): tolerance/cooldown domain. */
  private static nonnegOrUndefined(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return value;
  }

  /**
   * Inbound-position acceptance law (CONSOLIDATED m2 + the M6 clamp arm made
   * executable): finite, never negative (no honest producer for a <0
   * position — that frame class already refuses the 0-teleport family, the
   * sign is the same question), and clamped to the cached group's
   * `current_media_duration` when one is known — the SPEC §5/M6 consumer
   * clamp duty inherited by every wrapper that delegates here. `null` =
   * garbage; each caller drops the frame via its existing precedent.
   */
  private positionOrDrop(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return null;
    }
    const duration = this.group?.current_media_duration;
    if (
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration > 0 &&
      value > duration
    ) {
      return duration;
    }
    return value;
  }

  /**
   * `group_state` fold position law (LW-042, review `syncplay__crossfe` #4):
   * the SAME bounds {@link positionOrDrop} enforces on command frames — floor
   * at 0, ceiling at the fold's duration — applied as CLAMPS instead of
   * drops. Commands refuse garbage because a malformed command has no honest
   * producer; the state fold repairs instead, because §10.2's join-adoption
   * law feeds the folded `playback_position` verbatim to every player — a
   * dropped state would freeze the whole room on an entry frame, while a
   * clamped one is honest UX. Non-finite garbage keeps the ratified fallback 0
   * (M-SYNCPLAY-19 law, re-pinned); an absent/non-finite duration invents no
   * ceiling.
   */
  private static clampedPosition(value: unknown, duration: number | null): number {
    const position = SyncPlayClient.finiteOr(value, 0);
    if (position < 0) {
      return 0;
    }
    if (duration !== null && duration > 0 && position > duration) {
      return duration;
    }
    return position;
  }

  /**
   * Membership-check `playback_state` against the canonical four (SPEC §4,
   * `PlaybackState` in `messages.ts`); anything else degrades to `'stopped'`
   * (M-SYNCPLAY-19). A cast through this guard is the difference between a
   * consumer `switch` that always lands on a real case and one that matches
   * nothing while the model claims `PlaybackState`.
   */
  private static playbackState(value: unknown): PlaybackState {
    return value === 'playing' || value === 'paused' || value === 'buffering' || value === 'stopped'
      ? value
      : 'stopped';
  }

  private handleGroupState(msg: RawMessage): void {
    const payload = msg as Partial<GroupStatePayload>;
    const group = payload.group;
    if (typeof group !== 'object' || group === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }

    // LW-041a (review syncplay__asphp #2): `group_id` IS the room's identity.
    // Folding a non-string one to '' minted a nameless room in the model that
    // every `group_id ===` derivation then shared — a garbage frame silently
    // re-anchored the client into a phantom state. Both live servers mint
    // `sp_*` strings, so a non-string group_id has NO honest producer: refuse
    // the frame whole (the strOr fold below still serves every adjacent
    // field); the cached group and onState stay untouched.
    if (typeof group.group_id !== 'string') {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }

    // M-SYNCPLAY-19 + LW-041a: read once, reuse below and in the room-change
    // check so the comparison and the stored model can never disagree.
    const groupId = group.group_id;
    const hostId = SyncPlayClient.strOrNull(group.host_id);

    // Room change mid-window (R-SYNCPLAY-03): joinGroup(B) while a seek
    // coalescing window from room A is still open would otherwise flush A's
    // pending target stamped with B's group_id — the same "belongs to the
    // room we are leaving" law leaveGroup/onDisconnect already enforce.
    // A SAME-group re-delivery is a state refresh, not a room change: the
    // window must survive it (pinned in seekCoalescing.test).
    if (this.group !== null && this.group.group_id !== groupId) {
      this.cancelSeekCoalescing();
    }

    // M-SYNCPLAY-16: the roster diff belongs to THIS fold — capture the
    // outgoing model before replacing it (the same-stateful-fold idea the
    // review called "one cheap" — four platforms were re-implementing it).
    const previous = this.group;

    // Normalize members (dict on the live wire; array tolerated — S416) and
    // derive is_host from host_id (server includes is_host on members, but
    // host_id is authoritative).
    const members = SyncPlayClient.normalizeMembers(group.members, hostId);

    // LW-042: one duration read feeds both model fields — the position clamp
    // belongs to THIS fold's duration, not the stale cache.
    const duration = SyncPlayClient.finiteOrNull(group.current_media_duration);

    this.group = {
      group_id: groupId,
      group_name: SyncPlayClient.strOr(group.group_name, ''),
      members,
      member_count: SyncPlayClient.finiteOrUndefined(group.member_count),
      host_id: hostId,
      current_media_id: SyncPlayClient.strOrNull(group.current_media_id),
      current_media_duration: duration,
      playback_position: SyncPlayClient.clampedPosition(group.playback_position, duration),
      playback_state: SyncPlayClient.playbackState(group.playback_state),
      queue: SyncPlayClient.normalizeQueue(group.queue),
      created_at: SyncPlayClient.finiteOrUndefined(group.created_at),
      last_activity_at: SyncPlayClient.finiteOrUndefined(group.last_activity_at),
    };

    // M-SYNCPLAY-16: fire `onMemberLeft` for members this SAME room lost
    // since the previous fold. A room switch (different cached group_id) is
    // us leaving, not them leaving — no events. Joins are NOT diffed: they
    // already arrive as INFO frames (handleInfo), and a second announcement
    // path here would double-fire the same member (SPEC §6 event taxonomy).
    if (previous !== null && previous.group_id === groupId) {
      const present = new Set(members.map((m) => m.id));
      for (const m of previous.members) {
        if (!present.has(m.id)) {
          this.options.onMemberLeft?.({ id: m.id, name: m.name });
        }
      }
    }

    // `your_id` is surfaced VERBATIM and reconciled against nothing here:
    // the ctor `memberId` is immutable by design, and silently rewriting it
    // on first sight would mask the ghost-identity class instead of
    // naming it (SPEC §9; coupling law + mismatch UX documented on
    // {@link SyncPlayClientOptions.memberId}). Consumers own the
    // `yourId === getMemberId()` assertion.
    this.options.onState?.(
      this.group,
      typeof payload.your_id === 'string' ? payload.your_id : undefined,
    );
  }

  private handlePlayback(type: 'play' | 'pause', msg: RawMessage): void {
    // LW-044 (SPEC §4 Grouped-delivery law): command fan-out carries no
    // group_id — membership is implicit in the broadcast. A client with no
    // room receiving one is post-leave in-flight delivery: unattributable,
    // refused whole like any other garbage identity frame.
    if (this.group === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const senderId = typeof msg.member_id === 'string' ? msg.member_id : undefined;
    // Ignore our own echoed command (the server excludes the sender, but be safe).
    // SECURITY (see SPEC §9.1): suppression keys on `member_id`, so this is safe
    // ONLY because the server is expected to set the true (authenticated) sender
    // id on rebroadcast. If the server did not overwrite it, a peer spoofing our
    // id could make us silently drop a legitimate command. The client cannot
    // defend against this alone — it depends on the §9 server-set sender id.
    if (senderId === this.memberId) {
      return;
    }
    // M-SYNCPLAY-12 (parse-don't-validate): a frame without a finite numeric
    // `position` has NO honest producer — both live servers always stamp a
    // number — so it is malformed. Pre-fix it defaulted to 0 and emitted a
    // concrete jump-to-00:00 command the whole group obeys; the boundary now
    // refuses the frame instead. (A real 0 is finite and passes: this is a
    // type/presence check, not a truthiness check.)
    const position = this.positionOrDrop(msg.position);
    if (position === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const serverTime = SyncPlayClient.serverTimeOrNow(
      msg.server_time,
      () => this.getSynchronizedTime(),
    );
    this.options.onPlaybackCommand?.({ type, position, serverTime });
  }

  private handleSeek(msg: RawMessage): void {
    // LW-044: grouped-delivery law — see handlePlayback for the rationale.
    if (this.group === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const senderId = typeof msg.member_id === 'string' ? msg.member_id : undefined;
    // SECURITY (see SPEC §9.1): same dependency as handlePlayback — keying
    // echo-suppression on `member_id` is safe ONLY because the server sets the
    // true authenticated sender id on rebroadcast; a spoofed id would otherwise
    // let a peer suppress our legitimate seeks.
    if (senderId === this.memberId) {
      return;
    }
    // M-SYNCPLAY-12: malformed seek positions (missing / non-numeric /
    // non-finite) drop the frame — same law as handlePlayback; defaulting to
    // 0 rewound the group to 00:00 on a frame no server would ever emit.
    const position = this.positionOrDrop(msg.to_position);
    if (position === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const serverTime = SyncPlayClient.serverTimeOrNow(
      msg.server_time,
      () => this.getSynchronizedTime(),
    );
    this.options.onPlaybackCommand?.({ type: 'seek', position, serverTime });
  }

  /**
   * HOST_ELECT handler. LW-047 (review syncplay__crossfe): the `group ===
   * null` fall-through to `onHostChanged` below is DELIBERATE and ratified —
   * host_elect is the NAMED EXCEPTION to the grouped-delivery law (SPEC §4,
   * landed with LW-044 in `9268b66`): the frame carries no `group_id` to
   * scope by, there is no cached group to fold, and banner-style consumers
   * ("host X now leads") act on the announced id alone. A future consistency
   * sweep must NOT silence this path; see test/reviewWave11L10.test.ts.
   */
  private handleHostElect(msg: RawMessage): void {
    const payload = msg as Partial<HostElectPayload>;
    // CONSOLIDATED m1 (review asphp MINOR-1, secnet m1): `?? null` admitted
    // ANY JSON value into `host_id: string | null` — a number or object then
    // silently killed every `=== hostId` derivation and `isHost()` forever.
    // The M-SYNCPLAY-19 string law now covers this site like the rest of the
    // boundary (and a genuinely absent/null elected_id still means "no
    // host", unchanged).
    const newHostId = SyncPlayClient.strOrNull(payload.elected_id);
    if (this.group !== null) {
      // M-SYNCPLAY-03 (review `syncplay__crossfe` m3, ghost half): BOTH live
      // producers emit `host_elect` only on the host-LEAVE path, and on that
      // path `elected_by` IS the departing member's id (the same broadcasts
      // the {@link HostElectPayload} docblock pins: phlix-server
      // `SyncPlayManager.php:941-944`, phlix-hub
      // `SyncPlayRelayWorker.php:2073-2075`). The `:8097` surface broadcasts
      // no follow-up state, so pre-fix the departed host stayed a permanent
      // ghost in the cached roster. Drop it; the `foldHostId` below already
      // fixed the crown (W-min119 M-SYNCPLAY-15). Self-eviction guard: a
      // frame that removes OUR own id has no honest producer (we would be
      // disconnected, not electing), so the cached roster keeps us no matter
      // what garbage `elected_by` carries.
      const departed =
        typeof payload.elected_by === 'string' && payload.elected_by !== ''
          ? payload.elected_by
          : null;
      let group = this.group;
      const remaining =
        departed !== null && departed !== this.memberId
          ? group.members.filter((m) => m.id !== departed)
          : group.members;
      if (remaining.length !== group.members.length) {
        const gone = group.members.find((m) => m.id === departed);
        group = { ...group, members: remaining };
        this.group = SyncPlayClient.foldHostId(group, newHostId);
        // CONSOLIDATED m16 (review asphp MINOR-4): the eager eviction used to
        // swallow the departure — roster-diff `onMemberLeft` could never fire
        // for host departures on EITHER carrier, making the lib's leave
        // signal strictly worse than the hand-rolled diffs it replaced. Fire
        // it where the eviction ACTUALLY removed a member, before
        // `onHostChanged` so wrappers see the roster change first (same
        // fold-then-announce order as handleGroupState).
        if (gone !== undefined) {
          this.options.onMemberLeft?.({ id: gone.id, name: gone.name });
        }
        this.options.onHostChanged?.(newHostId);
        return;
      }
      this.group = SyncPlayClient.foldHostId(group, newHostId);
    }
    this.options.onHostChanged?.(newHostId);
  }

  private handleInfo(msg: RawMessage): void {
    const payload = msg as Partial<InfoPayload>;
    // A member JOIN arrives as INFO carrying member_id + member_name — the
    // server does NOT emit a dedicated member_joined type.
    // LW-044 (named exception pair, SPEC §4): a join announcement is
    // room-scoped — an ungrouped receiver has no room to announce into, and
    // the roster cannot be merged with a null group; the announcement is
    // skipped (not drop-reported: the frame's message half may still be
    // legitimately delivered below). The message branch has honest
    // ungrouped producers (server maintenance/shutdown chatter) and stays
    // live.
    if (
      this.group !== null &&
      typeof payload.member_id === 'string' &&
      typeof payload.member_name === 'string'
    ) {
      this.options.onMemberJoined?.({ id: payload.member_id, name: payload.member_name });
    }
    if (typeof payload.message === 'string') {
      this.options.onInfo?.(payload.message);
    }
  }

  private handleError(msg: RawMessage): void {
    const payload = msg as Partial<ErrorPayload>;
    // M-SYNCPLAY-19: `??` let a non-string `error_code` (a number, an object)
    // through `onError(_code: string, …)` — consumers string-interpolating the
    // code rendered `[object Object]`. Each candidate must BE a string or it
    // falls through, exactly as an absent one did.
    const code =
      typeof payload.error_code === 'string'
        ? payload.error_code
        : typeof payload.code === 'string'
          ? payload.code
          : 'UNKNOWN';
    const message = typeof payload.message === 'string' ? payload.message : 'Unknown error';
    // CONSOLIDATED m9 (review casualgamer Minor 7): SPEC §4's error frame may
    // carry a structured `details` object ("by how much / what limit"). It
    // used to die at this boundary. Object-guarded VERBATIM pass-through —
    // arrays and other JSON garbage read as absent, exactly like the rest of
    // the boundary's drop-the-garbage law.
    const details =
      typeof payload.details === 'object' &&
      payload.details !== null &&
      !Array.isArray(payload.details)
        ? (payload.details as Record<string, unknown>)
        : undefined;
    this.options.onError?.(code, message, details);
  }

  private handleTyping(msg: RawMessage): void {
    const payload = msg as Partial<TypingPayload>;
    if (typeof payload.member_id !== 'string') {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    // CONSOLIDATED m1 (review asphp MINOR-2, secnet m1): `?? false` admitted
    // `'1'` / `1` / `{}` into a typed boolean consumer. Finite-truthiness is
    // not the law here — the producers stamp a real boolean (server reads
    // `=== true` or legacy '1', but only ever WRITES true/false), so anything
    // that is not a boolean is a malformed frame and reads as false.
    const isTyping = typeof payload.is_typing === 'boolean' ? payload.is_typing : false;
    this.options.onMemberTyping?.(payload.member_id, isTyping);
  }

  /**
   * Surface a `syncplay_chat` broadcast (M-SYNCPLAY-11; wire bytes on
   * {@link ChatBroadcastPayload}). Refuse-garbage precedent
   * ({@link handleTyping} / handleTimeSync / handleGroupList): the speaker id
   * and the text are the message — a frame missing either has no producer on
   * either carrier and must not be rendered (the m1-class lesson: defaulted
   * garbage becomes visible UX). `member_name` is an adjacent field both live
   * producers always stamp, so its absence (hand-built frames only) coerces
   * to `''` per the {@link normalizeMembers} idiom — never an invented
   * 'Unknown' (that fallback is the SERVER's record-level law, not the
   * library's). No self-echo suppression: see the onChat docblock for the
   * fan-out law and the identity rationale.
   */
  private handleChat(msg: RawMessage): void {
    const payload = msg as Partial<ChatBroadcastPayload>;
    if (typeof payload.member_id !== 'string' || typeof payload.message !== 'string') {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const memberName = typeof payload.member_name === 'string' ? payload.member_name : '';
    // Envelope field — read off msg (BaseMessage.timestamp), not the payload
    // cast; the runtime check keeps hand-built/JSON-decoded junk honest
    // (M-SYNCPLAY-19: finite-only — `1e999` is not a timestamp).
    const timestampMs =
      typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
        ? msg.timestamp
        : undefined;
    this.options.onChat?.(payload.member_id, memberName, payload.message, timestampMs);
  }

  /**
   * Surface a `syncplay_playback_queue` broadcast (M-SYNCPLAY-11; wire bytes
   * on {@link QueueBroadcastPayload}) and fold it into the cached group —
   * this frame, not a `group_state` re-broadcast, is the ONLY live
   * queue-change signal the producers emit (server :1271-1278, hub
   * :1763-1765). Normalization REUSES {@link normalizeQueue} verbatim: the
   * broadcast items and `group_state.group.queue` items share both producers'
   * per-carrier shape, and a frame whose `queue` is absent or not an array
   * is garbage the handleGroupList precedent drops — half-applied (or
   * fabricated-empty) queue state is exactly how next-up UIs start lying.
   * LW-044 (SPEC §4 Grouped-delivery law): the broadcast is room-scoped
   * fan-out — received while ungrouped it is refused like the command
   * family, and the fold below needs no null branch anymore.
   */
  private handlePlaybackQueueBroadcast(msg: RawMessage): void {
    const group = this.group;
    if (group === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const payload = msg as Partial<QueueBroadcastPayload>;
    const queue = SyncPlayClient.normalizeQueue(payload.queue);
    if (queue === undefined) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    this.group = { ...group, queue };
    this.options.onQueueChanged?.(queue);
  }

  private handleHostTransfer(msg: RawMessage): void {
    const payload = msg as Partial<HostTransferPayload>;
    if (typeof payload.current_host_id !== 'string' || typeof payload.new_host_id !== 'string') {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    if (this.group !== null) {
      this.group = SyncPlayClient.foldHostId(this.group, payload.new_host_id);
    }
    this.options.onHostTransfer?.(payload.current_host_id, payload.new_host_id);
  }

  private handlePlaybackSync(msg: RawMessage): void {
    // LW-044: grouped-delivery law — see handlePlayback for the rationale.
    if (this.group === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    // LW-041b (review syncplay__secnet #2): the old `?? ''` fold minted an
    // ANONYMOUS speaker — consumers key drift UI and member attribution on
    // this id, and '' matches no honest producer (both servers stamp the
    // authenticated sender). Refuse the frame, same law as handleChat /
    // handleTyping face the identical non-string member_id.
    if (typeof msg.member_id !== 'string') {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const senderId = msg.member_id;
    // Frame-type decision (S294): playback_sync is a server-echoed STATE
    // REPORT, not a command. The server broadcasts it to EVERY group member —
    // stamped with the HOST id (SyncPlayManager::handlePlaybackSync excludes
    // nobody, unlike play/pause/seek which exclude the sender) — so the host's
    // own authoritative frame comes back to it, and in a one-member room that
    // frame is the ONLY re-anchor source. Consuming our own playback_sync is
    // therefore required. COMMAND frames keep the self-echo drop (see
    // handlePlayback/handleSeek — acting on our own commands would loop).
    // M-SYNCPLAY-12: even a STATE REPORT needs a finite numeric position to be
    // worth re-anchoring on — with a malformed one there is nothing to
    // re-anchor to, and defaulting 0 would soft-seek every consumer away from
    // where the reporter actually is. Drop the frame; the is_playing and
    // server_time fallbacks below stay (those defaults are truthful).
    const position = this.positionOrDrop(msg.position);
    if (position === null) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    const isPlaying = typeof msg.is_playing === 'boolean' ? msg.is_playing : false;
    // Carrier unit normalization (M-SYNCPLAY-04): the `:8097` echo arrives in
    // UNIX seconds, the hub echo in ms — consumers get ms either way.
    // M-SYNCPLAY-19: non-finite stamps take the same honest fallback.
    const serverTime = SyncPlayClient.serverTimeOrNow(
      msg.server_time,
      () => this.getSynchronizedTime(),
    );
    // S446 soft-correction carry (M-SYNCPLAY-08): the `:8097` server unicasts
    // a `nudge` object on the directed out-of-sync frame
    // (`SyncPlayManager.php:1569-1585`) riding this SAME type. Before this it
    // was dropped on the floor here, so embedders could not implement the
    // owner-ruled "nudge, never seek" correction at all. Delivered as the
    // 5th (additive, BREAKING-free) argument; `undefined` whenever the frame
    // carried none — the group echo and every hub-relay frame.
    const nudge = SyncPlayClient.normalizeNudge(msg.nudge);
    this.options.onPlaybackSync?.(senderId, position, isPlaying, serverTime, nudge);
  }

  private handleTimeSync(msg: RawMessage): void {
    // Server wire truth: SyncPlayManager.php:1650-1658 — seven fields, mixed
    // units, NO `client_time`. Parse-at-the-boundary: an advisory snapshot is
    // only meaningful whole, so a frame failing the real shape is DROPPED
    // (handleGroupList precedent). The pre-fix code read the fabricated
    // `client_time` off the frame and defaulted it to 0, handing consumers a
    // timestamp that never existed on any socket.
    const payload = msg as Partial<TimeSyncPayload>;
    // M-SYNCPLAY-19: the four numeric fields must be FINITE numbers — a
    // `1e999` stamp would otherwise reach consumers typed as real ms.
    if (
      typeof payload.member_id !== 'string' ||
      typeof payload.group_id !== 'string' ||
      !(typeof payload.server_time === 'number' && Number.isFinite(payload.server_time)) ||
      !(typeof payload.offset_ms === 'number' && Number.isFinite(payload.offset_ms)) ||
      !(typeof payload.latency_ms === 'number' && Number.isFinite(payload.latency_ms)) ||
      !(typeof payload.drift_rate === 'number' && Number.isFinite(payload.drift_rate)) ||
      typeof payload.is_stable !== 'boolean'
    ) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    this.options.onTimeSync?.({
      memberId: payload.member_id,
      groupId: payload.group_id,
      serverTimeSec: payload.server_time,
      offsetMs: payload.offset_ms,
      latencyMs: payload.latency_ms,
      driftRate: payload.drift_rate,
      isStable: payload.is_stable,
    });
  }

  private handleGroupList(msg: RawMessage): void {
    const payload = msg as Partial<GroupListResponsePayload>;
    // The reply envelope is `{groups, count}` on BOTH carriers; only `groups`
    // is surfaced to consumers (`count === groups.length` there, so it is
    // derivable — see SPEC §4 group_list reply block).
    const groups = payload.groups;
    if (!Array.isArray(groups)) {
      this.options.onFrameDropped?.('malformed', msg);
      return;
    }
    // CONSOLIDATED M10: the filter below IS the element-level guard, sharing
    // normalizeMembers' law — `groups: [null]` used to throw mid-fold. It
    // drops non-object rows without re-ordering; map() still normalizes each
    // surviving row's FIELDS.
    // Parse-at-the-boundary against the REAL producer keys (server
    // groupSummary() :1740-1750, hub handleCanonicalGroupList() :1938-1943 —
    // every key always emitted, so each row is total-typed, never optional).
    const rows = groups.filter((g) => typeof g === 'object' && g !== null);
    const list: GroupListSummaryRow[] = rows.map(
      (g): GroupListSummaryRow => ({
        id: typeof g.id === 'string' ? g.id : '',
        name: typeof g.name === 'string' ? g.name : '',
        member_count: SyncPlayClient.finiteOr(g.member_count, 0), // M-SYNCPLAY-19
        has_password: typeof g.has_password === 'boolean' ? g.has_password : false,
        current_media: typeof g.current_media === 'string' ? g.current_media : null,
        is_playing: typeof g.is_playing === 'boolean' ? g.is_playing : false,
      }),
    );
    this.options.onGroupList?.(list);
  }

  // --- Internals -----------------------------------------------------------

  private dispatch(type: SyncPlayMessageType, payload: Record<string, unknown>): void {
    this.send(encodeMessage(type, payload, this.now));
  }
}
