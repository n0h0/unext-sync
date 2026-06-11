import { expect, test } from "vitest";
import { makeBrowserSocket, type RawWebSocket } from "./browser-socket";

class FakeWebSocket implements RawWebSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  // DOM イベントオブジェクトの組み立てはここに閉じ込める（node 環境に CloseEvent が無いため cast）
  fireOpen() {
    this.onopen?.(new Event("open"));
  }
  fireClose() {
    this.onclose?.({} as CloseEvent);
  }
  fireMessage(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function setup() {
  let raw!: FakeWebSocket;
  const sock = makeBrowserSocket("wss://x/r/abc", "secret", (url, protocols) => {
    raw = new FakeWebSocket(url, protocols);
    return raw;
  });
  return { sock, raw };
}

test("URL と接続シークレット（サブプロトコル）を生ソケットへ渡す", () => {
  const { raw } = setup();
  expect(raw.url).toBe("wss://x/r/abc");
  expect(raw.protocols).toEqual(["secret"]);
});

test("open/close イベントをハンドラへ転送する", () => {
  const { sock, raw } = setup();
  const events: string[] = [];
  sock.onopen = () => events.push("open");
  sock.onclose = () => events.push("close");
  raw.fireOpen();
  raw.fireClose();
  expect(events).toEqual(["open", "close"]);
});

test("message は data を文字列化してハンドラへ渡す", () => {
  const { sock, raw } = setup();
  const got: string[] = [];
  sock.onmessage = (d) => got.push(d);
  raw.fireMessage('{"v":2}');
  expect(got).toEqual(['{"v":2}']);
});

test("readyState は生ソケットの現在値を反映する", () => {
  const { sock, raw } = setup();
  expect(sock.readyState).toBe(0);
  raw.readyState = 1;
  expect(sock.readyState).toBe(1);
});

test("send/close を生ソケットへ委譲する", () => {
  const { sock, raw } = setup();
  sock.send("hello");
  sock.close();
  expect(raw.sent).toEqual(["hello"]);
  expect(raw.closed).toBe(true);
});

test("ハンドラ未設定でも生イベントで落ちない", () => {
  const { raw } = setup();
  expect(() => {
    raw.fireOpen();
    raw.fireMessage("x");
    raw.fireClose();
  }).not.toThrow();
});
