import { expect, test } from "vitest";
import {
  DEFAULTS,
  isStaleSeq,
  needsCorrection,
  nextBackoffMs,
  oneWayLatencyFromRtt,
  projectedHostTime,
} from "./sync-core";

const playing = { playing: true, currentTime: 100, playbackRate: 1, seq: 1 };
const paused = { playing: false, currentTime: 100, playbackRate: 1, seq: 1 };

test("projectedHostTime adds latency+elapsed scaled by rate while playing", () => {
  // latency 0.2s + elapsed 1.0s = 1.2s @ rate 1 => 101.2
  expect(projectedHostTime(playing, 0.2, 1.0)).toBeCloseTo(101.2);
  // rate 2x
  expect(projectedHostTime({ ...playing, playbackRate: 2 }, 0.2, 1.0)).toBeCloseTo(102.4);
});

test("projectedHostTime ignores latency/elapsed when paused", () => {
  expect(projectedHostTime(paused, 5, 10)).toBe(100);
});

test("needsCorrection compares absolute diff to tolerance", () => {
  expect(needsCorrection(100, 100.5, 1)).toBe(false);
  expect(needsCorrection(100, 101.5, 1)).toBe(true);
  expect(needsCorrection(103, 100, 1)).toBe(true);
});

test("isStaleSeq drops equal-or-older seq", () => {
  expect(isStaleSeq(5, 5)).toBe(true);
  expect(isStaleSeq(4, 5)).toBe(true);
  expect(isStaleSeq(6, 5)).toBe(false);
});

test("oneWayLatencyFromRtt halves RTT and converts ms->s", () => {
  expect(oneWayLatencyFromRtt(400)).toBeCloseTo(0.2);
});

test("oneWayLatencyFromRtt clamps negative RTT to 0 (clock went backwards)", () => {
  // Date.now() が NTP 補正等で後退すると now()-sent が負になり、projection が過去へ巻き戻る。
  expect(oneWayLatencyFromRtt(-100)).toBe(0);
});

test("oneWayLatencyFromRtt clamps non-finite RTT to 0", () => {
  expect(oneWayLatencyFromRtt(Number.NaN)).toBe(0);
  expect(oneWayLatencyFromRtt(Number.POSITIVE_INFINITY)).toBe(0);
});

test("nextBackoffMs grows exponentially and caps", () => {
  expect(nextBackoffMs(0)).toBe(500);
  expect(nextBackoffMs(1)).toBe(1000);
  expect(nextBackoffMs(3)).toBe(4000);
  expect(nextBackoffMs(20)).toBe(30000);
});

test("DEFAULTS match the spec", () => {
  expect(DEFAULTS.toleranceSec).toBe(1);
  expect(DEFAULTS.heartbeatMs).toBe(5000);
});
