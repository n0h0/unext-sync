import { test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer } from "./src/server";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  return new Promise((res, rej) => {
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
}
const send = (ws: WebSocket, o: any) => ws.send(JSON.stringify(o));

test("create returns created with roomId and hostToken", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const msg = await nextMsg(host);
  expect(msg.type).toBe("created");
  expect(typeof msg.roomId).toBe("string");
  expect(typeof msg.hostToken).toBe("string");
});

test("host sync is broadcast to participant", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await nextMsg(host);
  send(host, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: created.hostToken });
  await nextMsg(host); // joined

  const guest = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant" });
  await nextMsg(guest); // joined

  send(host, {
    v: 1, type: "sync", event: "seek",
    playing: true, currentTime: 345.8, playbackRate: 1, seq: 1,
  });
  const state = await nextMsg(guest);
  expect(state).toMatchObject({ type: "state", event: "seek", currentTime: 345.8, seq: 1 });
});

test("late participant immediately receives lastState", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await nextMsg(host);
  send(host, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: created.hostToken });
  await nextMsg(host);
  send(host, { v: 1, type: "sync", event: "play", playing: true, currentTime: 50, playbackRate: 1, seq: 1 });

  const late = await connect(port);
  send(late, { v: 1, type: "join", roomId: created.roomId, role: "participant" });
  const joined = await nextMsg(late);
  expect(joined.type).toBe("joined");
  const state = await nextMsg(late);
  expect(state).toMatchObject({ type: "state", currentTime: 50, seq: 1 });
});

test("second host with wrong token gets host_taken", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await nextMsg(host);
  send(host, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: created.hostToken });
  await nextMsg(host);

  const imposter = await connect(port);
  send(imposter, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: "WRONG" });
  const msg = await nextMsg(imposter);
  expect(msg.type).toBe("host_taken");
});

test("ping gets pong with same id", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const ws = await connect(port);
  send(ws, { v: 1, type: "ping", id: 7 });
  const msg = await nextMsg(ws);
  expect(msg).toMatchObject({ type: "pong", id: 7 });
});
