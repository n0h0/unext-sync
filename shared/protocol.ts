export const PROTOCOL_VERSION = 1;

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
}
export interface CreateMessage { v: number; type: "create"; }
export interface JoinMessage {
  v: number; type: "join"; roomId: string; role: Role; hostToken?: string;
}
export interface PingMessage { v: number; type: "ping"; id: number; }
export type ClientMessage =
  | CreateMessage | JoinMessage | SyncMessage | PingMessage;

export interface CreatedMessage {
  v: number; type: "created"; roomId: string; hostToken: string;
}
export interface JoinedMessage { v: number; type: "joined"; role: Role; }
export interface StateMessage extends PlaybackFields {
  v: number; type: "state"; event: SyncEvent;
}
export interface HostStatusMessage {
  v: number; type: "host_taken" | "host_disconnected" | "host_resumed";
}
export interface PongMessage { v: number; type: "pong"; id: number; }
export interface NoRoomMessage { v: number; type: "no_room"; }
export type ServerMessage =
  | CreatedMessage | JoinedMessage | StateMessage | HostStatusMessage | PongMessage | NoRoomMessage;

const SYNC_EVENTS: SyncEvent[] = ["play", "pause", "seek", "ratechange", "heartbeat"];

function isPlayback(o: any): boolean {
  return typeof o.playing === "boolean"
    && typeof o.currentTime === "number" && o.currentTime >= 0
    && typeof o.playbackRate === "number" && o.playbackRate > 0
    && Number.isInteger(o.seq);
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || o.v !== PROTOCOL_VERSION || typeof o.type !== "string") return null;
  switch (o.type) {
    case "create":
      return { v: 1, type: "create" };
    case "join":
      if (typeof o.roomId !== "string") return null;
      if (o.role !== "host" && o.role !== "participant") return null;
      if (o.role === "host" && o.hostToken !== undefined
          && typeof o.hostToken !== "string") return null;
      return { v: 1, type: "join", roomId: o.roomId, role: o.role, hostToken: o.hostToken };
    case "sync":
      if (!SYNC_EVENTS.includes(o.event) || !isPlayback(o)) return null;
      return {
        v: 1, type: "sync", event: o.event,
        playing: o.playing, currentTime: o.currentTime,
        playbackRate: o.playbackRate, seq: o.seq,
      };
    case "ping":
      if (!Number.isInteger(o.id)) return null;
      return { v: 1, type: "ping", id: o.id };
    default:
      return null;
  }
}
