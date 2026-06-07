import { expect, test } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "./protocol";

test("PROTOCOL_VERSION is 1", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

test("parses a valid sync message", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 120.5,
    playbackRate: 1,
    seq: 42,
  });
  expect(parseClientMessage(raw)).toEqual({
    v: 1,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 120.5,
    playbackRate: 1,
    seq: 42,
  });
});

test("parses create and join", () => {
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "create" }))).toEqual({
    v: 1,
    type: "create",
  });
  expect(
    parseClientMessage(
      JSON.stringify({
        v: 1,
        type: "join",
        roomId: "abcd1234",
        role: "host",
        hostToken: "t",
      }),
    ),
  ).toMatchObject({ type: "join", role: "host", hostToken: "t" });
});

test("rejects wrong version, bad JSON, unknown type, missing fields", () => {
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "create" }))).toBeNull();
  expect(parseClientMessage("not json")).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "bogus" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "sync" }))).toBeNull();
});

test("parses join with name", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "join",
    roomId: "abcd1234",
    role: "participant",
    name: "はなこ",
  });
  expect(parseClientMessage(raw)).toMatchObject({
    type: "join",
    role: "participant",
    name: "はなこ",
  });
});

test("join without name is still valid (name undefined)", () => {
  const raw = JSON.stringify({ v: 1, type: "join", roomId: "r", role: "participant" });
  expect(parseClientMessage(raw)).toMatchObject({ type: "join", role: "participant" });
});

test("rejects join with non-string name", () => {
  const raw = JSON.stringify({ v: 1, type: "join", roomId: "r", role: "participant", name: 42 });
  expect(parseClientMessage(raw)).toBeNull();
});

test("parses a title message", () => {
  const raw = JSON.stringify({ v: 1, type: "title", title: "作品名 第3話" });
  expect(parseClientMessage(raw)).toEqual({ v: 1, type: "title", title: "作品名 第3話" });
});

test("rejects title with non-string title", () => {
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "title", title: 42 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "title" }))).toBeNull();
});
