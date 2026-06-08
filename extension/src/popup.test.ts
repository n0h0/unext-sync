import { expect, test } from "vitest";
import type { RosterEntry } from "../../shared/protocol";
import {
  actionButtonsDisabled,
  type ConnState,
  formatRosterLine,
  isActiveSession,
  isValidRoomId,
  leaveControlsVisible,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
  setupFormLocked,
  shouldDisableControls,
  unavailableNotice,
} from "./popup-status";

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

test("isActiveSession: 接続中／接続済みのみ true（再押下で表示を巻き戻さない）", () => {
  const cases: [ConnState, boolean][] = [
    ["connecting", true],
    ["connected", true],
    ["idle", false],
    ["disconnected", false],
    ["host_gone", false],
    ["no_room", false],
  ];
  for (const [s, expected] of cases) {
    expect(isActiveSession(s)).toBe(expected);
  }
});

test("rosterHeader shows participant count", () => {
  const entries: RosterEntry[] = [
    { id: "a", name: "たろう", host: true, connected: true },
    { id: "b", name: "はなこ", host: false, connected: true },
  ];
  expect(rosterHeader(entries)).toBe("参加者 (2)");
});

test("formatRosterLine decorates host, self, and disconnected", () => {
  const host: RosterEntry = { id: "a", name: "たろう", host: true, connected: true };
  const me: RosterEntry = { id: "b", name: "はなこ", host: false, connected: true };
  const gone: RosterEntry = { id: "__host__", name: "じろう", host: true, connected: false };
  expect(formatRosterLine(host, "b")).toBe("👑 たろう");
  expect(formatRosterLine(me, "b")).toBe("はなこ (あなた)");
  expect(formatRosterLine(gone, "b")).toBe("👑 じろう (切断)");
  // selfId が null のときは (あなた) を付けない
  expect(formatRosterLine(me, null)).toBe("はなこ");
});

test("unavailableNotice guides the user to open on a U-NEXT playback page", () => {
  const notice = unavailableNotice();
  expect(notice).toContain("U-NEXT");
  expect(notice).toContain("video.unext.jp");
});

test("renderWatchingTitle shows label for a title and null otherwise", () => {
  expect(renderWatchingTitle("作品名 第3話")).toBe("🎬 視聴中: 作品名 第3話");
  expect(renderWatchingTitle(null)).toBeNull();
  expect(renderWatchingTitle("")).toBeNull();
});

test("leaveControlsVisible: 生きたセッション中のみ true（idle/no_room は false）", () => {
  const cases: [ConnState, boolean][] = [
    ["idle", false],
    ["connecting", true],
    ["connected", true],
    ["disconnected", true],
    ["host_gone", true],
    // no_room は content script が自動でセッション解放するため退出UIは出さない
    ["no_room", false],
  ];
  for (const [s, expected] of cases) {
    expect(leaveControlsVisible(s)).toBe(expected);
  }
});

test("shouldDisableControls: 再生ページ以外＆未接続のみ作成/参加を無効化", () => {
  // 再生ページ以外（onPlayer=false）かつセッション未確立 → 無効化
  expect(shouldDisableControls(false, "idle")).toBe(true);
  expect(shouldDisableControls(false, "disconnected")).toBe(true);
  expect(shouldDisableControls(false, "host_gone")).toBe(true);
  expect(shouldDisableControls(false, "no_room")).toBe(true);
  // 再生ページなら有効
  expect(shouldDisableControls(true, "idle")).toBe(false);
  // 活きたセッション中は再生ページ判定に関わらず表示を維持（無効化しない）
  expect(shouldDisableControls(false, "connecting")).toBe(false);
  expect(shouldDisableControls(false, "connected")).toBe(false);
});

test("isValidRoomId: 英数字1〜32文字のみ受理（不正文字での固着を防ぐ）", () => {
  expect(isValidRoomId("95b5e33e")).toBe(true);
  expect(isValidRoomId("ABCxyz09")).toBe(true);
  expect(isValidRoomId("a".repeat(32))).toBe(true);
  expect(isValidRoomId("")).toBe(false);
  expect(isValidRoomId("ほげ")).toBe(false);
  expect(isValidRoomId("ab cd")).toBe(false);
  expect(isValidRoomId("room-123")).toBe(false);
  expect(isValidRoomId("a".repeat(33))).toBe(false);
});

test("setupFormLocked: 生きたセッション中のみ true（leaveControlsVisible と1対1）", () => {
  const cases: [ConnState, boolean][] = [
    ["idle", false],
    ["connecting", true],
    ["connected", true],
    ["disconnected", true],
    ["host_gone", true],
    ["no_room", false],
  ];
  for (const [s, expected] of cases) {
    expect(setupFormLocked(s)).toBe(expected);
  }
});

test("actionButtonsDisabled: セッション中 or 再生ページ以外なら無効化（2理由のOR）", () => {
  // onPlayer=true: 状態のみで決まる（setupFormLocked と一致）
  expect(actionButtonsDisabled(true, "idle")).toBe(false);
  expect(actionButtonsDisabled(true, "no_room")).toBe(false);
  expect(actionButtonsDisabled(true, "connecting")).toBe(true);
  expect(actionButtonsDisabled(true, "connected")).toBe(true);
  expect(actionButtonsDisabled(true, "disconnected")).toBe(true);
  expect(actionButtonsDisabled(true, "host_gone")).toBe(true);
  // onPlayer=false: 代表値で true を確認（全状態 true は setupFormLocked テスト側で担保）
  expect(actionButtonsDisabled(false, "idle")).toBe(true);
  expect(actionButtonsDisabled(false, "no_room")).toBe(true);
  expect(actionButtonsDisabled(false, "connected")).toBe(true);
});
