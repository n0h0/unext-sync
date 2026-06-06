import { PROTOCOL_VERSION, type ServerMessage } from "../../shared/protocol";

const TYPES = new Set([
  "created",
  "joined",
  "state",
  "host_taken",
  "host_disconnected",
  "host_resumed",
  "pong",
  "no_room",
]);

export function parseServerMessageLoose(raw: string): ServerMessage | null {
  // biome-ignore lint/suspicious/noExplicitAny: runtime JSON validation — unknown shape until checked
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || o.v !== PROTOCOL_VERSION || !TYPES.has(o.type)) return null;
  return o as ServerMessage;
}
