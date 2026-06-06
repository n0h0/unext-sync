import type { PlaybackFields } from "./protocol";

export const DEFAULTS = {
  toleranceSec: 1,
  heartbeatMs: 5000,
  pingIntervalMs: 5000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 30000,
} as const;

/**
 * 参加者ローカルで推定するホストの現在再生位置。
 * 壁時計は使わない：oneWayLatencySec（RTT/2）と、受信からの経過時間（参加者の
 * monotonicクロックで測る）だけを使う。
 */
export function projectedHostTime(
  state: PlaybackFields,
  oneWayLatencySec: number,
  elapsedSinceReceiptSec: number,
): number {
  if (!state.playing) return state.currentTime;
  return state.currentTime + (oneWayLatencySec + elapsedSinceReceiptSec) * state.playbackRate;
}

export function needsCorrection(
  localTime: number,
  expected: number,
  toleranceSec: number,
): boolean {
  return Math.abs(localTime - expected) > toleranceSec;
}

export function isStaleSeq(incomingSeq: number, lastAppliedSeq: number): boolean {
  return incomingSeq <= lastAppliedSeq;
}

export function oneWayLatencyFromRtt(rttMs: number): number {
  return rttMs / 2 / 1000;
}

export function nextBackoffMs(
  attempt: number,
  baseMs: number = DEFAULTS.reconnectBaseMs,
  maxMs: number = DEFAULTS.reconnectMaxMs,
): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}
