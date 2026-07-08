/**
 * time sync.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */
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
 * Samples with `rtt < 0` (corrupt: negative one-way latency) or
 * `rtt > MAX_ACCEPTABLE_RTT` are rejected. `getOffset()` returns a
 * weighted mean (weight = 1/rtt, favouring low-RTT samples) over the most
 * recent `OFFSET_SAMPLE_COUNT` samples. Sync is "stable" once at least
 * `OFFSET_SAMPLE_COUNT` samples exist AND the variance of recent offsets is
 * < 50ms. Drift is an EMA: `driftRate = 1.0 + 0.1 * (offsetDelta / timeDelta) / 1000`.
 *
 * The clock is INJECTED (`now`) so this class is pure and deterministic — it
 * never calls `Date.now()` itself.
 *
 * ## Clock contract (units)
 *
 * `now()` MUST return **epoch milliseconds** (same scale as `Date.now()`).
 * Every quad timestamp (`t1`..`t4`) passed to `addSample`, every `position` /
 * `serverTime` / `now` argument, and the computed `offset`/`latency` are all in
 * **milliseconds**. The only seconds-scaled value is `OffsetSample.timestamp`,
 * which is stored as `now() / 1000` purely so the drift `timeDelta` lands on
 * the server's per-second `microtime(true)` scale — see `addSample`. That
 * `/ 1000` is correct ONLY because `now()` is ms; do not feed a seconds clock.
 */
/** Number of recent samples averaged for offset/latency/stability. */
export declare const OFFSET_SAMPLE_COUNT = 5;
/** Samples with a round-trip time above this (ms) are discarded as unreliable. */
export declare const MAX_ACCEPTABLE_RTT = 1000;
/** Offset-variance threshold (ms^2-ish, per the server) below which sync is stable. */
export declare const STABILITY_VARIANCE_THRESHOLD = 50;
/** Drift EMA smoothing factor (lower = smoother, slower to adapt). */
export declare const DRIFT_CORRECTION_FACTOR = 0.1;
/**
 * Lower bound for the drift-rate multiplier. A `driftRate` below this would
 * mean the playback clock runs *slower* than wall-clock by more than 1%, and
 * any value `< 1.0` risks `getAdjustedPosition` moving the playhead BACKWARDS
 * for a forward-elapsed interval. Clamping the EMA into `[MIN, MAX]` is
 * client-side hardening against noisy/forged offset sequences and does not
 * change what is sent on the wire.
 */
export declare const DRIFT_RATE_MIN = 0.99;
/** Upper bound for the drift-rate multiplier (≤1% fast). See DRIFT_RATE_MIN. */
export declare const DRIFT_RATE_MAX = 1.01;
/** Protocol version for time-sync messages (mirrors TimeSync::PROTOCOL_VERSION). */
export declare const TIME_SYNC_PROTOCOL_VERSION = 1;
import type { NowFn } from './framing';
/**
 * A single offset measurement. `offset` and `rtt` are in **milliseconds**;
 * `timestamp` is in **seconds** (`now() / 1000`), matching the server's
 * `microtime(true)` per-second scale used only for the drift `timeDelta`.
 */
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
     * Monotonic "samples version" — incremented every time the sample window
     * changes (`addSample` accept, `reset`). The cached window aggregates below
     * are keyed by this value so they invalidate exactly when the inputs change.
     */
    private samplesVersion;
    /**
     * Lazily-computed cache of the window aggregates (`getOffset`/`getLatency`/
     * `isStable`). `cacheVersion` records the `samplesVersion` the cache was
     * computed at; a mismatch means the cache is stale and must be recomputed.
     * `getStatus` calls all three per accepted pong, so this avoids re-slicing
     * and re-iterating the recent window three times for an unchanged dataset.
     * Caching is a pure performance optimization — the returned numbers are
     * byte-for-byte identical to recomputing on every call.
     */
    private cacheVersion;
    private cachedOffset;
    private cachedLatency;
    private cachedIsStable;
    /**
     * @param now Clock source returning **epoch milliseconds** (same scale as
     *            `Date.now()`). Required — no implicit `Date.now()`. The drift
     *            math presumes ms; see the class-level "Clock contract" note.
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
     * @returns true if the sample was accepted, false if rejected (rtt < 0 or
     *          rtt > MAX_ACCEPTABLE_RTT).
     */
    addSample(clientSend: number, serverRecv: number, serverResp: number, clientReceive: number): boolean;
    /**
     * Recompute the window aggregates into the cache if it is stale, then mark it
     * fresh. Called by `getOffset`/`getLatency`/`isStable` before reading the
     * cached fields. Idempotent for a given `samplesVersion`.
     */
    private ensureWindowCache;
    /**
     * Weighted-mean offset (ms) over the most recent samples. Lower-RTT samples
     * carry more weight. Add this to local time to get server time.
     *
     * Memoized: returns the cached value unless the sample window has changed
     * since it was last computed (see {@link ensureWindowCache}).
     */
    getOffset(): number;
    /** Pure weighted-mean offset computation over the recent window. */
    private computeOffset;
    /**
     * Estimated one-way latency (ms): mean of rtt/2 over recent samples.
     *
     * Memoized: returns the cached value unless the sample window has changed.
     */
    getLatency(): number;
    /** Pure mean-latency computation over the recent window. */
    private computeLatency;
    /**
     * True once at least OFFSET_SAMPLE_COUNT samples exist AND the variance of
     * the recent offsets is below the stability threshold.
     *
     * Memoized: returns the cached value unless the sample window has changed.
     */
    isStable(): boolean;
    /** Pure stability (offset-variance) computation over the recent window. */
    private computeIsStable;
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
