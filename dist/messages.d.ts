/**
 * messages.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
/**
 * SyncPlay message types and per-message payload interfaces.
 *
 * This is the SHARED, CANONICAL mirror of the PHP server's
 * `src/Session/SyncPlay/Messages.php`. Every message type string and every
 * wire field name (snake_case) must match the server byte-for-byte.
 *
 * Canonical decisions (see SPEC.md for the full rationale):
 * - Every message `type` is prefixed `syncplay_` with an UNDERSCORE separator.
 *   (Roku's `syncplay.` dot prefix is WRONG and must not be used.)
 * - `protocol_version` is `1` and is included on every message.
 * - Wire field names are snake_case (e.g. `group_id`, `member_id`,
 *   `current_media_id`, `playback_position`, `server_time`, `client_time`).
 */
/**
 * All 19 SyncPlay message type constants, mirroring
 * `Phlix\Session\SyncPlay\Messages::TYPE_*` exactly.
 */
export declare const SYNCPLAY_MESSAGE_TYPES: {
    readonly GROUP_CREATE: "syncplay_group_create";
    readonly GROUP_JOIN: "syncplay_group_join";
    readonly GROUP_LEAVE: "syncplay_group_leave";
    readonly GROUP_STATE: "syncplay_group_state";
    readonly GROUP_LIST: "syncplay_group_list";
    readonly PLAYBACK_PLAY: "syncplay_playback_play";
    readonly PLAYBACK_PAUSE: "syncplay_playback_pause";
    readonly PLAYBACK_SEEK: "syncplay_playback_seek";
    readonly PLAYBACK_QUEUE: "syncplay_playback_queue";
    readonly PLAYBACK_SYNC: "syncplay_playback_sync";
    readonly CHAT: "syncplay_chat";
    readonly TYPING: "syncplay_typing";
    readonly HOST_TRANSFER: "syncplay_host_transfer";
    readonly HOST_ELECT: "syncplay_host_elect";
    readonly TIME_PING: "syncplay_time_ping";
    readonly TIME_PONG: "syncplay_time_pong";
    readonly TIME_SYNC: "syncplay_time_sync";
    readonly ERROR: "syncplay_error";
    readonly INFO: "syncplay_info";
};
/** Union of every valid SyncPlay message type string. */
export type SyncPlayMessageType = (typeof SYNCPLAY_MESSAGE_TYPES)[keyof typeof SYNCPLAY_MESSAGE_TYPES];
/**
 * The current SyncPlay protocol version. Mirrors
 * `Messages::PROTOCOL_VERSION` and `TimeSync::PROTOCOL_VERSION` (both `1`).
 */
export declare const PROTOCOL_VERSION = 1;
/**
 * Ordered list of all valid message type strings (mirrors
 * `Messages::VALID_TYPES`). Useful for validation and exhaustiveness tests.
 */
export declare const ALL_MESSAGE_TYPES: readonly SyncPlayMessageType[];
/** True if `type` is one of the 19 valid SyncPlay message types. */
export declare function isValidMessageType(type: string): type is SyncPlayMessageType;
/**
 * Playback state values used in `playback_state`, mirroring GroupState
 * `STATE_PLAYING` / `STATE_PAUSED` / `STATE_BUFFERING` / `STATE_STOPPED`.
 * `stopped` is also the client default before any state is known.
 */
export type PlaybackState = 'playing' | 'paused' | 'buffering' | 'stopped';
/**
 * A SyncPlay group member, as carried in `group.members[]` on the wire.
 * Field names are snake_case to match the server (`getState()` member shape).
 */
export interface SyncPlayMember {
    id: string;
    name: string;
    is_host: boolean;
    joined_at: number;
}
/**
 * The SyncPlay group model, as carried under the `group` key of a
 * GROUP_STATE message (the server emits `GroupState::getState()` here).
 *
 * Field names mirror `GroupState::getState()` EXACTLY: the group identity uses
 * `group_id` / `group_name` (NOT `id` / `name` — those belong to the members).
 * getState() always emits: group_id, group_name, member_count, members[],
 * host_id, current_media_id, current_media_duration, playback_position,
 * playback_state, queue, created_at, last_activity_at.
 */
export interface SyncPlayGroup {
    group_id: string;
    group_name: string;
    members: SyncPlayMember[];
    member_count?: number;
    host_id: string | null;
    current_media_id: string | null;
    /** Duration of the current media in ms (useful for clamping positions). */
    current_media_duration?: number | null;
    playback_position: number;
    playback_state: PlaybackState;
    created_at?: number;
    last_activity_at?: number;
    /**
     * NOT emitted by `GroupState::getState()` (and therefore never present on a
     * group_state message). Only the `listGroups()` summary carries it. Kept
     * optional here so a listGroups consumer can reuse this type without breakage.
     */
    has_password?: boolean;
}
/** Fields present on every framed SyncPlay message. */
export interface BaseMessage {
    type: SyncPlayMessageType;
    protocol_version: number;
    /** Sender wall-clock at send time, ms. Optional on the wire. */
    timestamp?: number;
}
export interface GroupCreatePayload {
    group_name: string;
    member_id?: string;
    member_name?: string;
    /** SHA-256 hex of the password (optional). */
    password_hash?: string;
}
export interface GroupJoinPayload {
    group_id: string;
    member_id?: string;
    member_name?: string;
    password_hash?: string;
}
export interface GroupLeavePayload {
    group_id: string;
    member_id: string;
}
export type GroupListPayload = Record<string, never>;
export interface PlaybackPlayPayload {
    group_id: string;
    member_id: string;
    position: number;
    server_time: number;
}
export interface PlaybackPausePayload {
    group_id: string;
    member_id: string;
    position: number;
    server_time: number;
}
export interface PlaybackSeekPayload {
    group_id: string;
    member_id: string;
    from_position: number;
    to_position: number;
    server_time: number;
}
export interface PlaybackQueueItem {
    media_id: string;
    media_info?: Record<string, unknown>;
}
export interface PlaybackQueuePayload {
    group_id: string;
    queue: PlaybackQueueItem[];
    member_id?: string;
}
export interface PlaybackSyncPayload {
    group_id: string;
    member_id: string;
    position: number;
    is_playing: boolean;
    server_time: number;
}
export interface ChatPayload {
    group_id: string;
    member_id: string;
    message: string;
}
export interface TypingPayload {
    group_id: string;
    member_id: string;
    is_typing: boolean;
}
export interface HostTransferPayload {
    group_id: string;
    current_host_id: string;
    new_host_id: string;
}
export interface TimePingPayload {
    /** Client local wall-clock at ping time, ms. This is t1. */
    client_time: number;
}
/**
 * GROUP_STATE as the server actually emits it (SyncPlayManager::handleGroupCreate
 * / handleGroupJoin): the full group is nested under `group`, and the recipient's
 * own member id is in `your_id`. NOTE: the server does NOT flatten group fields
 * onto the envelope — Windows' flat reader is a divergence.
 */
export interface GroupStatePayload {
    group: SyncPlayGroup;
    your_id?: string;
}
/**
 * HOST_ELECT as the server emits it on host departure
 * (SyncPlayManager::leaveGroup → broadcastToGroup).
 */
export interface HostElectPayload {
    elected_id: string | null;
    elected_by: string;
}
/**
 * TIME_PONG as the server emits it (TimeSync::processPing).
 * IMPORTANT: there is NO `server_receive_time` / t3 field. `server_time` IS the
 * server receive time (t2). The client must derive RTT from t1 and t4 alone.
 */
export interface TimePongPayload {
    /** Echoed client t1. */
    client_time: number;
    /** Server receive time t2 (ms). */
    server_time: number;
    protocol_version: number;
}
/**
 * TIME_SYNC as the server emits it for periodic clock drift correction.
 * The server sends its current time and the client's last known time to
 * allow the client to calculate and apply drift correction.
 */
export interface TimeSyncPayload {
    /** Server's current time (ms). */
    server_time: number;
    /** Client's last known time from a prior request (ms). */
    client_time: number;
}
/**
 * GROUP_LIST as the server emits it — a list of available groups.
 * Mirrors the response from `SyncPlayManager::listGroups()`.
 */
export interface GroupListResponsePayload {
    /** Array of group summary objects. */
    groups: {
        group_id: string;
        group_name: string;
        has_password?: boolean;
    }[];
}
/** ERROR message (Messages::error). */
export interface ErrorPayload {
    /** Server uses `error_code` in Messages::error; sendError uses `code`. */
    error_code?: string;
    code?: string;
    message: string;
    details?: Record<string, unknown>;
}
/**
 * INFO message (Messages::info / broadcastToGroup INFO). A member JOIN is
 * delivered as an INFO carrying `member_id` + `member_name` — the server does
 * NOT emit a dedicated `syncplay_member_joined` type (that is a Tizen invention).
 */
export interface InfoPayload {
    message: string;
    member_id?: string;
    member_name?: string;
    data?: Record<string, unknown>;
}
/** A decoded raw message: the envelope plus arbitrary payload fields. */
export type RawMessage = BaseMessage & Record<string, unknown>;
/**
 * A decoded frame whose `type` is NOT one of the 19 canonical SyncPlay types.
 *
 * Surfaced via {@link SyncPlayClientOptions.onUnknownFrame} (S298): consumers
 * routing non-SyncPlay vocabulary (e.g. the hub relay's `pending_command`
 * frames) receive them here, untouched and unvalidated. The `type` is a plain
 * string precisely so a consumer can compare it against its own vocabulary
 * without a cast.
 */
export type UnknownFrame = {
    type: string;
    protocol_version?: number;
    timestamp?: number;
} & Record<string, unknown>;
