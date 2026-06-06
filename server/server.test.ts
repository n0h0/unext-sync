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
  const state = await guestR.next();
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
