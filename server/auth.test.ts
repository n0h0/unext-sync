import { test, expect } from "vitest";
import { checkConnectSecret } from "./src/auth";

const SECRET = "a3f9c0d1e2b4a3f9c0d1e2b4";

test("returns true for exact match", () => {
  expect(checkConnectSecret(SECRET, SECRET)).toBe(true);
});

test("returns false for different value of same length", () => {
  const other = "b3f9c0d1e2b4a3f9c0d1e2b4";
  expect(checkConnectSecret(other, SECRET)).toBe(false);
});

test("returns false for different length without throwing", () => {
  expect(checkConnectSecret("short", SECRET)).toBe(false);
});

test("returns false for undefined and empty", () => {
  expect(checkConnectSecret(undefined, SECRET)).toBe(false);
  expect(checkConnectSecret("", SECRET)).toBe(false);
});

test("returns false for non-token-safe presented value", () => {
  expect(checkConnectSecret("ab+cd/ef=", SECRET)).toBe(false);
});
