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
