/**
 * TimeSync — NTP-style network time synchronization.
 *
 * This is a faithful TypeScript port of the server's
 * `src/Session/SyncPlay/TimeSync.php`. The math reproduces the server formula
 * exactly so client and server agree on offset, latency, stability, and drift.
 *
 * ## Algorithm
 *
 *   t1 = client send time      (client_time in the ping)
 *   t2 = server receive time   (server_time in the pong)
 *   t3 = server response time  (== t2 in practice: the server replies in the
 *                               same handler with no measurable processing gap)
 *   t4 = client receive time
 *
 *   rtt    = t4 - t1 - (t3 - t2)
 *   oneWay = rtt / 2
 *   offset = t2 - t1 + oneWay        // add to local time to get server time
 *
 * Samples with `rtt > MAX_ACCEPTABLE_RTT` are rejected. `getOffset()` returns a
 * weighted mean (weight = 1/rtt, favouring low-RTT samples) over the most
 * recent `OFFSET_SAMPLE_COUNT` samples. Sync is "stable" once at least
 * `OFFSET_SAMPLE_COUNT` samples exist AND the variance of recent offsets is
 * < 50ms. Drift is an EMA: `driftRate = 1.0 + 0.1 * (offsetDelta / timeDelta) / 1000`.
 *
 * The clock is INJECTED (`now`) so this class is pure and deterministic — it
 * never calls `Date.now()` itself. `timestamp` units match the server: seconds
 * (PHP `microtime(true)`), which only affects the drift `timeDelta` scaling.
 */
/** Number of recent samples averaged for offset/latency/stability. */
export declare const OFFSET_SAMPLE_COUNT = 5;
/** Samples with a round-trip time above this (ms) are discarded as unreliable. */
export declare const MAX_ACCEPTABLE_RTT = 1000;
/** Offset-variance threshold (ms^2-ish, per the server) below which sync is stable. */
export declare const STABILITY_VARIANCE_THRESHOLD = 50;
/** Drift EMA smoothing factor (lower = smoother, slower to adapt). */
export declare const DRIFT_CORRECTION_FACTOR = 0.1;
/** Protocol version for time-sync messages (mirrors TimeSync::PROTOCOL_VERSION). */
export declare const TIME_SYNC_PROTOCOL_VERSION = 1;
import type { NowFn } from './framing';
/** A single offset measurement. `timestamp` is in SECONDS (matches PHP). */
export interface OffsetSample {
    offset: number;
    rtt: number;
    timestamp: number;
}
export declare class TimeSync {
    private samples;
    private driftRate;
    private readonly now;
    /**
     * @param now Clock source (epoch ms). Required — no implicit `Date.now()`.
     */
    constructor(now: NowFn);
    /**
     * Add a sample from a completed ping/pong round, using the full NTP quad.
     *
     * @param clientSend    t1 — client send time (ms)
     * @param serverRecv    t2 — server receive time (ms)
     * @param serverResp    t3 — server response time (ms); pass t2 when the
     *                      server pong carries no separate response timestamp.
     * @param clientReceive t4 — client receive time (ms)
     * @returns true if the sample was accepted, false if rejected (rtt too high).
     */
    addSample(clientSend: number, serverRecv: number, serverResp: number, clientReceive: number): boolean;
    /**
     * Weighted-mean offset (ms) over the most recent samples. Lower-RTT samples
     * carry more weight. Add this to local time to get server time.
     */
    getOffset(): number;
    /** Estimated one-way latency (ms): mean of rtt/2 over recent samples. */
    getLatency(): number;
    /**
     * True once at least OFFSET_SAMPLE_COUNT samples exist AND the variance of
     * the recent offsets is below the stability threshold.
     */
    isStable(): boolean;
    /**
     * Recompute the local clock drift rate as an EMA of recent offset change per
     * second. 1.0 = no drift; >1 = local clock gaining, <1 = losing.
     *
     * Windows and Mobile omitted drift entirely; this restores it (matching the
     * server and Tizen).
     */
    updateDriftRate(): void;
    /** Current drift-rate multiplier (1.0 = no drift). */
    getDriftRate(): number;
    /** Number of retained samples. */
    getSampleCount(): number;
    /** Synchronized time = injected local time + current offset (ms). */
    getSynchronizedTime(now: number): number;
    /**
     * Compute the playback position a member should currently be at, given the
     * host's reported `position` captured at `serverTime`, evaluated at local
     * time `now`. Applies drift to the elapsed synchronized interval.
     *
     * @param position   Host position (ms) at the moment of `serverTime`.
     * @param serverTime Server-synchronized timestamp the position was captured at (ms).
     * @param now        Current local wall-clock (ms).
     */
    getAdjustedPosition(position: number, serverTime: number, now: number): number;
    /** Clear all samples and reset drift. */
    reset(): void;
    /** Snapshot of current sync state (parallels TimeSync::getStatus). */
    getStatus(): {
        offset: number;
        latency: number;
        driftRate: number;
        isStable: boolean;
        sampleCount: number;
    };
}
