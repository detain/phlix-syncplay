/**
 * time sync.test.
 *
 * @copyright 2026 Joe Huss <detain@interserver.net>
 */

import { describe, it, expect } from 'vitest';
import {
  TimeSync,
  OFFSET_SAMPLE_COUNT,
  MAX_ACCEPTABLE_RTT,
  DRIFT_CORRECTION_FACTOR,
  DRIFT_RATE_MIN,
  DRIFT_RATE_MAX,
  TIME_SYNC_PROTOCOL_VERSION,
  PING_INTERVAL_MS,
  startPinger,
  timePingAllowed,
} from '../src/time-sync';

/**
 * Offset aggregation law (crush-defect cured 2026-10-29).
 *
 * getOffset() returns the TRUE weighted mean of the recent window:
 * `sum(w * offset) / sum(w)` with `w = 1 / max(1, rtt)` — SPEC §5's "weighted
 * mean … favours low-RTT samples". Every weight in a non-empty accepted window
 * is positive, so the divisor is the real weight sum. The server's
 * `TimeSync.php::getTimeOffset()` historically divided by `max(1, $weightSum)`:
 * at realistic RTTs (20–1000 ms) every weight is < 1, the window total drops
 * below 1, the divisor freezes at 1, and the raw weighted SUM is returned —
 * crushing the offset toward zero (a true 120 ms offset read back as 3 ms).
 * The estate already ruled that a defect and fixed the mobile copy
 * (`phlix-mobile-client` `src/syncplay/SyncPlayService.ts`:
 * `Math.round(weightedSum / weightSum)`); this library matches that fix. The
 * server's local estimator still carries the crush until its own lockstep fix
 * lands — safe divergence, because this aggregation is per-side LOCAL math and
 * is never on the wire (ping/pong carry raw t1/t2 timestamps only).
 */

/** A controllable clock for deterministic tests. */
function makeClock(start = 0): { now: () => number; set: (v: number) => void; advance: (d: number) => void } {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (d: number) => {
      t += d;
    },
  };
}

describe('TimeSync constants', () => {
  it('mirrors the server constants exactly', () => {
    expect(OFFSET_SAMPLE_COUNT).toBe(5);
    expect(MAX_ACCEPTABLE_RTT).toBe(1000);
    expect(DRIFT_CORRECTION_FACTOR).toBe(0.1);
    expect(TIME_SYNC_PROTOCOL_VERSION).toBe(1);
  });

  it('exposes the drift-rate clamp bounds (B1)', () => {
    expect(DRIFT_RATE_MIN).toBe(0.99);
    expect(DRIFT_RATE_MAX).toBe(1.01);
    expect(DRIFT_RATE_MIN).toBeLessThan(1.0);
    expect(DRIFT_RATE_MAX).toBeGreaterThan(1.0);
  });
});

describe('TimeSync.addSample — server formula', () => {
  it('computes rtt, offset, latency for a known quad with unit weight (rtt=1)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // t1=1000, t2=1100, t3=1100, t4=1001.
    // rtt = 1001 - 1000 - 0 = 1
    // oneWay = trunc(0.5) = 0
    // offset = 1100 - 1000 - 0 = 100   (classical θ, S-syncplay-01)
    // weight = 1/max(1,1) = 1 → getOffset = round(100*1 / 1) = 100
    const accepted = ts.addSample(1000, 1100, 1100, 1001);
    expect(accepted).toBe(true);
    expect(ts.getOffset()).toBe(100);
    expect(ts.getLatency()).toBe(0);
  });

  it('honours a non-zero server processing gap (t3 != t2)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // t1=0, t2=100, t3=102 (2ms processing), t4=4
    // rtt = 4 - 0 - (102 - 100) = 2
    // oneWay = 1, offset = 100 - 0 - 1 = 99, weight = 1/2 = 0.5
    // getOffset = round(99*0.5 / 0.5) = 99 (true weighted mean; the pre-fix
    // max(1, weightSum) divisor froze at 1 and crushed this to 50).
    expect(ts.addSample(0, 100, 102, 4)).toBe(true);
    expect(ts.getLatency()).toBe(1);
    expect(ts.getOffset()).toBe(99);
  });

  it('does NOT crush a realistic-RTT single sample (regression: weightSum divisor)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    // rtt=40 → weight 0.025. The pre-fix `max(1, weightSum)` divisor froze at
    // 1 and returned the crushed weighted SUM: trunc(120*0.025) = 3. The true
    // weighted mean divides by the real weight sum: round(3 / 0.025) = 120.
    // Quad rotated by S-syncplay-01 to the classical-θ shape: a true skew of
    // 120 ms with symmetric 20 ms delay reads t2 = t1 + 120 + 20 = 140, and
    // offset = 140 - 0 - 20 = 120.
    ts.addSample(0, 140, 140, 40);
    expect(ts.getOffset()).toBe(120);
  });

  it('rejects samples with rtt > MAX_ACCEPTABLE_RTT', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // rtt = 2000 - 0 - 0 = 2000 > 1000 → rejected
    const accepted = ts.addSample(0, 500, 500, 2000);
    expect(accepted).toBe(false);
    expect(ts.getSampleCount()).toBe(0);
    expect(ts.getOffset()).toBe(0);
  });

  it('rejects a sample at exactly MAX_ACCEPTABLE_RTT + 1 (high-RTT branch)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // rtt = (MAX+1) - 0 - 0 = MAX+1 > MAX → rejected.
    const accepted = ts.addSample(0, 0, 0, MAX_ACCEPTABLE_RTT + 1);
    expect(accepted).toBe(false);
    expect(ts.getSampleCount()).toBe(0);
  });

  it('rejects samples producing rtt < 0 (negative one-way latency)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // clientReceive (t4) < clientSend (t1) → rtt = 990 - 1000 - 0 = -10 < 0.
    const accepted = ts.addSample(1000, 1100, 1100, 990);
    expect(accepted).toBe(false);
    expect(ts.getSampleCount()).toBe(0);
    expect(ts.getOffset()).toBe(0);
  });

  it('rejects a sample whose negative rtt comes from the server gap (t3 - t2)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // rtt = 1001 - 1000 - (1110 - 1100) = 1 - 10 = -9 < 0 → rejected.
    expect(ts.addSample(1000, 1100, 1110, 1001)).toBe(false);
    expect(ts.getSampleCount()).toBe(0);
  });

  it('accepts a valid sample with rtt === 0 (same-process / test path)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // rtt = 1000 - 1000 - 0 = 0 → accepted (the `< 0` guard is strict).
    const accepted = ts.addSample(1000, 1100, 1100, 1000);
    expect(accepted).toBe(true);
    expect(ts.getSampleCount()).toBe(1);
    // oneWay = 0; offset = 1100 - 1000 - 0 = 100.
    expect(ts.getOffset()).toBe(100);
  });

  it('still accepts an ordinary valid sample (positive rtt within bounds)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // rtt = 1001 - 1000 - 0 = 1 → accepted.
    expect(ts.addSample(1000, 1100, 1100, 1001)).toBe(true);
    expect(ts.getSampleCount()).toBe(1);
  });

  it('caps the rolling buffer at 2x OFFSET_SAMPLE_COUNT (shift branch)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // Push more than 2x the sample count; the oldest samples are dropped.
    for (let i = 0; i < OFFSET_SAMPLE_COUNT * 2 + 3; i++) {
      clock.advance(1000);
      ts.addSample(0, 100, 100, 1);
    }
    expect(ts.getSampleCount()).toBe(OFFSET_SAMPLE_COUNT * 2);
  });

  it('returns zero offset/latency before any samples', () => {
    const ts = new TimeSync(makeClock().now);
    expect(ts.getOffset()).toBe(0);
    expect(ts.getLatency()).toBe(0);
  });
});

describe('TimeSync.getOffset — weighted mean favours low RTT', () => {
  it('weights a low-rtt sample much more than a high-rtt one', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // Sample A: rtt 1, offset 100.  t1=0,t2=100,t3=100,t4=1 → offset 100, weight 1.
    ts.addSample(0, 100, 100, 1);
    // Sample B: rtt 1000, offset 1000. t1=0,t2=1500,t3=1500,t4=1000 →
    // offset = 1500 - 0 - 500 = 1000, weight 0.001. (Quad rotated by
    // S-syncplay-01: true skew 1000 ms + symmetric 500 ms delay ⇒ t2 = 1500.)
    ts.addSample(0, 1500, 1500, 1000);

    const weightA = 1; // 1/max(1,1)
    const weightB = 1 / 1000;
    // True weighted mean: round((100*1 + 1000*0.001) / (1 + 0.001)) = round(100.899…) = 101.
    const expected = Math.round((100 * weightA + 1000 * weightB) / (weightA + weightB));
    expect(ts.getOffset()).toBe(expected);
    // Result lies far closer to the low-rtt sample (100) than to 1000.
    expect(ts.getOffset()).toBeLessThan(150);
  });

  it('averages only the most recent OFFSET_SAMPLE_COUNT samples', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    // Push 7 identical stable samples (rtt 1, offset 100); only the last 5 count.
    for (let i = 0; i < 7; i++) {
      clock.advance(1000);
      ts.addSample(0, 100, 100, 1);
    }
    // weights all 1, weightSum 5 → round(100*5 / 5) = 100.
    expect(ts.getOffset()).toBe(100);
  });
});

describe('TimeSync.getOffset — realistic-sample vectors (crush-defect regression)', () => {
  /** Ground-truth server offset these vectors are built to recover (ms). */
  const TRUE_OFFSET_MS = 120;

  /**
   * Build a t1..t4 quad whose per-sample offset equals TRUE_OFFSET_MS and
   * whose round-trip time is exactly `rtt` (pong carries no separate response
   * stamp, so t3 == t2 — the same-process wire law, SPEC §5).
   * Physical model: TRUE_OFFSET_MS is the server's true clock skew S; `oneWay`
   * is the symmetric one-way delay, so the server receives at t2 = t1 + S +
   * oneWay and the classical θ (S-syncplay-01) recovers it:
   * sample offset = t2 - t1 - trunc(rtt / 2) = TRUE_OFFSET_MS.
   */
  function quadAtTrueOffset(t1: number, rtt: number): [number, number, number, number] {
    const oneWay = Math.trunc(rtt / 2);
    const t2 = t1 + TRUE_OFFSET_MS + oneWay;
    return [t1, t2, t2, t1 + rtt];
  }

  it('recovers the true offset from a jittery TV/phone RTT window (20-100 ms)', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // A plausible living-room window: wired TV ~20 ms, wifi phone ~45-80 ms,
    // one congested sample at 100 ms. All offsets sit exactly on truth.
    const rtts = [20, 45, 45, 80, 100];
    rtts.forEach((rtt, i) => {
      clock.advance(1000);
      const [t1, t2, t3, t4] = quadAtTrueOffset(1_000_000 + i * 1000, rtt);
      expect(ts.addSample(t1, t2, t3, t4)).toBe(true);
    });

    // PRE-FIX this window returned trunc(120 * 0.11444… / max(1, 0.11444…)) =
    // 13 — a ~10x crush. The weighted mean must land on truth exactly here
    // (all samples carry the same offset, so weights cannot skew the result).
    expect(ts.getOffset()).toBe(120);
    // The user-visible law: a box whose clock is 120 ms behind server time
    // gets server time back from getSynchronizedTime.
    expect(ts.getSynchronizedTime(1_000_000)).toBe(1_000_120);
    // And with a stable window, isStable() no longer certifies a crushed lie.
    expect(ts.isStable()).toBe(true);
  });

  it('tracks ground truth within ±2 ms across per-sample jitter', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Offsets jitter ±2 ms around truth, RTTs 30-90 ms.
    const vectors: Array<[rtt: number, offsetJitter: number]> = [
      [30, -2],
      [40, +1],
      [55, 0],
      [70, +2],
      [90, -1],
    ];
    const sampleOffsets: number[] = [];
    vectors.forEach(([rtt, jitter], i) => {
      clock.advance(1500);
      const t1 = 2_000_000 + i * 1500;
      const oneWay = Math.trunc(rtt / 2);
      const t2 = t1 + TRUE_OFFSET_MS + jitter + oneWay;
      expect(ts.addSample(t1, t2, t2, t1 + rtt)).toBe(true);
      sampleOffsets.push(TRUE_OFFSET_MS + jitter);
    });

    const offset = ts.getOffset();
    const mean = sampleOffsets.reduce((a, b) => a + b, 0) / sampleOffsets.length;
    // Lands within 2 ms of ground truth — and far clear of the pre-fix crushed
    // value trunc(120.16 * 0.08238…) = 9.
    expect(Math.abs(offset - TRUE_OFFSET_MS)).toBeLessThanOrEqual(2);
    expect(Math.abs(offset - mean)).toBeLessThanOrEqual(2);
  });

  it('actually WEIGHTS: a low-RTT outlier dominates a high-RTT consensus', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Four noisy consensus samples (rtt 40, w 0.025 each) and one crisp
    // low-RTT sample (rtt 2, w 0.5): the crisp sample's weight exceeds the
    // four consensus weights combined.
    for (let i = 0; i < 4; i++) {
      clock.advance(1000);
      ts.addSample(0, 138, 138, 40); // rtt 40, oneWay 20, offset = 138 - 20 = 118
    }
    ts.addSample(0, 201, 201, 2); // rtt 2, oneWay 1, offset = 201 - 1 = 200

    // consensus samples: rtt 40, oneWay 20, offset = 138 - 20 = 118, w 0.025.
    // crisp sample: offset 200, w 0.5.
    // weighted mean = (4*118*0.025 + 200*0.5) / (4*0.025 + 0.5)
    //               = (11.8 + 100) / 0.6 = 186.33… → round 186.
    // A plain (unweighted) mean would be 134; the PRE-FIX crushed sum was 111.
    expect(ts.getOffset()).toBe(186);
  });

  it('is symmetric for negative offsets (local clock ahead of server)', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // True offset -250 ms: local wall clock runs ahead of the server.
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      const t1 = 3_000_000 + i * 1000;
      const rtt = 40;
      const oneWay = Math.trunc(rtt / 2);
      const t2 = t1 - 250 + oneWay;
      expect(ts.addSample(t1, t2, t2, t1 + rtt)).toBe(true);
    }

    // PRE-FIX the crush returned trunc(-31.25) = -31 AND Math.trunc's
    // toward-zero bias is the same shrinkage family as the divisor defect;
    // the cured estimator lands on -250 exactly.
    expect(ts.getOffset()).toBe(-250);
    expect(ts.getSynchronizedTime(3_000_000)).toBe(2_999_750);
  });
});

describe('TimeSync.isStable', () => {
  it('is false before OFFSET_SAMPLE_COUNT samples', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    for (let i = 0; i < OFFSET_SAMPLE_COUNT - 1; i++) {
      clock.advance(1000);
      ts.addSample(0, 100, 100, 1);
    }
    expect(ts.isStable()).toBe(false);
  });

  it('is true when variance < 50 over enough samples', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    for (let i = 0; i < OFFSET_SAMPLE_COUNT; i++) {
      clock.advance(1000);
      ts.addSample(0, 100, 100, 1); // identical offsets → variance 0
    }
    expect(ts.isStable()).toBe(true);
  });

  it('is false when offset variance is high', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    // Alternate offsets 100 / 200 to push variance well above 50.
    const quads: Array<[number, number, number, number]> = [
      [0, 100, 100, 1], // offset 100
      [0, 200, 200, 1], // offset 200
      [0, 100, 100, 1], // 100
      [0, 200, 200, 1], // 200
      [0, 100, 100, 1], // 100
    ];
    for (const [a, b, c, d] of quads) {
      clock.advance(1000);
      ts.addSample(a, b, c, d);
    }
    expect(ts.isStable()).toBe(false);
  });
});

describe('TimeSync drift', () => {
  it('stays 1.0 with a single sample', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 100, 100, 1);
    expect(ts.getDriftRate()).toBe(1.0);
  });

  it('computes EMA drift from changing offsets over time', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Sample 1 at t=1000ms: offset 100 (rtt 1).
    clock.set(1000);
    ts.addSample(0, 100, 100, 1);
    // Sample 2 at t=3000ms (2s later): offset 110.
    clock.set(3000);
    ts.addSample(0, 110, 110, 1);

    // offsetDelta = 110-100 = 10; timeDelta = (3000-1000)/1000 = 2s.
    // drift = 10/2 = 5; driftRate = 1 + 0.1*5/1000 = 1.0005
    expect(ts.getDriftRate()).toBeCloseTo(1.0005, 6);
  });
});

describe('TimeSync drift clamp (B1)', () => {
  it('clamps a large positive offset jump to DRIFT_RATE_MAX', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Sample 1 @ t=1000ms: offset 0.  t1=0,t2=0,t3=0,t4=0 → offset 0.
    clock.set(1000);
    ts.addSample(0, 0, 0, 0);
    // Sample 2 @ t=2000ms (1s later): offset jumps to 100_000ms.
    // offsetDelta = 100000; timeDelta = 1s; drift = 100000;
    // raw driftRate = 1 + 0.1*100000/1000 = 11.0 → clamped to DRIFT_RATE_MAX.
    clock.set(2000);
    ts.addSample(0, 100000, 100000, 0);

    expect(ts.getDriftRate()).toBe(DRIFT_RATE_MAX);
    expect(ts.getDriftRate()).toBeLessThanOrEqual(DRIFT_RATE_MAX);
  });

  it('clamps a large negative offset jump to DRIFT_RATE_MIN and never below it', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Sample 1 @ t=1000ms: offset 100_000ms.
    clock.set(1000);
    ts.addSample(0, 100000, 100000, 0);
    // Sample 2 @ t=2000ms (1s later): offset drops to 0.
    // offsetDelta = -100000; drift = -100000;
    // raw driftRate = 1 - 10 = -9.0 → clamped to DRIFT_RATE_MIN.
    clock.set(2000);
    ts.addSample(0, 0, 0, 0);

    expect(ts.getDriftRate()).toBe(DRIFT_RATE_MIN);
    expect(ts.getDriftRate()).toBeGreaterThanOrEqual(DRIFT_RATE_MIN);
    expect(ts.getDriftRate()).toBeGreaterThan(0); // never zero/negative
  });

  it('leaves an in-range drift untouched (clamp is a no-op for small drift)', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    clock.set(1000);
    ts.addSample(0, 100, 100, 1); // offset 100
    clock.set(3000);
    ts.addSample(0, 110, 110, 1); // offset 110

    // raw driftRate 1.0005 is within [0.99, 1.01] → unchanged.
    expect(ts.getDriftRate()).toBeCloseTo(1.0005, 6);
    expect(ts.getDriftRate()).toBeGreaterThanOrEqual(DRIFT_RATE_MIN);
    expect(ts.getDriftRate()).toBeLessThanOrEqual(DRIFT_RATE_MAX);
  });

  it('regression: getAdjustedPosition never moves the playhead backwards for forward elapsed time even after a drift-suppressing offset sequence', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Drive the raw EMA below 1.0 with a steep negative offset jump.
    clock.set(1000);
    ts.addSample(0, 100000, 100000, 0); // offset 100000
    clock.set(2000);
    ts.addSample(0, 0, 0, 0); // offset 0 → raw drift << 0, clamped to MIN

    // Drift is clamped to DRIFT_RATE_MIN (>= 0.99 > 0).
    expect(ts.getDriftRate()).toBe(DRIFT_RATE_MIN);

    // With the current offset (0) and forward elapsed wall-clock, the adjusted
    // position must monotonically increase, never go backwards.
    const offset = ts.getOffset();
    const serverTime = 10000;
    const position = 5000;
    let prev = ts.getAdjustedPosition(position, serverTime, serverTime - offset);
    for (let nowMs = serverTime - offset + 1; nowMs <= serverTime - offset + 5000; nowMs += 250) {
      const next = ts.getAdjustedPosition(position, serverTime, nowMs);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });
});

describe('TimeSync clock contract (B8 — units, no behavior change)', () => {
  it('documents that drift timeDelta is in SECONDS given a known epoch-MS clock', () => {
    // The injected clock returns epoch MILLISECONDS. Two samples 2000ms apart
    // with an offsetDelta of 10ms must yield a per-SECOND drift, proving the
    // stored timestamp is now()/1000 (seconds): drift = 10 / ((3000-1000)/1000)
    // = 10 / 2 = 5, and driftRate = 1 + 0.1*5/1000 = 1.0005. If timeDelta were
    // wrongly kept in ms (2000), driftRate would be ~1.0000005 instead.
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    clock.set(1000); // ms
    ts.addSample(0, 100, 100, 1); // offset 100
    clock.set(3000); // ms (2 seconds later)
    ts.addSample(0, 110, 110, 1); // offset 110

    // Seconds-scaled timeDelta → 1.0005, NOT the ~1.0000005 a ms timeDelta gives.
    expect(ts.getDriftRate()).toBeCloseTo(1.0005, 6);
    expect(ts.getDriftRate()).not.toBeCloseTo(1.0000005, 6);
  });
});

describe('TimeSync time helpers', () => {
  it('getSynchronizedTime adds offset to injected now', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 100, 100, 1); // offset 100
    expect(ts.getSynchronizedTime(5000)).toBe(5100);
  });

  it('getAdjustedPosition advances position by drifted elapsed', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 100, 100, 1); // offset 100, drift 1.0 (single sample)

    // now=10000 → synchronizedNow = 10100. serverTime=10000.
    // elapsed = 100; drift 1.0 → adjusted = position + 100
    expect(ts.getAdjustedPosition(5000, 10000, 10000)).toBe(5100);
  });

  it('getAdjustedPosition clamps negative elapsed — a future-landing stamp floors at the commanded position (S-syncplay-15, phlix-syncplay-023)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 100, 100, 1); // offset 100, drift 1.0 (single sample)

    // now=10000 → synchronizedNow = 10100. serverTime=20000 lands 9900 ms in
    // the future. Pre-clamp math returned 5000 - 9900 = -4900 (playhead
    // rewound through the content); the floor law holds the commanded 5000.
    expect(ts.getAdjustedPosition(5000, 20000, 10000)).toBe(5000);
    // Exact boundary: elapsed === 0 rides the same floor.
    expect(ts.getAdjustedPosition(5000, 10100, 10000)).toBe(5000);
    // One ms of TRUE elapsed still advances — the floor is not a freeze.
    expect(ts.getAdjustedPosition(5000, 10099, 10000)).toBe(5001);
  });

  it('the negative-elapsed floor holds under a clamped-below-1.0 drift rate (drift cannot resurrect the rewind)', () => {
    const clock = makeClock(0);
    const ts = new TimeSync(clock.now);

    // Recreate the drift-suppressing sequence from the monotone-forward
    // regression: drift ends clamped at DRIFT_RATE_MIN (< 1.0).
    clock.set(1000);
    ts.addSample(0, 100000, 100000, 0);
    clock.set(2000);
    ts.addSample(0, 0, 0, 0);
    expect(ts.getDriftRate()).toBe(DRIFT_RATE_MIN);

    // serverTime far in any achievable future: pre-clamp the elapsed would go
    // negative and drift (< 1.0) would scale the rewind — the floor holds
    // position exactly regardless of the rate.
    expect(ts.getAdjustedPosition(5000, 1_000_000_000, 0)).toBe(5000);
  });

  it('reset clears samples and drift', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 100, 100, 1);
    ts.reset();
    expect(ts.getSampleCount()).toBe(0);
    expect(ts.getOffset()).toBe(0);
    expect(ts.getDriftRate()).toBe(1.0);
  });

  it('getStatus reports a full snapshot', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 100, 100, 1);
    const status = ts.getStatus();
    expect(status).toEqual({
      offset: 100,
      latency: 0,
      driftRate: 1.0,
      isStable: false,
      sampleCount: 1,
    });
  });
});

describe('TimeSync window-aggregate memoization (P3)', () => {
  it('cached values equal freshly-computed values over the same window', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    for (let i = 0; i < OFFSET_SAMPLE_COUNT; i++) {
      clock.advance(10);
      ts.addSample(0, 100, 100, 40);
    }

    // First access populates the cache; a second access must return identical
    // values (served from the cache, no recompute).
    const offset1 = ts.getOffset();
    const latency1 = ts.getLatency();
    const stable1 = ts.isStable();
    expect(ts.getOffset()).toBe(offset1);
    expect(ts.getLatency()).toBe(latency1);
    expect(ts.isStable()).toBe(stable1);

    // The cached numbers must equal an independent computation over the same
    // sample window (a fresh instance fed identical samples).
    const fresh = new TimeSync(makeClock().now);
    for (let i = 0; i < OFFSET_SAMPLE_COUNT; i++) {
      fresh.addSample(0, 100, 100, 40);
    }
    expect(offset1).toBe(fresh.getOffset());
    expect(latency1).toBe(fresh.getLatency());
    expect(stable1).toBe(fresh.isStable());
  });

  it('a value computed before addSample differs after it (cache invalidates)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // rtt=1 sample (weight exactly 1) → offset 100, latency 0.
    ts.addSample(1000, 1100, 1100, 1001);
    const offsetBefore = ts.getOffset();
    const latencyBefore = ts.getLatency();
    const stableBefore = ts.isStable();
    expect(offsetBefore).toBe(100);
    expect(stableBefore).toBe(false);

    // Add a sample with a very different offset/rtt; the cached aggregates must
    // recompute rather than return the pre-addSample values. Physically honest
    // under the S-syncplay-01 θ ruling: true skew 700 ms with symmetric 200 ms
    // delay ⇒ t2 = 2000 + 700 + 200 = 2900, and offset = 2900 - 2000 - 200 = 700.
    clock.advance(10);
    ts.addSample(2000, 2900, 2900, 2400);

    expect(ts.getOffset()).not.toBe(offsetBefore);
    expect(ts.getLatency()).not.toBe(latencyBefore);

    // Fill the window to OFFSET_SAMPLE_COUNT so isStable can flip true, proving
    // the cached `false` was invalidated.
    for (let i = 0; i < OFFSET_SAMPLE_COUNT; i++) {
      clock.advance(10);
      ts.addSample(0, 100, 100, 4);
    }
    expect(ts.isStable()).toBe(true);
    expect(ts.isStable()).not.toBe(stableBefore);
  });

  it('reset invalidates the cache (aggregates return to empty-window values)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    ts.addSample(1000, 1100, 1100, 1001); // rtt 1, weight 1 → offset 100
    expect(ts.getOffset()).toBe(100);
    ts.reset();
    // After reset the cache must recompute to the empty-window value, not
    // return the stale 101.
    expect(ts.getOffset()).toBe(0);
    expect(ts.getLatency()).toBe(0);
    expect(ts.isStable()).toBe(false);
  });
});

describe('TimeSync.updateDriftRate — early-return slope guards (time-sync.ts:339-368)', () => {
  // S-syncplay-34 re-anchor: this block previously narrated a stale "(line 292)"
  // cite and an `updateDrraftRate` typo, and its two `it()`s ended in clamp-
  // bounds asserts that can never fail (the initial 1.0 and every clamped
  // result both satisfy [DRIFT_RATE_MIN, DRIFT_RATE_MAX] by construction).
  // The live guard chain, coordinates verified against the shipped code:
  //   - `samples.length < 2` returns at time-sync.ts:340-342;
  //   - `recent.length < 2` returns at time-sync.ts:345-347 — strictly
  //     defensive: with OFFSET_SAMPLE_COUNT = 5, every samples.length >= 2
  //     slice keeps at least two entries, so while the first guard stands this
  //     arm cannot fire (the dead-guard conclusion the old narrative circled
  //     for thirty comment lines — stated once, with its coordinates);
  //   - `timeDelta <= 0` returns at time-sync.ts:353-355 — the slope guard the
  //     dataset below pins DIRECTLY, which is what the old block only gestured
  //     at through the vacuous bounds.
  // Samples store `timestamp = now() / 1000` (SECONDS — the units bridge at
  // time-sync.ts:188-191), so the clock values the dataset feeds are epoch ms.

  it.each([
    ['same-clock window (timeDelta === 0)', 1000, 1000],
    ['backward clock step (timeDelta < 0)', 5000, 3000],
  ] as Array<[string, number, number]>)(
    'a non-forward window never sets a slope — %s holds the 1.0 default',
    (_case, t1, t2) => {
      const clock = makeClock(t1);
      const ts = new TimeSync(clock.now);
      ts.addSample(0, 0, 0, 0); // offset 0, timestamp t1/1000
      clock.set(t2);
      ts.addSample(0, 100, 100, 0); // offset 100, timestamp t2/1000

      // The offsets DIFFER, so a computed slope would move the rate off the
      // default: timeDelta === 0 gives drift = 100/0 = +Infinity → clamped to
      // DRIFT_RATE_MAX; timeDelta < 0 gives drift = 100/-2 = -50 → raw 0.995.
      // Neither is 1.0, so this exact pin convicts the guard — mutation-proven
      // on a scratch copy: weakening `<= 0` to `< 0` reddens the zero row,
      // deleting the arm reddens both.
      expect(ts.getDriftRate()).toBe(1.0);
    },
  );

  it('positive control: a forward window past the guards reaches the slope math and computes the interior rate', () => {
    // The zero/negative pins above would also pass on an implementation whose
    // guards latch the rate shut forever. This pins the other side of the
    // time-sync.ts:353 boundary: timeDelta > 0 MUST reach the slope math —
    // mutation-proven: inverting the guard to `>= 0` reddens this test.
    const clock = makeClock(1000);
    const ts = new TimeSync(clock.now);
    ts.addSample(0, 0, 0, 0); // offset 0, timestamp 1s
    clock.set(101000);
    ts.addSample(0, 100, 100, 0); // offset 100, timestamp 101s

    // timeDelta = 100s; offsetDelta = 100ms → drift = 1 ms/s;
    // rate = 1 + 0.1*1/1000 = 1.0001 — interior, the clamp is a no-op.
    expect(ts.getDriftRate()).toBeCloseTo(1.0001, 6);
    expect(ts.getDriftRate()).not.toBe(1.0); // the window WAS observed
  });
});

describe('TimeSync.getSampleAgeMs — sample freshness (W-min124 M-SYNCPLAY-14, review syncplay__gameux m3)', () => {
  it('is null on an empty window (never invents an age)', () => {
    const clock = makeClock(5000);
    const ts = new TimeSync(clock.now);
    expect(ts.getSampleAgeMs()).toBeNull();
  });

  it('measures the NEWEST sample against the injected clock, in ms', () => {
    const clock = makeClock(1000);
    const ts = new TimeSync(clock.now);
    ts.addSample(1000, 1100, 1100, 1001); // timestamp = now()/1000 = 1s
    expect(ts.getSampleAgeMs()).toBe(0);
    clock.set(6000);
    expect(ts.getSampleAgeMs()).toBe(5000);
    ts.addSample(6000, 6100, 6100, 6001); // newest sample refreshes the age
    expect(ts.getSampleAgeMs()).toBe(0);
  });

  it('clamps at 0 across a BACKWARD clock step (never a negative age; m22 precedent)', () => {
    const clock = makeClock(10000);
    const ts = new TimeSync(clock.now);
    ts.addSample(10000, 10100, 10100, 10001);
    clock.set(4000); // wall clock stepped back 6s
    expect(ts.getSampleAgeMs()).toBeGreaterThanOrEqual(0);
    expect(ts.getSampleAgeMs()).toBe(0);
  });

  it('a rejected addSample refreshes nothing (garbage earns no timestamp)', () => {
    const clock = makeClock(1000);
    const ts = new TimeSync(clock.now);
    ts.addSample(1000, 1100, 1100, 1001);
    clock.set(4000);
    const rejected = ts.addSample(4000, 4100, 4100, 7500); // rtt 2500 > bound
    expect(rejected).toBe(false);
    expect(ts.getSampleAgeMs()).toBe(3000); // age still rides the GOOD sample
  });

  it('reset() clears the window back to null age', () => {
    const clock = makeClock(1000);
    const ts = new TimeSync(clock.now);
    ts.addSample(1000, 1100, 1100, 1001);
    ts.reset();
    expect(ts.getSampleAgeMs()).toBeNull();
  });
});

/**
 * The §10.1 ping law, shipped as a reusable seam (finding phlix-syncplay-004).
 *
 * Before this seam the pacing law lived ONLY inside `SyncPlayClient.pingTime`,
 * so every TypeScript consumer re-derived it — and drifted (the mobile client
 * forked the whole loop with its own interval and its own in-flight guard).
 * `timePingAllowed` is the law as one pure predicate; `startPinger` wraps it in
 * a cadence driven entirely by a CONSUMER-injected `{ schedule, cancel }` pair,
 * which keeps §10's "owns no socket and no periodic timers" law literally true:
 * the library never touches `setInterval`/`setTimeout` here — the scheduler the
 * consumer injects owns every timer, and tests own the fake.
 */
describe('timePingAllowed — §10.1 single-flight law as one predicate (phlix-syncplay-004)', () => {
  it('allows the first round (nothing outstanding)', () => {
    expect(timePingAllowed(null, 1000)).toBe(true);
  });

  it('refuses a ping while one is in flight across the whole window (age 0 … MAX_ACCEPTABLE_RTT)', () => {
    for (const age of [0, 1, 500, MAX_ACCEPTABLE_RTT]) {
      expect(timePingAllowed(1000, 1000 + age)).toBe(false);
    }
  });

  it('allows a re-ping once the outstanding round ages PAST the window (its pong could only rtt-reject)', () => {
    expect(timePingAllowed(1000, 1000 + MAX_ACCEPTABLE_RTT + 1)).toBe(true);
  });

  it('allows a re-ping through a BACKWARD clock step — a negative age is never a fresh ping (m22 arm)', () => {
    expect(timePingAllowed(1000, 999)).toBe(true);
    expect(timePingAllowed(1000, 4000 - 6000)).toBe(true); // age -1000: step back
  });
});

describe('startPinger — consumer-owned scheduler, compliant pacing seam (phlix-syncplay-004)', () => {
  type Arm = { cb: () => void; delayMs: number; cancelled: boolean; consumed: boolean };

  /** A fake scheduler: arms queue up, `fireNext` runs the oldest live one exactly once. */
  function makeFakeScheduler() {
    const arms: Arm[] = [];
    const cancels: number[] = [];
    const scheduler = {
      schedule: (cb: () => void, delayMs: number): Arm => {
        const arm: Arm = { cb, delayMs, cancelled: false, consumed: false };
        arms.push(arm);
        return arm;
      },
      cancel: (handle: unknown): void => {
        const arm = handle as Arm;
        if (arm.cancelled) {
          throw new Error('double-cancel: the seam must cancel each arm at most once');
        }
        arm.cancelled = true;
        cancels.push(arms.indexOf(arm));
      },
    };
    const live = () => arms.filter((a) => !a.cancelled && !a.consumed);
    return {
      scheduler,
      arms,
      cancels,
      live,
      fireNext(): void {
        const arm = live()[0];
        if (!arm) {
          throw new Error('no armed tick to fire');
        }
        arm.consumed = true;
        arm.cb();
      },
    };
  }

  it('ships the recommended cadence constant', () => {
    expect(PING_INTERVAL_MS).toBe(30000);
  });

  it('runs the first round synchronously and arms the next at PING_INTERVAL_MS', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    let pings = 0;
    startPinger({ ...sched.scheduler, ping: () => { pings += 1; }, now: clock.now });
    // §10.2: a connect/resume rebuilds the sync window immediately — no timer wait.
    expect(pings).toBe(1);
    expect(sched.live()).toHaveLength(1);
    expect(sched.live()[0].delayMs).toBe(PING_INTERVAL_MS);
  });

  it('honors a custom intervalMs (the wire enforces no ping rate — §8.5)', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    startPinger({ ...sched.scheduler, ping: () => {}, now: clock.now, intervalMs: 10000 });
    expect(sched.live()[0].delayMs).toBe(10000);
  });

  it('rejects a malformed intervalMs at the boundary (fail fast)', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    for (const bad of [0, -5, Number.NaN, 1.5]) {
      expect(() => startPinger({ ...sched.scheduler, ping: () => {}, now: clock.now, intervalMs: bad })).toThrow(RangeError);
    }
    expect(sched.arms).toHaveLength(0); // nothing armed before the throw
  });

  it('throws a TypeError when a seam function is missing (parse-don\'t-validate at the boundary)', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    expect(() => startPinger({ schedule: sched.scheduler.schedule, cancel: undefined as never, ping: () => {}, now: clock.now })).toThrow(TypeError);
    expect(() => startPinger({ schedule: undefined as never, cancel: sched.scheduler.cancel, ping: () => {}, now: clock.now })).toThrow(TypeError);
    expect(() => startPinger({ ...sched.scheduler, ping: undefined as never, now: clock.now })).toThrow(TypeError);
    expect(() => startPinger({ ...sched.scheduler, ping: () => {}, now: undefined as never })).toThrow(TypeError);
  });

  it('each lawful tick pings and re-arms — the cadence never dies', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    const stamps: number[] = [];
    startPinger({
      ...sched.scheduler,
      ping: () => { stamps.push(Math.trunc(clock.now())); },
      now: clock.now,
    });
    for (let i = 0; i < 3; i += 1) {
      clock.advance(PING_INTERVAL_MS);
      sched.fireNext();
    }
    expect(stamps).toEqual([1000, 31000, 61000, 91000]);
    expect(sched.arms).toHaveLength(4); // synchronous round + one arm per consumed tick
  });

  it('a tick racing inside the §10.1 window is skipped by the shared predicate — and the cadence re-arms anyway', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    let pings = 0;
    startPinger({ ...sched.scheduler, ping: () => { pings += 1; }, now: clock.now });
    clock.advance(10); // a spurious early fire: same in-flight window
    sched.fireNext();
    expect(pings).toBe(1); // the slot law refuses a stacked round
    expect(sched.arms).toHaveLength(2); // the skipped tick re-armed: cadence survives refusals
    clock.advance(MAX_ACCEPTABLE_RTT); // now the outstanding round is past the window
    sched.fireNext();
    expect(pings).toBe(2);
  });

  it('stop() cancels the armed tick exactly once; post-stop callbacks are inert; double stop idempotent', () => {
    const sched = makeFakeScheduler();
    const clock = makeClock(1000);
    let pings = 0;
    const handle = startPinger({ ...sched.scheduler, ping: () => { pings += 1; }, now: clock.now });
    const armed = sched.arms[0];
    handle.stop();
    expect(sched.cancels).toHaveLength(1);
    clock.set(1000 + PING_INTERVAL_MS);
    armed.cb(); // a scheduler that IGNORES cancel must still not drive the seam
    expect(pings).toBe(1);
    expect(sched.arms).toHaveLength(1); // no re-arm after stop
    handle.stop(); // idempotent — no second cancel (the fake would throw on one)
    expect(sched.cancels).toHaveLength(1);
  });

  it('independent pingers do not cross-talk (no global registry)', () => {
    const schedA = makeFakeScheduler();
    const schedB = makeFakeScheduler();
    const clock = makeClock(1000);
    let a = 0;
    let b = 0;
    const handleA = startPinger({ ...schedA.scheduler, ping: () => { a += 1; }, now: clock.now });
    startPinger({ ...schedB.scheduler, ping: () => { b += 1; }, now: clock.now });
    expect([a, b]).toEqual([1, 1]);
    handleA.stop();
    clock.set(1000 + PING_INTERVAL_MS);
    schedA.arms[0].cb(); // A is stopped: inert even if its scheduler misfires
    expect(a).toBe(1);
    schedB.fireNext();
    expect(b).toBe(2); // B never noticed A
  });
});
