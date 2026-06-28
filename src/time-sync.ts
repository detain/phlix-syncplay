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
 * never calls `Date.now()` itself. `timestamp` units match the server: seconds
 * (PHP `microtime(true)`), which only affects the drift `timeDelta` scaling.
 */

/** Number of recent samples averaged for offset/latency/stability. */
export const OFFSET_SAMPLE_COUNT = 5;

/** Samples with a round-trip time above this (ms) are discarded as unreliable. */
export const MAX_ACCEPTABLE_RTT = 1000;

/** Offset-variance threshold (ms^2-ish, per the server) below which sync is stable. */
export const STABILITY_VARIANCE_THRESHOLD = 50;

/** Drift EMA smoothing factor (lower = smoother, slower to adapt). */
export const DRIFT_CORRECTION_FACTOR = 0.1;

/** Protocol version for time-sync messages (mirrors TimeSync::PROTOCOL_VERSION). */
export const TIME_SYNC_PROTOCOL_VERSION = 1;

import type { NowFn } from './framing';

/** A single offset measurement. `timestamp` is in SECONDS (matches PHP). */
export interface OffsetSample {
  offset: number;
  rtt: number;
  timestamp: number;
}

export class TimeSync {
  private samples: OffsetSample[] = [];
  private driftRate = 1.0;
  private readonly now: NowFn;

  /**
   * @param now Clock source (epoch ms). Required — no implicit `Date.now()`.
   */
  constructor(now: NowFn) {
    this.now = now;
  }

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
  addSample(
    clientSend: number,
    serverRecv: number,
    serverResp: number,
    clientReceive: number,
  ): boolean {
    const rtt = clientReceive - clientSend - (serverResp - serverRecv);

    // Reject a negative rtt: it would yield a negative one-way latency and a
    // corrupt offset. `< 0` is strict so rtt === 0 is still accepted (the
    // same-process / test path where the server can legitimately emit rtt 0).
    if (rtt < 0 || rtt > MAX_ACCEPTABLE_RTT) {
      return false;
    }

    const oneWayLatency = rtt / 2;
    // offset = server_time - client_time + estimated_latency
    const offset = serverRecv - clientSend + Math.trunc(oneWayLatency);

    this.samples.push({
      offset,
      rtt,
      // Seconds, mirroring PHP microtime(true), used only for drift timeDelta.
      timestamp: this.now() / 1000,
    });

    // Rolling buffer of up to 2x the sample count.
    if (this.samples.length > OFFSET_SAMPLE_COUNT * 2) {
      this.samples.shift();
    }

    this.updateDriftRate();
    return true;
  }

  /**
   * Weighted-mean offset (ms) over the most recent samples. Lower-RTT samples
   * carry more weight. Add this to local time to get server time.
   */
  getOffset(): number {
    if (this.samples.length === 0) {
      return 0;
    }

    const recent = this.samples.slice(-OFFSET_SAMPLE_COUNT);
    let weightedSum = 0;
    let weightSum = 0;

    for (const sample of recent) {
      const weight = 1 / Math.max(1, sample.rtt);
      weightedSum += sample.offset * weight;
      weightSum += weight;
    }

    return Math.trunc(weightedSum / Math.max(1, weightSum));
  }

  /** Estimated one-way latency (ms): mean of rtt/2 over recent samples. */
  getLatency(): number {
    if (this.samples.length === 0) {
      return 0;
    }

    const recent = this.samples.slice(-OFFSET_SAMPLE_COUNT);
    let total = 0;
    for (const sample of recent) {
      total += sample.rtt / 2;
    }

    return Math.trunc(total / Math.max(1, recent.length));
  }

  /**
   * True once at least OFFSET_SAMPLE_COUNT samples exist AND the variance of
   * the recent offsets is below the stability threshold.
   */
  isStable(): boolean {
    if (this.samples.length < OFFSET_SAMPLE_COUNT) {
      return false;
    }

    const recent = this.samples.slice(-OFFSET_SAMPLE_COUNT);
    const offsets = recent.map((s) => s.offset);
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;

    let varianceSum = 0;
    for (const offset of offsets) {
      const diff = offset - mean;
      varianceSum += diff * diff;
    }
    const variance = varianceSum / offsets.length;

    return variance < STABILITY_VARIANCE_THRESHOLD;
  }

  /**
   * Recompute the local clock drift rate as an EMA of recent offset change per
   * second. 1.0 = no drift; >1 = local clock gaining, <1 = losing.
   *
   * Windows and Mobile omitted drift entirely; this restores it (matching the
   * server and Tizen).
   */
  updateDriftRate(): void {
    if (this.samples.length < 2) {
      return;
    }

    const recent = this.samples.slice(-OFFSET_SAMPLE_COUNT);
    if (recent.length < 2) {
      return;
    }

    const first = recent[0];
    const last = recent[recent.length - 1];

    const timeDelta = last.timestamp - first.timestamp;
    if (timeDelta <= 0) {
      return;
    }

    const offsetDelta = last.offset - first.offset;
    const drift = offsetDelta / timeDelta;

    this.driftRate = 1.0 + (DRIFT_CORRECTION_FACTOR * drift) / 1000;
  }

  /** Current drift-rate multiplier (1.0 = no drift). */
  getDriftRate(): number {
    return this.driftRate;
  }

  /** Number of retained samples. */
  getSampleCount(): number {
    return this.samples.length;
  }

  /** Synchronized time = injected local time + current offset (ms). */
  getSynchronizedTime(now: number): number {
    return now + this.getOffset();
  }

  /**
   * Compute the playback position a member should currently be at, given the
   * host's reported `position` captured at `serverTime`, evaluated at local
   * time `now`. Applies drift to the elapsed synchronized interval.
   *
   * @param position   Host position (ms) at the moment of `serverTime`.
   * @param serverTime Server-synchronized timestamp the position was captured at (ms).
   * @param now        Current local wall-clock (ms).
   */
  getAdjustedPosition(position: number, serverTime: number, now: number): number {
    const synchronizedNow = this.getSynchronizedTime(now);
    const elapsed = synchronizedNow - serverTime;
    return position + elapsed * this.driftRate;
  }

  /** Clear all samples and reset drift. */
  reset(): void {
    this.samples = [];
    this.driftRate = 1.0;
  }

  /** Snapshot of current sync state (parallels TimeSync::getStatus). */
  getStatus(): {
    offset: number;
    latency: number;
    driftRate: number;
    isStable: boolean;
    sampleCount: number;
  } {
    return {
      offset: this.getOffset(),
      latency: this.getLatency(),
      driftRate: this.driftRate,
      isStable: this.isStable(),
      sampleCount: this.samples.length,
    };
  }
}
