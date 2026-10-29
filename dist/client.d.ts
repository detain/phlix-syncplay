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
 * time. {@link SyncPlayClientOptions.seekThrottleMs}`: 0 disables it and
 * restores a fully timer-free surface.
 *
 * This is the canonical surface that mobile / windows / tizen wrappers should
 * delegate to instead of re-implementing the protocol (and re-introducing the
 * historical divergences).
 */
import { type NowFn } from './framing';
import { type GroupListSummaryRow, type PlaybackSyncNudge, type RawMessage, type SyncPlayGroup, type TimeSyncState, type UnknownFrame } from './messages';
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
    /** This client's stable member id. */
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
    /** A member started or stopped typing (TYPE_CHAT_TYPING / syncplay_typing). */
    onMemberTyping?: (_memberId: string, isTyping: boolean) => void;
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
     * Extension point for non-SyncPlay vocabulary. This library owns ONLY the 19
     * canonical `syncplay_*` types; ONLY frames whose type is NOT one of them
     * (e.g. the hub relay's `pending_command`) reach this hook — untouched, no
     * validation, no mutation. The two canonical types the library does not
     * orchestrate — syncplay_chat, syncplay_playback_queue — stay ignored, as
     * before. This is the extension point the old default-arm comment promised;
     * consumers route non-SyncPlay vocabulary through it and the library stays
     * protocol-pure.
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
    /** True if this member is the current host of the current group. */
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
    /** Periodic position report (PLAYBACK_SYNC) — typically host-driven. */
    reportPosition(position: number, isPlaying: boolean): void;
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
     * applies group_state, surfaces playback commands, host changes, errors, info.
     * Frames whose type is outside the 19 canonical `syncplay_*` types are
     * surfaced via {@link SyncPlayClientOptions.onUnknownFrame}; the two canonical
     * types the library does not orchestrate (syncplay_chat,
     * syncplay_playback_queue) stay silently ignored; invalid/undecodable frames
     * (decodeMessage returns null) are still ignored.
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
    private handleHostTransfer;
    private handlePlaybackSync;
    private handleTimeSync;
    private handleGroupList;
    private dispatch;
}
