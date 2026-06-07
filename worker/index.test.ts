import { SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const SECRET = "0123456789abcdef0123456789abcdef";

async function openWs(roomId: string) {
  const res = await SELF.fetch(`https://x/r/${roomId}`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": SECRET },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  const messages: any[] = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
  return { ws, messages };
}

it("create → host join → participant join receives lastState; sync broadcasts", async () => {
  const create = await SELF.fetch("https://x/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  expect(create.status).toBe(200);
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();

  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken, name: "host" }));
  await vi.waitFor(() => expect(host.messages.some((m) => m.type === "joined" && m.role === "host")).toBe(true));

  host.ws.send(JSON.stringify({ v: 2, type: "sync", event: "heartbeat", playing: true, currentTime: 42, playbackRate: 1, seq: 1 }));

  const part = await openWs(roomId);
  part.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "participant", name: "p" }));
  await vi.waitFor(() => {
    expect(part.messages.some((m) => m.type === "joined")).toBe(true);
    expect(part.messages.some((m) => m.type === "state" && m.currentTime === 42)).toBe(true);
  });

  host.ws.send(JSON.stringify({ v: 2, type: "sync", event: "seek", playing: true, currentTime: 99, playbackRate: 1, seq: 2 }));
  await vi.waitFor(() => expect(part.messages.some((m) => m.type === "state" && m.currentTime === 99)).toBe(true));
});

it("join into unknown room returns no_room", async () => {
  const part = await openWs("doesnotexist");
  part.ws.send(JSON.stringify({ v: 2, type: "join", roomId: "doesnotexist", role: "participant" }));
  await vi.waitFor(() => expect(part.messages.some((m) => m.type === "no_room")).toBe(true));
});

it("POST /create without secret is unauthorized", async () => {
  const res = await SELF.fetch("https://x/create", { method: "POST" });
  expect(res.status).toBe(401);
});

it("ping is echoed as pong with same id", async () => {
  const create = await SELF.fetch("https://x/create", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();
  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken }));
  host.ws.send(JSON.stringify({ v: 2, type: "ping", id: 7 }));
  await vi.waitFor(() => expect(host.messages.some((m) => m.type === "pong" && m.id === 7)).toBe(true));
});
