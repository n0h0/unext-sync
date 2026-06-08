import { expect, test, vi } from "vitest";
import { type SocketLike, WsClient } from "./ws-client";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  sent: string[] = [];
  readyState = 0;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(o: any) {
    this.onmessage?.(JSON.stringify(o));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const onMessage = vi.fn();
  const client = new WsClient("wss://x", { factory, onMessage });
  return { sockets, client, onMessage };
}

test("connect sends queued nothing until open, reports open", () => {
  const { sockets, client } = setup();
  const opened = vi.fn();
  client.onOpen = opened;
  client.connect();
  sockets[0].open();
  expect(opened).toHaveBeenCalled();
});

test("incoming messages are parsed and forwarded", () => {
  const { sockets, client, onMessage } = setup();
  client.connect();
  sockets[0].open();
  sockets[0].emit({ v: 2, type: "joined", role: "host" });
  expect(onMessage).toHaveBeenCalledWith({ v: 2, type: "joined", role: "host" });
});

test("pong updates RTT estimate (oneWayLatencySec)", () => {
  const now = vi.fn();
  const { sockets, client } = setupWithClock(now);
  client.connect();
  sockets[0].open();
  now.mockReturnValue(1000);
  client.sendPing(); // id=1 sent at t=1000
  now.mockReturnValue(1400); // pong at t=1400 → RTT=400ms
  sockets[0].emit({ v: 2, type: "pong", id: 1 });
  expect(client.oneWayLatencySec()).toBeCloseTo(0.2);
});

function setupWithClock(now: () => number) {
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const client = new WsClient("wss://x", { factory, onMessage: () => {}, now });
  return { sockets, client };
}

test("close schedules reconnect with growing backoff", () => {
  const delays: number[] = [];
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const client = new WsClient("wss://x", {
    factory,
    onMessage: () => {},
    schedule: (_fn, ms) => {
      delays.push(ms); /* 即時実行しない */
    },
  });
  client.connect();
  sockets[0].open();
  sockets[0].close(); // attempt 0 → 500ms
  client.connect();
  sockets[1].open();
  sockets[1].close(); // attempt 1 → 1000ms
  expect(delays).toEqual([500, 1000]);
});

test("close() stops reconnect and does not call onClose", () => {
  const delays: number[] = [];
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const onClose = vi.fn();
  const client = new WsClient("wss://x", {
    factory,
    onMessage: () => {},
    schedule: (_fn, ms) => {
      delays.push(ms); /* 即時実行しない */
    },
  });
  client.onClose = onClose;
  client.connect();
  sockets[0].open();
  client.close(); // stopped を立て、FakeSocket.close() → onclose を同期発火させる
  expect(delays).toEqual([]); // 再接続をスケジュールしない
  expect(onClose).not.toHaveBeenCalled(); // 意図的停止では切断扱いにしない
});
