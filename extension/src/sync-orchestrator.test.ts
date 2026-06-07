import { expect, test, vi } from "vitest";
import type { StateMessage } from "../../shared/protocol";
import { DEFAULTS } from "../../shared/sync-core";
import { SyncOrchestrator } from "./sync-orchestrator";

function deps(overrides: any = {}) {
  let t = 0;
  const sent: any[] = [];
  const applied: any[] = [];
  return {
    now: () => t,
    setNow: (v: number) => {
      t = v;
    },
    sent,
    applied,
    controller: {
      readState: () => ({ playing: true, currentTime: 100, playbackRate: 1 }),
      apply: vi.fn(async (s: any) => {
        applied.push(s);
      }),
      isApplying: () => false,
      ...overrides.controller,
    },
    client: {
      send: (m: any) => sent.push(m),
      oneWayLatencySec: () => overrides.latency ?? 0,
    },
  };
}

function stateMsg(seq: number, currentTime: number, playing = true): StateMessage {
  return { v: 1, type: "state", event: "heartbeat", playing, currentTime, playbackRate: 1, seq };
}

test("host mode: media event sends a sync with incremented seq", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.onMediaEvent("play");
  o.onMediaEvent("seek");
  expect(d.sent.map((m) => m.seq)).toEqual([1, 2]);
  expect(d.sent[0]).toMatchObject({ type: "sync", event: "play", currentTime: 100 });
});

test("host mode: does not send while controller is applying (guard)", () => {
  const d = deps({ controller: { isApplying: () => true } });
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.onMediaEvent("play");
  expect(d.sent).toEqual([]);
});

test("participant: applies fresh state and ignores stale seq", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  await o.onServerState(stateMsg(5, 200));
  await o.onServerState(stateMsg(4, 999)); // 古い → 無視
  expect(d.applied.length).toBe(1);
  expect(d.applied[0].currentTime).toBe(200);
});

test("participant tick corrects drift beyond tolerance using projected time", async () => {
  const d = deps({
    latency: 0.2,
    controller: { readState: () => ({ playing: true, currentTime: 100, playbackRate: 1 }) },
  });
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  d.setNow(1000);
  await o.onServerState(stateMsg(1, 100)); // 受信時刻1000, expected@receipt=100.2
  d.setNow(4000); // 3s経過 → projected ≈ 103.2、local=100 → 差3.2 > 1 → seek
  await o.tick();
  const lastApply = d.applied.at(-1);
  expect(lastApply.currentTime).toBeCloseTo(103.2, 1);
});

test("participant tick does nothing when no state received yet", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  await o.tick();
  expect(d.applied).toEqual([]);
});

test("host heartbeat() sends current state as heartbeat event", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.heartbeat();
  expect(d.sent[0]).toMatchObject({ type: "sync", event: "heartbeat", currentTime: 100 });
});

test("onServerState honors tolerance for heartbeat but snaps exactly for discrete events", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  await o.onServerState(stateMsg(1, 200)); // stateMsg default event is "heartbeat"
  expect(d.controller.apply).toHaveBeenLastCalledWith(expect.anything(), DEFAULTS.toleranceSec);
  await o.onServerState({ ...stateMsg(2, 300), event: "seek" });
  expect(d.controller.apply).toHaveBeenLastCalledWith(expect.anything(), 0);
});

test("host emit: localContentKey の値を SyncMessage.contentKey に乗せる", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host", localContentKey: () => "SID/ED2" });
  o.heartbeat();
  expect(d.sent[0]).toMatchObject({ type: "sync", contentKey: "SID/ED2" });
});

test("host emit: localContentKey 未注入なら contentKey は undefined", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.heartbeat();
  expect(d.sent[0].contentKey).toBeUndefined();
});

test("participant: contentKey 不一致なら apply しない（hold）", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => "SID/ED1" });
  await o.onServerState({ ...stateMsg(1, 200), contentKey: "SID/ED2" });
  expect(d.applied).toEqual([]);
});

test("participant: contentKey 一致なら従来どおり apply する", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => "SID/ED2" });
  await o.onServerState({ ...stateMsg(1, 200), contentKey: "SID/ED2" });
  expect(d.applied[0].currentTime).toBe(200);
});

test("participant: state.contentKey が undefined なら従来どおり apply（後方互換）", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => "SID/ED1" });
  await o.onServerState(stateMsg(1, 200)); // contentKey なし
  expect(d.applied[0].currentTime).toBe(200);
});

test("participant: hold 中も lastState は更新され、一致後の tick が projection で追従", async () => {
  let key = "SID/ED1";
  const d = deps({ latency: 0 });
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => key });
  d.setNow(1000);
  // ホストは ep2 にいるが参加者はまだ ep1 → hold（apply されない）
  await o.onServerState({ ...stateMsg(1, 100), contentKey: "SID/ED2" });
  expect(d.applied).toEqual([]);
  // 参加者が ep2 に着地 → tick で最新 lastState から projection して追従
  key = "SID/ED2";
  d.setNow(4000); // 3s 経過 → projected ≈ 103
  await o.tick();
  expect(d.applied.at(-1).currentTime).toBeCloseTo(103, 1);
});
