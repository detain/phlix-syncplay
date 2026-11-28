/**
 * time sync.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

/**
 * TimeSync — NTP-style network time synchronization.
 *
 * This is the TypeScript port of the server's
 * `src/Session/SyncPlay/TimeSync.php`. The ping/quad shape (rtt, one-way
 * latency, per-sample offset) mirrors the server; since SPEC §5's
 * `S-syncplay-01` ruling the OFFSET SIGN follows classical NTP θ
 * (`t2 - t1 - oneWay`), which the shipped server does not yet compute —
 * its twin flip at `TimeSync.php:153` was ruled in the same estate release
 * and is routed to the phlix-server wave. Until that row lands, the two
 * sides disagree on the local estimate; that is a SAFE divergence (the
 * offset never crosses the wire — ping/pong carry raw t1/t2 only, see the
 * aggregation note below). The console port
 * (`phlix-console-client/src/Api/SyncPlay/TimeSync.php:60`) already agrees
 * with this ruling: it computes `t2 - t1 - rtt/2` from the receive side.
 *
 * ## Documented divergence (offset aggregation)
 *
 * The server's `getTimeOffset()` divides the weighted sum by
 * `max(1, $weightSum)`. At realistic RTTs every weight is `< 1` and the window
 * total falls below 1, so the divisor freezes at 1 and the result is the raw
 * weighted SUM — an offset crush toward zero (a true 120 ms offset read back
 * as 3 ms). The estate ruled that a defect and fixed the mobile copy
 * (`phlix-mobile-client` `src/syncplay/SyncPlayService.ts`); `getOffset()`
 * here implements SPEC §5's actual weighted mean, `sum(w * offset) / sum(w)`,
 * in lockstep with that fix. The server's local estimator still carries the
 * crush until its own fix lands — a SAFE divergence: this aggregation is
 * per-side local math and never crosses the wire (ping/pong carry raw t1/t2
 * timestamps only; client and server need not agree on how they average them).
 *
 * ## Algorithm
 *
 *   t1 = client send time      (client_time in the ping)
 *   t2 = server receive time   (server_time in the pong; the server echoes the
 *                               client's own t1 back on the pong as client_time)
 *   t3 = server response time  (== t2 in practice: the server replies in the
 *                               same handler with no measurable processing gap)
 *   t4 = client receive time
 *
 *   rtt    = t4 - t1 - (t3 - t2)
 *   oneWay = trunc(rtt / 2)        // INTEGER-truncated — `Math.trunc` in
 *                                  // addSample, mirroring the server's int cast
 *   offset = t2 - t1 - oneWay        // classical NTP θ (SPEC §5, S-syncplay-01):
 *                                  // add to local time to get server time
 *
 * Samples with `rtt < 0` (corrupt: negative one-way latency) or
 * `rtt > MAX_ACCEPTABLE_RTT` are rejected. `getOffset()` returns a
 * weighted mean (`weight = 1 / max(1, rtt)`, favouring low-RTT samples;
 * mean = `sum(w * offset) / sum(w)`) over the most recent
 * `OFFSET_SAMPLE_COUNT` samples. Sync is "stable" once at least
 * `OFFSET_SAMPLE_COUNT` samples exist AND the population variance of recent
 * offsets is < 50 (unit ms² — variance of the integer-ms offsets; the server's
 * threshold is the same unit-less `50`). Drift is a WINDOW SLOPE: `driftRate = 1.0 + 0.1 * (offsetDelta / timeDelta) / 1000`,
 * recomputed from the recent window on every call with no carry from the previous rate.
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
export const OFFSET_SAMPLE_COUNT = 5;

/** Samples with a round-trip time above this (ms) are discarded as unreliable. */
export const MAX_ACCEPTABLE_RTT = 1000;

/** Offset-variance threshold (ms² — variance of ms; the server's constant is the unit-less 50) below which sync is stable. */
export const STABILITY_VARIANCE_THRESHOLD = 50;

/** Scale factor applied to the window-slope drift estimate (lower = a more conservative rate; no smoothing carry exists). */
export const DRIFT_CORRECTION_FACTOR = 0.1;

/**
 * Lower bound for the drift-rate multiplier. A `driftRate` below this would
 * mean the playback clock runs *slower* than wall-clock by more than 1%, and
 * any value `< 1.0` risks `getAdjustedPosition` moving the playhead BACKWARDS
 * for a forward-elapsed interval. Clamping the window-slope rate into
 * `[MIN, MAX]` is client-side hardening against noisy/forged offset sequences
 * and does not change what is sent on the wire.
 */
export const DRIFT_RATE_MIN = 0.99;

/** Upper bound for the drift-rate multiplier (≤1% fast). See DRIFT_RATE_MIN. */
export const DRIFT_RATE_MAX = 1.01;

/** Protocol version for time-sync messages (mirrors TimeSync::PROTOCOL_VERSION). */
export const TIME_SYNC_PROTOCOL_VERSION = 1;

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

export class TimeSync {
  private samples: OffsetSample[] = [];
  private driftRate = 1.0;
  private readonly now: NowFn;

  /**
   * Monotonic "samples version" — incremented every time the sample window
   * changes (`addSample` accept, `reset`). The cached window aggregates below
   * are keyed by this value so they invalidate exactly when the inputs change.
   */
  private samplesVersion = 0;

  /**
   * Lazily-computed cache of the window aggregates (`getOffset`/`getLatency`/
   * `isStable`). `cacheVersion` records the `samplesVersion` the cache was
   * computed at; a mismatch means the cache is stale and must be recomputed.
   * `getStatus` calls all three per accepted pong, so this avoids re-slicing
   * and re-iterating the recent window three times for an unchanged dataset.
   * Caching is a pure performance optimization — the returned numbers are
   * byte-for-byte identical to recomputing on every call.
   */
  private cacheVersion = -1;
  private cachedOffset = 0;
  private cachedLatency = 0;
  private cachedIsStable = false;

  /**
   * @param now Clock source returning **epoch milliseconds** (same scale as
   *            `Date.now()`). Required — no implicit `Date.now()`. The drift
   *            math presumes ms; see the class-level "Clock contract" note.
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
    // offset = t2 - t1 - oneWay — classical NTP θ (SPEC §5, S-syncplay-01):
    // server receive time minus client send time, MINUS the one-way delay
    // estimate. The pre-ruling `+` form led the true skew by a full rtt.
    const offset = serverRecv - clientSend - Math.trunc(oneWayLatency);

    this.samples.push({
      offset,
      rtt,
      // `now()` is epoch MILLISECONDS (see the class "Clock contract" note);
      // we store `now() / 1000` so the drift `timeDelta` is in SECONDS, the
      // same per-second scale as the server's `microtime(true)`. This `/ 1000`
      // is the units bridge — it presumes a ms clock and must not be removed.
      timestamp: this.now() / 1000,
    });

    // Rolling buffer of up to 2x the sample count.
    if (this.samples.length > OFFSET_SAMPLE_COUNT * 2) {
      this.samples.shift();
    }

    // The sample window changed — bump the version so the cached aggregates
    // (offset/latency/isStable) recompute lazily on next access.
    this.samplesVersion++;

    this.updateDriftRate();
    return true;
  }

  /**
   * Recompute the window aggregates into the cache if it is stale, then mark it
   * fresh. Called by `getOffset`/`getLatency`/`isStable` before reading the
   * cached fields. Idempotent for a given `samplesVersion`.
   */
  private ensureWindowCache(): void {
    if (this.cacheVersion === this.samplesVersion) {
      return;
    }
    this.cachedOffset = this.computeOffset();
    this.cachedLatency = this.computeLatency();
    this.cachedIsStable = this.computeIsStable();
    this.cacheVersion = this.samplesVersion;
  }

  /**
   * Weighted-mean offset (ms) over the most recent samples:
   * `sum(weight * offset) / sum(weight)` with `weight = 1 / max(1, rtt)`, so
   * lower-RTT samples carry more weight (SPEC §5). Add this to local time to
   * get server time.
   *
   * Memoized: returns the cached value unless the sample window has changed
   * since it was last computed (see {@link ensureWindowCache}).
   */
  getOffset(): number {
    this.ensureWindowCache();
    return this.cachedOffset;
  }

  /** Pure weighted-mean offset computation over the recent window. */
  private computeOffset(): number {
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

    // Every accepted sample has rtt <= MAX_ACCEPTABLE_RTT, so each weight is
    // >= 1/1000 > 0 and weightSum is strictly positive for a non-empty window
    // — unreachable today. The guard keeps the function total (never NaN/∞)
    // if the admission bounds ever change.
    if (weightSum === 0) {
      return 0;
    }

    // Divide by the REAL weight sum. The server's legacy
    // `max(1, $weightSum)` divisor froze at 1 for realistic RTTs and crushed
    // the raw weighted sum toward zero (true 120 ms read back as 3) — ruled a
    // defect by the estate and already fixed the same way in the mobile copy
    // (`Math.round(weightedSum / weightSum)`); see the class header divergence
    // note. `Math.round` (not `Math.trunc`): round is symmetric, trunc would
    // retain a toward-zero shrinkage bias on negative offsets. SPEC §5 does
    // not prescribe an integer rule — disclosed divergence from the server's
    // int cast.
    return Math.round(weightedSum / weightSum);
  }

  /**
   * Estimated one-way latency (ms): mean of rtt/2 over recent samples.
   *
   * Memoized: returns the cached value unless the sample window has changed.
   */
  getLatency(): number {
    this.ensureWindowCache();
    return this.cachedLatency;
  }

  /** Pure mean-latency computation over the recent window. */
  private computeLatency(): number {
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
   * True once at least OFFSET_SAMPLE_COUNT samples exist AND the population
   * variance of the recent offsets is below the stability threshold (ms²).
   *
   * Memoized: returns the cached value unless the sample window has changed.
   */
  isStable(): boolean {
    this.ensureWindowCache();
    return this.cachedIsStable;
  }

  /** Pure stability (offset-variance) computation over the recent window. */
  private computeIsStable(): boolean {
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
   * Recompute the local clock drift rate as a WINDOW SLOPE: the offset change
   * per second across the recent sample window (first to last sample), scaled
   * by DRIFT_CORRECTION_FACTOR. The result fully OVERWRITES the previous
   * rate — there is no carry from it. 1.0 = no drift; >1 = local clock
   * gaining, <1 = losing.
   *
   * Windows and Mobile omitted drift entirely; this restores it (matching the
   * server and Tizen). The server's copy shares the no-carry slope but applies
   * no [DRIFT_RATE_MIN, DRIFT_RATE_MAX] clamp — recorded in SPEC §7.
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

    // Clamp into [DRIFT_RATE_MIN, DRIFT_RATE_MAX]. A noisy or forged offset
    // sequence could otherwise push the raw window-slope estimate out of
    // range; a value < 1.0 in particular would let getAdjustedPosition move
    // the playhead backwards for a forward-elapsed interval. Client-side
    // hardening only — the wire is unaffected.
    this.driftRate = Math.min(DRIFT_RATE_MAX, Math.max(DRIFT_RATE_MIN, this.driftRate));
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
   * CONSUMER LAW: the advance here is UNCONDITIONAL — interpolate ONLY while
   * the group's `playback_state` is playing; while paused, HOLD the commanded
   * position the frames carry (a paused player that interpolates drifts off
   * the pause every peer honored).
   *
   * NEGATIVE-ELAPSED FLOOR (SPEC §5, MUST): elapsed is clamped to >= 0 BEFORE
   * drift is applied, so a future-landing `serverTime` (clock skew, forged or
   * reordered stamp) holds the commanded `position` instead of rewinding the
   * playhead through the content. Same discipline as getSampleAgeMs()'s
   * clamp-at-0 and the CONSOLIDATED m22 backward-step clamp.
   *
   * @param position   Host position (ms) at the moment of `serverTime`.
   * @param serverTime Server-synchronized timestamp the position was captured at (ms).
   * @param now        Current local wall-clock (ms).
   */
  getAdjustedPosition(position: number, serverTime: number, now: number): number {
    const synchronizedNow = this.getSynchronizedTime(now);
    const elapsed = Math.max(0, synchronizedNow - serverTime);
    return position + elapsed * this.driftRate;
  }

  /** Clear all samples and reset drift. */
  reset(): void {
    this.samples = [];
    this.driftRate = 1.0;
    // The sample window changed (emptied) — bump the version so the cached
    // aggregates recompute on next access rather than returning stale values.
    this.samplesVersion++;
  }

  /**
   * Age of the NEWEST accepted sample, in **milliseconds**, measured against
   * this class's own injected clock (W-min124 M-SYNCPLAY-14, review
   * `syncplay__gameux` m3). `null` when the window is empty.
   *
   * The window carries no expiry of its own: after a laptop sleep or a
   * frozen timer tab the aggregates keep serving a window recorded hours ago
   * with full confidence — `isStable()` says "stable" about time that is
   * merely STALE. This accessor exists because that gap is only observable
   * with a clock, and the clock was already injected here; consumers decide
   * their own freshness bound (and whether to `reset()` and re-ping when it
   * is exceeded). The library deliberately invents no default threshold —
   * the server's `TimeSync.php` has no freshness bound either, so a
   * built-in one would make the library stricter than the wire law it
   * mirrors.
   *
   * Scale note: `OffsetSample.timestamp` stores SECONDS (the `now() / 1000`
   * drift bridge, see {@link addSample}); this accessor converts back, so
   * its output is ms like every other public number here.
   *
   * Clamped at 0: a BACKWARD wall-clock step (NTP correction, manual clock
   * change) would otherwise yield a negative age, which consumers comparing
   * against a freshness bound read as "fresher than fresh". Same discipline
   * as the CONSOLIDATED m22 backward-step clamp in `client.ts`.
   */
  getSampleAgeMs(): number | null {
    const last = this.samples[this.samples.length - 1];
    if (last === undefined) {
      return null;
    }
    return Math.max(0, this.now() - last.timestamp * 1000);
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

/**
 * Recommended ping cadence for the {@link startPinger} seam (finding
 * phlix-syncplay-004). The wire enforces NO ping rate — the server absorbs
 * command frames at whatever rate arrives (SPEC §8.5) — so the cadence is a
 * client-side quality choice: fast enough to keep the §5 window fresh between
 * rounds, gentle enough not to spam. 30 s matches the interval the mobile
 * client converged on before it forked the loop; consumers may dial any value
 * they like, the seam never argues with `intervalMs` beyond sanity.
 */
export const PING_INTERVAL_MS = 30000;

/**
 * The §10.1 ping law as ONE pure predicate (finding phlix-syncplay-004).
 *
 * `SyncPlayClient.pingTime()` and {@link startPinger} share this function, so
 * a consumer driving pings through either path — or both — meets the same
 * law: a round is in flight exactly while `outstanding` is set within
 * `[0, MAX_ACCEPTABLE_RTT]` of `nowMs`, and calls inside that window are
 * refused because a pong can only be attributed to the one recorded send
 * time. An unanswered round older than the window can never seed a sample
 * (any such sample would itself be rejected on `rtt`), so it is treated as
 * lost and the next call may re-ping; a BACKWARD wall-clock step makes the
 * age negative, which is never a fresh ping — re-ping and let the newest send
 * time own the slot instead of wedging sync forever (SPEC §10.1's m22 arm).
 *
 * @param outstanding send time of the in-flight round, or `null` when none
 * @param nowMs       current time on the same injected epoch-ms clock
 * @returns `true` when a `TIME_PING` round may start now
 */
export function timePingAllowed(outstanding: number | null, nowMs: number): boolean {
  if (outstanding === null) {
    return true;
  }
  const age = nowMs - outstanding;
  return !(age >= 0 && age <= MAX_ACCEPTABLE_RTT);
}

/**
 * Consumer-injected timer pair for {@link startPinger}. Handles are OPAQUE:
 * the seam stores whatever `schedule` returns and hands it back to `cancel`,
 * so the library keeps its §10 promise to own no socket and no periodic
 * timers — `setInterval`/`setTimeout` never appear on this path, the
 * consumer's scheduler (or a test fake) owns every timer that ever ticks.
 */
export interface PingerScheduler {
  /** Arm `callback` after `delayMs`; return an opaque handle for {@link cancel}. */
  schedule(callback: () => void, delayMs: number): unknown;
  /** Disarm the handle a previous {@link schedule} returned. */
  cancel(handle: unknown): void;
}

/** Options for {@link startPinger}. */
export interface StartPingerOptions extends PingerScheduler {
  /** Start one ping round — typically `() => client.pingTime()`. */
  ping: () => void;
  /** Epoch-milliseconds clock, the same one handed to `SyncPlayClient`. */
  now: () => number;
  /** Arm delay between rounds; defaults to {@link PING_INTERVAL_MS}. */
  intervalMs?: number;
}

/** Stop handle returned by {@link startPinger}. */
export interface PingerHandle {
  /** Cancel the armed round exactly once; repeat calls are inert. */
  stop(): void;
}

/**
 * The §5 pacing seam: a reusable compliant ping loop (finding
 * phlix-syncplay-004).
 *
 * Before this seam the pacing law existed only inside
 * `SyncPlayClient.pingTime()`, so every TypeScript consumer re-derived the
 * loop around it — and drifted (the mobile client forked the whole thing:
 * its own time-sync copy, its own 30 s interval, its own in-flight guard).
 * `startPinger` ships the loop itself from this library, parameterised by an
 * injectable `{ schedule, cancel }` pair so it is testable without touching
 * wall-clock timer semantics and honest about §10: the library arms nothing.
 *
 * Semantics (documented choices, pinned by `test/time-sync.test.ts`):
 * - the FIRST round runs synchronously inside `startPinger()` — a
 *   connect/resume rebuilds the sync window immediately (§10.2), no timer
 *   wait for the first pong;
 * - every tick re-checks the §10.1 law through {@link timePingAllowed} even
 *   when `ping()` is a dumb callback, so a pinger tick racing a manual ping
 *   cannot stack rounds; a refused tick still re-arms — refusals never kill
 *   the cadence;
 * - ticks truncate `now()` to integer milliseconds for the same reason
 *   `pingTime()` does (SPY-2: the quad and the echo must be the same
 *   integer);
 * - `stop()` cancels the armed handle exactly once and is idempotent; a
 *   scheduler that ignores `cancel` and fires anyway drives an inert seam —
 *   no ping, no re-arm;
 * - there is NO global registry: each call starts an independent pinger, and
 *   stopping one cannot disturb another.
 *
 * @param options the {@link StartPingerOptions} seam contract
 * @returns a {@link PingerHandle} to end the loop
 * @throws TypeError when `schedule`/`cancel`/`ping`/`now` is not a function
 * @throws RangeError when `intervalMs` is present but not an integer >= 1
 */
export function startPinger(options: StartPingerOptions): PingerHandle {
  const { schedule, cancel, ping, now } = options;
  if (typeof schedule !== 'function' || typeof cancel !== 'function' || typeof ping !== 'function' || typeof now !== 'function') {
    throw new TypeError('startPinger requires schedule, cancel, ping and now functions');
  }
  const intervalMs = options.intervalMs ?? PING_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError(`startPinger intervalMs must be an integer >= 1, got ${String(intervalMs)}`);
  }
  let stopped = false;
  let armed: unknown = null;
  let lastRound: number | null = null;
  const tick = (): void => {
    if (stopped) {
      return;
    }
    const t1 = Math.trunc(now());
    if (timePingAllowed(lastRound, t1)) {
      lastRound = t1;
      ping();
    }
    if (stopped) {
      return; // ping() itself stopped the pinger — leave nothing armed
    }
    armed = schedule(tick, intervalMs);
  };
  tick();
  return {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      const handle = armed;
      armed = null;
      if (handle !== null) {
        cancel(handle);
      }
    },
  };
}
