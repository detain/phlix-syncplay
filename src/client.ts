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
  type GroupStatePayload,
  type HostElectPayload,
  type InfoPayload,
  type RawMessage,
  type SyncPlayGroup,
  type SyncPlayMember,
  type SyncPlayMessageType,
  type TimePongPayload,
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
  send: (message: RawMessage) => void;
  /** Clock source (epoch ms). */
  now: NowFn;
  /** This client's stable member id. */
  memberId: string;
  /** This client's display name (sent on create/join). */
  memberName?: string;

  onState?: (group: SyncPlayGroup, yourId: string | undefined) => void;
  onSync?: (status: TimeSyncStatus) => void;
  onPlaybackCommand?: (command: PlaybackCommand) => void;
  onMemberJoined?: (member: { id: string; name: string }) => void;
  onHostChanged?: (newHostId: string | null) => void;
  onError?: (code: string, message: string) => void;
  onInfo?: (message: string) => void;
}

export class SyncPlayClient {
  private readonly send: (message: RawMessage) => void;
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

  /** Create a group with this member as host. `passwordHash` is SHA-256 hex. */
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

  /** Join an existing group by id. `passwordHash` is SHA-256 hex. */
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
      group_id: this.group.id,
      member_id: this.memberId,
    });
    this.group = null;
  }

  // --- Playback (host only; server rejects non-hosts) ----------------------

  sendPlay(position: number): void {
    if (this.group === null) {
      return;
    }
    this.dispatch(SYNCPLAY_MESSAGE_TYPES.PLAYBACK_PLAY, {
      group_id: this.group.id,
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
      group_id: this.group.id,
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
      group_id: this.group.id,
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
      group_id: this.group.id,
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
      default:
        // group_list / chat / typing / playback_queue / host_transfer /
        // time_sync are not orchestrated here; consumers may inspect via a
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
      id: group.id,
      name: group.name,
      members,
      host_id: group.host_id ?? null,
      current_media_id: group.current_media_id ?? null,
      playback_position: group.playback_position ?? 0,
      playback_state: group.playback_state ?? 'stopped',
      has_password: group.has_password,
    };

    this.options.onState?.(this.group, payload.your_id);
  }

  private handlePlayback(type: 'play' | 'pause', msg: RawMessage): void {
    const senderId = typeof msg.member_id === 'string' ? msg.member_id : undefined;
    // Ignore our own echoed command (the server excludes the sender, but be safe).
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

  // --- Internals -----------------------------------------------------------

  private dispatch(type: SyncPlayMessageType, payload: Record<string, unknown>): void {
    this.send(encodeMessage(type, payload, this.now));
  }
}
