import { PROTOCOL_VERSION, type RosterEntry, type ServerMessage, type StateMessage, type SyncMessage } from "./protocol";

const MAX_NAME_LEN = 24;
const MAX_TITLE_LEN = 120;
const CONTROL_CHARS = /\p{Cc}/gu;

export function normalizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return [...raw.replace(CONTROL_CHARS, "").trim()].slice(0, maxLen).join("");
}
export function normalizeName(raw: unknown): string {
  return normalizeText(raw, MAX_NAME_LEN);
}

export type JoinOutcome = "joined-host" | "joined-participant" | "host_taken" | "no_room";

/** DO の ctx.storage に保存する永続状態。 */
export interface PersistentState {
  hostToken: string;
  hostId: string | null;
  hostName: string | null;
  hostDisconnectedAt: number | null;
  emptiedAt: number | null; // 最後のソケット切断時刻（空ルーム掃除用）
  lastState: StateMessage | null;
  hostTitle: string | null;
}

/** 接続状態（WS attachment から復元する）。 */
export interface ClientInfo {
  name: string;
  joinedAt: number; // 安定 roster 順序のための単調連番
}

export interface RoomState {
  persistent: PersistentState;
  clients: Map<string, ClientInfo>;
}

/** 各 WS ソケットに serializeAttachment で載せるメタ（hibernation 跨ぎで生存）。 */
export interface Attachment {
  clientId: string;
  name: string;
  isHost: boolean;
  joined: boolean; // join 完了前のソケットを roster から除外するため
  joinedAt: number;
}

export type Effect =
  | { kind: "send"; to: string; msg: ServerMessage }
  | { kind: "broadcast"; exclude?: string; msg: ServerMessage }
  | { kind: "setAttachment"; clientId: string; attachment: Attachment }
  | { kind: "setAlarm"; at: number }
  | { kind: "clearStorage" };

export interface RoomDeps {
  now: () => number;
  genToken: () => string;
  genGuestSuffix: () => string;
  hostTimeoutMs: number;
}

export function freshPersistent(hostToken: string): PersistentState {
  return {
    hostToken,
    hostId: null,
    hostName: null,
    hostDisconnectedAt: null,
    emptiedAt: null,
    lastState: null,
    hostTitle: null,
  };
}

function rosterOf(state: RoomState): RosterEntry[] {
  const { persistent: p, clients } = state;
  const entries: RosterEntry[] = [];
  if (p.hostId !== null) {
    const info = clients.get(p.hostId);
    entries.push({ id: p.hostId, name: info?.name ?? "", host: true, connected: true });
  } else if (p.hostName !== null && p.hostDisconnectedAt !== null) {
    entries.push({ id: "__host__", name: p.hostName, host: true, connected: false });
  }
  const sorted = [...clients.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  for (const [id, info] of sorted) {
    if (id === p.hostId) continue;
    entries.push({ id, name: info.name, host: false, connected: true });
  }
  return entries;
}

function earliestDeadline(p: PersistentState, hostTimeoutMs: number): number | null {
  const deadlines: number[] = [];
  if (p.hostId === null && p.hostDisconnectedAt !== null) deadlines.push(p.hostDisconnectedAt + hostTimeoutMs);
  if (p.emptiedAt !== null) deadlines.push(p.emptiedAt + hostTimeoutMs);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export interface RoomLogic {
  rosterOf(state: RoomState): RosterEntry[];
  applyJoin(
    state: RoomState,
    clientId: string,
    joinedAt: number,
    role: "host" | "participant",
    hostToken?: string,
    name?: string,
  ): { state: RoomState; effects: Effect[]; outcome: JoinOutcome };
  applySync(state: RoomState, clientId: string, msg: SyncMessage): { state: RoomState; effects: Effect[] };
  applyTitle(state: RoomState, clientId: string, rawTitle: unknown): { state: RoomState; effects: Effect[] };
  removeClient(state: RoomState, clientId: string): { state: RoomState; effects: Effect[] };
  sweepTimers(state: RoomState, now: number): { state: RoomState; effects: Effect[] };
}

export function makeRoomLogic(deps: RoomDeps): RoomLogic {
  return {
    rosterOf,
    applyJoin(state, clientId, joinedAt, role, hostToken, name) {
      const p = state.persistent;
      const effects: Effect[] = [];
      const cleanName = normalizeName(name) || `ゲスト-${deps.genGuestSuffix()}`;
      let isHost = false;
      let outcome: JoinOutcome;
      if (role === "host") {
        if (hostToken === p.hostToken && p.hostId === null) {
          p.hostId = clientId;
          p.hostName = cleanName;
          p.hostDisconnectedAt = null;
          isHost = true;
          outcome = "joined-host";
        } else {
          outcome = "host_taken";
        }
      } else {
        outcome = "joined-participant";
      }
      state.clients.set(clientId, { name: cleanName, joinedAt });
      p.emptiedAt = null;
      effects.push({
        kind: "setAttachment",
        clientId,
        attachment: { clientId, name: cleanName, isHost, joined: true, joinedAt },
      });
      if (outcome === "host_taken") {
        effects.push({ kind: "send", to: clientId, msg: { v: PROTOCOL_VERSION, type: "host_taken", clientId } });
      } else {
        effects.push({
          kind: "send",
          to: clientId,
          msg: { v: PROTOCOL_VERSION, type: "joined", role: isHost ? "host" : "participant", clientId },
        });
        if (outcome === "joined-host") {
          effects.push({ kind: "broadcast", exclude: clientId, msg: { v: PROTOCOL_VERSION, type: "host_resumed" } });
        }
      }
      if (outcome === "joined-participant" && p.lastState) {
        effects.push({ kind: "send", to: clientId, msg: p.lastState });
      }
      effects.push({ kind: "broadcast", msg: { v: PROTOCOL_VERSION, type: "roster", participants: rosterOf(state) } });
      if (p.hostTitle !== null) {
        effects.push({ kind: "send", to: clientId, msg: { v: PROTOCOL_VERSION, type: "room_title", title: p.hostTitle } });
      }
      return { state, effects, outcome };
    },
    applySync(state, clientId, msg) {
      const p = state.persistent;
      if (p.hostId !== clientId) return { state, effects: [] };
      const stateMsg: StateMessage = {
        v: msg.v,
        type: "state",
        event: msg.event,
        playing: msg.playing,
        currentTime: msg.currentTime,
        playbackRate: msg.playbackRate,
        seq: msg.seq,
        contentKey: msg.contentKey,
      };
      p.lastState = stateMsg;
      return { state, effects: [{ kind: "broadcast", exclude: clientId, msg: stateMsg }] };
    },
    applyTitle(state, clientId, rawTitle) {
      const p = state.persistent;
      if (p.hostId !== clientId) return { state, effects: [] };
      const title = normalizeText(rawTitle, MAX_TITLE_LEN);
      if (title === "" || title === p.hostTitle) return { state, effects: [] };
      p.hostTitle = title;
      return { state, effects: [{ kind: "broadcast", msg: { v: PROTOCOL_VERSION, type: "room_title", title } }] };
    },
    removeClient(state, clientId) {
      const p = state.persistent;
      const effects: Effect[] = [];
      state.clients.delete(clientId);
      if (p.hostId === clientId) {
        p.hostId = null;
        p.hostDisconnectedAt = deps.now();
        effects.push({ kind: "broadcast", msg: { v: PROTOCOL_VERSION, type: "host_disconnected" } });
      }
      if (state.clients.size === 0) p.emptiedAt = deps.now();
      effects.push({ kind: "broadcast", msg: { v: PROTOCOL_VERSION, type: "roster", participants: rosterOf(state) } });
      const at = earliestDeadline(p, deps.hostTimeoutMs);
      if (at !== null) effects.push({ kind: "setAlarm", at });
      return { state, effects };
    },
    sweepTimers(state, now) {
      const p = state.persistent;
      const effects: Effect[] = [];
      let rosterChanged = false;
      if (p.hostId === null && p.hostDisconnectedAt !== null && now - p.hostDisconnectedAt > deps.hostTimeoutMs) {
        p.hostDisconnectedAt = null;
        p.hostName = null;
        rosterChanged = true;
      }
      if (state.clients.size === 0 && p.emptiedAt !== null && now - p.emptiedAt > deps.hostTimeoutMs) {
        return { state, effects: [{ kind: "clearStorage" }] };
      }
      if (rosterChanged) {
        effects.push({ kind: "broadcast", msg: { v: PROTOCOL_VERSION, type: "roster", participants: rosterOf(state) } });
      }
      const at = earliestDeadline(p, deps.hostTimeoutMs);
      if (at !== null) effects.push({ kind: "setAlarm", at });
      return { state, effects };
    },
  };
}
