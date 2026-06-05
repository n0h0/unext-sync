import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  parseClientMessage, PROTOCOL_VERSION,
  type ServerMessage,
} from "../../shared/protocol";
import { RoomManager } from "./rooms";

interface ClientCtx {
  id: string;
  roomId: string | null;
  isAlive: boolean;
}

export interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

function log(...args: unknown[]) {
  // 接続/切断/エラーのみ
  console.log(new Date().toISOString(), ...args);
}

function genRoomId(): string {
  // 推測耐性のある短いID（8桁の英数）
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export async function startServer(port = Number(process.env.PORT) || 8080): Promise<RunningServer> {
  const rooms = new RoomManager({
    now: () => Date.now(),
    genId: genRoomId,
    genToken: () => randomUUID(),
    hostTimeoutMs: 60000,
  });
  const ctxOf = new WeakMap<WebSocket, ClientCtx>();

  const wss = new WebSocketServer({ port });
  await new Promise<void>((res) => wss.on("listening", () => res()));

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const findSocket = (clientId: string): WebSocket | undefined => {
    for (const ws of wss.clients) {
      if (ctxOf.get(ws)?.id === clientId) return ws;
    }
    return undefined;
  };
  const broadcastHostStatus = (
    roomId: string, type: "host_disconnected" | "host_resumed",
  ) => {
    for (const cid of rooms.participantsOf(roomId)) {
      const sock = findSocket(cid);
      if (sock) send(sock, { v: PROTOCOL_VERSION, type });
    }
  };

  wss.on("connection", (ws) => {
    const ctx: ClientCtx = { id: randomUUID(), roomId: null, isAlive: true };
    ctxOf.set(ws, ctx);
    log("connect", ctx.id);

    ws.on("pong", () => { ctx.isAlive = true; });

    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) { log("error", "bad message from", ctx.id); return; }

      switch (msg.type) {
        case "ping":
          send(ws, { v: PROTOCOL_VERSION, type: "pong", id: msg.id });
          break;
        case "create": {
          const { roomId, hostToken } = rooms.create(ctx.id);
          send(ws, { v: PROTOCOL_VERSION, type: "created", roomId, hostToken });
          break;
        }
        case "join": {
          const r = rooms.join(msg.roomId, ctx.id, msg.role, msg.hostToken);
          if (r.outcome === "no_room") { send(ws, { v: PROTOCOL_VERSION, type: "no_room" }); return; }
          ctx.roomId = msg.roomId;
          if (r.outcome === "host_taken") {
            send(ws, { v: PROTOCOL_VERSION, type: "host_taken" });
          } else {
            send(ws, {
              v: PROTOCOL_VERSION, type: "joined",
              role: r.outcome === "joined-host" ? "host" : "participant",
            });
            if (r.outcome === "joined-host") broadcastHostStatus(msg.roomId, "host_resumed");
          }
          if (r.outcome === "joined-participant" && r.lastState) send(ws, r.lastState);
          break;
        }
        case "sync": {
          if (!ctx.roomId) return;
          const { broadcastTo, state } = rooms.recordSync(ctx.roomId, ctx.id, msg);
          if (!state) return;
          for (const cid of broadcastTo) {
            const sock = findSocket(cid);
            if (sock) send(sock, state);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      log("disconnect", ctx.id);
      if (ctx.roomId) {
        const { hostDisconnected } = rooms.removeClient(ctx.roomId, ctx.id);
        if (hostDisconnected) broadcastHostStatus(ctx.roomId, "host_disconnected");
        rooms.deleteIfEmpty(ctx.roomId);
      }
    });

    ws.on("error", (e) => log("error", ctx.id, String(e)));
  });

  // protocol-level ping でゾンビ接続を掃除
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const ctx = ctxOf.get(ws);
      if (!ctx) continue;
      if (!ctx.isAlive) { ws.terminate(); continue; }
      ctx.isAlive = false;
      ws.ping();
    }
  }, 30000);

  // ホストスロットのタイムアウト掃除
  const sweepTimer = setInterval(() => rooms.sweepHostTimeouts(), 10000);

  const stop = () =>
    new Promise<void>((resolve) => {
      clearInterval(pingTimer);
      clearInterval(sweepTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    });

  const addr = wss.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  log("listening", boundPort);
  return { port: boundPort, stop };
}

// 直接起動された場合（Render等）
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startServer().catch((e) => { console.error(e); process.exit(1); });
}
