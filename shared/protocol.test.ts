import { expect, test } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "./protocol";

test("PROTOCOL_VERSION is 2", () => {
  expect(PROTOCOL_VERSION).toBe(2);
});

test("parses a valid sync message", () => {
  const raw = JSON.stringify({
    v: 2,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 120.5,
    playbackRate: 1,
    seq: 42,
  });
  expect(parseClientMessage(raw)).toEqual({
    v: 2,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 120.5,
    playbackRate: 1,
    seq: 42,
  });
});

test("parses join", () => {
  expect(
    parseClientMessage(
      JSON.stringify({ v: 2, type: "join", roomId: "r", role: "host", hostToken: "t" }),
    ),
  ).toEqual({ v: 2, type: "join", roomId: "r", role: "host", hostToken: "t", name: undefined });
});

test("create is no longer a valid message", () => {
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "create" }))).toBeNull();
});

test("rejects wrong version, bad JSON, unknown type, missing fields", () => {
  expect(parseClientMessage("not json")).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "bogus" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "sync" }))).toBeNull();
});

test("parses join with name", () => {
  const raw = JSON.stringify({
    v: 2,
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
  const raw = JSON.stringify({ v: 2, type: "join", roomId: "r", role: "participant" });
  expect(parseClientMessage(raw)).toMatchObject({ type: "join", role: "participant" });
});

test("rejects join with non-string name", () => {
  const raw = JSON.stringify({ v: 2, type: "join", roomId: "r", role: "participant", name: 42 });
  expect(parseClientMessage(raw)).toBeNull();
});

test("parses a title message", () => {
  const raw = JSON.stringify({ v: 2, type: "title", title: "作品名 第3話" });
  expect(parseClientMessage(raw)).toEqual({ v: 2, type: "title", title: "作品名 第3話" });
});

test("rejects title with non-string title", () => {
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "title", title: 42 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "title" }))).toBeNull();
});

test("parses sync with contentKey", () => {
  const raw = JSON.stringify({
    v: 2,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
    contentKey: "SID0234926/ED00720092",
  });
  expect(parseClientMessage(raw)).toMatchObject({
    type: "sync",
    contentKey: "SID0234926/ED00720092",
  });
});

test("rejects sync with non-string contentKey", () => {
  const raw = JSON.stringify({
    v: 2,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
    contentKey: 42,
  });
  expect(parseClientMessage(raw)).toBeNull();
});

test("rejects sync with non-finite currentTime (overflow literal → Infinity)", () => {
  // JSON.parse('{"x":1e999}') は Infinity を返すため、オーバーフロー数値で非有限値が到達しうる。
  const raw =
    '{"v":2,"type":"sync","event":"play","playing":true,"currentTime":1e999,"playbackRate":1,"seq":1}';
  expect(parseClientMessage(raw)).toBeNull();
});

test("rejects sync with non-finite playbackRate (overflow literal → Infinity)", () => {
  const raw =
    '{"v":2,"type":"sync","event":"play","playing":true,"currentTime":1,"playbackRate":1e999,"seq":1}';
  expect(parseClientMessage(raw)).toBeNull();
});

test("rejects sync with out-of-range / non-integer playback fields", () => {
  const base = {
    v: 2,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
  };
  expect(parseClientMessage(JSON.stringify({ ...base, currentTime: -1 }))).toBeNull(); // 負の位置
  expect(parseClientMessage(JSON.stringify({ ...base, playbackRate: 0 }))).toBeNull(); // 速度0
  expect(parseClientMessage(JSON.stringify({ ...base, playbackRate: -1 }))).toBeNull(); // 負の速度
  expect(parseClientMessage(JSON.stringify({ ...base, seq: 1.5 }))).toBeNull(); // 非整数 seq
  // JSON.stringify(NaN) は "null" になり型チェックで弾かれる経路も確認。
  expect(parseClientMessage(JSON.stringify({ ...base, currentTime: Number.NaN }))).toBeNull();
});

test("sync without contentKey is still valid (contentKey undefined)", () => {
  const raw = JSON.stringify({
    v: 2,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
  });
  expect(parseClientMessage(raw)).toMatchObject({ type: "sync" });
});
