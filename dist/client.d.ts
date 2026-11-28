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
import { type NowFn } from './framing';
import { type GroupListSummaryRow, type PlaybackQueueItem, type PlaybackSyncNudge, type RawMessage, type SyncPlayGroup, type TimeSyncState, type UnknownFrame } from './messages';
import { TimeSync } from './time-sync';
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
     *    adopted id is installed — via {@link SyncPlayClient.adoptServerIdentity}
     *    (S-syncplay-03: driven from {@link SyncPlayClientOptions.onIdentityMismatch},
     *    the seam replacing the rebuild-the-client workaround every platform
     *    hand-rolled), by rebuilding the client, or host UX gated on
     *    `group.host_id === yourId` from `onState` — `isHost()` and the
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
     * (phlix-server `SyncPlayManager.php:1939`/`:1995` @ `262f01d3`, phlix-hub
     * `SyncPlayRelayWorker.php:2251-2256` @ `65a0bc9d`).
     *
     * phlix-syncplay-008: the delivered group is the library's STORED object —
     * `===` what `getGroup()` returns and frozen at the store (scope named on
     * {@link SyncPlayClient.freezeGroup}): safe to keep and read, writes throw
     * (strict-mode consumers) or are ignored (legacy sloppy scripts), never
     * silently corrupt the model the next fold diffs against.
     *
     * S-syncplay-03: the hand-rolled `yourId === getMemberId()` compare this
     * docblock used to be the ONLY mismatch surface now has a dedicated sibling
     * hook — {@link SyncPlayClientOptions.onIdentityMismatch} (observe) plus
     * {@link SyncPlayClient.adoptServerIdentity} (enforce).
     */
    onState?: (_group: SyncPlayGroup, yourId: string | undefined) => void;
    /**
     * S-syncplay-03 (finding phlix-syncplay-003, High): an accepted
     * `syncplay_group_state` carried a `your_id` — the identity THE SERVER
     * stamped for THIS connection (SPEC §9) — that CONTRADICTS the id this
     * client currently holds. Fires per contradicting frame with the
     * server-stamped id first and the client-held id second, AFTER that frame's
     * {@link SyncPlayClientOptions.onState} delivery (the c14
     * onNudge-after-onPlaybackSync ordering precedent; a throwing `onState`
     * short-circuits it — THROW LAW, class header).
     *
     * WHY: the ctor `memberId` MUST equal the stamped identity for `isHost()`
     * and the echo suppressions to function (SPEC §9.2). The hub relay `:8804`
     * stamps a per-connection uuid that is unknowable before the first frame,
     * and a fabricated direct-`:8097` id (mobile's `memberId: 'mobile_*'`
     * class) makes `isHost()` permanently false and self-echo double-apply.
     * Pre-seam the contradiction surfaced only as the raw `yourId` argument —
     * enforcement was a hand-rolled compare on every platform, which is exactly
     * how it went missing. The seam splits the two halves:
     *  - OBSERVE: this hook names the contradiction without acting on it;
     *  - ENFORCE: {@link SyncPlayClient.adoptServerIdentity} from this handler
     *    installs the server-stamped id (SPEC §9.2's consumer-adopts-it path,
     *    first-class), or rebuild the client, or keep the ghost id by choice.
     *
     * The library NEVER self-adopts: a contradicting `your_id` changes no state
     * until the consumer acts (SPEC §9.2 — "the consumer adopts it"; silently
     * rewriting on first sight would mask the ghost-identity class instead of
     * naming it). Absent by default — existing consumers and option shapes are
     * untouched; a non-string or missing `your_id` is not a contradiction
     * (`undefined` only on hand-built frames, real producers always stamp —
     * nothing to compare against nothing).
     */
    onIdentityMismatch?: (_serverYourId: string, _clientMemberId: string) => void;
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
    onMemberJoined?: (_member: {
        id: string;
        name: string;
    }) => void;
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
    onMemberLeft?: (_member: {
        id: string;
        name: string;
    }) => void;
    /**
     * The group host changed (`syncplay_host_elect`). Firing law
     * (S-syncplay-41, finding phlix-syncplay-052): announced only on a
     * REAL transition — a `host_elect` re-announcing the already-cached
     * `host_id` (the duplicate-replay class: the wire has no frame-dedupe
     * field, §4 known limits) is a whole no-op, no callback and no store
     * write. The roster-eviction branch keeps its fire, and the ungrouped
     * named exception (LW-047) announces with no cached group to compare
     * against. See `handleHostElect`.
     */
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
     *
     * The union mixes TWO casing dialects: the legacy SCREAMING names (the
     * legacy 12 lead with `NOT_AUTHENTICATED`/`NOT_IN_GROUP`/`NOT_HOST`) and the
     * dotted twins — 12 + 8 = 20 names measured at `#v0.5.8` (`messages.ts`
     * lineage, pinned by `test/errorCodeUnion.test.ts`). An exhaustive switch
     * covers both; a dotted/snake-only expectation is the surprise, not the
     * wire (phlix-syncplay-042).
     */
    onError?: (_code: string, _message: string, _details?: Record<string, unknown>) => void;
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
     * An {@link SyncPlayClient.adoptServerIdentity} seam-adoption reconciles
     * it for the COMMAND arms but changes nothing here: chat stays echo-live
     * by carrier wire law regardless (the paragraph above).
     * Consumers render chat from THIS callback only (do not also locally
     * append on {@link SyncPlayClient.sendChat}) and are correct on both
     * carriers by construction.
     *
     * `_timestampMs` is the envelope `timestamp` — the server's send time,
     * authoritative MILLISECONDS on both carriers (S417;
     * `Messages.php:924-927`, `SyncPlayRelayWorker.php:1230`). `undefined` on
     * hand-built frames that omitted it AND on stamps that fail the shared
     * sane-stamp law ({@link SyncPlayClient.serverTimeOrNow}'s finite AND ≥1000
     * AND LW-050-window core, phlix-syncplay-049 — a forged epoch-zero or
     * uptime-magnitude value reads as no trustworthy stamp; a seconds-form
     * forged stamp is promoted ×1000 at the decode boundary); the library never
     * fabricates a send time.
     */
    onChat?: (_memberId: string, memberName: string, message: string, _timestampMs?: number) => void;
    /**
     * The group host transferred to another member (TYPE_HOST_TRANSFER /
     * syncplay_host_transfer). DEFENSIVE-ONLY arm: §3 types the frame
     * client → server, and no live producer emits it inbound — the server's
     * `handleHostTransfer` AND the hub's `handleCanonicalHostTransfer` both
     * answer with a broadcast `syncplay_group_state` (the new host rides
     * `group.host_id` into `onState`). The handler is kept in case a producer
     * ever appears; build transfer UX on `onState` — `syncplay_host_elect` /
     * `onHostChanged` fires only on host DEPARTURE (SPEC §3/§4.4/§6).
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
     *
     * Implementing the policy on this callback is possible but was
     * demonstrably MISSABLE (phlix-syncplay-017: both adopted consumers bound
     * fewer than five parameters and collapsed the nudge away). Bind
     * {@link SyncPlayClientOptions.onNudge} instead for the rate correction —
     * it is the dedicated, un-missable surface; this 5th argument stays for
     * the M-SYNCPLAY-08 frame-family delivery law.
     */
    onPlaybackSync?: (_memberId: string, position: number, isPlaying: boolean, _serverTime: number, nudge?: PlaybackSyncNudge) => void;
    /**
     * S446 rate-policy delivery, dedicated hook (phlix-syncplay-017): fires
     * ONLY when a `syncplay_playback_sync` frame carried a `nudge` object —
     * the directed out-of-sync correction the `:8097` server unicasts to the
     * drifting member (`SyncPlayManager.php:1569-1585`). The group echo and
     * every hub-relay frame carry no nudge and fire NOTHING here (absent ≠
     * zeroed, SPEC §4/§8.4).
     *
     * WHY A SECOND SURFACE: one five-positional-arg callback serving both
     * "state report (usually ignored)" and "act-now policy" lost the policy
     * half in adoption — positional arity collapse. A NAMED option makes
     * ignoring the correction a visible, deliberate omission. Apply
     * `nudge.suggested_rate` as the server's "nudge, never seek" policy
     * (`GroupState.php:39`) commands — do NOT seek in response.
     *
     * `_memberId` is the frame's `member_id`: per wire law the DRIFTING
     * MEMBER's own id on a directed frame (recipient is the one nudged,
     * `SyncPlayManager.php:1570`). `_nudge` is the SAME normalized object
     * delivered as the 5th {@link onPlaybackSync} argument (per-field
     * narrowing, every field optional). Ordering: fires after
     * `onPlaybackSync` for the same frame; like every callback here it is
     * invoked straight (THROW LAW, class header) — an `onPlaybackSync` that
     * throws short-circuits it, and a refused frame
     * ({@link onFrameDropped} `'malformed'`) never reaches either hook.
     */
    onNudge?: (_memberId: string, _nudge: PlaybackSyncNudge) => void;
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
     *    non-object, missing string `type`); `_frame` is the raw inbound value —
     *    the attacker-chosen bytes themselves: **untrusted** input, sanitize
     *    before logging or rendering (injection/ANSI-escape class) on that arm
     *    (phlix-syncplay-058).
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
export declare class SyncPlayClient {
    private readonly send;
    private readonly now;
    /**
     * This client's CURRENT identity — the ctor `memberId` unless a consumer
     * replaced it through {@link SyncPlayClient.adoptServerIdentity}
     * (S-syncplay-03). NOT readonly: the seam exists because a ghost ctor id
     * permanently inerts `isHost()` and the echo suppressions, and rebuilding
     * the client to recover was the workaround every platform hand-rolled. The
     * CLASS never rewrites it on its own initiative (SPEC §9.2 — the consumer
     * owns the adoption; silently rewriting on first sight would mask the
     * ghost-identity class instead of naming it). All reads are live field
     * reads, so an adoption takes effect on the next decision with no other
     * reconfiguration — delivered frozen `group_state` snapshots are never
     * touched by it (c08 replace-only store law).
     */
    private memberId;
    private readonly memberName;
    private readonly options;
    private readonly timeSync;
    /** Coalescing window for sendSeek, ms; 0 = off (passthrough, timer-free). */
    private readonly seekThrottleMs;
    /** True while a coalescing window is open (a trailing flush timer is armed). */
    private seekWindowOpen;
    /** The LAST (from,to) pair seen during the open window — latest-wins merge. */
    private pendingSeek;
    /** The single owned flush timer (present only while {@link seekWindowOpen}). */
    private seekFlushTimer;
    private group;
    /**
     * S-syncplay-25 (finding phlix-syncplay-030): the monotonic-stamp watermark
     * for the opportunistic `group_state` replay guard — the trusted envelope
     * stamp ({@link SyncPlayClient.saneServerStamp}, unit-normalized to ms) of
     * the LAST ADOPTED fold, scoped to that fold's room. Single slot, not a
     * map: the replay class this cures is the same-room echo/backlog, and a
     * stale stamp for a DIFFERENT room must still adopt (cross-room replays
     * are never the convicted case — the slot moves with the adoption).
     * Written ONLY on adoption — a refused frame moves neither the store nor
     * the watermark. Deliberately NOT reset by `leaveGroup()`/`onDisconnect()`:
     * in-flight stale backlog after a reconnect IS the replay class, and fresh
     * server send-time stamps always outrank a surviving watermark (both live
     * producers re-stamp every frame at emit — SPEC §10.1).
     */
    private stateFoldStamp;
    /**
     * S-syncplay-17 (finding phlix-syncplay-020): the intended-membership latch.
     * `handleGroupState` adopts a room ONLY while this is armed, so an in-flight
     * `group_state` echo that arrives AFTER a voluntary `leaveGroup()` can no
     * longer re-materialize the room we just left. Armed at construction (a
     * server-pushed first state is a legitimate adoption — SPEC §10.1 item 2's
     * fresh-state paths must not need a join call to function); disarmed by
     * `leaveGroup()` before its `group_leave` ships (SPY-5 unwind-before-send:
     * a throwing sink still leaves AND still disarms); re-armed by every
     * explicit `joinGroup()`/`createGroup()` before their dispatch.
     * `onDisconnect()` deliberately does NOT disarm (involuntary — resuming the
     * room by adopting the next state is lawful recovery), and `destroy()`
     * needs no latch write: the LW-046 routing halt already admits zero frames.
     */
    private intendsMembership;
    /**
     * LW-046: latch set by {@link SyncPlayClient.destroy}. The m18 docblock
     * already promised INERTY — this is the field that makes it true: inbound
     * routing, the void senders and the coalescer re-arm all consult it, and
     * the instance owns no timers past `destroy()` even when a `send` sink
     * re-enters the class mid-dispatch.
     */
    private destroyed;
    /** Local t1 of the most recent outstanding ping, ms. */
    private lastPingSendTime;
    /** SPY-S7: connection generation; bumped by onDisconnect. */
    private connectionEpoch;
    /** SPY-S7: the generation `lastPingSendTime` was stamped in. */
    private pingEpoch;
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
    private consecutiveSyncRejections;
    constructor(options: SyncPlayClientOptions);
    /**
     * Parse the seek-throttle window at the constructor boundary: accepted
     * domain = a finite number ≥ 0 (0 = off). Anything else is a
     * misconfiguration that must halt, not a value to silently re-default —
     * a consumer that asked for throttling and got a different number would
     * be tuning against a phantom.
     */
    private static parseSeekThrottleMs;
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
    private static parsePasswordHash;
    /**
     * SPY-16: outbound position guard (mirror of the inbound finite law) —
     * a position that is not a finite number >= 0 is a caller bug that would
     * serialize to `null` (NaN/Infinity) or a negative on the wire. Throw
     * before any state change or dispatch.
     */
    private static assertPosition;
    /** The TimeSync instance (for status/offset queries). */
    getTimeSync(): TimeSync;
    /**
     * The current group, or null if not in one.
     *
     * phlix-syncplay-008: the returned object IS the library's stored model,
     * frozen at every store (see {@link SyncPlayClient.freezeGroup} for the
     * exact scope). Reading and keeping the reference is the contract; writing
     * throws (strict-mode consumers) instead of corrupting the library's state
     * and the next fold's diff baseline.
     */
    getGroup(): SyncPlayGroup | null;
    /** This member's id. */
    getMemberId(): string;
    /**
     * True if this member is the current host of the current group — i.e.
     * `group.host_id === this.memberId`, the server-stamped host against the
     * CURRENT id (the ctor value unless a {@link SyncPlayClient.adoptServerIdentity}
     * seam-adoption replaced it — S-syncplay-03; the read is live, so an
     * adoption flips this immediately). Sound only under the identity coupling
     * documented on {@link SyncPlayClientOptions.memberId}: with a
     * fabricated/mismatched ctor id this is permanently false for a true host
     * (the dead-host bug class, SPEC §9) until the consumer reconciles through
     * the seam. Server truth: `host_id` is always the derived id
     * (`SyncPlayManager.php` groups key members by `$connection->getUserId()`;
     * hub rooms key by `$client->clientId`, `SyncPlayRelayWorker.php:1396`).
     */
    isHost(): boolean;
    /**
     * S-syncplay-03 (finding phlix-syncplay-003, High): install the
     * server-stamped identity — SPEC §9.2's hub-relay adoption path promoted
     * from a per-platform rebuild workaround to a first-class seam.
     *
     * CONSUMER-DRIVEN BY DESIGN: the class never calls this itself and never
     * rewrites the ctor id on its own initiative — silently adopting on first
     * sight would mask the ghost-identity class instead of naming it (the law
     * on {@link SyncPlayClientOptions.memberId}). The intended call site is the
     * {@link SyncPlayClientOptions.onIdentityMismatch} handler (or anywhere a
     * consumer holds `onState`'s `yourId`): the consumer that wants server
     * truth calls this with the server-stamped id; consumers that want the old
     * behavior call nothing and change nothing.
     *
     * Once installed, EVERY identity decision uses it live:
     * {@link SyncPlayClient.isHost}, the play/seek echo suppressions, the
     * `member_id`/`user_id` stamps on outbound frames, and the
     * `departed === me` check in `handleHostElect`. Delivered `group_state`
     * snapshots are NOT rebuilt or written into — the replacement is a field
     * swap, never an in-place write to a frozen delivered frame (c08 store law).
     *
     * Boundary rules follow the house order (cf. {@link SyncPlayClient.createGroup}
     * / LW-045): a bad-shape argument THROWS a TypeError even on a destroyed
     * instance — the accepted domain is a non-empty string (both carriers only
     * ever stamp non-empty ids: JWT subject / per-connection uuid); after the
     * parse, a destroyed instance is inert (LW-046) and returns false; an id
     * equal to the current one is a no-op returning false. TRUE only when an
     * actual replacement happened.
     *
     * Reconnect: {@link SyncPlayClient.onDisconnect} does NOT revert an
     * adoption — identity is not transport history. A hub re-dial stamps a NEW
     * per-connection uuid, which surfaces as a fresh
     * {@link SyncPlayClientOptions.onIdentityMismatch} on the first frame after
     * the rejoin; re-adopting is the consumer's decision again.
     */
    adoptServerIdentity(serverYourId: string): boolean;
    /** Server-synchronized current time (ms). */
    getSynchronizedTime(): number;
    /**
     * SYNC-READINESS (SPEC §5, finding phlix-syncplay-018): `true` once at least
     * one TIME_PONG sample has been accepted, i.e. getSynchronizedTime() answers
     * with a server-verified clock instead of the raw local one. Readiness is ONE
     * accepted sample — deliberately NOT isStable() (SPEC §5 STABLE_OFFSETS):
     * waiting for stability would stall first stamps for the whole buffer warm-up.
     * While false, the outbound playback senders below OMIT `server_time`
     * entirely (§4.2 echo law: the server's `?? time()` arm owns the absence);
     * stamping an unverified skew would anchor the entire room to it.
     */
    isSyncReady(): boolean;
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
     *
     * Hub-relay caveat (phlix-syncplay-057): on the hub relay (`:8804`) this
     * group password is inert — the hub's canonical create/join lanes collapse
     * into `handleCanonicalJoin`, which accepts-and-ignores `password_hash` and
     * `password` (phlix-hub `SyncPlayRelayWorker` @ b7ad2a3e). The room lives
     * inside the caller's own `(server_id, owner)` scope, and that scope is the
     * real gate on that carrier. Password enforcement exists only on the server
     * `:8097` direct path (`SyncPlayManager` + `JoinPasswordThrottle`).
     * See SPEC §8.2.
     */
    createGroup(groupName: string, passwordHash?: string): void;
    /**
     * Join an existing group by id. `passwordHash` is SHA-256 hex.
     *
     * SECURITY (see SPEC §8/§9): the `member_id` on this frame is **self-asserted**
     * and MUST NOT be trusted for authorization — the server derives the effective
     * id from the authenticated connection. `passwordHash` is an unsalted,
     * **replayable** SHA-256 group gate, not an identity.
     *
     * Hub-relay caveat (phlix-syncplay-057): on the hub relay (`:8804`) this
     * group password is inert — the hub accepts-and-ignores `password_hash` and
     * `password` on the canonical join lane, so a password-protected group is
     * NOT gated on that carrier; the caller's own `(server_id, owner)` scope is.
     * Enforcement is server-`:8097`-direct only. See {@link createGroup} and
     * SPEC §8.2.
     */
    joinGroup(groupId: string, passwordHash?: string): void;
    /**
     * Leave the current group. Returns whether the LEAVE frame actually
     * dispatched — `false` with no cached group (CONSOLIDATED m4: the silent
     * void no-op gave wrappers no way to show "still joining").
     *
     * S-syncplay-17: the leave is VOLUNTARY, so it also disarms the
     * intended-membership latch — a late `group_state` echo for the room just
     * left is refused whole (`SPEC §10.1`, finding phlix-syncplay-020). Only an
     * explicit `joinGroup()`/`createGroup()` re-arms.
     */
    leaveGroup(): boolean;
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
    sendPlay(position: number): boolean;
    /**
     * Host command: pause at `position` (ms). Boolean law per {@link sendPlay}.
     *
     * @throws TypeError on non-finite or negative position
     */
    sendPause(position: number): boolean;
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
    sendSeek(fromPosition: number, toPosition: number): boolean;
    /**
     * Convenience for the "jump to" case (phlix-syncplay-059): seek the group to
     * `toPosition` (ms) using the CACHED group's
     * {@link SyncPlayGroup.playback_position} as the seek origin, instead of
     * forcing every caller to carry its own `fromPos` (the shape that left a
     * `fromPos = 0` stub in consumers — fabricating the origin is exactly the
     * lie this method exists to remove). The cached read is safe by S-syncplay-08:
     * the stored snapshot is frozen, and this method NEVER mutates it — it
     * forwards the freshly-read number into {@link sendSeek} and touches nothing.
     *
     * Coalescing is sendSeek's: with {@link SyncPlayClientOptions.seekThrottleMs}
     * on, a burst of `seekTo` calls merges latest-wins into one trailing frame,
     * and a `seekTo` mixed with explicit two-arg `sendSeek` calls shares the same
     * window. The boolean law is sendSeek's too (CONSOLIDATED m4): `false` with
     * no cached group, `true` when the intent was accepted for the wire.
     *
     * Every store-site folds `playback_position` through `clampedPosition`, so a
     * stored group always carries a finite number >= 0; the guard below is a
     * backstop for a future nulling path (same defensive precedent as the
     * vanished-group arm in `closeSeekWindow`) and REFUSES rather than dispatch a
     * seek whose origin it cannot name.
     *
     * @throws TypeError on non-finite or negative toPosition
     */
    seekTo(toPosition: number): boolean;
    /** The single PLAYBACK_SEEK wire point — leading and trailing edges share it. */
    private dispatchSeek;
    /** Arm the window's trailing flush. This is the library's ONLY owned timer. */
    private openSeekWindow;
    /**
     * Window boundary: flush the latest coalesced target as ONE trailing frame
     * and immediately re-arm (a continued hold is then rate-capped at one frame
     * per window); with nothing pending, close cleanly and own no timer.
     */
    private closeSeekWindow;
    /** Drop any coalesced intent and disarm the window (leave/disconnect). */
    private cancelSeekCoalescing;
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
    reportPosition(position: number, isPlaying: boolean): boolean;
    /**
     * Request the group list (`syncplay_group_list`, SPEC §4.1 — bare request,
     * no fields). The reply arrives through
     * {@link SyncPlayClientOptions.onGroupList}. Callable outside a group (that
     * is its point); returns `false` only on a destroyed instance. `true` means
     * the frame was handed to the `send` sink, not that the server answered.
     */
    listGroups(): boolean;
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
    sendQueue(queue: ReadonlyArray<Pick<PlaybackQueueItem, 'media_id' | 'media_info'>>): boolean;
    /**
     * Host command: hand the host role to `newHostId`
     * (`syncplay_host_transfer`, SPEC §4.4: `group_id`, `current_host_id`,
     * `new_host_id`). `current_host_id` is this client's self-asserted
     * `memberId` (the server authorizes by the authenticated connection).
     * NOT_HOST-gated; the answer is a state re-fold, never an inbound
     * `host_transfer` frame: the `:8097` server (`SyncPlayManager`) and the
     * hub relay (`handleCanonicalHostTransfer`) BOTH answer with a fresh
     * broadcast `syncplay_group_state` — the new host rides `group.host_id`
     * into the state delivered by {@link SyncPlayClientOptions.onState}.
     * Build transfer UX on `onState`: `syncplay_host_elect` →
     * {@link SyncPlayClientOptions.onHostChanged} stays scoped to host
     * DEPARTURE on both carriers (SPEC §4.4/§6; see M-SYNCPLAY-03), never
     * the voluntary-transfer answer. Do not build on the defensive-only
     * `onHostTransfer` arm — zero live producers (see its own doc). Boolean
     * law per {@link sendPlay}.
     *
     * @throws TypeError when `newHostId` is not a non-empty string
     */
    transferHost(newHostId: string): boolean;
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
    sendChat(message: string): boolean;
    /**
     * Announce typing state (`syncplay_typing`, {@link SyncPlayClientOptions.onMemberTyping}
     * is the inbound arm). Shape mirrors `Messages::chatTyping` (phlix-server
     * `Messages.php:604-614` @ `262f01d3`). Producers read `is_typing` as `=== true` or the
     * legacy `'1'` string (server `SyncPlayManager.php:1485`, hub
     * `SyncPlayRelayWorker.php:2623-2625` @ `65a0bc9d`) — a real boolean passes cleanly.
     * Identity is again server-derived (S289 :1473-1474). Unlike chat, the typing
     * fan-out EXCLUDES the sender (server `[$memberId]` :1490, hub
     * `$client->clientId` :2629), so your own indicator never echoes back, and
     * guard misses are SILENT for typing on both producers (no error frames for
     * a transient indicator — there is nothing to observe beyond the peers'
     * view).
     */
    sendTyping(isTyping: boolean): boolean;
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
     *
     * The pacing itself is reusable: `startPinger()` (SPEC §5) wraps this same
     * law — through the shared `timePingAllowed` predicate — into a loop a
     * consumer drives with its own injected scheduler (finding phlix-syncplay-004).
     */
    pingTime(): void;
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
    onDisconnect(): void;
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
    destroy(): void;
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
    handleIncoming(raw: unknown): void;
    private handleTimePong;
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
    private static normalizeMembers;
    /**
     * phlix-syncplay-008: parse-at-the-boundary immutability law. Every object
     * ever stored in `this.group` is the SAME reference `getGroup()` returns,
     * `onState` delivers, and the next fold's roster-diff reads as `previous`
     * — pre-fix a consumer writing into a handed-out group mutated the
     * library's live model (and corrupted that diff baseline: a renamed or
     * ghost-pushed member surfaced as a false `onMemberLeft` event, a clobbered
     * position poisoned every later reader). Every internal change is a
     * whole-object REPLACE — this fold, {@link foldHostId}, and the queue fold
     * all build fresh objects and never assign a field of the stored one — so
     * freezing at the store costs the library nothing and closes the corruption
     * vector for ALL hand-out paths at once.
     *
     * Frozen scope, stated exactly (no deep-freeze overclaim): the group object
     * itself, its `members` array and every member object, and — when present —
     * its `queue` array and every queue ITEM. That is the whole consumer model:
     * `SyncPlayGroup` carries nothing else but primitives on these two arrays.
     * The one open island is each item's `media_info` — an opaque wire record,
     * shared by reference with the decoded frame; a write inside it is invisible
     * to the library's folds and the diff baseline — the library never reads
     * media_info — but it is NOT isolated from other consumers: the record is
     * part of the delivered graph, so writes there remain observable via
     * getGroup()/onState until the next store replaces the item. An assignment
     * to a frozen surface THROWS in strict-mode consumers (ESM and all
     * TS-emitted modules are strict) and is silently ignored in legacy sloppy
     * scripts — method writes like `push` on a frozen array throw in either
     * mode — either way the stored model stays pristine. The TS type stays
     * mutable (changing public type shape is another step's surface); the
     * immutability is the runtime law documented at every hand-out.
     */
    private static freezeGroup;
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
    private static foldHostId;
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
    static serverTimeToMs(raw: number): number;
    /**
     * THE shared sane-stamp decision (phlix-syncplay-049 unification): a wire
     * stamp is trusted only when it is a FINITE number, ≥ 1000, and inside one
     * of the two plausible wall-clock windows; a trusted stamp is then
     * unit-normalized via {@link serverTimeToMs}. Consumed by
     * {@link serverTimeOrNow} (the `server_time` arms with a clock-estimate
     * fallback) and by the chat envelope stamp (where the honest alternative is
     * `undefined` — the library never fabricates a send time).
     *
     * CONSOLIDATED m3 (review gameux m1): epoch-zero / negative stamps are the
     * exact "+56 years teleports the playhead" failure {@link serverTimeToMs}'s
     * docblock cites — `server_time: 0` used to fold into 0 ms and poison every
     * interpolation. No honest wall clock on EITHER carrier scale reads below
     * 1000 (that is 1970-01-01T00:16:40Z), so it reads as no trustworthy stamp
     * at all. LW-050 (review syncplay__secnet #5): the finite gate alone
     * BELIEVED any magnitude — a monotonic-uptime clock reading 9e11 "ms"
     * normalized to 9e14 (year ~30540) and teleported every interpolating
     * consumer. Trust is therefore bounded to `≥ 1e12` (epoch ms, real since
     * 2001-09) and `[1e9, 4e9)` (epoch seconds, 2001-09 → 2096-11). Deliberately
     * ABSOLUTE (not estimate-relative): a fake `now`-clock in tests must never
     * change what a real-epoch stamp is worth. The ≥ 1000 floor is subsumed by
     * the windows at current bounds — it is the retained m3 defense-in-depth,
     * not an independent acceptance leg.
     */
    private static saneServerStamp;
    /**
     * The one `server_time` acceptance law shared by the three consumers
     * (playback / seek / playback_sync, M-SYNCPLAY-12 set): a trusted stamp per
     * {@link saneServerStamp} (FINITE, ≥ 1000, LW-050 window — unit-normalized)
     * is returned; anything else (absent, non-numeric, `1e999` → `Infinity`,
     * implausible magnitude — M-SYNCPLAY-19 / LW-050) yields the caller's honest
     * clock-estimate fallback.
     */
    private static serverTimeOrNow;
    /**
     * phlix-syncplay-028 cure: the `time_pong` t2 gate was FINITE-only, so a
     * plausible-looking-but-absurd wall stamp (the report's epoch-SECONDS
     * 1.77e9 into an epoch-ms round, or a 9e11 uptime) was believed raw. With
     * t3 == t2 the estimator's rtt never contains t2, so such a sample passes
     * every RTT bound and poisons the offset average by ~1e12 — silently, for
     * the life of the connection. On a REAL-clock round (t1 itself inside the
     * LW-050 window) t2 now rides the same consumer-bound decision every other
     * `server_time` arm uses — {@link serverTimeOrNow} with the seconds-vs-ms
     * scale promotion — and an out-of-window magnitude yields null: the counted
     * rejection path (LW-043), refusing the sample WITHOUT writing state or
     * firing a callback it shouldn't. Synthetic-era rounds (t1 < 1e9 — the
     * ratified LW-049 fall-through territory, and every integer-ms test clock
     * in the estate) keep the legacy finite-only behavior bit-identically.
     */
    private static pongServerTimeOrReject;
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
    private static normalizeQueue;
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
    private static normalizeNudge;
    /**
     * Boundary coercion for wire strings (W-min124 M-SYNCPLAY-19, review
     * `syncplay__secnet` MINOR-3): `?? fallback` only catches null/undefined, so
     * a hub-relay bug or hostile relay could flow a NUMBER or OBJECT into fields
     * typed `string`/`string | null` — the model then lies and every
     * `=== hostId`-style derivation silently breaks. Non-strings fall back
     * exactly like an absent field did before.
     */
    private static strOr;
    private static strOrNull;
    /**
     * Numeric counterpart of {@link strOr} (M-SYNCPLAY-19): `JSON.parse` happily
     * yields `Infinity` for `1e999` and it passes a bare `typeof === 'number'`
     * check, then flows into player sinks (`currentTime = Infinity` throws in
     * browsers) and poisons the TimeSync offset average. Only FINITE numbers
     * are accepted; anything else takes the documented fallback.
     */
    private static finiteOr;
    private static finiteOrUndefined;
    /**
     * Nudge rate domain (CONSOLIDATED m2): the server's only emitted values are
     * `1 ± 0.1`, so anything outside `[0.9, 1.1]` has no honest producer and
     * reads as absent. A future band change is a WIRE-LAW edit: widen here only
     * together with the SPEC §4 nudge section (never silently).
     */
    private static nudgeRateOrUndefined;
    /** Finite AND non-negative ms (CONSOLIDATED m2): tolerance/cooldown domain. */
    private static nonnegOrUndefined;
    /**
     * The `null` twin of {@link nonnegOrUndefined} — and the duration-domain
     * parse for the `group_state` fold. phlix-syncplay-048 (FUZZ R-004): a
     * finite NEGATIVE `current_media_duration` has no honest producer, and
     * because every ceiling law in this client is keyed `duration > 0`
     * ({@link clampedPosition}, {@link positionOrDrop}), storing one would
     * silently disarm the position clamp while advertising a bogus duration to
     * every `onState` consumer. The boundary treats it exactly like an absent
     * field (`null` = duration unknown, the documented LW-042 shape). Zero
     * stays honest: a freshly-created room genuinely reports 0 (fold-pinned).
     */
    private static nonnegOrNull;
    /**
     * Inbound-position acceptance law (CONSOLIDATED m2 + the M6 clamp arm made
     * executable): finite, never negative (no honest producer for a <0
     * position — that frame class already refuses the 0-teleport family, the
     * sign is the same question), and clamped to the cached group's
     * `current_media_duration` when one is known — the SPEC §5/M6 consumer
     * clamp duty inherited by every wrapper that delegates here. `null` =
     * garbage; each caller drops the frame via its existing precedent.
     */
    private positionOrDrop;
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
    private static clampedPosition;
    /**
     * Membership-check `playback_state` against the canonical four (SPEC §4,
     * `PlaybackState` in `messages.ts`); anything else degrades to `'stopped'`
     * (M-SYNCPLAY-19). A cast through this guard is the difference between a
     * consumer `switch` that always lands on a real case and one that matches
     * nothing while the model claims `PlaybackState`.
     */
    private static playbackState;
    private handleGroupState;
    private handlePlayback;
    private handleSeek;
    /**
     * HOST_ELECT handler. LW-047 (review syncplay__crossfe): the `group ===
     * null` fall-through to `onHostChanged` below is DELIBERATE and ratified —
     * host_elect is the NAMED EXCEPTION to the grouped-delivery law (SPEC §4,
     * landed with LW-044 in `9268b66`): the frame carries no `group_id` to
     * scope by, there is no cached group to fold, and banner-style consumers
     * ("host X now leads") act on the announced id alone. A future consistency
     * sweep must NOT silence this path; see test/reviewWave11L10.test.ts.
     */
    private handleHostElect;
    private handleInfo;
    private handleError;
    private handleTyping;
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
    private handleChat;
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
    private handlePlaybackQueueBroadcast;
    private handleHostTransfer;
    private handlePlaybackSync;
    private handleTimeSync;
    private handleGroupList;
    private dispatch;
}
