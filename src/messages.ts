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
export const SYNCPLAY_MESSAGE_TYPES = {
  // --- Group management ---
  GROUP_CREATE: 'syncplay_group_create',
  GROUP_JOIN: 'syncplay_group_join',
  GROUP_LEAVE: 'syncplay_group_leave',
  GROUP_STATE: 'syncplay_group_state',
  GROUP_LIST: 'syncplay_group_list',

  // --- Playback control ---
  PLAYBACK_PLAY: 'syncplay_playback_play',
  PLAYBACK_PAUSE: 'syncplay_playback_pause',
  PLAYBACK_SEEK: 'syncplay_playback_seek',
  PLAYBACK_QUEUE: 'syncplay_playback_queue',
  PLAYBACK_SYNC: 'syncplay_playback_sync',

  // --- Chat ---
  CHAT: 'syncplay_chat',
  TYPING: 'syncplay_typing',

  // --- Host management ---
  HOST_TRANSFER: 'syncplay_host_transfer',
  HOST_ELECT: 'syncplay_host_elect',

  // --- Time synchronization ---
  TIME_PING: 'syncplay_time_ping',
  TIME_PONG: 'syncplay_time_pong',
  TIME_SYNC: 'syncplay_time_sync',

  // --- Informational ---
  ERROR: 'syncplay_error',
  INFO: 'syncplay_info',
} as const;

/** Union of every valid SyncPlay message type string. */
export type SyncPlayMessageType =
  (typeof SYNCPLAY_MESSAGE_TYPES)[keyof typeof SYNCPLAY_MESSAGE_TYPES];

/**
 * The current SyncPlay protocol version. Mirrors
 * `Messages::PROTOCOL_VERSION` and `TimeSync::PROTOCOL_VERSION` (both `1`).
 */
export const PROTOCOL_VERSION = 1;

/**
 * Ordered list of all valid message type strings (mirrors
 * `Messages::VALID_TYPES`). Useful for validation and exhaustiveness tests.
 */
export const ALL_MESSAGE_TYPES: readonly SyncPlayMessageType[] = [
  SYNCPLAY_MESSAGE_TYPES.GROUP_CREATE,
  SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN,
  SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE,
  SYNCPLAY_MESSAGE_TYPES.GROUP_STATE,
  SYNCPLAY_MESSAGE_TYPES.GROUP_LIST,
  SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY,
  SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE,
  SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SEEK,
  SYNCPLAY_MESSAGE_TYPES.PLAYBACK_QUEUE,
  SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC,
  SYNCPLAY_MESSAGE_TYPES.CHAT,
  SYNCPLAY_MESSAGE_TYPES.TYPING,
  SYNCPLAY_MESSAGE_TYPES.HOST_TRANSFER,
  SYNCPLAY_MESSAGE_TYPES.HOST_ELECT,
  SYNCPLAY_MESSAGE_TYPES.TIME_PING,
  SYNCPLAY_MESSAGE_TYPES.TIME_PONG,
  SYNCPLAY_MESSAGE_TYPES.TIME_SYNC,
  SYNCPLAY_MESSAGE_TYPES.ERROR,
  SYNCPLAY_MESSAGE_TYPES.INFO,
];

/** True if `type` is one of the 19 valid SyncPlay message types. */
export function isValidMessageType(type: string): type is SyncPlayMessageType {
  return (ALL_MESSAGE_TYPES as readonly string[]).includes(type);
}

/**
 * Playback state values used in `playback_state`, mirroring GroupState
 * `STATE_PLAYING` / `STATE_PAUSED` / `STATE_BUFFERING` / `STATE_STOPPED`.
 * `stopped` is also the client default before any state is known.
 */
export type PlaybackState = 'playing' | 'paused' | 'buffering' | 'stopped';

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

/**
 * A SyncPlay group member, as carried on the wire inside `group.members`.
 * Field names are snake_case to match the server (`getState()` member shape).
 */
export interface SyncPlayMember {
  id: string;
  name: string;
  is_host: boolean;
  joined_at: number;
}

/**
 * The `members` field AS THE WIRE CARRIES IT inside a `group_state` payload.
 *
 * The LIVE spelling (and the only spelling phlix-server has EVER emitted —
 * `GroupState::getState()` builds `$membersDict[$memberId]` since the initial
 * SyncPlay commit) is a DICTIONARY keyed by member id. The array spelling is
 * accepted too: it is this library's own normalized model shape ({@link
 * SyncPlayGroup.members}), which hand-built frames (tests, consumers
 * re-feeding a stored group) may carry.
 */
export type SyncPlayMembersWire =
  | SyncPlayMember[]
  | Record<string, Partial<SyncPlayMember> & { id?: string }>;

/**
 * The SyncPlay group MODEL the library exposes to consumers (via `onState` /
 * `getGroup`). Field names mirror `GroupState::getState()` EXACTLY: the group
 * identity uses `group_id` / `group_name` (NOT `id` / `name` — those spellings
 * belong to the members and to the `listGroups()` rows). getState() always
 * emits: group_id, group_name, member_count, members, host_id,
 * current_media_id, current_media_duration, playback_position, playback_state,
 * queue, created_at, last_activity_at.
 *
 * S416: on the WIRE, `members` arrives as a DICTIONARY keyed by member id
 * ({@link SyncPlayGroupWire}); this model is the library's NORMALIZED view —
 * `handleGroupState` folds the dict (or a tolerated array) into this array.
 * `queue` is carried verbatim per the producers, with per-carrier item
 * fields — see {@link PlaybackQueueItem} (M-SYNCPLAY-06: before that fix
 * `handleGroupState` silently dropped it).
 */
export interface SyncPlayGroup {
  group_id: string;
  group_name: string;
  /** NORMALIZED member list (the wire dict folded to an array, S416). */
  members: SyncPlayMember[];
  member_count?: number;
  host_id: string | null;
  current_media_id: string | null;
  /** Duration of the current media in ms (useful for clamping positions). */
  current_media_duration?: number | null;
  playback_position: number;
  playback_state: PlaybackState;
  /**
   * The playback queue, as the producer sent it (the SPEC §4 block is
   * "verbatim getState()"). Both live carriers always emit the key (possibly
   * `[]`); item fields are per-carrier ({@link PlaybackQueueItem}). The
   * library normalizes defensively and NEVER fabricates a queue a frame did
   * not carry — `undefined` means the frame omitted the key (hand-built
   * frames only).
   */
  queue?: PlaybackQueueItem[];
  created_at?: number;
  last_activity_at?: number;
  /**
   * NOT emitted by `GroupState::getState()` (and therefore never present on a
   * group_state message). Only the `listGroups()` summary carries it. Kept
   * optional here so a listGroups consumer can reuse this type without breakage.
   */
  has_password?: boolean;
}

// ---------------------------------------------------------------------------
// Common message envelope
// ---------------------------------------------------------------------------

/** Fields present on every framed SyncPlay message. */
export interface BaseMessage {
  type: SyncPlayMessageType;
  protocol_version: number;
  /** Sender wall-clock at send time, ms. Optional on the wire. */
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Client -> server payloads (the body merged into the envelope)
// ---------------------------------------------------------------------------

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

/**
 * One playback-queue entry, exactly as the live producers emit it.
 *
 * `:8097` `phlix-server`: `GroupState::getState()` nests `$this->playbackQueue`
 * under `group_state.group.queue` (`GroupState.php:970`) and
 * `SyncPlayManager.php:1271-1273` broadcasts the same array under
 * `syncplay_playback_queue`; items are built by `GroupState::addToQueue()`
 * (`GroupState.php:812-817`): `media_id` + `media_info` (title, thumbnail, …)
 * + `added_at` (UNIX seconds, `time()`) + `added_by` (the host member id at
 * enqueue time, nullable — `hostId` may be null).
 *
 * `:8804` `phlix-hub` relay: items are narrowed to `media_id` + `media_info`
 * ONLY (`SyncPlayRelayWorker.php:1713-1747`, emitted at :1401 and :1764) — on
 * that carrier `added_at`/`added_by` are ABSENT, never zeroed.
 */
export interface PlaybackQueueItem {
  media_id: string;
  media_info?: Record<string, unknown>;
  /** `:8097` server only (UNIX seconds); never emitted by the `:8804` hub relay. */
  added_at?: number;
  /** `:8097` server only (member id at enqueue time, nullable); never emitted by the `:8804` hub relay. */
  added_by?: string | null;
}

export interface PlaybackQueuePayload {
  group_id: string;
  queue: PlaybackQueueItem[];
  member_id?: string;
}

/**
 * Which side of the authoritative playhead the drifting member sits on
 * (S446 nudge, SPEC §4). The server picks the literal pair
 * `$behind ? 'behind' : 'ahead'` at phlix-server
 * `src/Session/SyncPlay/SyncPlayManager.php:1578` (@84e55800), where
 * `$behind` is `drift_ms > 0` (:1566-1567) and `drift_ms` =
 * authoritative position − reporter's last reported position.
 */
export type PlaybackSyncNudgeDirection = 'behind' | 'ahead';

/**
 * The S446 soft-desync correction object riding a server-DIRECTED
 * `syncplay_playback_sync` frame ("a rate-limited NUDGE — never a seek",
 * phlix-server `GroupState.php:39` policy header). Emitted ONLY by
 * `SyncPlayManager::sendOutOfSyncNudge()`, unicast to the member whose
 * just-ingested position fell outside the group tolerance (guard
 * phlix-server `src/Session/SyncPlay/SyncPlayManager.php:1529-1531`,
 * @84e55800); the group echo (:1517-1524) NEVER carries it, and the
 * `:8804` hub relay produces no nudge at all (phlix-hub
 * `src/SyncPlay/SyncPlayRelayWorker.php` has zero nudge producers;
 * SPEC §8.4 "not relayed"). Fields as the emitter stamps them
 * (`SyncPlayManager.php:1576-1584`, @84e55800):
 */
export interface PlaybackSyncNudge {
  /**
   * Group position − reported position, ms (computed :1566). Positive =
   * the member is BEHIND the room.
   */
  drift_ms?: number;
  /** Literal pair stamped at :1578 (`$behind ? 'behind' : 'ahead'`). */
  direction?: PlaybackSyncNudgeDirection;
  /**
   * Recommended playRate correction: `1 ± GroupState::NUDGE_RATE_STEP`
   * (step 0.1, phlix-server `GroupState.php:167`), i.e. 1.1 when behind,
   * 0.9 when ahead (:1579-1581).
   */
  suggested_rate?: number;
  /**
   * The group's position tolerance the in-sync verdict was judged
   * against (:1582 → `GroupState::getPositionTolerance()`; default
   * `POSITION_TOLERANCE` = 2000 ms, `GroupState.php:124`).
   */
  tolerance_ms?: number;
  /**
   * Minimum spacing before the SAME member can be nudged again —
   * `GroupState::NUDGE_COOLDOWN_MS` = 1000 ms (`GroupState.php:145`,
   * slot claim `SyncPlayManager.php:1561`, consumed on the wire at :1583).
   */
  cooldown_ms?: number;
}

export interface PlaybackSyncPayload {
  group_id: string;
  /** Echo frames carry the HOST id (:1518); nudge frames carry the DRIFTING
   * MEMBER's own id (:1570) — the recipient is the one nudged, so
   * `member_id === your id` + `nudge` present identifies the directed frame. */
  member_id: string;
  /** Stamped by BOTH live producers: echo phlix-server `SyncPlayManager.php:1520`,
   * nudge :1572, hub relay phlix-hub `SyncPlayRelayWorker.php:1676`; nullable.
   * Not delivered as its own `onPlaybackSync` argument — read it off the
   * cached group (`SyncPlayGroup.current_media_id`). */
  current_media_id?: string | null;
  position: number;
  is_playing: boolean;
  /**
   * WIRE UNITS MIX PER CARRIER (SPEC §8.4): UNIX **seconds** on `:8097`
   * (stamp site phlix-server `SyncPlayManager.php:1506` `time()`, echo
   * field :1523, nudge field :1575, @84e55800) vs **milliseconds**
   * on the hub relay (field phlix-hub `SyncPlayRelayWorker.php:1679`
   * `nowMs()`, @f85f48ec). `SyncPlayClient.serverTimeToMs` normalizes
   * every delivered `server_time` to ms — the §4 ms law holds for consumers.
   */
  server_time: number;
  /**
   * `:8097` server ONLY, and only on the directed out-of-sync frame
   * (`SyncPlayManager.php:1569-1585`); ABSENT on the group echo and on
   * every hub-relay frame — absent, never zeroed (M-SYNCPLAY-08).
   */
  nudge?: PlaybackSyncNudge;
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

// ---------------------------------------------------------------------------
// Server -> client payloads
// ---------------------------------------------------------------------------

/**
 * GROUP_STATE as the server actually emits it (SyncPlayManager::handleGroupCreate
 * / handleGroupJoin): the full group is nested under `group`, and the recipient's
 * own member id is in `your_id`. NOTE: the server does NOT flatten group fields
 * onto the envelope — Windows' flat reader is a divergence.
 */
/**
 * The `group` value AS THE SERVER PUTS IT under a `group_state` frame — the
 * same fields as {@link SyncPlayGroup} but with `members` in the WIRE spelling
 * ({@link SyncPlayMembersWire}: a dict keyed by member id live; array also
 * tolerated). {@link SyncPlayClient.handleGroupState} normalizes this to the
 * array-model {@link SyncPlayGroup}.
 *
 * Every field is optional because the decoder must not assume a partial frame
 * is a full group (it guards + fills defaults); the server's complete emission
 * is documented in SPEC.md §4.
 */
export interface SyncPlayGroupWire extends Partial<Omit<SyncPlayGroup, 'members'>> {
  members?: SyncPlayMembersWire;
}

export interface GroupStatePayload {
  group: SyncPlayGroupWire;
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
 * TIME_SYNC as the server emits it — SERVER WIRE TRUTH,
 * `phlix-server/src/Session/SyncPlay/SyncPlayManager.php:1653-1659`
 * (`handleTimeSync`, reply sent with `Messages::frame` over the requesting
 * connection). The previous model here was FABRICATED: it promised a
 * `client_time` the server has never emitted (the handler silently defaulted
 * it to 0) and claimed `server_time` was ms. The live frame is an ADVISORY
 * sync-STATE snapshot answering a client `syncplay_time_sync` request — a
 * unicast reply, not a group broadcast. Units are mixed ON PURPOSE and must
 * be read per-field: `server_time` carries the `:8097` legacy seconds quirk
 * (`time()`), while `offset_ms` / `latency_ms` are milliseconds. The hub
 * relay (`:8804`) has no producer for this type and refuses inbound use
 * (SPEC §4; `hub.protocol_unsupported`).
 */
export interface TimeSyncPayload {
  /** Server-derived identity of the requester (S289 — payload member_id is ignored). */
  member_id: string;
  /** The requester's current group. */
  group_id: string;
  /** Server wall-clock in UNIX SECONDS (`time()` — the `:8097` seconds quirk), NOT ms. */
  server_time: number;
  /** Server's own clock-offset estimate in ms (`TimeSync::getTimeOffset()`). */
  offset_ms: number;
  /** Server's estimated one-way latency in ms (`TimeSync::getEstimatedLatency()`). */
  latency_ms: number;
  /** Server multiplicative drift factor, float ≈1.0 (`TimeSync::$localDriftRate`). */
  drift_rate: number;
  /** Whether the server deems its own sync stable (`TimeSync::isSyncStable()`). */
  is_stable: boolean;
  /** `Messages::frame` envelope stamp — always present on the wire. */
  protocol_version: number;
}

/**
 * Normalized TIME_SYNC model handed to `SyncPlayClientOptions.onTimeSync`.
 * Field units are named into the identifiers (`...Sec` vs `...Ms`) because the
 * wire itself mixes seconds and milliseconds. `serverTimeSec` is passed
 * VERBATIM — the `:8097` advisory's seconds stamp is preserved (phlix-server
 * `SyncPlayManager.php:1655` `time()`, @84e55800) — multiply by 1000 for ms.
 * This is NOT the `onPlaybackSync` law: since M-SYNCPLAY-04 that callback's
 * `serverTime` arrives NORMALIZED to ms at the decode boundary
 * (`SyncPlayClient.serverTimeToMs`, SPEC §4/§8.4) — never raw.
 */
export interface TimeSyncState {
  memberId: string;
  groupId: string;
  /** Server wall-clock, UNIX SECONDS (raw wire value). */
  serverTimeSec: number;
  /** Server clock-offset estimate, ms. */
  offsetMs: number;
  /** Server estimated one-way latency, ms. */
  latencyMs: number;
  /** Server drift factor (≈1.0). */
  driftRate: number;
  /** Whether the server deems its sync stable. */
  isStable: boolean;
}

/**
 * One `group_list` reply summary row — LIVE PRODUCER TRUTH, identical on both
 * carriers (all six keys are ALWAYS emitted):
 *  - `:8097`: `phlix-server/src/Session/SyncPlay/SyncPlayManager.php`
 *    `groupSummary()` :1740-1750 (`'id'`:1743 `'name'`:1744 `'member_count'`:1745
 *    `'has_password'`:1746 `'current_media'`:1747 `'is_playing'`:1748;
 *    `current_media` is `GroupState::getCurrentMediaId(): ?string`,
 *    GroupState.php:565);
 *  - `:8804`: `phlix-hub/src/SyncPlay/SyncPlayRelayWorker.php`
 *    `handleCanonicalGroupList()` row literal :1938-1943 (deliberately mirrors
 *    the Server summary; `has_password` is the truthful constant `false`).
 *
 * The identity keys are `id` / `name` — NOT `group_id` / `group_name` (that
 * spelling belongs only to the nested `group_state.group` block). The previous
 * model here was FABRICATED (`{group_id, group_name, has_password?}`): it
 * matched no byte on either socket, so consumers reading it against a live
 * reply silently saw `''`/`undefined` (SPEC §4 group_list reply block).
 */
export interface GroupListSummaryRow {
  /** Group id — producer key `id` (NOT `group_id`). */
  id: string;
  /** Display name — producer key `name` (NOT `group_name`). */
  name: string;
  /** Integer member count. */
  member_count: number;
  /** Whether the room is password-gated (always a real bool on the wire). */
  has_password: boolean;
  /** Current media id, or null when the room has no media loaded. */
  current_media: string | null;
  /** Whether the room is currently playing. */
  is_playing: boolean;
}

/**
 * GROUP_LIST reply as the server emits it — `syncplay_group_list`
 * (server → client). Producers: `phlix-server` `SyncPlayManager::handleGroupList`
 * reply send :1686-1689 and `phlix-hub` `SyncPlayRelayWorker::
 * handleCanonicalGroupList` send :1947-1950 — both frame
 * `{groups: <summary rows>, count: <int>}` beside the `Messages::frame`
 * envelope keys. `count === groups.length` on both.
 */
export interface GroupListResponsePayload {
  /** Array of group summary rows (see {@link GroupListSummaryRow}). */
  groups: GroupListSummaryRow[];
  /** Integer row count, emitted alongside `groups` by both producers. */
  count: number;
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
