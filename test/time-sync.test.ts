import { describe, it, expect } from 'vitest';
import {
  TimeSync,
  OFFSET_SAMPLE_COUNT,
  MAX_ACCEPTABLE_RTT,
  DRIFT_CORRECTION_FACTOR,
  TIME_SYNC_PROTOCOL_VERSION,
} from '../src/time-sync';

/**
 * NOTE on the server's weighted-mean quirk (faithfully ported):
 * getOffset() divides by `max(1, weightSum)`. When the only samples have
 * rtt > 1 the total weight is < 1, so the guard clamps the divisor to 1 and
 * the returned offset is the *weighted sum*, not a true mean. This matches
 * TimeSync.php (`(int)($weightedSum / max(1, $weightSum))`) and the mobile
 * client exactly. Tests below use rtt values that make the math exact and
 * also assert the quirk explicitly.
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
});

describe('TimeSync.addSample — server formula', () => {
  it('computes rtt, offset, latency for a known quad with unit weight (rtt=1)', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);

    // t1=1000, t2=1100, t3=1100, t4=1001.
    // rtt = 1001 - 1000 - 0 = 1
    // oneWay = trunc(0.5) = 0
    // offset = 1100 - 1000 + 0 = 100
    // weight = 1/max(1,1) = 1 → getOffset = trunc(100*1 / max(1,1)) = 100
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
    // oneWay = 1, offset = 100 - 0 + 1 = 101, weight = 1/2 = 0.5
    // getOffset = trunc(101*0.5 / max(1, 0.5)) = trunc(50.5 / 1) = 50  (clamp quirk)
    expect(ts.addSample(0, 100, 102, 4)).toBe(true);
    expect(ts.getLatency()).toBe(1);
    expect(ts.getOffset()).toBe(50);
  });

  it('exposes the max(1, weightSum) clamp quirk for high-rtt single samples', () => {
    const clock = makeClock();
    const ts = new TimeSync(clock.now);
    // rtt=40 → weight 0.025; offset 120; getOffset = trunc(120*0.025 / 1) = 3.
    ts.addSample(0, 100, 100, 40);
    expect(ts.getOffset()).toBe(3);
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
    // oneWay = 0; offset = 1100 - 1000 + 0 = 100.
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
    // Sample B: rtt 1000, offset 1000. t1=0,t2=500,t3=500,t4=1000 → offset 1000, weight 0.001.
    ts.addSample(0, 500, 500, 1000);

    const weightA = 1; // 1/max(1,1)
    const weightB = 1 / 1000;
    const expected = Math.trunc((100 * weightA + 1000 * weightB) / Math.max(1, weightA + weightB));
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
    // weights all 1, weightSum 5 → trunc(100*5 / 5) = 100.
    expect(ts.getOffset()).toBe(100);
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
