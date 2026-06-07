import { expect, test } from "vitest";
import { deriveContentKey } from "./content-key";

test("play ページの pathname から SID/ED を導く", () => {
  expect(deriveContentKey("/play/SID0234926/ED00720091")).toBe("SID0234926/ED00720091");
  expect(deriveContentKey("/play/SID0234926/ED00720092")).toBe("SID0234926/ED00720092");
});

test("末尾スラッシュやクエリが付いても SID/ED を導く", () => {
  expect(deriveContentKey("/play/SID0234926/ED00720091/")).toBe("SID0234926/ED00720091");
});

test("別シリーズは別キーになる（SID を含むため衝突しない）", () => {
  expect(deriveContentKey("/play/SID9999999/ED00720091")).toBe("SID9999999/ED00720091");
});

test("play ページでなければ undefined", () => {
  expect(deriveContentKey("/")).toBeUndefined();
  expect(deriveContentKey("/browse/foo")).toBeUndefined();
  expect(deriveContentKey("/play/SID0234926")).toBeUndefined();
});
