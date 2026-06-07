import { expect, test } from "vitest";
import { type ConnState, nextStateForServerEvent, renderStatusLabel } from "./popup-status";

test("maps connection states to Japanese labels", () => {
  const cases: [ConnState, string][] = [
    ["idle", "未接続"],
    ["connecting", "接続中"],
    ["connected", "接続済み"],
    ["disconnected", "切断"],
    ["host_gone", "ホスト切断"],
    ["no_room", "ルームが存在しません"],
  ];
  for (const [s, label] of cases) {
    expect(renderStatusLabel(s)).toBe(label);
  }
});

test("joined event sets connected (参加成功で「接続中」のまま固まらない)", () => {
  expect(nextStateForServerEvent("joined")).toBe("connected");
});

test("maps server events to next ConnState", () => {
  const cases: [string, ConnState | null][] = [
    ["joined", "connected"],
    ["host_resumed", "connected"],
    ["host_taken", "connected"],
    ["host_disconnected", "host_gone"],
    ["no_room", "no_room"],
  ];
  for (const [event, expected] of cases) {
    expect(nextStateForServerEvent(event)).toBe(expected);
  }
});

test("unknown server events do not change state (null)", () => {
  expect(nextStateForServerEvent("pong")).toBeNull();
  expect(nextStateForServerEvent("bogus")).toBeNull();
});
