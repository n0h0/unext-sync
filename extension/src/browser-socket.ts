import type { SocketLike } from "./ws-client";

/**
 * ブラウザ WebSocket のうちアダプタが使う最小面（テストではフェイクを注入する）。
 * ハンドラのイベント型は DOM の WebSocket と正確に一致させてある（緩めると mutable
 * プロパティの不変性チェックで DOM の WebSocket が構造的に代入不能になり、キャストが要る）。
 */
export interface RawWebSocket {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export type RawSocketFactory = (url: string, protocols: string[]) => RawWebSocket;

const defaultFactory: RawSocketFactory = (url, protocols) => new WebSocket(url, protocols);

/**
 * ブラウザ WebSocket を SocketLike（onmessage は文字列）に適合させるアダプタ。
 * 接続シークレットは Sec-WebSocket-Protocol（サブプロトコル）として渡す。
 */
export function makeBrowserSocket(
  url: string,
  protocol: string,
  factory: RawSocketFactory = defaultFactory,
): SocketLike {
  const raw = factory(url, [protocol]);
  const adapter: SocketLike = {
    onopen: null,
    onclose: null,
    onmessage: null,
    get readyState() {
      return raw.readyState;
    },
    send: (d) => raw.send(d),
    close: () => raw.close(),
  };
  raw.onopen = () => adapter.onopen?.();
  raw.onclose = () => adapter.onclose?.();
  raw.onmessage = (ev) => adapter.onmessage?.(String(ev.data));
  return adapter;
}
