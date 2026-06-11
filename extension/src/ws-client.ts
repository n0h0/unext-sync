import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "../../shared/protocol";
import { nextBackoffMs, oneWayLatencyFromRtt } from "../../shared/sync-core";
import { parseServerMessageLoose } from "./parse-server";

export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  readyState: number;
  send(data: string): void;
  close(): void;
}

export interface WsClientDeps {
  factory: () => SocketLike;
  onMessage: (msg: ServerMessage) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

export class WsClient {
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private socket: SocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private pingSentAt = new Map<number, number>();
  private latencySec = 0;
  private nextPingId = 1;
  private warnedAbnormalRtt = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private deps: WsClientDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  connect(): void {
    if (this.stopped) return;
    const s = this.deps.factory();
    this.socket = s;
    s.onopen = () => {
      this.onOpen?.();
    };
    s.onmessage = (data) => {
      const msg = parseServerMessageLoose(data);
      if (!msg) return;
      if (msg.type === "pong") {
        const sent = this.pingSentAt.get(msg.id);
        if (sent !== undefined) {
          const rttMs = this.now() - sent;
          // 異常 RTT（負＝クロック後退 / 非有限＝測定破損）は sync-core 側で 0 にクランプされるが、
          // 測定が壊れた兆候なので1回だけ可視化する（毎 pong のスパムは避ける）。
          if ((!Number.isFinite(rttMs) || rttMs < 0) && !this.warnedAbnormalRtt) {
            this.warnedAbnormalRtt = true;
            console.warn(
              `[watch-sync] 異常な RTT を検出 (${rttMs}ms)。同期精度が落ちる可能性があります。`,
            );
          }
          this.latencySec = oneWayLatencyFromRtt(rttMs);
          this.pingSentAt.delete(msg.id);
        }
        return;
      }
      this.deps.onMessage(msg);
    };
    s.onclose = () => {
      this.pingSentAt.clear();
      if (this.stopped) return; // 意図的停止：再接続もせず onClose も呼ばない
      this.onClose?.();
      const delay = nextBackoffMs(this.attempt++);
      this.schedule(() => this.connect(), delay);
    };
  }

  close(): void {
    this.stopped = true;
    this.socket?.close();
  }

  send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  sendPing(): void {
    const id = this.nextPingId++;
    this.pingSentAt.set(id, this.now());
    this.send({ v: PROTOCOL_VERSION, type: "ping", id });
  }

  oneWayLatencySec(): number {
    return this.latencySec;
  }
}
