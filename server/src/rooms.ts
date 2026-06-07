import type { RosterEntry, StateMessage, SyncMessage } from "../../shared/protocol";

const MAX_NAME_LEN = 24;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 信頼しない表示名から制御文字を除去する
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** 信頼しない表示名を正規化する（trim・制御文字除去・24文字切り詰め）。空なら "" を返す。 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return [...raw.replace(CONTROL_CHARS, "").trim()].slice(0, MAX_NAME_LEN).join("");
}

export type JoinOutcome = "joined-host" | "joined-participant" | "host_taken" | "no_room";

export interface JoinResult {
  outcome: JoinOutcome;
  lastState: StateMessage | null;
}

interface ClientInfo {
  name: string;
}

interface Room {
  id: string;
  hostToken: string;
  hostId: string | null; // 現在接続中のホストclientId
  hostName: string | null;
  hostDisconnectedAt: number | null;
  lastState: StateMessage | null;
  clients: Map<string, ClientInfo>; // ホストを含む全接続clientId
}

export interface RoomManagerDeps {
  now: () => number;
  genId: () => string;
  genToken: () => string;
  hostTimeoutMs: number;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  constructor(private deps: RoomManagerDeps) {}

  create(_creatorClientId: string): { roomId: string; hostToken: string } {
    const id = this.deps.genId();
    const hostToken = this.deps.genToken();
    this.rooms.set(id, {
      id,
      hostToken,
      hostId: null,
      hostName: null,
      hostDisconnectedAt: null,
      lastState: null,
      clients: new Map(),
    });
    return { roomId: id, hostToken };
  }

  join(
    roomId: string,
    clientId: string,
    role: "host" | "participant",
    hostToken?: string,
    name?: string,
  ): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return { outcome: "no_room", lastState: null };
    // 空名は genId の先頭4文字をサフィックスにゲスト名を合成（DI済みの乱数源を再利用）。
    const cleanName = normalizeName(name) || `ゲスト-${this.deps.genId().slice(0, 4)}`;
    room.clients.set(clientId, { name: cleanName });

    if (role === "host") {
      const tokenOk = hostToken === room.hostToken;
      const slotFree = room.hostId === null;
      if (tokenOk && slotFree) {
        room.hostId = clientId;
        room.hostName = cleanName;
        room.hostDisconnectedAt = null;
        return { outcome: "joined-host", lastState: room.lastState };
      }
      // トークン不一致 or 既にホスト在席 → participantフォールバック
      return { outcome: "host_taken", lastState: room.lastState };
    }
    return { outcome: "joined-participant", lastState: room.lastState };
  }

  recordSync(
    roomId: string,
    clientId: string,
    msg: SyncMessage,
  ): { broadcastTo: string[]; state: StateMessage | null } {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== clientId) return { broadcastTo: [], state: null };
    const state: StateMessage = {
      v: msg.v,
      type: "state",
      event: msg.event,
      playing: msg.playing,
      currentTime: msg.currentTime,
      playbackRate: msg.playbackRate,
      seq: msg.seq,
    };
    room.lastState = state;
    const broadcastTo = [...room.clients.keys()].filter((c) => c !== clientId);
    return { broadcastTo, state };
  }

  removeClient(roomId: string, clientId: string): { hostDisconnected: boolean } {
    const room = this.rooms.get(roomId);
    if (!room) return { hostDisconnected: false };
    room.clients.delete(clientId);
    if (room.hostId === clientId) {
      room.hostId = null;
      room.hostDisconnectedAt = this.deps.now();
      return { hostDisconnected: true };
    }
    return { hostDisconnected: false };
  }

  /** ホスト切断後 hostTimeoutMs を超えたルームのスロットを解放し、roomId配列を返す。 */
  sweepHostTimeouts(): string[] {
    const released: string[] = [];
    const t = this.deps.now();
    for (const room of this.rooms.values()) {
      if (
        room.hostId === null &&
        room.hostDisconnectedAt !== null &&
        t - room.hostDisconnectedAt > this.deps.hostTimeoutMs
      ) {
        room.hostDisconnectedAt = null; // スロットは hostId=null のまま＝再取得可能
        room.hostName = null;
        released.push(room.id);
      }
    }
    return released;
  }

  participantsOf(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.clients.keys()].filter((c) => c !== room.hostId);
  }

  /** ルーム全員（ホスト＋参加者）の接続中 clientId。roster送信の宛先列挙に使う。 */
  clientIdsOf(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.clients.keys()];
  }

  /** 表示用ロスター。先頭がホスト行、続けて参加者を挿入順で。ホストは二重に出さない。 */
  rosterOf(roomId: string): RosterEntry[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const entries: RosterEntry[] = [];
    if (room.hostId !== null) {
      // 不変条件: hostId が非nullなら必ず clients に存在する（join で set 済み）。
      const info = room.clients.get(room.hostId);
      entries.push({ id: room.hostId, name: info?.name ?? "", host: true, connected: true });
    } else if (room.hostName !== null && room.hostDisconnectedAt !== null) {
      // "__host__" は実 clientId（randomUUID）と衝突しない表示専用センチネル。WS送信先にはしない。
      entries.push({ id: "__host__", name: room.hostName, host: true, connected: false });
    }
    for (const [id, info] of room.clients) {
      if (id === room.hostId) continue;
      entries.push({ id, name: info.name, host: false, connected: true });
    }
    return entries;
  }

  deleteIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.clients.size === 0) this.rooms.delete(roomId);
  }
}
