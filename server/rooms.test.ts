import { beforeEach, expect, test } from "vitest";
import type { SyncMessage } from "../shared/protocol";
import { normalizeName, RoomManager } from "./src/rooms";

let now = 1000;
const clock = () => now;
let idCounter = 0;
let tokenCounter = 0;
const genId = () => `room${++idCounter}`;
const genToken = () => `tok${++tokenCounter}`;

function makeSync(seq: number): SyncMessage {
  return {
    v: 1,
    type: "sync",
    event: "heartbeat",
    playing: true,
    currentTime: 10 + seq,
    playbackRate: 1,
    seq,
  };
}

let rm: RoomManager;
beforeEach(() => {
  now = 1000;
  idCounter = 0;
  tokenCounter = 0;
  rm = new RoomManager({ now: clock, genId, genToken, hostTimeoutMs: 60000 });
});

test("create returns a roomId and hostToken", () => {
  const { roomId, hostToken } = rm.create("hostClient");
  expect(roomId).toBe("room1");
  expect(hostToken).toBe("tok1");
});

test("creator joining as host with correct token becomes host", () => {
  const { roomId, hostToken } = rm.create("c1");
  const r = rm.join(roomId, "c1", "host", hostToken);
  expect(r.outcome).toBe("joined-host");
});

test("host join with wrong token falls back to participant (host_taken)", () => {
  const { roomId } = rm.create("c1");
  rm.join(roomId, "c1", "host", "tok1"); // claim host first
  const r = rm.join(roomId, "c2", "host", "WRONG");
  expect(r.outcome).toBe("host_taken");
});

test("participant join into unknown room fails", () => {
  const r = rm.join("nope", "c9", "participant");
  expect(r.outcome).toBe("no_room");
});

test("late participant receives lastState", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.recordSync(roomId, "c1", makeSync(1));
  const r = rm.join(roomId, "c2", "participant");
  expect(r.outcome).toBe("joined-participant");
  expect(r.lastState?.seq).toBe(1);
});

test("recordSync from host broadcasts to participants only", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.join(roomId, "c2", "participant");
  rm.join(roomId, "c3", "participant");
  const res = rm.recordSync(roomId, "c1", makeSync(1));
  expect(res.broadcastTo.sort()).toEqual(["c2", "c3"]);
});

test("recordSync from non-host is ignored", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.join(roomId, "c2", "participant");
  const res = rm.recordSync(roomId, "c2", makeSync(1));
  expect(res.broadcastTo).toEqual([]);
});

test("host reconnect within timeout reclaims slot with token", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  const dropped = rm.removeClient(roomId, "c1");
  expect(dropped.hostDisconnected).toBe(true);
  now += 30000; // < 60s
  const r = rm.join(roomId, "c1b", "host", hostToken);
  expect(r.outcome).toBe("joined-host");
});

test("host slot released after timeout sweep", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.removeClient(roomId, "c1");
  now += 61000;
  const released = rm.sweepHostTimeouts();
  expect(released).toContain(roomId);
});

test("normalizeName trims and strips control chars", () => {
  expect(normalizeName("  たろう  ")).toBe("たろう");
  expect(normalizeName("abc")).toBe("abc");
  expect(normalizeName("ab\x7fcd")).toBe("abcd");
  expect(normalizeName("\x01\x02")).toBe("");
});

test("normalizeName truncates to 24 chars", () => {
  expect(normalizeName("あ".repeat(40))).toBe("あ".repeat(24));
});

test("normalizeName returns empty string for non-string or empty", () => {
  expect(normalizeName(undefined)).toBe("");
  expect(normalizeName(42)).toBe("");
  expect(normalizeName("   ")).toBe("");
  expect(normalizeName(null)).toBe("");
  expect(normalizeName({})).toBe("");
});

test("normalizeName truncates by code point without splitting surrogates", () => {
  const out = normalizeName("😀".repeat(40));
  expect([...out]).toHaveLength(24);
  expect(out).toBe("😀".repeat(24));
});
