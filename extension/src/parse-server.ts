import { PROTOCOL_VERSION, type ServerMessage } from "../../shared/protocol";

const TYPES = new Set([
  "created",
  "joined",
  "state",
  "roster",
  "room_title",
  "host_taken",
  "host_disconnected",
  "host_resumed",
  "pong",
  "no_room",
]);

export function parseServerMessageLoose(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== PROTOCOL_VERSION || typeof o.type !== "string" || !TYPES.has(o.type)) return null;
  return o as unknown as ServerMessage;
}
