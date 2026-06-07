# 参加者一覧表示（ロスター）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ルーム内の参加者（名前付き）を全員のpopupに一覧表示する。

**Architecture:** サーバー（`rooms.ts`）が唯一の真実源として名簿を持ち、join/leave/host状態変化のたびに「全ロスターのスナップショット」(`roster` メッセージ) をルーム全員へpush。拡張側は content script がロスターと自分のidを保持し、popupが純粋関数で描画する。同期ロジック（完全スレーブ・方式C）には触れない。

**Tech Stack:** TypeScript / Node.js + `ws`（server）/ Chrome MV3（extension）/ vitest / Biome / pnpm。

**正典 spec:** `docs/superpowers/specs/2026-06-07-participant-roster-design.md`

---

## File Structure

| ファイル | 役割 | 変更種別 |
|---|---|---|
| `shared/protocol.ts` | `RosterEntry`/`RosterMessage` 型、`join.name`、`joined`/`host_taken` の `clientId`、`name` 型チェック | 変更 |
| `shared/protocol.test.ts` | `join.name` のパース検証 | 変更 |
| `server/src/rooms.ts` | `normalizeName`（純粋）、`clients` の Map 化、`hostName`、`join(name)`、`rosterOf`、`clientIdsOf` | 変更 |
| `server/rooms.test.ts` | `normalizeName`/`rosterOf`/名前格納/合成ホスト行のユニットテスト | 変更 |
| `server/src/server.ts` | `broadcastRoster` 配線、`joined`/`host_taken` に `clientId`、`join` で `name` 受け渡し、各契機で roster 送出 | 変更 |
| `server/server.test.ts` | roster ブロードキャストの ws テスト＋既存テストのメッセージ順序追従 | 変更 |
| `extension/src/popup-status.ts` | `formatRosterLine`/`rosterHeader`（純粋・描画） | 変更 |
| `extension/src/popup.test.ts` | `formatRosterLine`/`rosterHeader` のユニットテスト | 変更 |
| `extension/src/content.ts` | `roster`/`selfId` 保持・転送、`name` を `join` に乗せる、`get_status` 応答拡張 | 変更 |
| `extension/src/popup.ts` | 名前入力（storage保存・プリフィル）、ロスター描画 | 変更 |
| `extension/src/popup.html` | 名前入力欄・ロスター表示欄・`.offline` CSS | 変更 |

---

## Task 1: protocol.ts — 型とパース

**Files:**
- Modify: `shared/protocol.ts`
- Test: `shared/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

`shared/protocol.test.ts` の末尾に追記:

```ts
test("parses join with name", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "join",
    roomId: "abcd1234",
    role: "participant",
    name: "はなこ",
  });
  expect(parseClientMessage(raw)).toMatchObject({
    type: "join",
    role: "participant",
    name: "はなこ",
  });
});

test("join without name is still valid (name undefined)", () => {
  const raw = JSON.stringify({ v: 1, type: "join", roomId: "r", role: "participant" });
  expect(parseClientMessage(raw)).toMatchObject({ type: "join", role: "participant" });
});

test("rejects join with non-string name", () => {
  const raw = JSON.stringify({ v: 1, type: "join", roomId: "r", role: "participant", name: 42 });
  expect(parseClientMessage(raw)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: FAIL — `name` フィールドが返らない / 非文字列nameが弾かれない。

- [ ] **Step 3: Implement protocol changes**

`shared/protocol.ts` の `JoinMessage` に `name` を追加:

```ts
export interface JoinMessage {
  v: number;
  type: "join";
  roomId: string;
  role: Role;
  hostToken?: string;
  name?: string;
}
```

`JoinedMessage` に `clientId` を追加し、`host_taken` を独立型として切り出す。`HostStatusMessage` から `host_taken` を除く:

```ts
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
export interface HostStatusMessage {
  v: number;
  type: "host_disconnected" | "host_resumed";
}
```

`RosterEntry` / `RosterMessage` を追加（`StateMessage` 定義の近くに）:

```ts
export interface RosterEntry {
  id: string;
  name: string;
  host: boolean;
  connected: boolean;
}
export interface RosterMessage {
  v: number;
  type: "roster";
  participants: RosterEntry[];
}
```

`ServerMessage` 合併型を更新:

```ts
export type ServerMessage =
  | CreatedMessage
  | JoinedMessage
  | HostTakenMessage
  | StateMessage
  | HostStatusMessage
  | RosterMessage
  | PongMessage
  | NoRoomMessage;
```

`parseClientMessage` の `case "join"` に `name` の型チェックと透過を追加:

```ts
    case "join":
      if (typeof o.roomId !== "string") return null;
      if (o.role !== "host" && o.role !== "participant") return null;
      if (o.role === "host" && o.hostToken !== undefined && typeof o.hostToken !== "string")
        return null;
      if (o.name !== undefined && typeof o.name !== "string") return null;
      return {
        v: 1,
        type: "join",
        roomId: o.roomId,
        role: o.role,
        hostToken: o.hostToken,
        name: o.name,
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: PASS（既存テストも含めて緑）。

- [ ] **Step 5: Commit**

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(protocol): add roster types, join.name, clientId on joined/host_taken

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: rooms.ts — `normalizeName`（純粋関数）

**Files:**
- Modify: `server/src/rooms.ts`
- Test: `server/rooms.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/rooms.test.ts` の import を更新し、テストを追記:

```ts
import { normalizeName, RoomManager } from "./src/rooms";

test("normalizeName trims and strips control chars", () => {
  expect(normalizeName("  たろう  ")).toBe("たろう");
  expect(normalizeName("a\u0001b\u007fc")).toBe("abc");
});

test("normalizeName truncates to 24 chars", () => {
  expect(normalizeName("あ".repeat(40))).toBe("あ".repeat(24));
});

test("normalizeName returns empty string for non-string or empty", () => {
  expect(normalizeName(undefined)).toBe("");
  expect(normalizeName(42)).toBe("");
  expect(normalizeName("   ")).toBe("");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: FAIL — `normalizeName` が未定義（import エラー）。

- [ ] **Step 3: Implement `normalizeName`**

`server/src/rooms.ts` の先頭（import 直後、`RoomManager` の外）に追加:

```ts
const MAX_NAME_LEN = 24;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 信頼しない表示名から制御文字を除去する
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** 信頼しない表示名を正規化する（trim・制御文字除去・24文字切り詰め）。空なら "" を返す。 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(CONTROL_CHARS, "").trim().slice(0, MAX_NAME_LEN);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: PASS（既存の RoomManager テストも緑のまま）。

- [ ] **Step 5: Commit**

```bash
git add server/src/rooms.ts server/rooms.test.ts
git commit -m "feat(rooms): add normalizeName pure helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: rooms.ts — `clients` の Map 化・`join(name)`・`hostName`

**Files:**
- Modify: `server/src/rooms.ts`
- Test: `server/rooms.test.ts`

> これは Map 化のリファクタリング。`clients` の内部表現を変えても**既存の RoomManager テストが緑のまま**であることがこのタスクのガード（名前格納の新規テストは `rosterOf` が必要なため Task 4 でまとめて書く）。`[...room.clients]` は Map では `[key,value]` ペアになるため `.keys()` へ直すのが肝。

- [ ] **Step 1: Run existing tests to capture the green baseline**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: 既存テスト全 PASS（編集前の基準）。

- [ ] **Step 2: Implement Map 化・`join` 拡張・`hostName`**

`server/src/rooms.ts` を以下のように変更。

import に `RosterEntry` を追加:

```ts
import type { RosterEntry, StateMessage, SyncMessage } from "../../shared/protocol";
```

`ClientInfo` を追加し `Room` を変更:

```ts
interface ClientInfo {
  name: string;
}

interface Room {
  id: string;
  hostToken: string;
  hostId: string | null;
  hostName: string | null;
  hostDisconnectedAt: number | null;
  lastState: StateMessage | null;
  clients: Map<string, ClientInfo>;
}
```

`create` の初期化を更新（`hostName: null`、`clients: new Map()`）:

```ts
    this.rooms.set(id, {
      id,
      hostToken,
      hostId: null,
      hostName: null,
      hostDisconnectedAt: null,
      lastState: null,
      clients: new Map(),
    });
```

`join` シグネチャと本体を変更:

```ts
  join(
    roomId: string,
    clientId: string,
    role: "host" | "participant",
    hostToken?: string,
    name?: string,
  ): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return { outcome: "no_room", lastState: null };
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
      return { outcome: "host_taken", lastState: room.lastState };
    }
    return { outcome: "joined-participant", lastState: room.lastState };
  }
```

`recordSync` のブロードキャスト先抽出を `.keys()` に修正:

```ts
    const broadcastTo = [...room.clients.keys()].filter((c) => c !== clientId);
```

`sweepHostTimeouts` でスロット解放時に `hostName` もクリア:

```ts
        room.hostDisconnectedAt = null; // スロットは hostId=null のまま＝再取得可能
        room.hostName = null;
        released.push(room.id);
```

`participantsOf` を `.keys()` に修正:

```ts
  participantsOf(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.clients.keys()].filter((c) => c !== room.hostId);
  }
```

（`removeClient` の `room.clients.delete(clientId)` と `deleteIfEmpty` の `room.clients.size === 0` は Map でもそのまま動くので変更不要。）

- [ ] **Step 3: Run existing tests to verify Map migration didn't break them**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: 既存テストは全 PASS（このタスクはリファクタなので新規テストは増やさない。`rosterOf` を使う名前格納テストは Task 4 で追加する）。

- [ ] **Step 4: Commit**

```bash
git add server/src/rooms.ts
git commit -m "feat(rooms): migrate clients to Map, store names, track hostName

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: rooms.ts — `rosterOf` / `clientIdsOf`

**Files:**
- Modify: `server/src/rooms.ts`
- Test: `server/rooms.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/rooms.test.ts` に追記:

```ts
test("join stores normalized name, guest fallback when empty", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "  たろう  ");
  rm.join(roomId, "c2", "participant", undefined, "");
  const roster = rm.rosterOf(roomId);
  expect(roster.find((e) => e.id === "c1")?.name).toBe("たろう");
  expect(roster.find((e) => e.id === "c2")?.name).toMatch(/^ゲスト-/);
});

test("rosterOf lists host first then participants in insertion order", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.join(roomId, "c2", "participant", undefined, "はなこ");
  rm.join(roomId, "c3", "participant", undefined, "じろう");
  const roster = rm.rosterOf(roomId);
  expect(roster).toEqual([
    { id: "c1", name: "たろう", host: true, connected: true },
    { id: "c2", name: "はなこ", host: false, connected: true },
    { id: "c3", name: "じろう", host: false, connected: true },
  ]);
});

test("rosterOf shows synthetic disconnected host row during hold", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.join(roomId, "c2", "participant", undefined, "はなこ");
  rm.removeClient(roomId, "c1"); // host drops, within 60s hold
  const roster = rm.rosterOf(roomId);
  expect(roster[0]).toEqual({ id: "__host__", name: "たろう", host: true, connected: false });
  expect(roster.find((e) => e.id === "c2")).toEqual({
    id: "c2",
    name: "はなこ",
    host: false,
    connected: true,
  });
});

test("rosterOf drops host row after timeout sweep", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.join(roomId, "c2", "participant", undefined, "はなこ");
  rm.removeClient(roomId, "c1");
  now += 61000;
  rm.sweepHostTimeouts();
  const roster = rm.rosterOf(roomId);
  expect(roster.some((e) => e.host)).toBe(false);
  expect(roster).toHaveLength(1);
});

test("clientIdsOf returns all connected client ids including host", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.join(roomId, "c2", "participant", undefined, "はなこ");
  expect(rm.clientIdsOf(roomId).sort()).toEqual(["c1", "c2"]);
});

test("rosterOf returns empty for unknown room", () => {
  expect(rm.rosterOf("nope")).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: FAIL — `rosterOf` / `clientIdsOf` 未定義。

- [ ] **Step 3: Implement `rosterOf` and `clientIdsOf`**

`server/src/rooms.ts` の `participantsOf` の隣に追加:

```ts
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
      const info = room.clients.get(room.hostId);
      entries.push({ id: room.hostId, name: info?.name ?? "", host: true, connected: true });
    } else if (room.hostName !== null && room.hostDisconnectedAt !== null) {
      entries.push({ id: "__host__", name: room.hostName, host: true, connected: false });
    }
    for (const [id, info] of room.clients) {
      if (id === room.hostId) continue;
      entries.push({ id, name: info.name, host: false, connected: true });
    }
    return entries;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: PASS（Task 3 の `join stores normalized name...` を含め全緑）。

- [ ] **Step 5: Commit**

```bash
git add server/src/rooms.ts server/rooms.test.ts
git commit -m "feat(rooms): add rosterOf and clientIdsOf

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: server.ts — `broadcastRoster` 配線

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/server.test.ts`

> `broadcastRoster` を足すと、各クライアントのメッセージ列に `roster` が割り込む。既存テストの素朴な `r.next()` がメッセージ順序に依存するため、型を待つ `nextType` ヘルパを導入して既存テストを順序非依存にする。

- [ ] **Step 1: Write the failing tests + harden existing ones**

`server/server.test.ts` の `reader` の下に `nextType` ヘルパを追加:

```ts
async function nextType(r: ReturnType<typeof reader>, type: string): Promise<any> {
  for (;;) {
    const m = await r.next();
    if (m.type === type) return m;
  }
}
```

既存テスト「host sync is broadcast to participant」の最後の行を `nextType` に変更:

```ts
  // 旧: const state = await guestR.next();
  const state = await nextType(guestR, "state");
  expect(state).toMatchObject({ type: "state", event: "seek", currentTime: 345.8, seq: 1 });
```

末尾に新規テストを追加:

```ts
test("joined carries clientId", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  const joined = await nextType(hostR, "joined");
  expect(typeof joined.clientId).toBe("string");
});

test("roster broadcast lists host and participant with names", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");

  const { ws: guest, r: guestR } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  await nextType(guestR, "joined");
  const roster = await nextType(guestR, "roster");
  expect(roster.participants).toHaveLength(2);
  expect(roster.participants[0]).toMatchObject({ name: "たろう", host: true, connected: true });
  expect(roster.participants.find((p: any) => p.name === "はなこ")).toMatchObject({
    host: false,
    connected: true,
  });
});

test("participant leaving updates roster", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  const { ws: host, r: hostR } = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await hostR.next();
  send(host, {
    v: 1,
    type: "join",
    roomId: created.roomId,
    role: "host",
    hostToken: created.hostToken,
    name: "たろう",
  });
  await nextType(hostR, "joined");

  const { ws: guest } = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  await nextType(hostR, "roster"); // guest joined → host gets 2-entry roster
  guest.close();
  const roster = await nextType(hostR, "roster"); // guest left → back to 1 entry
  expect(roster.participants).toHaveLength(1);
  expect(roster.participants[0]).toMatchObject({ name: "たろう", host: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run server/server.test.ts`
Expected: FAIL — `roster` メッセージが来ない / `clientId` が無い。

- [ ] **Step 3: Implement server wiring**

`server/src/server.ts` の `broadcastHostStatus` 定義の直後に `broadcastRoster` を追加:

```ts
  const broadcastRoster = (roomId: string) => {
    const participants = rooms.rosterOf(roomId);
    for (const cid of rooms.clientIdsOf(roomId)) {
      const sock = findSocket(cid);
      if (sock) send(sock, { v: PROTOCOL_VERSION, type: "roster", participants });
    }
  };
```

`case "join"` を更新（`name` 受け渡し、`clientId` 付与、最後に roster ブロードキャスト）:

```ts
        case "join": {
          const r = rooms.join(msg.roomId, ctx.id, msg.role, msg.hostToken, msg.name);
          if (r.outcome === "no_room") {
            send(ws, { v: PROTOCOL_VERSION, type: "no_room" });
            return;
          }
          ctx.roomId = msg.roomId;
          if (r.outcome === "host_taken") {
            send(ws, { v: PROTOCOL_VERSION, type: "host_taken", clientId: ctx.id });
          } else {
            send(ws, {
              v: PROTOCOL_VERSION,
              type: "joined",
              role: r.outcome === "joined-host" ? "host" : "participant",
              clientId: ctx.id,
            });
            if (r.outcome === "joined-host") broadcastHostStatus(msg.roomId, "host_resumed");
          }
          if (r.outcome === "joined-participant" && r.lastState) send(ws, r.lastState);
          broadcastRoster(msg.roomId);
          break;
        }
```

`ws.on("close", ...)` を更新（leave 後に roster ブロードキャスト）:

```ts
    ws.on("close", () => {
      log("disconnect", ctx.id);
      if (ctx.roomId) {
        const { hostDisconnected } = rooms.removeClient(ctx.roomId, ctx.id);
        if (hostDisconnected) broadcastHostStatus(ctx.roomId, "host_disconnected");
        broadcastRoster(ctx.roomId);
        rooms.deleteIfEmpty(ctx.roomId);
      }
    });
```

ホストスロット掃除タイマーを更新（解放したルームへ roster ブロードキャスト）:

```ts
  // ホストスロットのタイムアウト掃除
  const sweepTimer = setInterval(() => {
    for (const roomId of rooms.sweepHostTimeouts()) broadcastRoster(roomId);
  }, 10000);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run server/server.test.ts`
Expected: PASS（既存テストも含めて全緑）。

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/server.test.ts
git commit -m "feat(server): broadcast roster on join/leave/host changes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: popup-status.ts — ロスター描画（純粋関数）

**Files:**
- Modify: `extension/src/popup-status.ts`
- Test: `extension/src/popup.test.ts`

- [ ] **Step 1: Write the failing tests**

`extension/src/popup.test.ts` の import に追加し、テストを追記:

```ts
import {
  type ConnState,
  formatRosterLine,
  nextStateForServerEvent,
  renderStatusLabel,
  rosterHeader,
} from "./popup-status";
import type { RosterEntry } from "../../shared/protocol";

test("rosterHeader shows participant count", () => {
  const entries: RosterEntry[] = [
    { id: "a", name: "たろう", host: true, connected: true },
    { id: "b", name: "はなこ", host: false, connected: true },
  ];
  expect(rosterHeader(entries)).toBe("参加者 (2)");
});

test("formatRosterLine decorates host, self, and disconnected", () => {
  const host: RosterEntry = { id: "a", name: "たろう", host: true, connected: true };
  const me: RosterEntry = { id: "b", name: "はなこ", host: false, connected: true };
  const gone: RosterEntry = { id: "__host__", name: "じろう", host: true, connected: false };
  expect(formatRosterLine(host, "b")).toBe("👑 たろう");
  expect(formatRosterLine(me, "b")).toBe("はなこ (あなた)");
  expect(formatRosterLine(gone, "b")).toBe("👑 じろう (切断)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: FAIL — `rosterHeader` / `formatRosterLine` 未定義。

- [ ] **Step 3: Implement the pure functions**

`extension/src/popup-status.ts` の先頭に import を追加:

```ts
import type { RosterEntry } from "../../shared/protocol";
```

ファイル末尾に追加:

```ts
export function rosterHeader(entries: RosterEntry[]): string {
  return `参加者 (${entries.length})`;
}

/** ロスター1行の表示文字列。XSS回避のため呼び出し側は textContent で描画すること。 */
export function formatRosterLine(entry: RosterEntry, selfId: string | null): string {
  const crown = entry.host ? "👑 " : "";
  const you = selfId !== null && entry.id === selfId ? " (あなた)" : "";
  const offline = entry.connected ? "" : " (切断)";
  return `${crown}${entry.name}${you}${offline}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add extension/src/popup-status.ts extension/src/popup.test.ts
git commit -m "feat(popup): add rosterHeader and formatRosterLine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: content.ts — ロスター/selfId 保持・name 受け渡し

**Files:**
- Modify: `extension/src/content.ts`

> このファイルは chrome.* / DOM 依存でユニットテストが無い。検証は `pnpm tsc --noEmit` と `pnpm build:extension`、最終的に手動E2E（`docs/e2e-pseudo-host-testing.md`）で行う。

- [ ] **Step 1: Add imports and module state**

`extension/src/content.ts` の import に `RosterEntry` を追加:

```ts
import type { RosterEntry, ServerMessage, SyncEvent } from "../../shared/protocol";
```

`Session` インターフェースに `name` を追加し、モジュール状態に roster/selfId を追加:

```ts
interface Session {
  roomId: string;
  role: "host" | "participant";
  hostToken?: string;
  name?: string;
}
let started = false;
let currentStatus: ConnState = "idle";
let currentRoomId: string | null = null;
let currentRoster: RosterEntry[] = [];
let currentSelfId: string | null = null;
```

- [ ] **Step 2: Handle roster/joined/host_taken in `handleServer`**

`handleServer` の `switch` に、`case "state":` の後・`default:` の前へ以下を挿入:

```ts
      case "joined":
      case "host_taken": {
        currentSelfId = msg.clientId;
        const next = nextStateForServerEvent(msg.type);
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: msg.type }).catch(() => {});
        break;
      }
      case "roster":
        currentRoster = msg.participants;
        chrome.runtime
          .sendMessage({ type: "roster", participants: msg.participants, selfId: currentSelfId })
          .catch(() => {});
        break;
```

- [ ] **Step 3: Pass `name` on join (both host-rejoin and participant)**

`handleServer` の `case "created":` 内の host-join に `name` を追加:

```ts
        client.send({
          v: 1,
          type: "join",
          roomId: msg.roomId,
          role: "host",
          hostToken: msg.hostToken,
          name: session.name,
        });
```

`client.onOpen` の join 送信に `name` を追加:

```ts
  client.onOpen = () => {
    if (session.role === "host" && !session.hostToken) {
      client.send({ v: 1, type: "create" });
    } else {
      client.send({
        v: 1,
        type: "join",
        roomId: session.roomId,
        role: session.role,
        hostToken: session.hostToken,
        name: session.name,
      });
    }
  };
```

- [ ] **Step 4: Pass `name` from start_session and extend get_status**

末尾の `chrome.runtime.onMessage` リスナを更新:

```ts
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "start_session") {
    currentStatus = "connecting";
    void start({ roomId: msg.roomId, role: msg.role, name: msg.name });
    return;
  }
  if (msg?.type === "get_status") {
    sendResponse({
      status: currentStatus,
      roomId: currentRoomId,
      roster: currentRoster,
      selfId: currentSelfId,
    });
  }
});
```

- [ ] **Step 5: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: エラー無し。

- [ ] **Step 6: Commit**

```bash
git add extension/src/content.ts
git commit -m "feat(content): hold roster/selfId, forward to popup, send name on join

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: popup.html / popup.ts — 名前入力とロスター描画

**Files:**
- Modify: `extension/src/popup.html`
- Modify: `extension/src/popup.ts`

> popup.ts は DOM/chrome 依存でユニットテスト無し。描画ロジックは Task 6 の純粋関数でテスト済み。検証は tsc + build + 手動。

- [ ] **Step 1: Update popup.html**

`extension/src/popup.html` を以下に置き換え（名前入力欄・ロスター欄・`.offline` スタイルを追加）:

```html
<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><style>
    body { font: 14px sans-serif; width: 240px; padding: 12px; }
    input, button { width: 100%; margin: 4px 0; padding: 6px; box-sizing: border-box; }
    #status { margin-top: 8px; font-weight: bold; }
    #rosterHeader { margin-top: 10px; font-weight: bold; color: #444; }
    #roster div { padding: 2px 0; }
    #roster div.offline { color: #999; }
  </style></head>
  <body>
    <input id="name" placeholder="あなたの名前" />
    <input id="room" placeholder="ルームID（参加時）" />
    <button id="create">ルーム作成（ホスト）</button>
    <button id="join">参加（参加者）</button>
    <div id="roomId"></div>
    <div id="status">未接続</div>
    <div id="rosterHeader"></div>
    <div id="roster"></div>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Update popup.ts — imports, render helper, name persistence**

`extension/src/popup.ts` を以下に置き換え:

```ts
import type { RosterEntry } from "../../shared/protocol";
import {
  type ConnState,
  formatRosterLine,
  nextStateForServerEvent,
  renderStatusLabel,
  rosterHeader,
} from "./popup-status";

// biome-ignore lint/style/noNonNullAssertion: popup HTML elements are always present
const $ = (id: string) => document.getElementById(id)!;
const setStatus = (s: ConnState) => {
  $("status").textContent = renderStatusLabel(s);
};

function renderRoster(entries: RosterEntry[], selfId: string | null) {
  $("rosterHeader").textContent = entries.length ? rosterHeader(entries) : "";
  const list = $("roster");
  list.textContent = "";
  for (const e of entries) {
    const row = document.createElement("div");
    row.textContent = formatRosterLine(e, selfId);
    if (!e.connected) row.classList.add("offline");
    list.appendChild(row);
  }
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // biome-ignore lint/style/noNonNullAssertion: tab.id is always set for active tabs
  return tab.id!;
}

function nameValue(): string {
  return ($("name") as HTMLInputElement).value.trim();
}

$("create").addEventListener("click", async () => {
  const name = nameValue();
  await chrome.storage.local.set({ name });
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "host", name });
});

$("join").addEventListener("click", async () => {
  const roomId = ($("room") as HTMLInputElement).value.trim();
  if (!roomId) return;
  const name = nameValue();
  await chrome.storage.local.set({ name });
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), {
    type: "start_session",
    role: "participant",
    roomId,
    name,
  });
});

// popup は開くたびに作り直されるため、開いた瞬間に現在状態を復元する。
(async () => {
  const { name } = await chrome.storage.local.get("name");
  if (typeof name === "string") ($("name") as HTMLInputElement).value = name;
  try {
    const resp = await chrome.tabs.sendMessage(await activeTabId(), { type: "get_status" });
    if (resp?.roomId) $("roomId").textContent = `ルームID: ${resp.roomId}（共有してください）`;
    if (resp?.status) setStatus(resp.status);
    if (resp?.roster) renderRoster(resp.roster, resp.selfId ?? null);
  } catch {
    // content script 未注入（U-NEXTページでない等）→ 既定の「未接続」のまま
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "room_created") {
    $("roomId").textContent = `ルームID: ${msg.roomId}（共有してください）`;
    setStatus("connected");
    return;
  }
  if (msg?.type === "roster") {
    renderRoster(msg.participants, msg.selfId ?? null);
    return;
  }
  if (msg?.type !== "server_event") return;
  const next = nextStateForServerEvent(msg.event);
  if (next) setStatus(next);
});
```

- [ ] **Step 3: Verify types compile**

Run: `pnpm tsc --noEmit`
Expected: エラー無し。

- [ ] **Step 4: Commit**

```bash
git add extension/src/popup.html extension/src/popup.ts
git commit -m "feat(popup): name input with storage, render participant roster

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: 全体検証（型・lint・テスト・ビルド）

**Files:** なし（検証のみ）

- [ ] **Step 1: Type check**

Run: `pnpm tsc --noEmit`
Expected: エラー無し。

- [ ] **Step 2: Lint + format (CI モード)**

Run: `pnpm biome ci .`
Expected: エラー無し。差分が出たら `pnpm check:fix` で修正し、変更を `git add` してコミットに含める。

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: 全テスト PASS。

- [ ] **Step 4: Build both targets**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension && pnpm build:server`
Expected: どちらも成功（`dist/extension`・`dist/server.js` 生成）。

- [ ] **Step 5: Final commit if biome made changes**

```bash
git add -A
git commit -m "chore(roster): apply biome formatting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

（差分が無ければスキップ。）

---

## 完了の定義

- `pnpm tsc --noEmit` / `pnpm biome ci .` / `pnpm test` が全て緑。
- 拡張・サーバーの両ビルドが成功。
- spec の全要件（§3 データモデル・§4 プロトコル・§5 UI・§6 テスト・§8 不変条件）に対応するタスクが存在する。
- 実E2E（U-NEXT実機での名前表示・切断/復帰の見え方）は手動確認として残る（`docs/e2e-pseudo-host-testing.md` の擬似ホスト方式を流用）。
