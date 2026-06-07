import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { startServer } from "./src/server";

const TEST_SECRET = "testsecrettoken0123";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (stop) await stop();
  stop = null;
});

function reader(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return {
    next(): Promise<any> {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => waiters.push(res));
    },
  };
}

async function nextType(r: ReturnType<typeof reader>, type: string): Promise<any> {
  for (;;) {
    const m = await r.next();
    if (m.type === type) return m;
  }
}

function connect(
  port: number,
  secret: string = TEST_SECRET,
): Promise<{ ws: WebSocket; r: ReturnType<typeof reader> }> {
  const ws = new WebSocket(`ws://localhost:${port}`, [secret]);
  const r = reader(ws);
  return new Promise((res, rej) => {
    ws.on("open", () => res({ ws, r }));
    ws.on("error", rej);
  });
}
const send = (ws: WebSocket, o: any) => ws.send(JSON.stringify(o));

test("create returns created with roomId and hostToken", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const msg = await hostR.next();
  expect(msg.type).toBe("created");
  expect(typeof msg.roomId).toBe("string");
  expect(typeof msg.hostToken).toBe("string");
});

test("host sync is broadcast to participant", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
  });
  await hostR.next(); // joined

  const { ws: guest, r: guestR } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant" });
  await guestR.next(); // joined

  send(host, {
    v: 1,
    type: "sync",
    event: "seek",
    playing: true,
    currentTime: 345.8,
    playbackRate: 1,
    seq: 1,
  });
  const state = await nextType(guestR, "state");
  expect(state).toMatchObject({ type: "state", event: "seek", currentTime: 345.8, seq: 1 });
});

test("late participant immediately receives lastState", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
  });
  await hostR.next();
  send(host, {
    v: 1,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 50,
    playbackRate: 1,
    seq: 1,
  });

  const { ws: late, r: lateR } = await connect(port);
  send(late, { v: 1, type: "join", roomId: created.roomId, role: "participant" });
  const joined = await lateR.next();
  expect(joined.type).toBe("joined");
  const state = await lateR.next();
  expect(state).toMatchObject({ type: "state", currentTime: 50, seq: 1 });
});

test("second host with wrong token gets host_taken", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
  });
  await hostR.next();

  const { ws: imposter, r: imposterR } = await connect(port);
  send(imposter, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: "WRONG" });
  const msg = await imposterR.next();
  expect(msg.type).toBe("host_taken");
});

test("ping gets pong with same id", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws, r } = await connect(port);
  send(ws, { v: 1, type: "ping", id: 7 });
  const msg = await r.next();
  expect(msg).toMatchObject({ type: "pong", id: 7 });
});

test("connection without secret is rejected at handshake", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  await expect(
    new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${port}`); // サブプロトコル無し
      ws.on("open", () => res("open"));
      ws.on("error", (e) => rej(e));
    }),
  ).rejects.toThrow();
});

test("connection with wrong secret is rejected at handshake", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  await expect(
    new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${port}`, ["wrongsecret"]);
      ws.on("open", () => res("open"));
      ws.on("error", (e) => rej(e));
    }),
  ).rejects.toThrow();
});

test("startServer() without arg rejects when CONNECT_SECRET env is unset", async () => {
  const saved = process.env.CONNECT_SECRET;
  delete process.env.CONNECT_SECRET;
  try {
    await expect(startServer(0)).rejects.toThrow("CONNECT_SECRET");
  } finally {
    if (saved !== undefined) process.env.CONNECT_SECRET = saved;
  }
});

test("joined carries clientId", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  const joined = await nextType(hostR, "joined");
  expect(typeof joined.clientId).toBe("string");
});

test("roster broadcast lists host and participant with names", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");

  const { ws: guest, r: guestR } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  await nextType(guestR, "joined");
  const roster = await nextType(guestR, "roster");
  expect(roster.participants).toHaveLength(2);
  expect(roster.participants[0]).toMatchObject({ name: "たろう", host: true, connected: true });
  expect(roster.participants.find((p: any) => p.name === "はなこ")).toMatchObject({
    host: false,
    connected: true,
  });
});

test("host title is broadcast to participant as room_title", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");

  const { ws: guest, r: guestR } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  await nextType(guestR, "joined");

  send(host, { v: 1, type: "title", title: "作品名 第3話" });
  const rt = await nextType(guestR, "room_title");
  expect(rt.title).toBe("作品名 第3話");
});

test("late joiner receives current room_title as catch-up", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");
  send(host, { v: 1, type: "title", title: "作品名 第3話" });
  await nextType(hostR, "room_title"); // ホスト自身にも届く（drain）

  const { ws: late, r: lateR } = await connect(port);
  send(late, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  const rt = await nextType(lateR, "room_title");
  expect(rt.title).toBe("作品名 第3話");
});

test("title from a non-host is ignored", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");

  const { ws: guest, r: guestR } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  await nextType(guestR, "joined");

  await nextType(guestR, "roster"); // drain roster from guest's join
  // 参加者が title を送っても誰にも room_title は来ない
  send(guest, { v: 1, type: "title", title: "偽タイトル" });
  // 後続の ping/pong で「room_title が割り込んでいない」ことを確認する
  send(guest, { v: 1, type: "ping", id: 99 });
  const pong = await guestR.next();
  expect(pong).toMatchObject({ type: "pong", id: 99 });
});

test("participant leaving updates roster", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");
  await nextType(hostR, "roster"); // host's own join → 1-entry roster (drain it)

  const { ws: guest } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  await nextType(hostR, "roster"); // guest joined → host gets 2-entry roster
  guest.close();
  const roster = await nextType(hostR, "roster"); // guest left → back to 1 entry
  expect(roster.participants).toHaveLength(1);
  expect(roster.participants[0]).toMatchObject({ name: "たろう", host: true });
});
