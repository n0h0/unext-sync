import { constantTimeEqual, isTokenSafe } from "../../shared/secret";
import { RoomDurableObject } from "./room-do";

export { RoomDurableObject };

interface Env {
  ROOM: DurableObjectNamespace;
  CONNECT_SECRET: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function genRoomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.CONNECT_SECRET || !isTokenSafe(env.CONNECT_SECRET)) {
      return new Response("server misconfigured: CONNECT_SECRET", { status: 500 });
    }
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/create") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "POST" && url.pathname === "/create") {
      const auth = request.headers.get("Authorization") ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!constantTimeEqual(presented, env.CONNECT_SECRET)) {
        return new Response("unauthorized", { status: 401, headers: CORS });
      }
      for (let i = 0; i < 5; i++) {
        const roomId = genRoomId();
        const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
        const res = await stub.fetch("https://do/__init", { method: "POST" });
        if (res.status === 409) continue;
        const { hostToken } = await res.json<{ hostToken: string }>();
        return Response.json({ roomId, hostToken }, { headers: CORS });
      }
      return new Response("room id space exhausted", { status: 503, headers: CORS });
    }

    const m = url.pathname.match(/^\/r\/([A-Za-z0-9]{1,32})$/);
    if (m && request.headers.get("Upgrade") === "websocket") {
      const presented =
        (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",")[0]?.trim() ?? "";
      if (!constantTimeEqual(presented, env.CONNECT_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
