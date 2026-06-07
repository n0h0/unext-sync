import { expect, test } from "vitest";
import { cleanTitle } from "./title";

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
