import type { ClientMessage, ServerMessage } from "../../shared/protocol";
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
  private attempt = 0;
  private pingSentAt = new Map<number, number>();
  private latencySec = 0;
  private nextPingId = 1;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(
    _url: string,
    private deps: WsClientDeps,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  connect(): void {
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
          this.latencySec = oneWayLatencyFromRtt(this.now() - sent);
          this.pingSentAt.delete(msg.id);
        }
        return;
      }
      this.deps.onMessage(msg);
    };
    s.onclose = () => {
      this.pingSentAt.clear();
      this.onClose?.();
      const delay = nextBackoffMs(this.attempt++);
      this.schedule(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  sendPing(): void {
    const id = this.nextPingId++;
    this.pingSentAt.set(id, this.now());
    this.send({ v: 1, type: "ping", id });
  }

  oneWayLatencySec(): number {
    return this.latencySec;
  }
}
