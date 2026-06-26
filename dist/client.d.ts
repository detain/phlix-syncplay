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
import { type NowFn } from './framing';
import { type RawMessage, type SyncPlayGroup } from './messages';
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
    onMemberJoined?: (member: {
        id: string;
        name: string;
    }) => void;
    onHostChanged?: (newHostId: string | null) => void;
    onError?: (code: string, message: string) => void;
    onInfo?: (message: string) => void;
}
export declare class SyncPlayClient {
    private readonly send;
    private readonly now;
    private readonly memberId;
    private readonly memberName;
    private readonly options;
    private readonly timeSync;
    private group;
    /** Local t1 of the most recent outstanding ping, ms. */
    private lastPingSendTime;
    constructor(options: SyncPlayClientOptions);
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
    /** Create a group with this member as host. `passwordHash` is SHA-256 hex. */
    createGroup(groupName: string, passwordHash?: string): void;
    /** Join an existing group by id. `passwordHash` is SHA-256 hex. */
    joinGroup(groupId: string, passwordHash?: string): void;
    /** Leave the current group (no-op if not in one). */
    leaveGroup(): void;
    sendPlay(position: number): void;
    sendPause(position: number): void;
    sendSeek(fromPosition: number, toPosition: number): void;
    /** Periodic position report (PLAYBACK_SYNC) — typically host-driven. */
    reportPosition(position: number, isPlaying: boolean): void;
    /** Send a time_ping. Call periodically (e.g. every 10–30s). */
    pingTime(): void;
    /**
     * Route one inbound frame (string or parsed object). Feeds time-sync on pong,
     * applies group_state, surfaces playback commands, host changes, errors, info.
     * Unknown/invalid frames are ignored.
     */
    handleIncoming(raw: unknown): void;
    private handleTimePong;
    private handleGroupState;
    private handlePlayback;
    private handleSeek;
    private handleHostElect;
    private handleInfo;
    private handleError;
    private dispatch;
}
