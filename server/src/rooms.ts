import type { StateMessage, SyncMessage } from "../../shared/protocol";

export type JoinOutcome = "joined-host" | "joined-participant" | "host_taken" | "no_room";

export interface JoinResult {
  outcome: JoinOutcome;
  lastState: StateMessage | null;
}

interface Room {
  id: string;
  hostToken: string;
  hostId: string | null; // 現在接続中のホストclientId
  hostDisconnectedAt: number | null;
  lastState: StateMessage | null;
  clients: Set<string>; // ホストを含む全接続clientId
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
      hostDisconnectedAt: null,
      lastState: null,
      clients: new Set(),
    });
    return { roomId: id, hostToken };
  }

  join(
    roomId: string,
    clientId: string,
    role: "host" | "participant",
    hostToken?: string,
  ): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return { outcome: "no_room", lastState: null };
    room.clients.add(clientId);

    if (role === "host") {
      const tokenOk = hostToken === room.hostToken;
      const slotFree = room.hostId === null;
      if (tokenOk && slotFree) {
        room.hostId = clientId;
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
    const broadcastTo = [...room.clients].filter((c) => c !== clientId);
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
        released.push(room.id);
      }
    }
    return released;
  }

  participantsOf(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.clients].filter((c) => c !== room.hostId);
  }

  deleteIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.clients.size === 0) this.rooms.delete(roomId);
  }
}
