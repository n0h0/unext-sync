import { DurableObject } from "cloudflare:workers";
import { PROTOCOL_VERSION, parseClientMessage } from "../../shared/protocol";
import {
  type Attachment,
  type ClientInfo,
  type Effect,
  freshPersistent,
  makeRoomLogic,
  type PersistentState,
  type RoomState,
} from "../../shared/rooms";

const HOST_TIMEOUT_MS = 60_000;
const KEY_P = "p";
const KEY_SEQ = "seq";

export class RoomDurableObject extends DurableObject {
  private logic() {
    return makeRoomLogic({
      now: () => Date.now(),
      genToken: () => crypto.randomUUID(),
      genGuestSuffix: () => crypto.randomUUID().slice(0, 4),
      hostTimeoutMs: HOST_TIMEOUT_MS,
    });
  }

  private async loadPersistent(): Promise<PersistentState | null> {
    return (await this.ctx.storage.get<PersistentState>(KEY_P)) ?? null;
  }

  private async hydrate(exclude?: string): Promise<RoomState | null> {
    const persistent = await this.loadPersistent();
    if (!persistent) return null;
    const clients = new Map<string, ClientInfo>();
    for (const sock of this.ctx.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a?.joined && a.clientId !== exclude)
        clients.set(a.clientId, { name: a.name, joinedAt: a.joinedAt });
    }
    return { persistent, clients };
  }

  private socketOf(clientId: string): WebSocket | undefined {
    for (const sock of this.ctx.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a?.clientId === clientId) return sock;
    }
    return undefined;
  }

  private async applyEffects(effects: Effect[]): Promise<void> {
    for (const e of effects) {
      switch (e.kind) {
        case "send": {
          const sock = this.socketOf(e.to);
          if (sock) sock.send(JSON.stringify(e.msg));
          break;
        }
        case "broadcast": {
          for (const sock of this.ctx.getWebSockets()) {
            const a = sock.deserializeAttachment() as Attachment | null;
            if (!a?.joined) continue;
            if (e.exclude && a.clientId === e.exclude) continue;
            sock.send(JSON.stringify(e.msg));
          }
          break;
        }
        case "setAttachment": {
          const sock = this.socketOf(e.clientId);
          if (sock) sock.serializeAttachment(e.attachment);
          break;
        }
        case "setAlarm":
          // reducer が出す setAlarm 効果は「現在状態の最早締切」を権威的に表すため上書きが正しい
          // （締切を持つ removeClient/sweepTimers/applyJoin が毎回再計算して発行する。古い締切は
          // state 上で既に無効化されている）。
          await this.ctx.storage.setAlarm(e.at);
          break;
        case "clearAlarm":
          await this.ctx.storage.deleteAlarm();
          break;
        case "clearStorage":
          // persist 側で deleteAll するためここでは何もしない
          break;
      }
    }
  }

  private async commit(result: { state: RoomState; effects: Effect[] }): Promise<void> {
    const hasClear = result.effects.some((e) => e.kind === "clearStorage");
    if (!hasClear) await this.ctx.storage.put(KEY_P, result.state.persistent);
    await this.applyEffects(result.effects);
    if (hasClear) await this.ctx.storage.deleteAll();
  }

  private async nextJoinSeq(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>(KEY_SEQ)) ?? 0) + 1;
    await this.ctx.storage.put(KEY_SEQ, n);
    return n;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/__init") {
      if (await this.loadPersistent()) return new Response("exists", { status: 409 });
      const hostToken = crypto.randomUUID();
      await this.ctx.storage.put(KEY_P, freshPersistent(hostToken));
      return Response.json({ hostToken });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const proto = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",")[0]?.trim();
      const headers: Record<string, string> = {};
      if (proto) headers["Sec-WebSocket-Protocol"] = proto;

      const persistent = await this.loadPersistent();
      this.ctx.acceptWebSocket(server);
      if (!persistent) {
        server.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "no_room" }));
        server.close(1000, "no_room");
        return new Response(null, { status: 101, webSocket: client, headers });
      }
      const clientId = crypto.randomUUID();
      const joinedAt = await this.nextJoinSeq();
      const att: Attachment = { clientId, name: "", isHost: false, joined: false, joinedAt };
      server.serializeAttachment(att);
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const msg = parseClientMessage(raw);
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!msg || !att) return;
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "pong", id: msg.id }));
      return;
    }
    const state = await this.hydrate();
    if (!state) return;
    const logic = this.logic();
    if (msg.type === "join") {
      await this.commit(
        logic.applyJoin(state, att.clientId, att.joinedAt, msg.role, msg.hostToken, msg.name),
      );
    } else if (msg.type === "sync") {
      await this.commit(logic.applySync(state, att.clientId, msg));
    } else if (msg.type === "title") {
      await this.commit(logic.applyTitle(state, att.clientId, msg.title));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const state = await this.hydrate(att.clientId);
    if (!state) return;
    await this.commit(this.logic().removeClient(state, att.clientId));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const state = await this.hydrate();
    if (!state) return;
    await this.commit(this.logic().sweepTimers(state, Date.now()));
  }
}
