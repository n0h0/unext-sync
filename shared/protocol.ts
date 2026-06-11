export const PROTOCOL_VERSION = 2;

export type SyncEvent = "play" | "pause" | "seek" | "ratechange" | "heartbeat";
export type Role = "host" | "participant";

export interface PlaybackFields {
  playing: boolean;
  currentTime: number;
  playbackRate: number;
  seq: number;
}

export interface SyncMessage extends PlaybackFields {
  v: number;
  type: "sync";
  event: SyncEvent;
  contentKey?: string;
}
export interface JoinMessage {
  v: number;
  type: "join";
  roomId: string;
  role: Role;
  hostToken?: string;
  name?: string;
}
export interface PingMessage {
  v: number;
  type: "ping";
  id: number;
}
export interface TitleMessage {
  v: number;
  type: "title";
  title: string;
}
export type ClientMessage = JoinMessage | SyncMessage | PingMessage | TitleMessage;

export interface JoinedMessage {
  v: number;
  type: "joined";
  role: Role;
  clientId: string;
}
export interface HostTakenMessage {
  v: number;
  type: "host_taken";
  clientId: string;
}
export interface StateMessage extends PlaybackFields {
  v: number;
  type: "state";
  event: SyncEvent;
  contentKey?: string;
}
export interface HostStatusMessage {
  v: number;
  type: "host_disconnected" | "host_resumed";
}
export interface RosterEntry {
  id: string;
  // 常に非空。クライアントが name を省略した場合はサーバーがゲスト名を合成する（rooms.join）。
  name: string;
  host: boolean;
  connected: boolean;
}
export interface RosterMessage {
  v: number;
  type: "roster";
  participants: RosterEntry[];
}
export interface RoomTitleMessage {
  v: number;
  type: "room_title";
  title: string;
}
export interface PongMessage {
  v: number;
  type: "pong";
  id: number;
}
export interface NoRoomMessage {
  v: number;
  type: "no_room";
}
export type ServerMessage =
  | JoinedMessage
  | HostTakenMessage
  | StateMessage
  | HostStatusMessage
  | RosterMessage
  | RoomTitleMessage
  | PongMessage
  | NoRoomMessage;

// ServerMessage の type 判別子の単一の真実源。Record<ServerMessage["type"], true> なので、
// ユニオンへ型を追加してここに足し忘れる（または余分なキーを書く）と tsc が落ちる。
// クライアント側 allowlist（extension/src/parse-server.ts）はこの配列から導出され、
// 「新メッセージ型を allowlist に足し忘れて黙って破棄される」事故を構造的に防ぐ。
const SERVER_MESSAGE_TYPE_MAP: Record<ServerMessage["type"], true> = {
  joined: true,
  host_taken: true,
  state: true,
  host_disconnected: true,
  host_resumed: true,
  roster: true,
  room_title: true,
  pong: true,
  no_room: true,
};
export const SERVER_MESSAGE_TYPES = Object.keys(SERVER_MESSAGE_TYPE_MAP) as ServerMessage["type"][];

const SYNC_EVENTS: SyncEvent[] = ["play", "pause", "seek", "ratechange", "heartbeat"];

function isSyncEvent(x: unknown): x is SyncEvent {
  return typeof x === "string" && (SYNC_EVENTS as string[]).includes(x);
}

function isPlayback(o: Record<string, unknown>): o is Record<string, unknown> & PlaybackFields {
  return (
    typeof o.playing === "boolean" &&
    // Number.isFinite は NaN と ±Infinity を両方弾く（JSON のオーバーフロー数値リテラル
    // 1e999 は JSON.parse で Infinity になり得るため、型と符号だけでは不十分）。
    Number.isFinite(o.currentTime) &&
    (o.currentTime as number) >= 0 &&
    Number.isFinite(o.playbackRate) &&
    (o.playbackRate as number) > 0 &&
    Number.isInteger(o.seq)
  );
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== PROTOCOL_VERSION || typeof o.type !== "string") return null;
  switch (o.type) {
    case "join":
      if (typeof o.roomId !== "string") return null;
      if (o.role !== "host" && o.role !== "participant") return null;
      if (o.hostToken !== undefined && typeof o.hostToken !== "string") return null;
      if (o.name !== undefined && typeof o.name !== "string") return null;
      return {
        v: PROTOCOL_VERSION,
        type: "join",
        roomId: o.roomId,
        role: o.role,
        hostToken: o.hostToken,
        name: o.name,
      };
    case "sync":
      if (!isSyncEvent(o.event) || !isPlayback(o)) return null;
      if (o.contentKey !== undefined && typeof o.contentKey !== "string") return null;
      return {
        v: PROTOCOL_VERSION,
        type: "sync",
        event: o.event,
        playing: o.playing,
        currentTime: o.currentTime,
        playbackRate: o.playbackRate,
        seq: o.seq,
        contentKey: o.contentKey,
      };
    case "title":
      if (typeof o.title !== "string") return null;
      return { v: PROTOCOL_VERSION, type: "title", title: o.title };
    case "ping":
      if (typeof o.id !== "number" || !Number.isInteger(o.id)) return null;
      return { v: PROTOCOL_VERSION, type: "ping", id: o.id };
    default:
      return null;
  }
}
