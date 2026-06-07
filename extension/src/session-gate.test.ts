import { expect, test, vi } from "vitest";
import { makeSessionGate } from "./session-gate";

test("begin で開始したセッションは現行、end で aborted になる", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  expect(s.aborted()).toBe(false);
  gate.end();
  expect(s.aborted()).toBe(true);
});

test("add で登録した解放処理を dispose が LIFO で実行する", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  const order: number[] = [];
  s.add(() => order.push(1));
  s.add(() => order.push(2));
  s.dispose();
  expect(order).toEqual([2, 1]);
});

test("end は登録済みの解放処理をすべて実行する", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  const d1 = vi.fn();
  const d2 = vi.fn();
  s.add(d1);
  s.add(d2);
  gate.end();
  expect(d1).toHaveBeenCalledTimes(1);
  expect(d2).toHaveBeenCalledTimes(1);
});

test("新しい begin は直前のセッションを無効化する（古い start の復活を防ぐ）", () => {
  const gate = makeSessionGate();
  const first = gate.begin();
  const second = gate.begin();
  expect(first.aborted()).toBe(true);
  expect(second.aborted()).toBe(false);
});

test("dispose は冪等（二度呼んでも解放処理を再実行しない）", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  const d = vi.fn();
  s.add(d);
  s.dispose();
  s.dispose();
  expect(d).toHaveBeenCalledTimes(1);
});
