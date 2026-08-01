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
 * It has NO dependency on WebSocket, Date, timers, or any framework. The
 * transport `send` and the clock `now` are injected; the consumer is
 * responsible for opening the socket, calling {@link handleIncoming} on each
 * inbound frame, and scheduling periodic {@link pingTime}/{@link reportPosition}.
 *
 * This is the canonical surface that mobile / windows / tizen wrappers should
 * delegate to instead of re-implementing the protocol (and re-introducing the
 * historical divergences).
 */

import { decodeMessage, encodeMessage, type NowFn } from './framing';
import {
  SYNCPLAY_MESSAGE_TYPES,
  type ErrorPayload,
  type GroupListResponsePayload,
  type GroupStatePayload,
  type HostElectPayload,
  type HostTransferPayload,
  type InfoPayload,
  type RawMessage,
  type SyncPlayGroup,
  type SyncPlayMember,
  type SyncPlayMessageType,
  type TimePongPayload,
  type TimeSyncPayload,
  type TypingPayload,
} from './messages';
import { TimeSync } from './time-sync';

/** A play/pause/seek command surfaced to the consumer for local application. */
export interface PlaybackCommand {
  type: 'play' | 'pause' | 'seek';
  /** Target position in ms (for seek this is `to_position`). */
  position: number;
  /** Server-synchronized timestamp the command was issued at (ms). */
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

  onState?: (_group: SyncPlayGroup, yourId: string | undefined) => void;
  onSync?: (_status: TimeSyncStatus) => void;
  onPlaybackCommand?: (_command: PlaybackCommand) => void;
  onMemberJoined?: (_member: { id: string; name: string }) => void;
  onHostChanged?: (_newHostId: string | null) => void;
  onError?: (_code: string, _message: string) => void;
  onInfo?: (_message: string) => void;
  /** A member started or stopped typing (TYPE_CHAT_TYPING / syncplay_typing). */
  onMemberTyping?: (_memberId: string, isTyping: boolean) => void;
  /** The group host transferred to another member (TYPE_HOST_TRANSFER / syncplay_host_transfer). */
  onHostTransfer?: (_currentHostId: string, _newHostId: string) => void;
  /** Periodic playback position sync from a group member (TYPE_PLAYBACK_SYNC / syncplay_playback_sync). */
  onPlaybackSync?: (_memberId: string, position: number, isPlaying: boolean, _serverTime: number) => void;
  /** Server-initiated clock drift correction (TYPE_TIME_SYNC / syncplay_time_sync). */
  onTimeSync?: (_serverTime: number, _clientTime: number) => void;
  /** Group list enumeration reply (TYPE_GROUP_LIST / syncplay_group_list). */
  onGroupList?: (_groups: { group_id: string; group_name: string; has_password?: boolean }[]) => void;
  /**
   * Invoked by {@link SyncPlayClient.onDisconnect} after the client's transient
   * state has been cleared, so the consumer can update its UI (e.g. show a
   * "reconnecting…" indicator). This library owns no socket; the consumer calls
   * {@link SyncPlayClient.onDisconnect} from its transport's close/error path.
   */
  onDisconnect?: () => void;
}

export class SyncPlayClient {
  private readonly send: (_message: RawMessage) => void;
  private readonly now: NowFn;
  private readonly memberId: string;
  private readonly memberName: string;
  private readonly options: SyncPlayClientOptions;
  private readonly timeSync: TimeSync;

  private group: SyncPlayGroup | null = null;
  /** Local t1 of the most recent outstanding ping, ms. */
  private lastPingSendTime: number | null = null;

  constructor(options: SyncPlayClientOptions) {
    this.options = options;
    this.send = options.send;
    this.now = options.now;
    this.memberId = options.memberId;
    this.memberName = options.memberName ?? 'User';
    this.timeSync = new TimeSync(options.now);
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

  /** True if this member is the current host of the current group. */
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
    const payload: Record<string, unknown> = {
      group_name: groupName,
      member_id: this.memberId,
      member_name: this.memberName,
    };
    if (passwordHash !== undefined) {
      payload.password_hash = passwordHash;
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
    const payload: Record<string, unknown> = {
      group_id: groupId,
      member_id: this.memberId,
      member_name: this.memberName,
    };
    if (passwordHash !== undefined) {
      payload.password_hash = passwordHash;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.GROUP_JOIN, payload);
  }

  /** Leave the current group (no-op if not in one). */
  leaveGroup(): void {
    if (this.group === null) {
      return;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.GROUP_LEAVE, {
      group_id: this.group.group_id,
      member_id: this.memberId,
    });
    this.group = null;
  }

  // --- Playback (host only; server rejects non-hosts) ----------------------
  //
  // SECURITY (see SPEC §9): every playback sender below stamps the frame with
  // this client's self-asserted `member_id`. The server MUST authorize these
  // host-only actions by the *authenticated connection's* identity (not by the
  // claimed `member_id`) and MUST overwrite the sender id with the authenticated
  // one before rebroadcasting. The echo-suppression in handlePlayback/handleSeek
  // relies on that server-set sender id.

  sendPlay(position: number): void {
    if (this.group === null) {
      return;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      position,
      server_time: this.getSynchronizedTime(),
    });
  }

  sendPause(position: number): void {
    if (this.group === null) {
      return;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PAUSE, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      position,
      server_time: this.getSynchronizedTime(),
    });
  }

  sendSeek(fromPosition: number, toPosition: number): void {
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

  /** Periodic position report (PLAYBACK_SYNC) — typically host-driven. */
  reportPosition(position: number, isPlaying: boolean): void {
    if (this.group === null) {
      return;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_SYNC, {
      group_id: this.group.group_id,
      member_id: this.memberId,
      position,
      is_playing: isPlaying,
      server_time: this.getSynchronizedTime(),
    });
  }

  // --- Time sync -----------------------------------------------------------

  /** Send a time_ping. Call periodically (e.g. every 10–30s). */
  pingTime(): void {
    const t1 = this.now();
    this.lastPingSendTime = t1;
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
   *   transport concern owned by the consumer; this library schedules no timers.
   */
  onDisconnect(): void {
    this.timeSync.reset();
    this.group = null;
    this.lastPingSendTime = null;
    this.options.onDisconnect?.();
  }

  // --- Inbound -------------------------------------------------------------

  /**
   * Route one inbound frame (string or parsed object). Feeds time-sync on pong,
   * applies group_state, surfaces playback commands, host changes, errors, info.
   * Unknown/invalid frames are ignored.
   */
  handleIncoming(raw: unknown): void {
    const msg = decodeMessage(raw);
    if (msg === null) {
      return;
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
      default:
        // playback_queue is not orchestrated here; consumers may inspect via a
        // custom transport hook. Ignored to stay forward-compatible.
        break;
    }
  }

  // --- Inbound handlers ----------------------------------------------------

  private handleTimePong(msg: RawMessage): void {
    const pong = msg as Partial<TimePongPayload>;
    const t4 = this.now();
    // Prefer the echoed client_time as t1; fall back to our recorded send time.
    const t1 = typeof pong.client_time === 'number' ? pong.client_time : this.lastPingSendTime;
    const t2 = typeof pong.server_time === 'number' ? pong.server_time : null;

    if (t1 === null || t2 === null) {
      return;
    }

    // The server pong has no separate response timestamp: t3 == t2.
    const accepted = this.timeSync.addSample(t1, t2, t2, t4);
    this.lastPingSendTime = null;

    if (accepted) {
      this.options.onSync?.({
        offset: this.timeSync.getOffset(),
        latency: this.timeSync.getLatency(),
        isStable: this.timeSync.isStable(),
      });
    }
  }

  private handleGroupState(msg: RawMessage): void {
    const payload = msg as Partial<GroupStatePayload>;
    const group = payload.group;
    if (typeof group !== 'object' || group === null) {
      return;
    }

    // Normalize members and derive is_host from host_id (server includes
    // is_host on members, but host_id is authoritative).
    const members: SyncPlayMember[] = Array.isArray(group.members)
      ? group.members.map((m) => ({
          id: m.id,
          name: m.name,
          is_host: m.id === group.host_id,
          joined_at: typeof m.joined_at === 'number' ? m.joined_at : 0,
        }))
      : [];

    this.group = {
      group_id: group.group_id,
      group_name: group.group_name,
      members,
      member_count: group.member_count,
      host_id: group.host_id ?? null,
      current_media_id: group.current_media_id ?? null,
      current_media_duration: group.current_media_duration ?? null,
      playback_position: group.playback_position,
      playback_state: group.playback_state,
      created_at: group.created_at,
      last_activity_at: group.last_activity_at,
    };

    this.options.onState?.(this.group, payload.your_id);
  }

  private handlePlayback(type: 'play' | 'pause', msg: RawMessage): void {
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
    const position = typeof msg.position === 'number' ? msg.position : 0;
    const serverTime =
      typeof msg.server_time === 'number' ? msg.server_time : this.getSynchronizedTime();
    this.options.onPlaybackCommand?.({ type, position, serverTime });
  }

  private handleSeek(msg: RawMessage): void {
    const senderId = typeof msg.member_id === 'string' ? msg.member_id : undefined;
    // SECURITY (see SPEC §9.1): same dependency as handlePlayback — keying
    // echo-suppression on `member_id` is safe ONLY because the server sets the
    // true authenticated sender id on rebroadcast; a spoofed id would otherwise
    // let a peer suppress our legitimate seeks.
    if (senderId === this.memberId) {
      return;
    }
    const position = typeof msg.to_position === 'number' ? msg.to_position : 0;
    const serverTime =
      typeof msg.server_time === 'number' ? msg.server_time : this.getSynchronizedTime();
    this.options.onPlaybackCommand?.({ type: 'seek', position, serverTime });
  }

  private handleHostElect(msg: RawMessage): void {
    const payload = msg as Partial<HostElectPayload>;
    const newHostId = payload.elected_id ?? null;
    if (this.group !== null) {
      this.group = { ...this.group, host_id: newHostId };
    }
    this.options.onHostChanged?.(newHostId);
  }

  private handleInfo(msg: RawMessage): void {
    const payload = msg as Partial<InfoPayload>;
    // A member JOIN arrives as INFO carrying member_id + member_name — the
    // server does NOT emit a dedicated member_joined type.
    if (typeof payload.member_id === 'string' && typeof payload.member_name === 'string') {
      this.options.onMemberJoined?.({ id: payload.member_id, name: payload.member_name });
    }
    if (typeof payload.message === 'string') {
      this.options.onInfo?.(payload.message);
    }
  }

  private handleError(msg: RawMessage): void {
    const payload = msg as Partial<ErrorPayload>;
    const code = payload.error_code ?? payload.code ?? 'UNKNOWN';
    const message = typeof payload.message === 'string' ? payload.message : 'Unknown error';
    this.options.onError?.(code, message);
  }

  private handleTyping(msg: RawMessage): void {
    const payload = msg as Partial<TypingPayload>;
    if (typeof payload.member_id !== 'string') {
      return;
    }
    this.options.onMemberTyping?.(payload.member_id, payload.is_typing ?? false);
  }

  private handleHostTransfer(msg: RawMessage): void {
    const payload = msg as Partial<HostTransferPayload>;
    if (typeof payload.current_host_id !== 'string' || typeof payload.new_host_id !== 'string') {
      return;
    }
    if (this.group !== null) {
      this.group = { ...this.group, host_id: payload.new_host_id };
    }
    this.options.onHostTransfer?.(payload.current_host_id, payload.new_host_id);
  }

  private handlePlaybackSync(msg: RawMessage): void {
    const senderId = typeof msg.member_id === 'string' ? msg.member_id : undefined;
    if (senderId === this.memberId) {
      return;
    }
    const position = typeof msg.position === 'number' ? msg.position : 0;
    const isPlaying = typeof msg.is_playing === 'boolean' ? msg.is_playing : false;
    const serverTime =
      typeof msg.server_time === 'number' ? msg.server_time : this.getSynchronizedTime();
    this.options.onPlaybackSync?.(senderId ?? '', position, isPlaying, serverTime);
  }

  private handleTimeSync(msg: RawMessage): void {
    const payload = msg as Partial<TimeSyncPayload>;
    const serverTime = typeof payload.server_time === 'number' ? payload.server_time : 0;
    const clientTime = typeof payload.client_time === 'number' ? payload.client_time : 0;
    this.options.onTimeSync?.(serverTime, clientTime);
  }

  private handleGroupList(msg: RawMessage): void {
    const payload = msg as Partial<GroupListResponsePayload>;
    // The server returns an object with a 'groups' array
    const groups = payload.groups;
    if (!Array.isArray(groups)) {
      return;
    }
    const list: { group_id: string; group_name: string; has_password?: boolean }[] = groups.map(
      (g) => ({
        group_id: typeof g.group_id === 'string' ? g.group_id : '',
        group_name: typeof g.group_name === 'string' ? g.group_name : '',
        has_password: typeof g.has_password === 'boolean' ? g.has_password : undefined,
      }),
    );
    this.options.onGroupList?.(list);
  }

  // --- Internals -----------------------------------------------------------

  private dispatch(type: SyncPlayMessageType, payload: Record<string, unknown>): void {
    this.send(encodeMessage(type, payload, this.now));
  }
}
