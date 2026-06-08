import { beforeEach, expect, test } from "vitest";
import {
  freshPersistent,
  makeRoomLogic,
  normalizeName,
  normalizeText,
  type RoomState,
} from "./rooms";

let nowVal = 1000;
const deps = {
  now: () => nowVal,
  genToken: () => "tok",
  genGuestSuffix: () => "abcd",
  hostTimeoutMs: 60000,
};
const logic = makeRoomLogic(deps);

function emptyRoom(hostToken = "tok"): RoomState {
  return { persistent: freshPersistent(hostToken), clients: new Map() };
}

beforeEach(() => {
  nowVal = 1000;
});

test("rosterOf: host first, participants sorted by joinedAt (not insertion)", () => {
  const st = emptyRoom();
  logic.applyJoin(st, "c1", 5, "host", "tok", "host");
  logic.applyJoin(st, "c2", 2, "participant", undefined, "B");
  logic.applyJoin(st, "c3", 8, "participant", undefined, "A");
  expect(logic.rosterOf(st).map((e) => e.id)).toEqual(["c1", "c2", "c3"]);
});

test("normalizeName trims, strips control chars, truncates", () => {
  expect(normalizeName("  たろう  ")).toBe("たろう");
  expect(normalizeName("ab\x7fcd")).toBe("abcd");
  expect(normalizeName("あ".repeat(40))).toBe("あ".repeat(24));
});

test("normalizeText truncates by code point", () => {
  expect(normalizeText("😀".repeat(200), 120)).toBe("😀".repeat(120));
  expect(normalizeText(42, 120)).toBe("");
});

test("applyJoin host: sets hostId, emits setAttachment(joined,isHost) and joined", () => {
  const st = emptyRoom("tok");
  const r = logic.applyJoin(st, "c1", 1, "host", "tok", "たろう");
  expect(r.outcome).toBe("joined-host");
  expect(r.state.persistent.hostId).toBe("c1");
  expect(r.effects).toContainEqual({
    kind: "setAttachment",
    clientId: "c1",
    attachment: { clientId: "c1", name: "たろう", isHost: true, joined: true, joinedAt: 1 },
  });
  expect(r.effects).toContainEqual({
    kind: "send",
    to: "c1",
    msg: { v: 2, type: "joined", role: "host", clientId: "c1" },
  });
});

test("applyJoin host with wrong token falls back to host_taken", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  const r = logic.applyJoin(st, "c2", 2, "host", "WRONG");
  expect(r.outcome).toBe("host_taken");
  expect(r.effects).toContainEqual({
    kind: "send",
    to: "c2",
    msg: { v: 2, type: "host_taken", clientId: "c2" },
  });
});

test("applyJoin participant gets lastState and contentKey", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applySync(st, "c1", {
    v: 2,
    type: "sync",
    event: "heartbeat",
    playing: true,
    currentTime: 11,
    playbackRate: 1,
    seq: 1,
    contentKey: "SID0234926/ED00720092",
  });
  const r = logic.applyJoin(st, "c2", 2, "participant");
  expect(r.outcome).toBe("joined-participant");
  const sent = r.effects.find((e) => e.kind === "send" && e.to === "c2" && e.msg.type === "state");
  expect(sent && sent.kind === "send" && sent.msg.type === "state" && sent.msg.contentKey).toBe(
    "SID0234926/ED00720092",
  );
});

test("applyJoin empty name yields ゲスト- guest name", () => {
  const st = emptyRoom("tok");
  const r = logic.applyJoin(st, "c1", 1, "participant", undefined, "");
  expect(r.state.clients.get("c1")?.name).toBe("ゲスト-abcd");
});

test("applyJoin always broadcasts roster", () => {
  const st = emptyRoom("tok");
  const r = logic.applyJoin(st, "c1", 1, "host", "tok", "た");
  expect(r.effects.some((e) => e.kind === "broadcast" && e.msg.type === "roster")).toBe(true);
});

function syncMsg(seq: number) {
  return {
    v: 2 as const,
    type: "sync" as const,
    event: "heartbeat" as const,
    playing: true,
    currentTime: 10 + seq,
    playbackRate: 1,
    seq,
  };
}

test("applySync from host broadcasts state excluding host, stores lastState", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applyJoin(st, "c2", 2, "participant");
  const r = logic.applySync(st, "c1", syncMsg(1));
  expect(r.effects).toEqual([
    {
      kind: "broadcast",
      exclude: "c1",
      msg: {
        v: 2,
        type: "state",
        event: "heartbeat",
        playing: true,
        currentTime: 11,
        playbackRate: 1,
        seq: 1,
        contentKey: undefined,
      },
    },
  ]);
  expect(r.state.persistent.lastState?.seq).toBe(1);
});

test("applySync from non-host is ignored", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applyJoin(st, "c2", 2, "participant");
  expect(logic.applySync(st, "c2", syncMsg(1)).effects).toEqual([]);
});

test("applyTitle: only host, normalized, idempotent, rejects empty", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applyJoin(st, "c2", 2, "participant");
  expect(logic.applyTitle(st, "c2", "作品名").effects).toEqual([]); // 非ホスト
  const r = logic.applyTitle(st, "c1", "  作品名 第3話  ");
  expect(r.effects).toEqual([
    { kind: "broadcast", msg: { v: 2, type: "room_title", title: "作品名 第3話" } },
  ]);
  expect(logic.applyTitle(st, "c1", "作品名 第3話").effects).toEqual([]); // 同値
  expect(logic.applyTitle(st, "c1", "   ").effects).toEqual([]); // 空
});

test("removeClient(host) emits host_disconnected, roster, alarm at host deadline", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.applyJoin(st, "p", 2, "participant");
  const r = logic.removeClient(st, "h");
  expect(r.effects).toContainEqual({ kind: "broadcast", msg: { v: 2, type: "host_disconnected" } });
  expect(r.effects).toContainEqual({ kind: "setAlarm", at: 61000 });
  expect(r.state.persistent.hostId).toBeNull();
});

test("host reconnect within hold reclaims slot", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.removeClient(st, "h");
  nowVal = 31000; // < 60s
  const r = logic.applyJoin(st, "h2", 3, "host", "tok");
  expect(r.outcome).toBe("joined-host");
});

test("host reclaim clears the pending host-release alarm (no stale wake)", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.applyJoin(st, "p", 2, "participant");
  logic.removeClient(st, "h"); // alarm を 61000 に武装
  nowVal = 31000;
  const r = logic.applyJoin(st, "h2", 3, "host", "tok"); // 復帰で締切が消える
  // 復帰後はホスト締切も空締切も無いので、保留中 alarm をクリアして不要 wake を防ぐ。
  expect(r.effects).toContainEqual({ kind: "clearAlarm" });
});

test("participant join while host disconnected re-affirms the host-release alarm", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.removeClient(st, "h"); // emptiedAt=1000 と hostDisconnectedAt=1000、最早 61000
  nowVal = 5000;
  const r = logic.applyJoin(st, "p", 2, "participant");
  // 参加者が来ても hostDisconnectedAt は残る → ホスト締切 61000 を維持。
  expect(r.effects).toContainEqual({ kind: "setAlarm", at: 61000 });
});

test("sweepTimers re-arms when host deadline fires but empty cleanup remains", () => {
  // host 切断 t=1000 → host 締切 61000
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.applyJoin(st, "p", 2, "participant");
  logic.removeClient(st, "h");
  // 参加者退出 t=40000 → emptiedAt=40000（空締切 100000）。最早は host 61000。
  nowVal = 40000;
  const rm = logic.removeClient(st, "p");
  expect(rm.effects).toContainEqual({ kind: "setAlarm", at: 61000 });
  // t=61001: host 解放、空締切(100000)は未到来 → clearStorage せず 100000 へ再武装
  const sw1 = logic.sweepTimers(st, 61001);
  expect(sw1.effects.some((e) => e.kind === "clearStorage")).toBe(false);
  expect(sw1.effects).toContainEqual({ kind: "setAlarm", at: 100000 });
  expect(sw1.state.persistent.hostDisconnectedAt).toBeNull();
  expect(sw1.effects.some((e) => e.kind === "broadcast" && e.msg.type === "roster")).toBe(true);
  // t=100001: 空掃除 → clearStorage
  const sw2 = logic.sweepTimers(st, 100001);
  expect(sw2.effects).toEqual([{ kind: "clearStorage" }]);
});

test("rosterOf shows synthetic disconnected host row during hold, dropped after sweep", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok", "たろう");
  logic.applyJoin(st, "p", 2, "participant", undefined, "はなこ");
  logic.removeClient(st, "h");
  expect(logic.rosterOf(st)[0]).toEqual({
    id: "__host__",
    name: "たろう",
    host: true,
    connected: false,
  });
  logic.sweepTimers(st, 61001);
  expect(logic.rosterOf(st).some((e) => e.host)).toBe(false);
});
