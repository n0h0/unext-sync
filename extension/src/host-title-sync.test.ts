import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { makeHostTitleSync, type TitleInputs } from "./host-title-sync";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(initial?: Partial<TitleInputs>) {
  let inputs: TitleInputs = {
    docTitle: "再生 | U-NEXT",
    ogTitle: null,
    workTitle: null,
    episodeTitle: null,
    ...initial,
  };
  const sent: string[] = [];
  let observerCb: (() => void) | null = null;
  const counts = { installs: 0, disposes: 0 };
  const sync = makeHostTitleSync({
    readInputs: () => inputs,
    sendTitle: (t) => sent.push(t),
    observeHead: (onChange) => {
      counts.installs++;
      observerCb = onChange;
      return () => {
        counts.disposes++;
      };
    },
  });
  return {
    sync,
    sent,
    counts,
    setInputs: (next: Partial<TitleInputs>) => {
      inputs = { ...inputs, ...next };
    },
    fireObserver: () => observerCb?.(),
  };
}

test("start() はタイトルを即時送信する", () => {
  const { sync, sent } = setup({ workTitle: "作品X", episodeTitle: "第1話" });
  sync.start();
  expect(sent).toEqual(["作品X 第1話"]);
});

test("start() はタイトルが空なら送信しない", () => {
  const { sync, sent } = setup(); // docTitle はプレイヤー状態語 → pick 結果は空
  sync.start();
  expect(sent).toEqual([]);
});

test("start() はデバウンス後に再取得し、遅延描画されたヘッダを拾う", () => {
  const { sync, sent, setInputs } = setup({ workTitle: "作品X" });
  sync.start();
  expect(sent).toEqual(["作品X"]);
  setInputs({ episodeTitle: "第2話" }); // join 直後はヘッダ未描画 → 後から描画される想定
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual(["作品X", "作品X 第2話"]);
});

test("schedule() は複数回呼んでも1回の送信にデバウンスされる", () => {
  const { sync, sent } = setup({ workTitle: "作品X" });
  sync.schedule();
  sync.schedule();
  sync.schedule();
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual(["作品X"]);
});

test("同じタイトルは再送しない", () => {
  const { sync, sent } = setup({ workTitle: "作品X" });
  sync.start();
  vi.advanceTimersByTime(1000); // start のデバウンス再取得も同値 → 送らない
  sync.schedule();
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual(["作品X"]);
});

test("再 start()（再join）で重複抑制がリセットされ、同じタイトルでも1回送る", () => {
  const { sync, sent } = setup({ workTitle: "作品X" });
  sync.start();
  sync.start(); // 再join: サーバーが同値を弾くため現在値を確実に1回送る
  expect(sent).toEqual(["作品X", "作品X"]);
});

test("observer の変化通知でデバウンス送信され、observer は1回だけ設置される", () => {
  const { sync, sent, counts, setInputs, fireObserver } = setup({ workTitle: "作品X" });
  sync.start();
  sync.start();
  expect(counts.installs).toBe(1);
  setInputs({ workTitle: "作品Y" });
  fireObserver();
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual(["作品X", "作品X", "作品Y"]);
});

test("dispose() は保留中のデバウンス送信を止め、observer を解除する", () => {
  const { sync, sent, counts, setInputs } = setup({ workTitle: "作品X" });
  sync.start();
  setInputs({ workTitle: "作品Y" });
  sync.schedule();
  sync.dispose();
  vi.advanceTimersByTime(5000);
  expect(sent).toEqual(["作品X"]); // 保留分は発火しない
  expect(counts.disposes).toBe(1);
});

test("start() 前の schedule() も動く（遷移検知が join 前に走るケース）", () => {
  const { sync, sent } = setup({ workTitle: "作品X" });
  sync.schedule();
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual(["作品X"]);
});
