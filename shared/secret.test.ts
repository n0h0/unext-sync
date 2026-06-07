import { expect, test } from "vitest";
import { constantTimeEqual, isTokenSafe } from "./secret";

test("accepts hex output", () => {
  expect(isTokenSafe("a3f9c0d1e2b4")).toBe(true);
});

test("accepts base64url chars (- and _)", () => {
  expect(isTokenSafe("abc-DEF_123")).toBe(true);
});

test("rejects standard base64 separators + / =", () => {
  expect(isTokenSafe("ab+cd/ef=")).toBe(false);
  expect(isTokenSafe("abcd==")).toBe(false);
});

test("rejects comma, colon, space and empty", () => {
  expect(isTokenSafe("a,b")).toBe(false);
  expect(isTokenSafe("a:b")).toBe(false);
  expect(isTokenSafe("a b")).toBe(false);
  expect(isTokenSafe("")).toBe(false);
});

test("constantTimeEqual: equal token-safe strings match", () => {
  expect(constantTimeEqual("abc123", "abc123")).toBe(true);
});
test("constantTimeEqual: different strings do not match", () => {
  expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false); // 長さ違い
});
test("constantTimeEqual: non-token-safe presented is rejected", () => {
  expect(constantTimeEqual("ab+c", "ab+c")).toBe(false);
  expect(constantTimeEqual("", "x")).toBe(false);
});
