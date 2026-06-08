import { expect, test } from "vitest";
import { cleanOgTitle, cleanTitle, pickWatchTitle } from "./title";

test("strips U-NEXT suffix after a pipe (half-width and full-width)", () => {
  expect(cleanTitle("作品名 第3話 | U-NEXT")).toBe("作品名 第3話");
  expect(cleanTitle("作品名｜U-NEXT")).toBe("作品名");
  expect(cleanTitle("作品名 | U-NEXT 映画・ドラマ・アニメの動画が見放題")).toBe("作品名");
});

test("collapses internal whitespace and trims", () => {
  expect(cleanTitle("  作品名   サブ  ")).toBe("作品名 サブ");
});

test("leaves an already-clean title untouched", () => {
  expect(cleanTitle("作品名")).toBe("作品名");
});

test("returns empty string for brand-only or empty title", () => {
  expect(cleanTitle("U-NEXT")).toBe("");
  expect(cleanTitle("UNEXT")).toBe("");
  expect(cleanTitle("")).toBe("");
});

test("keeps a pipe that is not the U-NEXT brand", () => {
  expect(cleanTitle("Re:ゼロ | 第2期")).toBe("Re:ゼロ | 第2期");
});

test("cleanOgTitle extracts the work name from a U-NEXT og:title", () => {
  expect(
    cleanOgTitle(
      "笑顔のたえない職場です。(アニメ / 2025) - 動画配信 | U-NEXT 31日間無料トライアル",
    ),
  ).toBe("笑顔のたえない職場です。");
  // 映画など別フォーマットでもメタ括弧＋「- 動画配信」を落とす。
  expect(cleanOgTitle("ある作品(映画 / 2020) - 動画配信 | U-NEXT")).toBe("ある作品");
  // 全角括弧・全角ダッシュ。
  expect(cleanOgTitle("作品名（ドラマ / 2023）― 動画配信 | U-NEXT")).toBe("作品名");
});

test("cleanOgTitle returns empty for brand-only og:title", () => {
  expect(cleanOgTitle("U-NEXT")).toBe("");
  expect(cleanOgTitle("")).toBe("");
});

test("pickWatchTitle uses DOM work + episode when present", () => {
  expect(
    pickWatchTitle({
      docTitle: "再生 | U-NEXT",
      workTitle: "笑顔のたえない職場です。",
      episodeTitle: "第1話 とある漫画家と編集です。",
    }),
  ).toBe("笑顔のたえない職場です。 第1話 とある漫画家と編集です。");
});

test("pickWatchTitle uses DOM work alone when no episode", () => {
  expect(pickWatchTitle({ docTitle: "再生 | U-NEXT", workTitle: "笑顔のたえない職場です。" })).toBe(
    "笑顔のたえない職場です。",
  );
});

test("pickWatchTitle falls back to og:title when docTitle is a generic player word", () => {
  expect(
    pickWatchTitle({
      docTitle: "再生 | U-NEXT",
      ogTitle: "笑顔のたえない職場です。(アニメ / 2025) - 動画配信 | U-NEXT 31日間無料トライアル",
    }),
  ).toBe("笑顔のたえない職場です。");
});

test("pickWatchTitle never returns a generic player word (regression for 再生)", () => {
  // DOM も og も無く docTitle が汎用語のみ → 空（「再生」を出さない）。
  expect(pickWatchTitle({ docTitle: "再生 | U-NEXT" })).toBe("");
  expect(pickWatchTitle({ docTitle: "一時停止 | U-NEXT" })).toBe("");
});

test("pickWatchTitle keeps a meaningful docTitle (non-player work page)", () => {
  expect(pickWatchTitle({ docTitle: "作品名 | U-NEXT" })).toBe("作品名");
});
