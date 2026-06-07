# Cloudflare Workers + Durable Objects 移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WS リレーサーバーを Render Free（Node.js + `ws`）から Cloudflare Workers + Durable Objects（1ルーム=1 DO, WebSocket Hibernation）へ移行し、コールドスタートを排し無料枠で運用する。

**Architecture:** Worker をエッジ／ルーターにし、`POST /create` でルーム発行・`WS /r/<roomId>` を `idFromName(roomId)` の `RoomDurableObject` へ転送する。ルーム状態ロジックは `shared/rooms.ts` の**純粋リデューサ**（`(state, …) → {state, effects}`）に集約し、DO は load→reduce→effects適用→save の薄い殻に徹する。永続状態は `ctx.storage`、接続状態は WS attachment（hibernation 跨ぎで復元）。タイマーは DO Alarm（再武装あり）。

**Tech Stack:** TypeScript / Cloudflare Workers (`cloudflare:workers` DurableObject) / SQLite-backed DO storage / Wrangler / `@cloudflare/vitest-pool-workers` / vitest / pnpm / esbuild（拡張ビルド）。

**正典 spec:** `docs/superpowers/specs/2026-06-07-cloudflare-workers-do-migration-design.md`。食い違ったら spec を確認。

---

## ファイル構成（作成・変更・削除）

**作成:**
- `worker/src/index.ts` — Worker エントリ。認証（POST Authorization / WS subprotocol）・CORS・ルーティング・DO 転送。
- `worker/src/room-do.ts` — `RoomDurableObject`。WS 受理・storage I/O・effects 適用・alarm。
- `worker/index.test.ts` — DO 統合テスト（vitest-pool-workers, workerd 上）。
- `wrangler.jsonc` — DO バインディング＋SQLite migration＋compatibility_date。
- `worker/vitest.config.ts` — workers pool 用の vitest 設定。

**変更:**
- `shared/protocol.ts` — `PROTOCOL_VERSION` を 2 へ。`create`/`created` 型と parse 分岐を削除。`v: 1` リテラルを `PROTOCOL_VERSION` へ。
- `shared/secret.ts` — Workers でも動く `constantTimeEqual` を追加。
- `shared/rooms.ts` — `RoomManager`（複数ルーム）→単一ルーム純粋リデューサ `makeRoomLogic` ＋型・effects へ作り替え。
- `shared/protocol.test.ts` / `shared/secret.test.ts` — 上記に追従。
- `server/rooms.test.ts` → `shared/rooms.test.ts` 相当へ移植・拡充（effects ベース・roster 順序・re-arm）。
- `extension/src/config.ts` — `httpBaseFrom` 追加。
- `extension/src/content.ts` — host create を POST 化、WS URL に `/r/<roomId>`、`created` ケース削除、`onOpen` の create 分岐削除、`v: 1`→`PROTOCOL_VERSION`。
- `extension/src/ws-client.ts` / `sync-orchestrator.ts` — `v: 1`→`PROTOCOL_VERSION`。
- `extension/src/parse-server.ts` — TYPES から `created` 削除。
- `extension/manifest.json` — `host_permissions` に Worker ドメイン追加。
- `extension/build.mjs` — 既定 `SERVER_URL` を workers.dev へ。
- `extension/src/ws-client.test.ts` / `sync-orchestrator.test.ts` / `parse-server.test.ts` — version リテラル追従。
- `vitest.config.ts` — `worker/**` を exclude。
- `package.json` — scripts 更新（`build:server`/`dev:server`/`start` 削除、`deploy`/`dev:worker`/`test:worker` 追加）、devDeps 追加。
- `pnpm-workspace.yaml` — 新規 devDeps を `minimumReleaseAgeExclude`／`allowBuilds` に必要なら追加。
- `docs/e2e-pseudo-host-testing.md` — `ws://localhost:8080` を `wrangler dev` URL へ。
- `CLAUDE.md` — 構成記述を CF へ更新。

**削除:**
- `server/src/server.ts` / `server/src/auth.ts` / `server/server.test.ts` / `server/auth.test.ts` / `server/src/rooms.ts`（ロジックは `shared/rooms.ts` へ移設）/ `build-server.mjs`。

---

## Phase 0 — 依存とスキャフォールド

### Task 0: Cloudflare ツールチェーン導入

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`
- Create: `wrangler.jsonc`

- [ ] **Step 1: devDeps を追加**

Run:
```bash
pnpm add -D wrangler @cloudflare/workers-types @cloudflare/vitest-pool-workers
```
Expected: 追加成功。**`minimumReleaseAge`（1週間クールダウン）で弾かれた場合**は、エラーに出た `pkg@x.y.z` を `pnpm-workspace.yaml` の `minimumReleaseAgeExclude:` 配列へ追記して再実行する（既存の vitest 群と同じ運用）。`strictDepBuilds` で `workerd` 等のビルドが拒否されたら `allowBuilds:` に `workerd: true`（およびエラーに出た該当パッケージ）を追記して再実行。

- [ ] **Step 2: `wrangler.jsonc` を作成**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "unext-sync",
  "main": "worker/src/index.ts",
  "compatibility_date": "2026-01-01",
  "durable_objects": {
    "bindings": [{ "name": "ROOM", "class_name": "RoomDurableObject" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RoomDurableObject"] }
  ],
  "observability": { "enabled": true }
}
```
Note: `CONNECT_SECRET` は本番では `wrangler secret put`（Task 17）。テストでは worker/vitest.config.ts の bindings で注入する。

- [ ] **Step 3: 型参照を通す**

`tsconfig.json` の `types` に `@cloudflare/workers-types` を追加し、`include` に `worker` を追加する。

変更後の該当部分:
```json
    "types": ["node", "chrome", "@cloudflare/workers-types"]
```
```json
  "include": ["shared", "server", "extension", "worker"]
```

- [ ] **Step 4: コミット**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml wrangler.jsonc tsconfig.json
git commit -m "chore(cf): wrangler/workers-types/vitest-pool-workers と wrangler.jsonc を導入"
```

---

## Phase 1 — shared 純粋層（TDD・CF 不要・node で完結）

### Task 1: protocol.ts を v2 化し create/created を削除

**Files:**
- Modify: `shared/protocol.ts`, `shared/protocol.test.ts`

- [ ] **Step 1: テストを v2・create 無しへ更新（失敗させる）**

`shared/protocol.test.ts` を以下へ編集（差分の要点）:
- `test("PROTOCOL_VERSION is 1", …)` を:
```ts
test("PROTOCOL_VERSION is 2", () => {
  expect(PROTOCOL_VERSION).toBe(2);
});
```
- `test("parses create and join", …)` の **create アサーションを削除**し、join のみ残す。join 系の入力 `v: 1` は `v: 2` へ。例:
```ts
test("parses join", () => {
  expect(
    parseClientMessage(JSON.stringify({ v: 2, type: "join", roomId: "r", role: "host", hostToken: "t" })),
  ).toEqual({ v: 2, type: "join", roomId: "r", role: "host", hostToken: "t", name: undefined });
});
```
- `expect(parseClientMessage(JSON.stringify({ v: 2, type: "create" }))).toBeNull();` を「create は常に null」アサーションとして残す:
```ts
test("create is no longer a valid message", () => {
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "create" }))).toBeNull();
});
```
- その他テスト中の入力・期待値の `v: 1` を **すべて `v: 2`** に置換（sync/title/ping/join）。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: FAIL（PROTOCOL_VERSION が 1 のまま等）。

- [ ] **Step 3: protocol.ts を編集**

`shared/protocol.ts`:
- 1行目を `export const PROTOCOL_VERSION = 2;` に。
- `CreateMessage` interface と `ClientMessage` 合併からの `CreateMessage` を削除。
- `CreatedMessage` interface と `ServerMessage` 合併からの `CreatedMessage` を削除。
- `parseClientMessage` の `case "create":` 節を削除。
- `parseClientMessage` 内の戻り値リテラル `v: 1` をすべて `v: PROTOCOL_VERSION` へ置換（join/sync/title/ping の4箇所）。

`ClientMessage` は:
```ts
export type ClientMessage = JoinMessage | SyncMessage | PingMessage | TitleMessage;
```
`ServerMessage` は `CreatedMessage` を除いた合併にする。

- [ ] **Step 4: 通過を確認**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(protocol): PROTOCOL_VERSION を 2 へ bump し create/created を削除"
```

### Task 2: shared/secret.ts に portable な constantTimeEqual を追加

**Files:**
- Modify: `shared/secret.ts`, `shared/secret.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`shared/secret.test.ts` に追記:
```ts
import { constantTimeEqual } from "./secret";

test("constantTimeEqual: equal token-safe strings match", () => {
  expect(constantTimeEqual("abc123", "abc123")).toBe(true);
});
test("constantTimeEqual: different strings do not match", () => {
  expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false); // 長さ違い
});
test("constantTimeEqual: non-token-safe presented is rejected", () => {
  expect(constantTimeEqual("ab+c", "ab+c")).toBe(false);
  expect(constantTimeEqual("", "x")).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run shared/secret.test.ts`
Expected: FAIL（constantTimeEqual 未定義）。

- [ ] **Step 3: secret.ts に実装を追加**

`shared/secret.ts` に追記（`TextEncoder` は Node/Workers 共通のグローバル。node:crypto に依存しない）:
```ts
/** Node/Workers 共通の定数時間比較。presented が非 token-safe／長さ不一致なら false。 */
export function constantTimeEqual(presented: string, expected: string): boolean {
  if (!isTokenSafe(presented)) return false;
  const enc = new TextEncoder();
  const a = enc.encode(presented);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

- [ ] **Step 4: 通過を確認**

Run: `pnpm vitest run shared/secret.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add shared/secret.ts shared/secret.test.ts
git commit -m "feat(secret): Workers 互換の constantTimeEqual を追加"
```

### Task 3: rooms.ts 純粋リデューサ — 型・freshPersistent・正規化・rosterOf

**Files:**
- Create: `shared/rooms.ts`（`server/src/rooms.ts` の正規化ロジックを移設）
- Create: `shared/rooms.test.ts`

- [ ] **Step 1: roster 順序のテストを書く（失敗させる）**

`shared/rooms.test.ts`:
```ts
import { beforeEach, expect, test } from "vitest";
import { freshPersistent, makeRoomLogic, normalizeName, normalizeText, type RoomState } from "./rooms";

let nowVal = 1000;
const deps = {
  now: () => nowVal,
  genToken: () => "tok",
  genGuestSuffix: () => "abcd",
  hostTimeoutMs: 60000,
};
const logic = makeRoomLogic(deps);

function emptyRoom(hostToken = "tok"): RoomState {
  return { persistent: freshPersistent(hostToken), clients: new Map() };
}

beforeEach(() => {
  nowVal = 1000;
});

test("rosterOf: host first, participants sorted by joinedAt (not insertion)", () => {
  const st = emptyRoom();
  logic.applyJoin(st, "c1", 5, "host", "tok", "host");
  logic.applyJoin(st, "c2", 2, "participant", undefined, "B");
  logic.applyJoin(st, "c3", 8, "participant", undefined, "A");
  expect(logic.rosterOf(st).map((e) => e.id)).toEqual(["c1", "c2", "c3"]);
});

test("normalizeName trims, strips control chars, truncates", () => {
  expect(normalizeName("  たろう  ")).toBe("たろう");
  expect(normalizeName("ab\x7fcd")).toBe("abcd");
  expect(normalizeName("あ".repeat(40))).toBe("あ".repeat(24));
});

test("normalizeText truncates by code point", () => {
  expect(normalizeText("😀".repeat(200), 120)).toBe("😀".repeat(120));
  expect(normalizeText(42, 120)).toBe("");
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run shared/rooms.test.ts`
Expected: FAIL（`./rooms` 未作成）。

- [ ] **Step 3: shared/rooms.ts の土台を実装**

```ts
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
```

- [ ] **Step 4: 通過を確認**

Run: `pnpm vitest run shared/rooms.test.ts`
Expected: PASS（roster 順序・normalize）。

- [ ] **Step 5: コミット**

```bash
git add shared/rooms.ts shared/rooms.test.ts
git commit -m "feat(rooms): 単一ルーム純粋リデューサの土台（型・effects・rosterOf）"
```

### Task 4: applyJoin の振る舞いテスト（effects/attachment/lastState/host_taken）

**Files:**
- Modify: `shared/rooms.test.ts`

- [ ] **Step 1: テストを追加**

```ts
test("applyJoin host: sets hostId, emits setAttachment(joined,isHost) and joined", () => {
  const st = emptyRoom("tok");
  const r = logic.applyJoin(st, "c1", 1, "host", "tok", "たろう");
  expect(r.outcome).toBe("joined-host");
  expect(r.state.persistent.hostId).toBe("c1");
  expect(r.effects).toContainEqual({
    kind: "setAttachment",
    clientId: "c1",
    attachment: { clientId: "c1", name: "たろう", isHost: true, joined: true, joinedAt: 1 },
  });
  expect(r.effects).toContainEqual({
    kind: "send",
    to: "c1",
    msg: { v: 2, type: "joined", role: "host", clientId: "c1" },
  });
});

test("applyJoin host with wrong token falls back to host_taken", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  const r = logic.applyJoin(st, "c2", 2, "host", "WRONG");
  expect(r.outcome).toBe("host_taken");
  expect(r.effects).toContainEqual({ kind: "send", to: "c2", msg: { v: 2, type: "host_taken", clientId: "c2" } });
});

test("applyJoin participant gets lastState and contentKey", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applySync(st, "c1", {
    v: 2, type: "sync", event: "heartbeat", playing: true, currentTime: 11, playbackRate: 1, seq: 1,
    contentKey: "SID0234926/ED00720092",
  });
  const r = logic.applyJoin(st, "c2", 2, "participant");
  expect(r.outcome).toBe("joined-participant");
  const sent = r.effects.find((e) => e.kind === "send" && e.to === "c2" && e.msg.type === "state");
  expect(sent && sent.kind === "send" && sent.msg.type === "state" && sent.msg.contentKey).toBe("SID0234926/ED00720092");
});

test("applyJoin empty name yields ゲスト- guest name", () => {
  const st = emptyRoom("tok");
  const r = logic.applyJoin(st, "c1", 1, "participant", undefined, "");
  expect(r.state.clients.get("c1")?.name).toBe("ゲスト-abcd");
});

test("applyJoin always broadcasts roster", () => {
  const st = emptyRoom("tok");
  const r = logic.applyJoin(st, "c1", 1, "host", "tok", "た");
  expect(r.effects.some((e) => e.kind === "broadcast" && e.msg.type === "roster")).toBe(true);
});
```

- [ ] **Step 2: 実行（土台実装で通るはず）**

Run: `pnpm vitest run shared/rooms.test.ts`
Expected: PASS（Task 3 の実装で満たす）。失敗時は実装を修正。

- [ ] **Step 3: コミット**

```bash
git add shared/rooms.test.ts
git commit -m "test(rooms): applyJoin の effects/attachment/lastState/host_taken を検証"
```

### Task 5: applySync / applyTitle の振る舞いテスト

**Files:**
- Modify: `shared/rooms.test.ts`

- [ ] **Step 1: テストを追加**

```ts
function syncMsg(seq: number) {
  return { v: 2 as const, type: "sync" as const, event: "heartbeat" as const, playing: true, currentTime: 10 + seq, playbackRate: 1, seq };
}

test("applySync from host broadcasts state excluding host, stores lastState", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applyJoin(st, "c2", 2, "participant");
  const r = logic.applySync(st, "c1", syncMsg(1));
  expect(r.effects).toEqual([{ kind: "broadcast", exclude: "c1", msg: { v: 2, type: "state", event: "heartbeat", playing: true, currentTime: 11, playbackRate: 1, seq: 1, contentKey: undefined } }]);
  expect(r.state.persistent.lastState?.seq).toBe(1);
});

test("applySync from non-host is ignored", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applyJoin(st, "c2", 2, "participant");
  expect(logic.applySync(st, "c2", syncMsg(1)).effects).toEqual([]);
});

test("applyTitle: only host, normalized, idempotent, rejects empty", () => {
  const st = emptyRoom("tok");
  logic.applyJoin(st, "c1", 1, "host", "tok");
  logic.applyJoin(st, "c2", 2, "participant");
  expect(logic.applyTitle(st, "c2", "作品名").effects).toEqual([]); // 非ホスト
  const r = logic.applyTitle(st, "c1", "  作品名 第3話  ");
  expect(r.effects).toEqual([{ kind: "broadcast", msg: { v: 2, type: "room_title", title: "作品名 第3話" } }]);
  expect(logic.applyTitle(st, "c1", "作品名 第3話").effects).toEqual([]); // 同値
  expect(logic.applyTitle(st, "c1", "   ").effects).toEqual([]); // 空
});
```

- [ ] **Step 2: 実行**

Run: `pnpm vitest run shared/rooms.test.ts`
Expected: PASS

- [ ] **Step 3: コミット**

```bash
git add shared/rooms.test.ts
git commit -m "test(rooms): applySync/applyTitle の振る舞いを検証"
```

### Task 6: removeClient / sweepTimers の re-arm テスト（最重要）

**Files:**
- Modify: `shared/rooms.test.ts`

- [ ] **Step 1: テストを追加**

```ts
test("removeClient(host) emits host_disconnected, roster, alarm at host deadline", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.applyJoin(st, "p", 2, "participant");
  const r = logic.removeClient(st, "h");
  expect(r.effects).toContainEqual({ kind: "broadcast", msg: { v: 2, type: "host_disconnected" } });
  expect(r.effects).toContainEqual({ kind: "setAlarm", at: 61000 });
  expect(r.state.persistent.hostId).toBeNull();
});

test("host reconnect within hold reclaims slot", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.removeClient(st, "h");
  nowVal = 31000; // < 60s
  const r = logic.applyJoin(st, "h2", 3, "host", "tok");
  expect(r.outcome).toBe("joined-host");
});

test("sweepTimers re-arms when host deadline fires but empty cleanup remains", () => {
  // host 切断 t=1000 → host 締切 61000
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok");
  logic.applyJoin(st, "p", 2, "participant");
  logic.removeClient(st, "h");
  // 参加者退出 t=40000 → emptiedAt=40000（空締切 100000）。最早は host 61000。
  nowVal = 40000;
  const rm = logic.removeClient(st, "p");
  expect(rm.effects).toContainEqual({ kind: "setAlarm", at: 61000 });
  // t=61001: host 解放、空締切(100000)は未到来 → clearStorage せず 100000 へ再武装
  const sw1 = logic.sweepTimers(st, 61001);
  expect(sw1.effects.some((e) => e.kind === "clearStorage")).toBe(false);
  expect(sw1.effects).toContainEqual({ kind: "setAlarm", at: 100000 });
  expect(sw1.state.persistent.hostDisconnectedAt).toBeNull();
  expect(sw1.effects.some((e) => e.kind === "broadcast" && e.msg.type === "roster")).toBe(true);
  // t=100001: 空掃除 → clearStorage
  const sw2 = logic.sweepTimers(st, 100001);
  expect(sw2.effects).toEqual([{ kind: "clearStorage" }]);
});

test("rosterOf shows synthetic disconnected host row during hold, dropped after sweep", () => {
  nowVal = 1000;
  const st = emptyRoom("tok");
  logic.applyJoin(st, "h", 1, "host", "tok", "たろう");
  logic.applyJoin(st, "p", 2, "participant", undefined, "はなこ");
  logic.removeClient(st, "h");
  expect(logic.rosterOf(st)[0]).toEqual({ id: "__host__", name: "たろう", host: true, connected: false });
  logic.sweepTimers(st, 61001);
  expect(logic.rosterOf(st).some((e) => e.host)).toBe(false);
});
```

- [ ] **Step 2: 実行**

Run: `pnpm vitest run shared/rooms.test.ts`
Expected: PASS。失敗（特に re-arm）時は `sweepTimers`/`earliestDeadline` を仕様（§5.1）どおりに修正。

- [ ] **Step 3: 型チェックと全テスト**

Run: `pnpm tsc --noEmit && pnpm vitest run shared/`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add shared/rooms.test.ts
git commit -m "test(rooms): removeClient/sweepTimers の re-arm と host hold を検証"
```

### Task 7: 旧 server ディレクトリと旧テストを撤去

**Files:**
- Delete: `server/src/server.ts`, `server/src/auth.ts`, `server/src/rooms.ts`, `server/server.test.ts`, `server/auth.test.ts`, `server/rooms.test.ts`, `build-server.mjs`

- [ ] **Step 1: 削除**

Run:
```bash
git rm server/src/server.ts server/src/auth.ts server/src/rooms.ts \
       server/server.test.ts server/auth.test.ts server/rooms.test.ts build-server.mjs
```
（`server/` 配下が空になる場合はディレクトリごと消える。）

- [ ] **Step 2: 残参照がないか確認**

Run: `grep -rn "server/src/\|build-server\|RoomManager" --include=*.ts --include=*.mjs --include=*.json . | grep -v node_modules`
Expected: 出力なし（あれば後続 Task で潰す対象。`package.json` scripts は Task 16 で更新）。

- [ ] **Step 3: 全テスト（残りが通ること）**

Run: `pnpm vitest run`
Expected: PASS（`worker/` テストはまだ無い）。

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "refactor(server): Node ws ランタイムと旧テストを撤去（ロジックは shared/rooms へ移設済み）"
```

---

## Phase 2 — Cloudflare Worker + Durable Object

### Task 8: RoomDurableObject を実装

**Files:**
- Create: `worker/src/room-do.ts`

- [ ] **Step 1: room-do.ts を作成**

```ts
import { DurableObject } from "cloudflare:workers";
import { PROTOCOL_VERSION, parseClientMessage } from "../../shared/protocol";
import {
  type Attachment,
  type ClientInfo,
  type Effect,
  type PersistentState,
  type RoomState,
  freshPersistent,
  makeRoomLogic,
} from "../../shared/rooms";

const HOST_TIMEOUT_MS = 60_000;
const KEY_P = "p";
const KEY_SEQ = "seq";

export class RoomDurableObject extends DurableObject {
  private logic() {
    return makeRoomLogic({
      now: () => Date.now(),
      genToken: () => crypto.randomUUID(),
      genGuestSuffix: () => crypto.randomUUID().slice(0, 4),
      hostTimeoutMs: HOST_TIMEOUT_MS,
    });
  }

  private async loadPersistent(): Promise<PersistentState | null> {
    return (await this.ctx.storage.get<PersistentState>(KEY_P)) ?? null;
  }

  private async hydrate(exclude?: string): Promise<RoomState | null> {
    const persistent = await this.loadPersistent();
    if (!persistent) return null;
    const clients = new Map<string, ClientInfo>();
    for (const sock of this.ctx.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a && a.joined && a.clientId !== exclude) clients.set(a.clientId, { name: a.name, joinedAt: a.joinedAt });
    }
    return { persistent, clients };
  }

  private socketOf(clientId: string): WebSocket | undefined {
    for (const sock of this.ctx.getWebSockets()) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a?.clientId === clientId) return sock;
    }
    return undefined;
  }

  private async maybeSetAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  private applyEffects(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case "send": {
          const sock = this.socketOf(e.to);
          if (sock) sock.send(JSON.stringify(e.msg));
          break;
        }
        case "broadcast": {
          for (const sock of this.ctx.getWebSockets()) {
            const a = sock.deserializeAttachment() as Attachment | null;
            if (!a || !a.joined) continue;
            if (e.exclude && a.clientId === e.exclude) continue;
            sock.send(JSON.stringify(e.msg));
          }
          break;
        }
        case "setAttachment": {
          const sock = this.socketOf(e.clientId);
          if (sock) sock.serializeAttachment(e.attachment);
          break;
        }
        case "setAlarm":
          void this.maybeSetAlarm(e.at);
          break;
        case "clearStorage":
          // persist 側で deleteAll するためここでは何もしない
          break;
      }
    }
  }

  private async commit(result: { state: RoomState; effects: Effect[] }): Promise<void> {
    const hasClear = result.effects.some((e) => e.kind === "clearStorage");
    if (!hasClear) await this.ctx.storage.put(KEY_P, result.state.persistent);
    this.applyEffects(result.effects);
    if (hasClear) await this.ctx.storage.deleteAll();
  }

  private async nextJoinSeq(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>(KEY_SEQ)) ?? 0) + 1;
    await this.ctx.storage.put(KEY_SEQ, n);
    return n;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ルーム初期化（Worker からのみ呼ばれる）。衝突は 409。
    if (request.method === "POST" && url.pathname === "/__init") {
      if (await this.loadPersistent()) return new Response("exists", { status: 409 });
      const hostToken = crypto.randomUUID();
      await this.ctx.storage.put(KEY_P, freshPersistent(hostToken));
      return Response.json({ hostToken });
    }

    // WS upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const proto = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",")[0]?.trim();
      const headers: Record<string, string> = {};
      if (proto) headers["Sec-WebSocket-Protocol"] = proto;

      const persistent = await this.loadPersistent();
      this.ctx.acceptWebSocket(server);
      if (!persistent) {
        server.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "no_room" }));
        server.close(1000, "no_room");
        return new Response(null, { status: 101, webSocket: client, headers });
      }
      const clientId = crypto.randomUUID();
      const joinedAt = await this.nextJoinSeq();
      const att: Attachment = { clientId, name: "", isHost: false, joined: false, joinedAt };
      server.serializeAttachment(att);
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const msg = parseClientMessage(raw);
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!msg || !att) return;
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "pong", id: msg.id }));
      return;
    }
    const state = await this.hydrate();
    if (!state) return;
    const logic = this.logic();
    if (msg.type === "join") {
      await this.commit(logic.applyJoin(state, att.clientId, att.joinedAt, msg.role, msg.hostToken, msg.name));
    } else if (msg.type === "sync") {
      await this.commit(logic.applySync(state, att.clientId, msg));
    } else if (msg.type === "title") {
      await this.commit(logic.applyTitle(state, att.clientId, msg.title));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const state = await this.hydrate(att.clientId);
    if (!state) return;
    await this.commit(this.logic().removeClient(state, att.clientId));
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const state = await this.hydrate();
    if (!state) return;
    await this.commit(this.logic().sweepTimers(state, Date.now()));
  }
}
```

- [ ] **Step 2: 型チェック**

Run: `pnpm tsc --noEmit`
Expected: PASS（`@cloudflare/workers-types` で `WebSocketPair`/`DurableObject`/`crypto` が解決）。失敗時は tsconfig の types/include（Task 0）を確認。

- [ ] **Step 3: コミット**

```bash
git add worker/src/room-do.ts
git commit -m "feat(do): RoomDurableObject（acceptWebSocket/storage/effects/alarm）"
```

### Task 9: Worker エントリ（認証・CORS・ルーティング）

**Files:**
- Create: `worker/src/index.ts`

- [ ] **Step 1: index.ts を作成**

```ts
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
      const presented = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",")[0]?.trim() ?? "";
      if (!constantTimeEqual(presented, env.CONNECT_SECRET)) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
```

- [ ] **Step 2: 型チェック**

Run: `pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 3: ローカル起動で疎通（手動・任意）**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm wrangler dev`
別端末で `curl -s -X POST -H "Authorization: Bearer <同じ値>" http://localhost:8787/create`（`wrangler dev` のローカル secret は `.dev.vars` でも可）。Expected: `{"roomId":"...","hostToken":"..."}`。確認後 Ctrl-C。

- [ ] **Step 4: コミット**

```bash
git add worker/src/index.ts
git commit -m "feat(worker): エントリ（認証/CORS/POST create/WS ルーティング/DO 転送）"
```

### Task 10: DO 統合テスト（vitest-pool-workers）

**Files:**
- Create: `worker/vitest.config.ts`, `worker/index.test.ts`
- Modify: `vitest.config.ts`（root: worker を exclude）, `package.json`（test:worker）

- [ ] **Step 1: root vitest が worker を拾わないよう exclude**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "worker/**"],
  },
});
```

- [ ] **Step 2: worker 用 vitest 設定**

`worker/vitest.config.ts`:
```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker/**/*.test.ts"],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2026-01-01",
          bindings: { CONNECT_SECRET: "0123456789abcdef0123456789abcdef" },
        },
        wrangler: { configPath: "../wrangler.jsonc" },
      },
    },
  },
});
```

- [ ] **Step 3: 統合テストを書く（失敗させる）**

`worker/index.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const SECRET = "0123456789abcdef0123456789abcdef";

async function openWs(roomId: string) {
  const res = await SELF.fetch(`https://x/r/${roomId}`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": SECRET },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  const messages: any[] = [];
  ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
  return { ws, messages };
}

it("create → host join → participant join receives lastState; sync broadcasts", async () => {
  const create = await SELF.fetch("https://x/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  expect(create.status).toBe(200);
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();

  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken, name: "host" }));
  await vi.waitFor(() => expect(host.messages.some((m) => m.type === "joined" && m.role === "host")).toBe(true));

  host.ws.send(JSON.stringify({ v: 2, type: "sync", event: "heartbeat", playing: true, currentTime: 42, playbackRate: 1, seq: 1 }));

  const part = await openWs(roomId);
  part.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "participant", name: "p" }));
  await vi.waitFor(() => {
    expect(part.messages.some((m) => m.type === "joined")).toBe(true);
    expect(part.messages.some((m) => m.type === "state" && m.currentTime === 42)).toBe(true);
  });

  // 以降の host sync は participant に届く
  host.ws.send(JSON.stringify({ v: 2, type: "sync", event: "seek", playing: true, currentTime: 99, playbackRate: 1, seq: 2 }));
  await vi.waitFor(() => expect(part.messages.some((m) => m.type === "state" && m.currentTime === 99)).toBe(true));
});

it("join into unknown room returns no_room", async () => {
  const part = await openWs("doesnotexist");
  part.ws.send(JSON.stringify({ v: 2, type: "join", roomId: "doesnotexist", role: "participant" }));
  await vi.waitFor(() => expect(part.messages.some((m) => m.type === "no_room")).toBe(true));
});

it("POST /create without secret is unauthorized", async () => {
  const res = await SELF.fetch("https://x/create", { method: "POST" });
  expect(res.status).toBe(401);
});

it("ping is echoed as pong with same id", async () => {
  const create = await SELF.fetch("https://x/create", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
  const { roomId, hostToken } = await create.json<{ roomId: string; hostToken: string }>();
  const host = await openWs(roomId);
  host.ws.send(JSON.stringify({ v: 2, type: "join", roomId, role: "host", hostToken }));
  host.ws.send(JSON.stringify({ v: 2, type: "ping", id: 7 }));
  await vi.waitFor(() => expect(host.messages.some((m) => m.type === "pong" && m.id === 7)).toBe(true));
});
```

- [ ] **Step 4: スクリプト追加と実行**

`package.json` の scripts に追加: `"test:worker": "vitest run -c worker/vitest.config.ts"`。

Run: `pnpm test:worker`
Expected: 最初は設定/実装の不整合で FAIL しうる。エラーに応じて `wrangler.jsonc`／`worker/vitest.config.ts`／`room-do.ts` を修正し、全 it が PASS するまで回す。

- [ ] **Step 5: コミット**

```bash
git add worker/vitest.config.ts worker/index.test.ts vitest.config.ts package.json
git commit -m "test(worker): DO 統合テスト（create/join/sync/no_room/ping）"
```

---

## Phase 3 — 拡張側の配線

### Task 11: config.ts に httpBaseFrom を追加

**Files:**
- Modify: `extension/src/config.ts`
- Create: `extension/src/config.test.ts`

- [ ] **Step 1: テストを書く（失敗させる）**

`extension/src/config.test.ts`:
```ts
import { expect, test } from "vitest";
import { httpBaseFrom } from "./config";

test("httpBaseFrom maps wss→https and ws→http", () => {
  expect(httpBaseFrom("wss://unext-sync.example.workers.dev")).toBe("https://unext-sync.example.workers.dev");
  expect(httpBaseFrom("ws://localhost:8787")).toBe("http://localhost:8787");
});
```
Note: `config.ts` は `__SERVER_URL__`/`__CONNECT_SECRET__` を参照するため import 時に `declare const` の未定義で実行時 throw する。テストは関数のみ検証したいので、`httpBaseFrom` を**副作用のない純粋関数として** export し、`config.ts` 冒頭の検証は `httpBaseFrom` 定義より後段に置く（下記実装で担保）。それでも import 時評価が問題になる場合は、関数を `shared/server-url.ts` に置いてそこからテストする。**まず config.ts 内 export で試し、import エラーになったら server-url.ts へ移す**こと。

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run extension/src/config.test.ts`
Expected: FAIL（httpBaseFrom 未定義）。

- [ ] **Step 3: 実装**

`extension/src/config.ts` の先頭付近（`import` 直後、`__SERVER_URL__` 検証より前）に追加:
```ts
/** ws(s):// を http(s):// へ写像する（POST /create 用のベース URL 導出）。 */
export function httpBaseFrom(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}
```

- [ ] **Step 4: 通過を確認**

Run: `pnpm vitest run extension/src/config.test.ts`
Expected: PASS。import 時 throw で落ちる場合は Step 1 の注記どおり `shared/server-url.ts` へ移設し、テストの import 元を変更して再実行。

- [ ] **Step 5: コミット**

```bash
git add extension/src/config.ts extension/src/config.test.ts
git commit -m "feat(config): httpBaseFrom で POST /create 用 URL を導出"
```

### Task 12: client 側メッセージの v リテラルを PROTOCOL_VERSION へ

**Files:**
- Modify: `extension/src/ws-client.ts`, `extension/src/sync-orchestrator.ts`, `extension/src/ws-client.test.ts`, `extension/src/sync-orchestrator.test.ts`

- [ ] **Step 1: テストの version 期待値を 2 へ**

`extension/src/ws-client.test.ts`:
- `sockets[0].emit({ v: 1, type: "joined", role: "host" });` と直後の `toHaveBeenCalledWith({ v: 1, … })` を `v: 2` に。
- `sockets[0].emit({ v: 1, type: "pong", id: 1 });` を `v: 2` に。

`extension/src/sync-orchestrator.test.ts`: `v: 1` を含む sync/state リテラルを `v: 2` に（`grep -n "v: 1" extension/src/sync-orchestrator.test.ts` で全箇所を確認して置換）。

- [ ] **Step 2: 実装の送信リテラルを置換**

`extension/src/ws-client.ts`: 先頭 import に `PROTOCOL_VERSION` を追加し、`sendPing` の `{ v: 1, … }` を `{ v: PROTOCOL_VERSION, … }` へ。
```ts
import { type ClientMessage, PROTOCOL_VERSION, type ServerMessage } from "../../shared/protocol";
```
```ts
    this.send({ v: PROTOCOL_VERSION, type: "ping", id });
```
`extension/src/sync-orchestrator.ts`: 先頭で `PROTOCOL_VERSION` を import し、`v: 1` の送信リテラル（45行付近の sync 構築）を `v: PROTOCOL_VERSION` へ。

- [ ] **Step 3: テスト**

Run: `pnpm vitest run extension/src/ws-client.test.ts extension/src/sync-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 4: コミット**

```bash
git add extension/src/ws-client.ts extension/src/sync-orchestrator.ts extension/src/ws-client.test.ts extension/src/sync-orchestrator.test.ts
git commit -m "refactor(extension): client メッセージの version を PROTOCOL_VERSION に統一"
```

### Task 13: parse-server.ts から created を削除

**Files:**
- Modify: `extension/src/parse-server.ts`, `extension/src/parse-server.test.ts`

- [ ] **Step 1: テストを v2 化し created 非対応を明示**

`extension/src/parse-server.test.ts`:
- 全テストの入力 `v: 1` を `v: 2` に。
- `rejects unknown type and wrong version` の `{ v: 2, type: "roster" }` は今や有効なので、誤バージョン例を `{ v: 1, type: "roster" }` に変更:
```ts
test("rejects unknown type and wrong version", () => {
  expect(parseServerMessageLoose(JSON.stringify({ v: 2, type: "bogus" }))).toBeNull();
  expect(parseServerMessageLoose(JSON.stringify({ v: 1, type: "roster" }))).toBeNull();
  expect(parseServerMessageLoose("not json")).toBeNull();
});
```
- 追加:
```ts
test("created is no longer accepted", () => {
  expect(parseServerMessageLoose(JSON.stringify({ v: 2, type: "created", roomId: "r", hostToken: "t" }))).toBeNull();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run extension/src/parse-server.test.ts`
Expected: FAIL（created がまだ許可されている／version 不一致）。

- [ ] **Step 3: TYPES から created を削除**

`extension/src/parse-server.ts` の `TYPES` Set から `"created",` 行を削除。

- [ ] **Step 4: 通過を確認**

Run: `pnpm vitest run extension/src/parse-server.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add extension/src/parse-server.ts extension/src/parse-server.test.ts
git commit -m "refactor(parse-server): created を allowlist から削除（v2）"
```

### Task 14: content.ts — host create を POST 化、WS URL に roomId

**Files:**
- Modify: `extension/src/content.ts`

- [ ] **Step 1: import に PROTOCOL_VERSION と httpBaseFrom を追加**

1行目付近を:
```ts
import { PROTOCOL_VERSION, type RosterEntry, type ServerMessage, type SyncEvent } from "../../shared/protocol";
```
3行目を:
```ts
import { CONNECT_SECRET, httpBaseFrom, SERVER_URL } from "./config";
```

- [ ] **Step 2: `makeBrowserSocket` を `/r/<roomId>` 接続にし、factory を更新**

`makeBrowserSocket(SERVER_URL)` 呼び出し（85行付近）を、`session.roomId` を載せた URL に変更:
```ts
  let orchestrator: SyncOrchestrator;
  const roomUrl = () => `${SERVER_URL}/r/${session.roomId}`;
  const client = new WsClient(roomUrl(), {
    factory: () => makeBrowserSocket(roomUrl()),
    onMessage: (msg: ServerMessage) => handleServer(msg),
  });
```
（`makeBrowserSocket` 本体は引数 `url` をそのまま使うので変更不要。）

- [ ] **Step 3: host create を POST 化（onOpen の create 分岐を削除）**

`handleServer` の `case "created":`（91〜106行）を**丸ごと削除**する。

`client.onOpen`（179〜192行）を、create 分岐なしの join 一本に置換:
```ts
  client.onOpen = () => {
    client.send({
      v: PROTOCOL_VERSION,
      type: "join",
      roomId: session.roomId,
      role: session.role,
      hostToken: session.hostToken,
      name: session.name,
    });
  };
```

`start()` 内、`client.connect();`（193行付近）の**直前**に、ホストの事前 create を挿入:
```ts
  // ホスト（トークン未保持）はまず HTTP でルームを発行してから WS 接続する。
  if (session.role === "host" && !session.hostToken) {
    try {
      const res = await fetch(`${httpBaseFrom(SERVER_URL)}/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CONNECT_SECRET}` },
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      const data = (await res.json()) as { roomId: string; hostToken: string };
      session.roomId = data.roomId;
      session.hostToken = data.hostToken;
      currentRoomId = data.roomId;
      chrome.runtime.sendMessage({ type: "room_created", roomId: data.roomId }).catch(() => {});
    } catch {
      currentStatus = "disconnected";
      chrome.runtime.sendMessage({ type: "server_event", event: "host_disconnected" }).catch(() => {});
      return;
    }
  }
  client.connect();
```
Note: create は接続前に行うため `roomUrl()` は `session.roomId` 確定後に評価される（factory は接続時に呼ばれる）。`makeBrowserSocket`/`WsClient` の定義は据え置きでよい。

- [ ] **Step 4: 残った v: 1 リテラルを置換**

`client.send({ v: 1, type: "title", … })`（152行付近）を `v: PROTOCOL_VERSION` に。`grep -n "v: 1" extension/src/content.ts` で他に残っていないか確認し全て `PROTOCOL_VERSION` へ。

- [ ] **Step 5: 型チェックと拡張テスト**

Run: `pnpm tsc --noEmit && pnpm vitest run extension/`
Expected: PASS（content.ts に直接の unit テストは無いが型と既存テストが通ること）。

- [ ] **Step 6: コミット**

```bash
git add extension/src/content.ts
git commit -m "feat(content): host create を POST /create 化、WS を /r/<roomId> へ"
```

### Task 15: manifest と build.mjs を CF 向けに更新

**Files:**
- Modify: `extension/manifest.json`, `extension/build.mjs`

- [ ] **Step 1: manifest に Worker ドメインの host_permissions を追加**

`extension/manifest.json` の `host_permissions` を更新（`<subdomain>` は Task 17 で確定する実値に後で差し替え。ここでは workers.dev 既定に合わせる）:
```json
  "host_permissions": ["https://video.unext.jp/*", "https://unext-sync.<subdomain>.workers.dev/*"],
```
Note: WS 接続（content script 発）は page CSP/CORS の対象外で host_permissions も不要だが、`POST /create`（fetch）はクロスオリジンのため Worker ドメインを host_permissions に入れて content script の特権 fetch を許可する。MV3 既定の extension_pages CSP は connect-src を制限しないため CSP キーの追加は不要。

- [ ] **Step 2: build.mjs の既定 SERVER_URL を workers.dev へ**

`extension/build.mjs`（注: ファイルはリポジトリ直下 `build.mjs`）の既定 URL 行を変更:
```js
const serverUrl = process.env.SERVER_URL ?? "wss://unext-sync.<subdomain>.workers.dev";
```
（`<subdomain>` は Task 17 で実 deploy 後に確定値へ差し替える。）

- [ ] **Step 3: ビルド検証（ローカル）**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) SERVER_URL=ws://localhost:8787 pnpm build:extension`
Expected: `extension built -> dist/extension`。`__SERVER_URL__`/`__CONNECT_SECRET__` が埋め込まれること。

- [ ] **Step 4: コミット**

```bash
git add extension/manifest.json build.mjs
git commit -m "chore(extension): host_permissions と既定 SERVER_URL を CF 向けに更新"
```

### Task 16: package.json scripts を CF ランタイムへ更新

**Files:**
- Modify: `package.json`

- [ ] **Step 1: scripts を更新**

`build:server` / `dev:server` / `start` を削除し、以下を追加:
```json
    "build:server": "echo 'server runs on Cloudflare Workers; use pnpm deploy' && exit 1",
    "dev:worker": "wrangler dev",
    "deploy": "wrangler deploy",
    "test:worker": "vitest run -c worker/vitest.config.ts",
    "test": "vitest run && vitest run -c worker/vitest.config.ts",
```
Note: `build:server` は誤実行防止のスタブにする（完全削除でも可）。`dev:server`/`start` は削除。`test` は node 群と worker 群の両方を実行する。

- [ ] **Step 2: 全テスト**

Run: `pnpm test`
Expected: PASS（shared/extension は node、worker は workers pool）。

- [ ] **Step 3: コミット**

```bash
git add package.json
git commit -m "chore(scripts): server スクリプトを wrangler/worker テストへ置換"
```

---

## Phase 4 — デプロイ・E2E・撤去

### Task 17: 本番デプロイと extension 再ビルド

**Files:**（運用手順。コード変更は確定値の差し替えのみ）
- Modify: `extension/manifest.json`, `build.mjs`（`<subdomain>` を実値へ）

- [ ] **Step 1: シークレット設定とデプロイ**

Run:
```bash
wrangler secret put CONNECT_SECRET   # 既存と同じ値、もしくは openssl rand -hex 32 の新値
pnpm deploy
```
Expected: `https://unext-sync.<subdomain>.workers.dev` が払い出される。**この `<subdomain>` を控える**。

- [ ] **Step 2: manifest と build.mjs の `<subdomain>` を実値へ差し替え**

Task 15 で置いた `<subdomain>` を、Step 1 の実サブドメインに置換（`extension/manifest.json` の host_permissions と `build.mjs` の既定 URL）。

- [ ] **Step 3: 本番 secret で拡張を再ビルド**

Run:
```bash
CONNECT_SECRET=<本番と同じ値> pnpm build:extension
```
Expected: `dist/extension` に本番 URL/secret が埋め込まれる（**値はコミットしない**）。

- [ ] **Step 4: コミット（確定値のみ）**

```bash
git add extension/manifest.json build.mjs
git commit -m "chore(extension): Worker サブドメインを実値に確定"
```

### Task 18: 擬似ホスト E2E と CLAUDE.md 更新、Render 撤去

**Files:**
- Modify: `docs/e2e-pseudo-host-testing.md`, `CLAUDE.md`

- [ ] **Step 1: E2E 手順の URL を更新**

`docs/e2e-pseudo-host-testing.md` の `SERVER_URL=ws://localhost:8080` を、ローカルは `ws://localhost:8787`（`wrangler dev`）、本番は `wss://unext-sync.<subdomain>.workers.dev` に差し替える。サーバー起動コマンドを `pnpm dev:server` から `pnpm dev:worker` に。

- [ ] **Step 2: 実機 E2E（手動）**

`pnpm dev:worker` を起動し、ローカル secret（`.dev.vars` に `CONNECT_SECRET=...`）で拡張をビルド・読み込み、擬似ホスト手順でホスト作成→参加→sync 追従を確認。Expected: 参加者がホストの play/pause/seek に追従。

- [ ] **Step 3: CLAUDE.md の構成記述を更新**

`## Architecture` のレイヤー構成と「WSリレーサーバー（Node.js + ws / Render Free）」記述を、CF Workers + DO 構成（`worker/` 配下、`shared/rooms.ts` の純粋リデューサ、`wrangler` コマンド）に更新。`## Commands` の `build:server`/`dev:server`/`start` を `deploy`/`dev:worker`/`test:worker` に差し替える。

- [ ] **Step 4: Render 撤去（ロールバック余地を残す）**

CF が E2E で安定稼働したことを確認後、Render ダッシュボードでサービスを停止・削除する。**ロールバック手段**: 旧 Node ランタイム（`server/`・`build-server.mjs`）は Task 7 の削除コミットとして git 履歴に残っているため、CF 不調時はその commit を revert して Render に再 deploy できる。この方針を CLAUDE.md「既知の制約」に1行残す。

- [ ] **Step 5: コミット**

```bash
git add docs/e2e-pseudo-host-testing.md CLAUDE.md
git commit -m "docs: E2E 手順と CLAUDE.md を CF 構成へ更新、ロールバック方針を明記"
```

---

## Self-Review チェック結果

- **Spec coverage**: §2 純粋リデューサ→Task 3-7 / §3.3 effects(setAttachment 含む)→Task 3-4 / §3.5 roster 順序→Task 3,6 / §4 create HTTP化・CORS・v2→Task 1,9,14 / §4.3 acceptWebSocket→Task 8 / §4.5 manifest・parse-server→Task 13,15 / §5 Alarm 化・re-arm→Task 6,8 / §5.2 hibernation-eligibility（setInterval 不使用・acceptWebSocket・未解決 Promise 回避）→Task 8 実装方針 / §6 secret/wrangler/URL 導出→Task 2,9,11,17 / §7 テスト→Task 4-6,10 / §8 段階・ロールバック→Phase 構成・Task 18。網羅。
- **Placeholder**: `<subdomain>` のみ意図的テンプレ（Task 17 で実値確定の明示手順あり）。他に TODO/TBD なし。
- **Type consistency**: `Attachment{clientId,name,isHost,joined,joinedAt}` / `Effect`5種 / `makeRoomLogic`・`freshPersistent`・`applyJoin(state,clientId,joinedAt,role,hostToken?,name?)` を全タスクで一致。DO の `hydrate/commit/applyEffects/socketOf` と effects の対応一致。`PROTOCOL_VERSION=2` を client/server/parse 全面で統一。
