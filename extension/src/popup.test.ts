import { expect, test } from "vitest";
import { type ConnState, renderStatusLabel } from "./popup-status";

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
