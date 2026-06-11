import { PROTOCOL_VERSION, SERVER_MESSAGE_TYPES, type ServerMessage } from "../../shared/protocol";

// allowlist は protocol.ts の SERVER_MESSAGE_TYPES（単一の真実源）から導出する。
const TYPES: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

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
