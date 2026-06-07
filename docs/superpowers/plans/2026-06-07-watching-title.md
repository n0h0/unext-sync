# 視聴中タイトル表示 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ホストが視聴中の作品名を専用メッセージ路で全員へ配信し、各ユーザーの popup に「🎬 視聴中: 〈作品名〉」を表示する。

**Architecture:** ホストの content script が `document.title` を `cleanTitle` で浄化し、`title` メッセージで送信。サーバーは `room.hostTitle` を保持（純粋な `rooms.ts` 側、不変条件#2）、変化時に `room_title` を全員へブロードキャストし、途中参加者には join 直後に現在値を送る。同期ロジック（方式C・壁時計非依存）には一切触れない。

**Tech Stack:** TypeScript（strict）, Node.js + ws（サーバー）, Chrome MV3 content/popup（拡張）, vitest, Biome。pnpm。

仕様の正典: `docs/superpowers/specs/2026-06-07-watching-title-design.md`

---

## ファイル構成

| ファイル | 役割 | 変更種別 |
|---|---|---|
| `shared/protocol.ts` | `TitleMessage`（C→S）/`RoomTitleMessage`（S→C）の型定義と `title` のパース | 変更 |
| `shared/protocol.test.ts` | `title` パースのテスト | 変更 |
| `server/src/rooms.ts` | `normalizeText` 一般化・`hostTitle` 状態・`setHostTitle`/`hostTitleOf`（純粋） | 変更 |
| `server/rooms.test.ts` | 上記のテスト | 変更 |
| `server/src/server.ts` | `title` 受信配線・`broadcastRoomTitle`・join キャッチアップ | 変更 |
| `server/server.test.ts` | タイトル配信の E2E テスト | 変更 |
| `extension/src/title.ts` | `cleanTitle`（純粋・U-NEXT 非依存の浄化） | 新規 |
| `extension/src/title.test.ts` | `cleanTitle` のテスト | 新規 |
| `extension/src/parse-server.ts` | `room_title` を allowlist へ追加 | 変更 |
| `extension/src/parse-server.test.ts` | `room_title` 回帰テスト | 変更 |
| `extension/src/popup-status.ts` | `renderWatchingTitle`（純粋・表示文字列生成） | 変更 |
| `extension/src/popup.test.ts` | `renderWatchingTitle` のテスト | 変更 |
| `extension/src/popup.html` | `#watchingTitle` 行を追加 | 変更 |
| `extension/src/popup.ts` | `room_title` 受信・`get_status` 復元で表示 | 変更 |
| `extension/src/content.ts` | `room_title` 保持・転送・`get_status` 同梱、ホストのタイトル送信 | 変更 |

---

## Task 1: プロトコルに `title` / `room_title` を追加

**Files:**
- Modify: `shared/protocol.ts`
- Test: `shared/protocol.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`shared/protocol.test.ts` の末尾に追記:

```typescript
test("parses a title message", () => {
  const raw = JSON.stringify({ v: 1, type: "title", title: "作品名 第3話" });
  expect(parseClientMessage(raw)).toEqual({ v: 1, type: "title", title: "作品名 第3話" });
});

test("rejects title with non-string title", () => {
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "title", title: 42 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "title" }))).toBeNull();
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: FAIL（`title` は未知の type のため `parseClientMessage` が `null` を返し、最初のテストが落ちる）

- [ ] **Step 3: 型と parse を実装**

`shared/protocol.ts` の `JoinMessage` インターフェース定義の後（`PingMessage` の前あたり）に `TitleMessage` を追加:

```typescript
export interface TitleMessage {
  v: number;
  type: "title";
  title: string;
}
```

`ClientMessage` 合併型に `TitleMessage` を加える:

```typescript
export type ClientMessage = CreateMessage | JoinMessage | SyncMessage | PingMessage | TitleMessage;
```

`RosterMessage` インターフェースの後に `RoomTitleMessage` を追加:

```typescript
export interface RoomTitleMessage {
  v: number;
  type: "room_title";
  title: string;
}
```

`ServerMessage` 合併型に `RoomTitleMessage` を加える:

```typescript
export type ServerMessage =
  | CreatedMessage
  | JoinedMessage
  | HostTakenMessage
  | StateMessage
  | HostStatusMessage
  | RosterMessage
  | RoomTitleMessage
  | PongMessage
  | NoRoomMessage;
```

`parseClientMessage` の `switch (o.type)` 内、`case "ping":` の前に `title` ケースを追加:

```typescript
    case "title":
      if (typeof o.title !== "string") return null;
      return { v: 1, type: "title", title: o.title };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(protocol): add title (C→S) and room_title (S→C) messages"
```

---

## Task 2: `rooms.ts` に hostTitle 状態と純粋ロジックを追加

**Files:**
- Modify: `server/src/rooms.ts`
- Test: `server/rooms.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/rooms.test.ts` の import を `normalizeText` も含むよう変更:

```typescript
import { normalizeName, normalizeText, RoomManager } from "./src/rooms";
```

ファイル末尾に追記:

```typescript
test("normalizeText truncates by code point to the given maxLen", () => {
  expect(normalizeText("  あ  ", 24)).toBe("あ");
  expect(normalizeText("a\x01b", 24)).toBe("ab");
  expect(normalizeText("😀".repeat(200), 120)).toBe("😀".repeat(120));
  expect(normalizeText(42, 120)).toBe("");
});

test("setHostTitle accepts only the host and normalizes", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.join(roomId, "c2", "participant", undefined, "はなこ");
  // 非ホストは拒否
  expect(rm.setHostTitle(roomId, "c2", "作品名").changed).toBe(false);
  expect(rm.hostTitleOf(roomId)).toBeNull();
  // ホストは受理・正規化される
  expect(rm.setHostTitle(roomId, "c1", "  作品名 第3話  ").changed).toBe(true);
  expect(rm.hostTitleOf(roomId)).toBe("作品名 第3話");
});

test("setHostTitle is idempotent for the same title and rejects empty", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  expect(rm.setHostTitle(roomId, "c1", "作品名").changed).toBe(true);
  expect(rm.setHostTitle(roomId, "c1", "作品名").changed).toBe(false); // 同値
  expect(rm.setHostTitle(roomId, "c1", "   ").changed).toBe(false); // 空は無視
  expect(rm.hostTitleOf(roomId)).toBe("作品名"); // 直前値を維持
});

test("setHostTitle truncates to 120 code points", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.setHostTitle(roomId, "c1", "あ".repeat(200));
  expect([...(rm.hostTitleOf(roomId) ?? "")]).toHaveLength(120);
});

test("setHostTitle returns false for unknown room", () => {
  expect(rm.setHostTitle("nope", "c1", "x").changed).toBe(false);
  expect(rm.hostTitleOf("nope")).toBeNull();
});

test("hostTitle persists while host is disconnected within hold", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken, "たろう");
  rm.setHostTitle(roomId, "c1", "作品名");
  rm.removeClient(roomId, "c1"); // ホスト切断（60s保持中）
  expect(rm.hostTitleOf(roomId)).toBe("作品名");
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: FAIL（`normalizeText` / `setHostTitle` / `hostTitleOf` 未定義）

- [ ] **Step 3: 実装する**

`server/src/rooms.ts` の `MAX_NAME_LEN` 定義の直後に上限定数を追加:

```typescript
const MAX_TITLE_LEN = 120;
```

`normalizeName` 関数を `normalizeText` への委譲に置き換える（既存の `normalizeName` 定義を以下で丸ごと差し替え）:

```typescript
/** 信頼しない表示文字列を正規化する（trim・制御文字除去・maxLen コードポイントで切り詰め）。空なら "" を返す。 */
export function normalizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return [...raw.replace(CONTROL_CHARS, "").trim()].slice(0, maxLen).join("");
}

/** 表示名の正規化（最大24コードポイント）。 */
export function normalizeName(raw: unknown): string {
  return normalizeText(raw, MAX_NAME_LEN);
}
```

`Room` インターフェースに `hostTitle` を追加（`lastState` の後あたり）:

```typescript
  lastState: StateMessage | null;
  hostTitle: string | null;
  clients: Map<string, ClientInfo>; // ホストを含む全接続clientId
```

`create()` の `this.rooms.set(...)` のオブジェクトリテラルに `hostTitle: null,` を追加（`lastState: null,` の後）:

```typescript
      lastState: null,
      hostTitle: null,
      clients: new Map(),
```

`deleteIfEmpty` メソッドの直前（クラス内）に2メソッドを追加:

```typescript
  /** ホストのみ視聴中タイトルを設定。正規化後が空/同値なら changed:false。ホスト以外・不在ルームも changed:false。 */
  setHostTitle(roomId: string, clientId: string, rawTitle: unknown): { changed: boolean } {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== clientId) return { changed: false };
    const title = normalizeText(rawTitle, MAX_TITLE_LEN);
    if (title === "" || title === room.hostTitle) return { changed: false };
    room.hostTitle = title;
    return { changed: true };
  }

  hostTitleOf(roomId: string): string | null {
    return this.rooms.get(roomId)?.hostTitle ?? null;
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: PASS（既存テスト＋新規テスト全て）

- [ ] **Step 5: コミット**

```bash
git add server/src/rooms.ts server/rooms.test.ts
git commit -m "feat(rooms): add hostTitle state with setHostTitle/hostTitleOf (host-only, normalized)"
```

---

## Task 3: `server.ts` に title 受信・配信・キャッチアップを配線

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/server.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/server.test.ts` の末尾に追記:

```typescript
test("host title is broadcast to participant as room_title", async () => {
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

  send(host, { v: 1, type: "title", title: "作品名 第3話" });
  const rt = await nextType(guestR, "room_title");
  expect(rt.title).toBe("作品名 第3話");
});

test("late joiner receives current room_title as catch-up", async () => {
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
  send(host, { v: 1, type: "title", title: "作品名 第3話" });
  await nextType(hostR, "room_title"); // ホスト自身にも届く（drain）

  const { ws: late, r: lateR } = await connect(port);
  send(late, { v: 1, type: "join", roomId: created.roomId, role: "participant", name: "はなこ" });
  const rt = await nextType(lateR, "room_title");
  expect(rt.title).toBe("作品名 第3話");
});

test("title from a non-host is ignored", async () => {
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

  // 参加者が title を送っても誰にも room_title は来ない
  send(guest, { v: 1, type: "title", title: "偽タイトル" });
  // 後続の ping/pong で「room_title が割り込んでいない」ことを確認する
  send(guest, { v: 1, type: "ping", id: 99 });
  const pong = await guestR.next();
  expect(pong).toMatchObject({ type: "pong", id: 99 });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run server/server.test.ts`
Expected: FAIL（`room_title` が送られず `nextType` がタイムアウト、または最初の2テストが落ちる）

- [ ] **Step 3: 実装する**

`server/src/server.ts` の `broadcastRoster` 定義の直後に `broadcastRoomTitle` を追加:

```typescript
  const broadcastRoomTitle = (roomId: string) => {
    const title = rooms.hostTitleOf(roomId);
    if (title === null) return;
    for (const cid of rooms.clientIdsOf(roomId)) {
      const sock = findSocket(cid);
      if (sock) send(sock, { v: PROTOCOL_VERSION, type: "room_title", title });
    }
  };
```

`join` ケースの `broadcastRoster(msg.roomId);` の直後（`break;` の前）にキャッチアップ送信を追加。これは `joined` / `host_taken` の両 outcome を通る位置なので、降格参加者にも届く:

```typescript
          broadcastRoster(msg.roomId);
          const catchUpTitle = rooms.hostTitleOf(msg.roomId);
          if (catchUpTitle !== null) {
            send(ws, { v: PROTOCOL_VERSION, type: "room_title", title: catchUpTitle });
          }
          break;
```

`sync` ケースの `}` の後（`switch` の閉じ括弧の前）に `title` ケースを追加:

```typescript
        case "title": {
          if (!ctx.roomId) return;
          const { changed } = rooms.setHostTitle(ctx.roomId, ctx.id, msg.title);
          if (changed) broadcastRoomTitle(ctx.roomId);
          break;
        }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run server/server.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add server/src/server.ts server/server.test.ts
git commit -m "feat(server): broadcast room_title on change and catch up late joiners"
```

---

## Task 4: `cleanTitle`（拡張・純粋関数）

**Files:**
- Create: `extension/src/title.ts`
- Test: `extension/src/title.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/title.test.ts` を新規作成:

```typescript
import { expect, test } from "vitest";
import { cleanTitle } from "./title";

test("strips U-NEXT suffix after a pipe (half-width and full-width)", () => {
  expect(cleanTitle("作品名 第3話 | U-NEXT")).toBe("作品名 第3話");
  expect(cleanTitle("作品名｜U-NEXT")).toBe("作品名");
  expect(cleanTitle("作品名 | U-NEXT 映画・ドラマ・アニメの動画が見放題")).toBe("作品名");
});

test("collapses internal whitespace and trims", () => {
  expect(cleanTitle("  作品名   サブ  ")).toBe("作品名 サブ");
});

test("leaves an already-clean title untouched", () => {
  expect(cleanTitle("作品名")).toBe("作品名");
});

test("returns empty string for brand-only or empty title", () => {
  expect(cleanTitle("U-NEXT")).toBe("");
  expect(cleanTitle("UNEXT")).toBe("");
  expect(cleanTitle("")).toBe("");
});

test("keeps a pipe that is not the U-NEXT brand", () => {
  expect(cleanTitle("Re:ゼロ | 第2期")).toBe("Re:ゼロ | 第2期");
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/title.test.ts`
Expected: FAIL（`./title` が存在しない）

- [ ] **Step 3: 実装する**

`extension/src/title.ts` を新規作成:

```typescript
/**
 * U-NEXT の document.title を表示用に浄化する純粋関数。
 * - 「… | U-NEXT…」「…｜U-NEXT…」のブランドサフィックスを除去（半角/全角パイプ両対応）
 * - ブランド名のみ（トップ/ブラウズ画面など）は作品なしとみなして空文字
 * - trim し、連続空白（全角含む）を半角スペース1つに圧縮
 * U-NEXT 以外のパイプ（例「作品名 | 第2期」）は残す。
 */
export function cleanTitle(raw: string): string {
  const withoutSuffix = raw.replace(/\s*[|｜]\s*U-?NEXT.*$/i, "").trim();
  if (/^U-?NEXT$/i.test(withoutSuffix)) return "";
  return withoutSuffix.replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/title.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add extension/src/title.ts extension/src/title.test.ts
git commit -m "feat(extension): add cleanTitle to sanitize U-NEXT document.title"
```

---

## Task 5: `parse-server.ts` の allowlist に `room_title` を追加

**Files:**
- Modify: `extension/src/parse-server.ts`
- Test: `extension/src/parse-server.test.ts`

> WsClient は `parseServerMessageLoose` の allowlist を通らないメッセージを黙って破棄する（既知の落とし穴）。`room_title` を必ず追加する。

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/parse-server.test.ts` の末尾に追記:

```typescript
test("parses a room_title message (regression: room_title must not be dropped)", () => {
  const raw = JSON.stringify({ v: 1, type: "room_title", title: "作品名 第3話" });
  const msg = parseServerMessageLoose(raw);
  expect(msg).not.toBeNull();
  expect(msg?.type).toBe("room_title");
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/parse-server.test.ts`
Expected: FAIL（`room_title` が `TYPES` に無く `null` が返る）

- [ ] **Step 3: 実装する**

`extension/src/parse-server.ts` の `TYPES` Set に `"room_title"` を追加（`"roster"` の後あたり）:

```typescript
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/parse-server.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add extension/src/parse-server.ts extension/src/parse-server.test.ts
git commit -m "fix(extension): allow 'room_title' in parseServerMessageLoose allowlist"
```

---

## Task 6: `renderWatchingTitle`（popup 表示文字列・純粋）

**Files:**
- Modify: `extension/src/popup-status.ts`
- Test: `extension/src/popup.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/popup.test.ts` の import に `renderWatchingTitle` を追加:

```typescript
import {
  type ConnState,
  formatRosterLine,
  isActiveSession,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
} from "./popup-status";
```

ファイル末尾に追記:

```typescript
test("renderWatchingTitle shows label for a title and null otherwise", () => {
  expect(renderWatchingTitle("作品名 第3話")).toBe("🎬 視聴中: 作品名 第3話");
  expect(renderWatchingTitle(null)).toBeNull();
  expect(renderWatchingTitle("")).toBeNull();
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: FAIL（`renderWatchingTitle` 未定義）

- [ ] **Step 3: 実装する**

`extension/src/popup-status.ts` の末尾（`formatRosterLine` の後）に追加:

```typescript
/**
 * 視聴中タイトルの表示文字列。title が null/空なら null（行を描画しない）。
 * XSS回避のため呼び出し側は textContent で描画すること。
 */
export function renderWatchingTitle(title: string | null): string | null {
  if (!title) return null;
  return `🎬 視聴中: ${title}`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: コミット**

```bash
git add extension/src/popup-status.ts extension/src/popup.test.ts
git commit -m "feat(popup): add renderWatchingTitle pure helper"
```

---

## Task 7: popup の DOM 配線（表示）

**Files:**
- Modify: `extension/src/popup.html`
- Modify: `extension/src/popup.ts`

> popup.ts/popup.html はユニットテスト対象外（DOM 配線）。検証は `pnpm tsc --noEmit` と後続の手動確認で行う。

- [ ] **Step 1: HTML に表示行を追加**

`extension/src/popup.html` の `#status` div と `#rosterHeader` div の間に `#watchingTitle` を追加:

```html
    <div id="status">未接続</div>
    <div id="watchingTitle"></div>
    <div id="rosterHeader"></div>
```

同ファイルの `<style>` 内、`#status` の行の後にスタイルを追加:

```css
    #status { margin-top: 8px; font-weight: bold; }
    #watchingTitle { margin-top: 6px; color: #333; }
```

- [ ] **Step 2: popup.ts で表示関数を追加し配線**

`extension/src/popup.ts` の import に `renderWatchingTitle` を追加:

```typescript
import {
  type ConnState,
  formatRosterLine,
  isActiveSession,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
} from "./popup-status";
```

`renderRoster` 関数の後に表示ヘルパを追加:

```typescript
function showWatchingTitle(title: string | null) {
  $("watchingTitle").textContent = renderWatchingTitle(title) ?? "";
}
```

`get_status` 復元ブロック（`if (resp?.roster) ...` の行の後）にタイトル復元を追加:

```typescript
    if (resp?.roster) renderRoster(resp.roster, resp.selfId ?? null);
    if (resp?.title) showWatchingTitle(resp.title);
```

`chrome.runtime.onMessage.addListener` 内、`roster` ハンドラの後に `room_title` ハンドラを追加:

```typescript
  if (msg?.type === "room_title") {
    showWatchingTitle(msg.title);
    return;
  }
```

- [ ] **Step 3: 型チェック**

Run: `pnpm tsc --noEmit`
Expected: エラーなし

- [ ] **Step 4: コミット**

```bash
git add extension/src/popup.html extension/src/popup.ts
git commit -m "feat(popup): display watching title row from room_title and get_status"
```

---

## Task 8: content script の配線（保持・転送・ホスト送信）

**Files:**
- Modify: `extension/src/content.ts`

> content.ts はユニットテスト対象外。検証は `pnpm tsc --noEmit`・`pnpm check`・ビルド、および後続の手動確認で行う。サーバー側の挙動は Task 3 の E2E テストで実証済み。

- [ ] **Step 1: import と状態を追加**

`extension/src/content.ts` 冒頭の import に `cleanTitle` を追加:

```typescript
import { cleanTitle } from "./title";
```

`currentSelfId` 宣言の後にタイトル状態を追加:

```typescript
let currentSelfId: string | null = null;
let currentTitle: string | null = null;
```

- [ ] **Step 2: `room_title` を受信して保持・転送**

`handleServer` の `switch` 内、`case "roster":` ブロックの後に専用ケースを追加（`default` に落とさないこと）:

```typescript
      case "room_title":
        currentTitle = msg.title;
        chrome.runtime.sendMessage({ type: "room_title", title: msg.title }).catch(() => {});
        break;
```

- [ ] **Step 3: ホストのタイトル送信ロジックを追加**

`handleServer` 関数の定義の直後（`orchestrator = new SyncOrchestrator(...)` の前）に、送信ヘルパを追加:

```typescript
  // ホストのみ：document.title を浄化して送る。空なら送らず直前値を維持。
  let lastSentTitle: string | null = null;
  let titleDebounce: ReturnType<typeof setTimeout> | undefined;
  let titleObserverInstalled = false;
  function sendTitleIfChanged() {
    const t = cleanTitle(document.title);
    if (!t || t === lastSentTitle) return;
    lastSentTitle = t;
    client.send({ v: 1, type: "title", title: t });
  }
  function scheduleTitleSend() {
    if (titleDebounce) clearTimeout(titleDebounce);
    titleDebounce = setTimeout(sendTitleIfChanged, 1000);
  }
  function startHostTitleSync() {
    lastSentTitle = null; // (再)join のたびに現在値を確実に1回送る（サーバーが同値を弾く）
    sendTitleIfChanged();
    if (titleObserverInstalled) return;
    titleObserverInstalled = true;
    // <title> の差し替え・テキスト変更の両方を拾うため head を subtree 監視する。
    new MutationObserver(scheduleTitleSend).observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
```

- [ ] **Step 4: `joined`（host）でのみ送信開始するよう分岐を分離**

現在 `case "joined":` と `case "host_taken":` は1ブロックを共有している。これを2つに分け、`joined` かつ `role: "host"` のときだけ `startHostTitleSync()` を呼ぶ（`session.role` では判定しない）。

既存の以下のブロック:

```typescript
      case "joined":
      case "host_taken": {
        currentSelfId = msg.clientId;
        const next = nextStateForServerEvent(msg.type);
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: msg.type }).catch(() => {});
        break;
      }
```

を、次の2ケースに置き換える:

```typescript
      case "joined": {
        currentSelfId = msg.clientId;
        const next = nextStateForServerEvent("joined");
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: "joined" }).catch(() => {});
        if (msg.role === "host") startHostTitleSync();
        break;
      }
      case "host_taken": {
        currentSelfId = msg.clientId;
        const next = nextStateForServerEvent("host_taken");
        if (next) currentStatus = next;
        chrome.runtime.sendMessage({ type: "server_event", event: "host_taken" }).catch(() => {});
        break;
      }
```

- [ ] **Step 5: `get_status` 応答に title を同梱**

`chrome.runtime.onMessage.addListener` 内、`get_status` の `sendResponse({...})` に `title` を追加:

```typescript
    sendResponse({
      status: currentStatus,
      roomId: currentRoomId,
      roster: currentRoster,
      selfId: currentSelfId,
      title: currentTitle,
    });
```

- [ ] **Step 6: 型チェックと Lint**

Run: `pnpm tsc --noEmit && pnpm check`
Expected: エラーなし（`pnpm check` は import 順・format も検査。指摘が出たら `pnpm check:fix`）

- [ ] **Step 7: 全テスト通過を確認**

Run: `pnpm test`
Expected: PASS（全テスト）

- [ ] **Step 8: ビルドが通ることを確認**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension && pnpm build:server`
Expected: 両方ともエラーなく成功

- [ ] **Step 9: コミット**

```bash
git add extension/src/content.ts
git commit -m "feat(content): hold/forward room_title and send host title on join + title changes"
```

---

## 完了後の確認（手動 E2E は任意・post-MVP）

`docs/e2e-pseudo-host-testing.md` の擬似ホスト方式に沿って、ホストが `title` を送ると参加者の popup に「🎬 視聴中: …」が出ること、話数遷移（`document.title` 変化）で更新されること、途中参加でキャッチアップ表示されることを確認できる。これは正典 §「既知の制約」の post-MVP 実機検証に含まれる。

---

## Self-Review（計画作成者によるチェック結果）

**Spec coverage（仕様の各節 → タスク対応）:**
- §2 コア挙動（ホストのみ表示）→ Task 8 Step 4（`joined`+host のみ送信開始）
- §3 `cleanTitle` → Task 4／送信ロジック（join 確定後・デバウンス・空は送らない）→ Task 8 Step 3-4
- §4.1 `TitleMessage`/parse、§4.2 `RoomTitleMessage` → Task 1
- §5 `normalizeText` 一般化・`hostTitle`・`setHostTitle`/`hostTitleOf`・切断保持 → Task 2
- §6 `broadcastRoomTitle`・change時配信・join/host_taken キャッチアップ・sync非介入 → Task 3
- §7 source of truth（content）・`parse-server` allowlist・`renderWatchingTitle`・textContent・配置 → Task 5/6/7/8
- §9 stale 残置 → 実装上「空は送らない」（Task 8 Step 3 / Task 2）で自然に成立
- §10 不変条件 → 同期ロジック・seq・isApplying に一切触れない（全タスクで未変更）

**Placeholder scan:** プレースホルダなし。各 code step に実コードを記載済み。

**Type consistency:** `setHostTitle(roomId, clientId, rawTitle): { changed: boolean }`・`hostTitleOf(roomId): string | null`・`normalizeText(raw, maxLen)`・`cleanTitle(raw): string`・`renderWatchingTitle(title): string | null`・メッセージ型 `{ type:"title", title }` / `{ type:"room_title", title }` を全タスクで一貫使用。`JoinedMessage.role` を Task 8 の host 判定に使用（protocol 既定義）。
