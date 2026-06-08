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
  host.ws.send(
    JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken, name: "host" }),
  );
  await vi.waitFor(() =>
    expect(host.messages.some((m) => m.type === "joined" && m.role === "host")).toBe(true),
  );

  host.ws.send(
    JSON.stringify({
      v: 2,
      type: "sync",
      event: "heartbeat",
      playing: true,
      currentTime: 42,
      playbackRate: 1,
      seq: 1,
    }),
  );

  const part = await openWs(roomId);
  part.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "participant", name: "p" }));
  await vi.waitFor(() => {
    expect(part.messages.some((m) => m.type === "joined")).toBe(true);
    expect(part.messages.some((m) => m.type === "state" && m.currentTime === 42)).toBe(true);
  });

  host.ws.send(
    JSON.stringify({
      v: 2,
      type: "sync",
      event: "seek",
      playing: true,
      currentTime: 99,
      playbackRate: 1,
      seq: 2,
    }),
  );
  await vi.waitFor(() =>
    expect(part.messages.some((m) => m.type === "state" && m.currentTime === 99)).toBe(true),
  );
});

it("host_taken: 2人目の host 志望は participant として roster に乗る（spec フォールバック）", async () => {
  const create = await SELF.fetch("https://x/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();

  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken, name: "H" }));
  await vi.waitFor(() =>
    expect(host.messages.some((m) => m.type === "joined" && m.role === "host")).toBe(true),
  );

  // 誤トークンで host を主張 → host_taken を受けつつ participant として roster に乗る。
  const second = await openWs(roomId);
  second.ws.send(
    JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken: "WRONG", name: "X" }),
  );
  await vi.waitFor(() => expect(second.messages.some((m) => m.type === "host_taken")).toBe(true));

  // ホストへ届く roster に X が participant（host:false）として現れる。
  await vi.waitFor(() => {
    const roster = [...host.messages].reverse().find((m) => m.type === "roster");
    expect(roster).toBeTruthy();
    expect(roster.participants.some((p: any) => p.name === "X" && p.host === false)).toBe(true);
  });
});

it("roster: host が先頭、参加者は joinedAt 順で続く", async () => {
  const create = await SELF.fetch("https://x/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();

  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken, name: "H" }));
  await vi.waitFor(() =>
    expect(host.messages.some((m) => m.type === "joined" && m.role === "host")).toBe(true),
  );
  const p1 = await openWs(roomId);
  p1.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "participant", name: "A" }));
  const p2 = await openWs(roomId);
  p2.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "participant", name: "B" }));

  await vi.waitFor(() => {
    const roster = [...host.messages].reverse().find((m) => m.type === "roster");
    expect(roster?.participants.length).toBe(3);
    expect(roster.participants[0].host).toBe(true);
    expect(roster.participants.map((p: any) => p.name)).toEqual(["H", "A", "B"]);
  });
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
  const create = await SELF.fetch("https://x/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();
  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken }));
  host.ws.send(JSON.stringify({ v: 2, type: "ping", id: 7 }));
  await vi.waitFor(() =>
    expect(host.messages.some((m) => m.type === "pong" && m.id === 7)).toBe(true),
  );
});
