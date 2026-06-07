import { beforeEach, expect, test } from "vitest";
import { freshPersistent, makeRoomLogic, normalizeName, normalizeText, type RoomState } from "./rooms";

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
  expect(r.effects).toContainEqual({ kind: "send", to: "c2", msg: { v: 2, type: "host_taken", clientId: "c2" } });
});

test("applyJoin participant gets lastState and contentKey", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applySync(st, "c1", {
    v: 2, type: "sync", event: "heartbeat", playing: true, currentTime: 11, playbackRate: 1, seq: 1,
    contentKey: "SID0234926/ED00720092",
  });
  const r = logic.applyJoin(st, "c2", 2, "participant");
  expect(r.outcome).toBe("joined-participant");
  const sent = r.effects.find((e) => e.kind === "send" && e.to === "c2" && e.msg.type === "state");
  expect(sent && sent.kind === "send" && sent.msg.type === "state" && sent.msg.contentKey).toBe("SID0234926/ED00720092");
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
