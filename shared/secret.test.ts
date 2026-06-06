import { test, expect } from "vitest";
import { isTokenSafe } from "./secret";

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
