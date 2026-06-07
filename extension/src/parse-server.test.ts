import { expect, test } from "vitest";
import { parseServerMessageLoose } from "./parse-server";

test("parses a roster message (regression: roster must not be dropped)", () => {
  const raw = JSON.stringify({
    v: 2,
    type: "roster",
    participants: [{ id: "a", name: "たろう", host: true, connected: true }],
  });
  const msg = parseServerMessageLoose(raw);
  expect(msg).not.toBeNull();
  expect(msg?.type).toBe("roster");
});

test("parses joined with clientId", () => {
  const raw = JSON.stringify({ v: 2, type: "joined", role: "participant", clientId: "x" });
  expect(parseServerMessageLoose(raw)?.type).toBe("joined");
});

test("rejects unknown type and wrong version", () => {
  expect(parseServerMessageLoose(JSON.stringify({ v: 2, type: "bogus" }))).toBeNull();
  expect(parseServerMessageLoose(JSON.stringify({ v: 1, type: "roster" }))).toBeNull();
  expect(parseServerMessageLoose("not json")).toBeNull();
});

test("parses a room_title message (regression: room_title must not be dropped)", () => {
  const raw = JSON.stringify({ v: 2, type: "room_title", title: "作品名 第3話" });
  const msg = parseServerMessageLoose(raw);
  expect(msg).not.toBeNull();
  expect(msg?.type).toBe("room_title");
});

test("created is no longer accepted", () => {
  expect(
    parseServerMessageLoose(JSON.stringify({ v: 2, type: "created", roomId: "r", hostToken: "t" })),
  ).toBeNull();
});
