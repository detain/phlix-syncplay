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
 *  - the host-only playback command senders.
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
/**
 * Constructor options. `send` and `now` are required; everything else is an
 * optional callback. `send` receives the RAW message object (already framed);
 * the consumer serializes and writes it to its transport.
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
     * everything from `$connection->getUserId()`, e.g. :1056/:1154/:1297).
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
     *    `syncplay_group_state` (`SyncPlayManager.php:1799`, `:1855` —
     *    `$connection->getUserId()`); REST mutations set
     *    `$memberId = $request->userId` (`SyncPlayController.php:173`, `:267`,
     *    `:305` — S289 "identity is the authenticated JWT subject ONLY");
     *    rebroadcast commands carry the same derived sender id
     *    (`SyncPlayManager.php:1084-1093` play, `:1182-1187` seek).
     *    The consumer knows this id BEFORE dialing — it is what the login /
     *    auth layer holds.
     *  - Hub relay `:8804`: a hub-generated PER-CONNECTION uuid
     *    (phlix-hub `SyncPlayRelayWorker.php:423`, `generateClientId()`
     *    `:2107-2120`), surfaced as `your_id` on the join ack (`:1486-1491`)
     *    and used as `member_id`/`host_id` on every later frame (`:1615`,
     *    `:1796`). It is NOT knowable before the first `group_state` —
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
    /** This client's display name (sent on create/join). */
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
     * (parse-don't-validate at the options boundary).
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
    onPlaybackCommand?: (_command: PlaybackCommand) => void;
    onMemberJoined?: (_member: {
        id: string;
        name: string;
    }) => void;
    onHostChanged?: (_newHostId: string | null) => void;
    onError?: (_code: string, _message: string) => void;
    onInfo?: (_message: string) => void;
    /** A member started or stopped typing (TYPE_CHAT_TYPING / syncplay_typing).
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
    onChat?: (_memberId: string, memberName: string, message: string, _timestampMs?: number) => void;
    /** The group host transferred to another member (TYPE_HOST_TRANSFER / syncplay_host_transfer). */
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
    onPlaybackSync?: (_memberId: string, position: number, isPlaying: boolean, _serverTime: number, nudge?: PlaybackSyncNudge) => void;
    /**
     * Advisory server sync-state snapshot (TYPE_TIME_SYNC / syncplay_time_sync):
     * the server's UNICAST reply to a `syncplay_time_sync` request. Units are
     * named per-field — `serverTimeSec` is UNIX seconds (the `:8097` seconds
     * quirk), `offsetMs`/`latencyMs` are ms. Server wire truth:
     * `SyncPlayManager.php:1653-1659`. The pre-fix `(serverTime, clientTime)`
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
     * canonical `syncplay_*` types; ONLY frames whose type is NOT one of them
     * (e.g. the hub relay's `pending_command`) reach this hook — untouched, no
     * validation, no mutation. The two canonical types that used to be named
     * here as "carried but not orchestrated" — syncplay_chat,
     * syncplay_playback_queue — are ORCHESTRATED since M-SYNCPLAY-11 (they fire
     * {@link SyncPlayClientOptions.onChat} / {@link SyncPlayClientOptions.onQueueChanged});
     * they still NEVER reach this hook. This remains the extension point the old
     * default-arm comment promised; consumers route non-SyncPlay vocabulary
     * through it and the library stays protocol-pure.
     */
    onUnknownFrame?: (_frame: UnknownFrame) => void;
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
    private readonly memberId;
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
    /** Local t1 of the most recent outstanding ping, ms. */
    private lastPingSendTime;
    constructor(options: SyncPlayClientOptions);
    /**
     * Parse the seek-throttle window at the constructor boundary: accepted
     * domain = a finite number ≥ 0 (0 = off). Anything else is a
     * misconfiguration that must halt, not a value to silently re-default —
     * a consumer that asked for throttling and got a different number would
     * be tuning against a phantom.
     */
    private static parseSeekThrottleMs;
    /** The TimeSync instance (for status/offset queries). */
    getTimeSync(): TimeSync;
    /** The current group, or null if not in one. */
    getGroup(): SyncPlayGroup | null;
    /** This member's id. */
    getMemberId(): string;
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
    isHost(): boolean;
    /** Server-synchronized current time (ms). */
    getSynchronizedTime(): number;
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
    createGroup(groupName: string, passwordHash?: string): void;
    /**
     * Join an existing group by id. `passwordHash` is SHA-256 hex.
     *
     * SECURITY (see SPEC §8/§9): the `member_id` on this frame is **self-asserted**
     * and MUST NOT be trusted for authorization — the server derives the effective
     * id from the authenticated connection. `passwordHash` is an unsalted,
     * **replayable** SHA-256 group gate, not an identity.
     */
    joinGroup(groupId: string, passwordHash?: string): void;
    /** Leave the current group (no-op if not in one). */
    leaveGroup(): void;
    sendPlay(position: number): void;
    sendPause(position: number): void;
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
     */
    sendSeek(fromPosition: number, toPosition: number): void;
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
     */
    reportPosition(position: number, isPlaying: boolean): void;
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
     * No-op outside a group (sendPlay precedent — the frame's `group_id` comes
     * from the cached group).
     */
    sendChat(message: string): void;
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
    sendTyping(isTyping: boolean): void;
    /** Send a time_ping. Call periodically (e.g. every 10–30s). */
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
     * Route one inbound frame (string or parsed object). Feeds time-sync on pong,
     * applies group_state, surfaces playback commands, host changes, errors, info,
     * chat and queue updates. Frames whose type is outside the 19 canonical
     * `syncplay_*` types are surfaced via {@link SyncPlayClientOptions.onUnknownFrame};
     * the two formerly-ignored canonical types (syncplay_chat,
     * syncplay_playback_queue) are orchestrated since M-SYNCPLAY-11 through
     * {@link SyncPlayClientOptions.onChat} / {@link SyncPlayClientOptions.onQueueChanged}
     * and never reach that hook; invalid/undecodable frames (decodeMessage
     * returns null) are still ignored.
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
     * exactly; ms stamps pass through untouched.
     */
    static serverTimeToMs(raw: number): number;
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
    private handleGroupState;
    private handlePlayback;
    private handleSeek;
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
     */
    private handlePlaybackQueueBroadcast;
    private handleHostTransfer;
    private handlePlaybackSync;
    private handleTimeSync;
    private handleGroupList;
    private dispatch;
}
