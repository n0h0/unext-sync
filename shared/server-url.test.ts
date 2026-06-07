import { expect, test } from "vitest";
import { httpBaseFrom, isWsUrl } from "./server-url";

test("accepts wss:// and ws:// URLs", () => {
  expect(isWsUrl("wss://unext-sync.onrender.com")).toBe(true);
  expect(isWsUrl("ws://localhost:8080")).toBe(true);
});

test("rejects non-WebSocket schemes", () => {
  expect(isWsUrl("https://example.com")).toBe(false);
  expect(isWsUrl("http://localhost:8080")).toBe(false);
});

test("rejects missing scheme and malformed values", () => {
  expect(isWsUrl("localhost:8080")).toBe(false);
  expect(isWsUrl("unext-sync.onrender.com")).toBe(false);
  expect(isWsUrl("")).toBe(false);
  expect(isWsUrl("not a url")).toBe(false);
});

test("httpBaseFrom maps wss→https and ws→http", () => {
  expect(httpBaseFrom("wss://unext-sync.example.workers.dev")).toBe(
    "https://unext-sync.example.workers.dev",
  );
  expect(httpBaseFrom("ws://localhost:8787")).toBe("http://localhost:8787");
});
