# 接続シークレット実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公開WSサーバーへの接続を単一共有シークレットでゲートし、部外者をハンドシェイク段階で弾く（DoS/乱用対策）。

**Architecture:** クライアントは `Sec-WebSocket-Protocol` ヘッダ（`new WebSocket(url, [secret])`）でシークレットを提示し、サーバーは `verifyClient` で接続成立前に検証する。シークレットは token-safe（hex推奨）であることが必須で、純粋関数 `isTokenSafe`（shared）と `checkConnectSecret`（server, 定数時間比較）に検証ロジックを分離する。シークレットはコミットせず、サーバーはruntime env、拡張はesbuild defineでビルド時注入する。両者とも未設定/非token-safeなら fail-closed で停止する。

**Tech Stack:** TypeScript (strict), `ws`, esbuild, vitest, Node `crypto.timingSafeEqual`。

正典spec: `docs/superpowers/specs/2026-06-06-connect-secret-design.md`

---

## ファイル構成

- **Create** `shared/secret.ts` — `isTokenSafe(value)` + `TOKEN_SAFE_RE`。プラットフォーム非依存の純粋関数。クライアント・サーバー双方が import する（DRY）。
- **Create** `shared/secret.test.ts` — `isTokenSafe` の TDD。
- **Create** `server/src/auth.ts` — `checkConnectSecret(presented, expected)`。`isTokenSafe` + `timingSafeEqual`（node専用）。ws非依存・副作用なし。
- **Create** `server/auth.test.ts` — `checkConnectSecret` の TDD（既存テストは `server/` 直下に置く流儀）。
- **Modify** `server/src/server.ts` — env読み＋fail-closed＋`verifyClient` 配線。`startServer` にシークレット引数を追加（DI）。
- **Modify** `server/server.test.ts` — `startServer(0, TEST_SECRET)` 化、接続ヘルパをサブプロトコル対応化、ハンドシェイク拒否/許可テストを追加。
- **Modify** `extension/src/config.ts` — `CONNECT_SECRET` をdefine経由で公開＋token検証。
- **Modify** `extension/src/content.ts` — `new WebSocket(url, [CONNECT_SECRET])`。
- **Modify** `build.mjs` — env読み（未設定でビルド失敗）＋`define` 注入。
- **Create** `.env.example` — `CONNECT_SECRET=` プレースホルダ。
- **Modify** `CLAUDE.md` — 鍵の生成/設定/ローテーション手順を追記。

---

## Task 1: `isTokenSafe`（shared 純粋関数）

**Files:**
- Create: `shared/secret.ts`
- Test: `shared/secret.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/secret.test.ts`:

```ts
import { test, expect } from "vitest";
import { isTokenSafe } from "./secret";

test("accepts hex output", () => {
  expect(isTokenSafe("a3f9c0d1e2b4")).toBe(true);
});

test("accepts base64url chars (- and _)", () => {
  expect(isTokenSafe("abc-DEF_123")).toBe(true);
});

test("rejects standard base64 separators + / =", () => {
  expect(isTokenSafe("ab+cd/ef=")).toBe(false);
  expect(isTokenSafe("abcd==")).toBe(false);
});

test("rejects comma, colon, space and empty", () => {
  expect(isTokenSafe("a,b")).toBe(false);
  expect(isTokenSafe("a:b")).toBe(false);
  expect(isTokenSafe("a b")).toBe(false);
  expect(isTokenSafe("")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run shared/secret.test.ts`
Expected: FAIL — `isTokenSafe` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

`shared/secret.ts`:

```ts
/** RFC 7230 token のうち、hex と base64url を許容する安全な部分集合。
 *  Sec-WebSocket-Protocol に載せる値はこの文字種でなければ
 *  ブラウザの new WebSocket(url, [secret]) が SyntaxError を投げる。 */
export const TOKEN_SAFE_RE = /^[A-Za-z0-9_-]+$/;

export function isTokenSafe(value: string): boolean {
  return TOKEN_SAFE_RE.test(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run shared/secret.test.ts`
Expected: PASS（4テスト）

- [ ] **Step 5: Commit**

```bash
git add shared/secret.ts shared/secret.test.ts
git commit -m "feat: add isTokenSafe for Sec-WebSocket-Protocol token validation"
```

---

## Task 2: `checkConnectSecret`（server 純粋関数・定数時間比較）

**Files:**
- Create: `server/src/auth.ts`
- Test: `server/auth.test.ts`

- [ ] **Step 1: Write the failing test**

`server/auth.test.ts`:

```ts
import { test, expect } from "vitest";
import { checkConnectSecret } from "./src/auth";

const SECRET = "a3f9c0d1e2b4a3f9c0d1e2b4";

test("returns true for exact match", () => {
  expect(checkConnectSecret(SECRET, SECRET)).toBe(true);
});

test("returns false for different value of same length", () => {
  const other = "b3f9c0d1e2b4a3f9c0d1e2b4";
  expect(checkConnectSecret(other, SECRET)).toBe(false);
});

test("returns false for different length without throwing", () => {
  expect(checkConnectSecret("short", SECRET)).toBe(false);
});

test("returns false for undefined and empty", () => {
  expect(checkConnectSecret(undefined, SECRET)).toBe(false);
  expect(checkConnectSecret("", SECRET)).toBe(false);
});

test("returns false for non-token-safe presented value", () => {
  expect(checkConnectSecret("ab+cd/ef=", SECRET)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/auth.test.ts`
Expected: FAIL — `checkConnectSecret` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

`server/src/auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { isTokenSafe } from "../../shared/secret";

/** クライアント提示シークレットが期待値と一致するか定数時間で判定。
 *  - presented が undefined/空/非token-safe なら false
 *  - 長さが違えば timingSafeEqual を呼ばず false（例外回避） */
export function checkConnectSecret(
  presented: string | undefined,
  expected: string,
): boolean {
  if (!presented || !isTokenSafe(presented)) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/auth.test.ts`
Expected: PASS（5テスト）

- [ ] **Step 5: Commit**

```bash
git add server/src/auth.ts server/auth.test.ts
git commit -m "feat: add checkConnectSecret with constant-time comparison"
```

---

## Task 3: サーバー配線（verifyClient + fail-closed + 既存テスト改修）

**Files:**
- Modify: `server/src/server.ts`
- Modify: `server/server.test.ts`

> 注意: server.ts に `verifyClient` を入れると、サブプロトコル無しで接続する既存テストが全て壊れる。そのため server.ts 変更とテスト改修を同一タスク・同一コミットで行う。

- [ ] **Step 1: 既存テストを改修し、新規ハンドシェイクテストを追加（まだ失敗させる）**

`server/server.test.ts` の冒頭〜`connect` ヘルパを以下に置き換える。`TEST_SECRET` 定数を追加し、`connect` をサブプロトコル対応にする。

置換前（1〜32行目相当）:

```ts
import { test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer } from "./src/server";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

function reader(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  return {
    next(): Promise<any> {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => waiters.push(res));
    },
  };
}

function connect(port: number): Promise<{ ws: WebSocket; r: ReturnType<typeof reader> }> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const r = reader(ws);
  return new Promise((res, rej) => {
    ws.on("open", () => res({ ws, r }));
    ws.on("error", rej);
  });
}
const send = (ws: WebSocket, o: any) => ws.send(JSON.stringify(o));
```

置換後:

```ts
import { test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer } from "./src/server";

const TEST_SECRET = "testsecrettoken0123";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

function reader(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  return {
    next(): Promise<any> {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => waiters.push(res));
    },
  };
}

function connect(
  port: number,
  secret: string = TEST_SECRET,
): Promise<{ ws: WebSocket; r: ReturnType<typeof reader> }> {
  const ws = new WebSocket(`ws://localhost:${port}`, [secret]);
  const r = reader(ws);
  return new Promise((res, rej) => {
    ws.on("open", () => res({ ws, r }));
    ws.on("error", rej);
  });
}
const send = (ws: WebSocket, o: any) => ws.send(JSON.stringify(o));
```

次に、既存5テストの `startServer(0)` を全て `startServer(0, TEST_SECRET)` に変更する（5箇所）。

最後に、ファイル末尾へ新規テスト2件を追加する:

```ts
test("connection without secret is rejected at handshake", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  await expect(
    new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${port}`); // サブプロトコル無し
      ws.on("open", () => res("open"));
      ws.on("error", (e) => rej(e));
    }),
  ).rejects.toThrow();
});

test("connection with wrong secret is rejected at handshake", async () => {
  const { port, stop: s } = await startServer(0, TEST_SECRET);
  stop = s;
  await expect(
    new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${port}`, ["wrongsecret"]);
      ws.on("open", () => res("open"));
      ws.on("error", (e) => rej(e));
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify the new reject-tests fail**

Run: `pnpm vitest run server/server.test.ts`
Expected: FAIL — `startServer` がまだ第2引数を使わず `verifyClient` も無いため、サブプロトコル無し接続が成立し、新規2テストが「open」になって `rejects.toThrow` が失敗する。（既存5テストは subprotocol を送るが検証されないので通る。）

- [ ] **Step 3: server.ts を修正（env読み＋fail-closed＋verifyClient＋シグネチャ）**

`server/src/server.ts` を以下のように修正する。

import 群に追加:

```ts
import { checkConnectSecret } from "./auth";
import { isTokenSafe } from "../../shared/secret";
```

`startServer` の直前に env 読み出しヘルパを追加:

```ts
function requireSecretFromEnv(): string {
  const s = process.env.CONNECT_SECRET;
  if (!s || !isTokenSafe(s)) {
    throw new Error(
      "CONNECT_SECRET is unset or not token-safe. " +
        "Set a hex secret, e.g. `openssl rand -hex 32`.",
    );
  }
  return s;
}
```

`startServer` のシグネチャを変更（第2引数 `connectSecret` を追加。省略時のみ env を読む＝直接起動で fail-closed、テストは明示注入）:

```ts
export async function startServer(
  port = Number(process.env.PORT) || 8080,
  connectSecret: string = requireSecretFromEnv(),
): Promise<RunningServer> {
```

`WebSocketServer` 生成を `verifyClient` 付きに変更:

```ts
  const wss = new WebSocketServer({
    port,
    verifyClient: (info, cb) => {
      const raw = info.req.headers["sec-websocket-protocol"];
      const presented = (typeof raw === "string" ? raw : "")
        .split(",")[0]
        ?.trim();
      if (checkConnectSecret(presented, connectSecret)) cb(true);
      else cb(false, 401, "Unauthorized");
    },
  });
```

（`startServer().catch(...)` の直接起動ブロックは変更不要。第2引数省略で `requireSecretFromEnv()` が走り、未設定なら起動失敗する。）

- [ ] **Step 4: Run all server tests to verify they pass**

Run: `pnpm vitest run server/server.test.ts`
Expected: PASS（既存5＋新規2＝7テスト）

- [ ] **Step 5: 型チェック**

Run: `pnpm tsc --noEmit`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/server.test.ts
git commit -m "feat: reject WS connections without valid secret at handshake"
```

---

## Task 4: クライアント（config.ts + content.ts）

**Files:**
- Modify: `extension/src/config.ts`
- Modify: `extension/src/content.ts`

> ブラウザ `WebSocket` を起動するコードはユニットテストしづらいため、このタスクは型チェックとビルド（Task 5）で担保する。token検証の純粋ロジックは Task 1 の `isTokenSafe` で既にテスト済み。

- [ ] **Step 1: config.ts に CONNECT_SECRET を追加**

`extension/src/config.ts` を以下に置き換える:

```ts
import { isTokenSafe } from "../../shared/secret";

// デプロイ後の実URLに置き換える（Task 10）。
export const SERVER_URL = "wss://unext-sync.onrender.com";

// ビルド時に build.mjs が esbuild define で実値へ置換する。コミットしない。
declare const __CONNECT_SECRET__: string;
export const CONNECT_SECRET = __CONNECT_SECRET__;

// 非token-safeな値は new WebSocket(url, [secret]) で SyntaxError を起こし
// 拡張が無言停止するため、原因を明示するためここで早期に弾く。
if (!isTokenSafe(CONNECT_SECRET)) {
  throw new Error(
    "CONNECT_SECRET is missing or not token-safe. " +
      "Rebuild with a hex secret: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`.",
  );
}
```

- [ ] **Step 2: content.ts でサブプロトコルとして渡す**

`extension/src/content.ts:5` の import を変更:

```ts
import { SERVER_URL, CONNECT_SECRET } from "./config";
```

`extension/src/content.ts:46` の `new WebSocket(url)` を変更:

```ts
    const raw = new WebSocket(url, [CONNECT_SECRET]);
```

- [ ] **Step 3: 型チェック（define未注入だと __CONNECT_SECRET__ 未定義なので declare で通す）**

Run: `pnpm tsc --noEmit`
Expected: エラーなし（`declare const __CONNECT_SECRET__` により型は通る）

- [ ] **Step 4: Commit**

```bash
git add extension/src/config.ts extension/src/content.ts
git commit -m "feat: send CONNECT_SECRET as WS subprotocol from extension"
```

---

## Task 5: ビルド時注入（build.mjs）と .env.example

**Files:**
- Modify: `build.mjs`
- Create: `.env.example`

- [ ] **Step 1: build.mjs に env 読み出しと define を追加**

`build.mjs` を以下に置き換える:

```js
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const secret = process.env.CONNECT_SECRET;
if (!secret || !/^[A-Za-z0-9_-]+$/.test(secret)) {
  console.error(
    "CONNECT_SECRET is unset or not token-safe.\n" +
      "Build the extension with a hex secret, e.g.:\n" +
      "  CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension",
  );
  process.exit(1);
}

await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["extension/src/content.ts", "extension/src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist/extension",
  define: { __CONNECT_SECRET__: JSON.stringify(secret) },
});
await cp("extension/manifest.json", "dist/extension/manifest.json");
await cp("extension/src/popup.html", "dist/extension/popup.html");
console.log("extension built -> dist/extension");
```

- [ ] **Step 2: .env.example を作成**

`.env.example`:

```
# WS接続を部外者から守る共有シークレット。token-safe（hex）で生成すること。
#   生成例: openssl rand -hex 32
# 標準base64（openssl rand -base64）は + / = を含み拡張が SyntaxError で停止するため不可。
# サーバー(Render)の環境変数と、拡張ビルド時の env の両方に同じ値を設定する。
CONNECT_SECRET=
```

- [ ] **Step 3: 未設定でビルドが失敗することを確認**

Run: `env -u CONNECT_SECRET pnpm build:extension`
Expected: FAIL（exit 1）— "CONNECT_SECRET is unset or not token-safe" が表示される。

- [ ] **Step 4: シークレット付きでビルドが成功することを確認**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`
Expected: PASS — "extension built -> dist/extension"。

- [ ] **Step 5: Commit**

```bash
git add build.mjs .env.example
git commit -m "feat: inject CONNECT_SECRET into extension at build time (fail-closed)"
```

---

## Task 6: ドキュメント（CLAUDE.md）

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md に接続シークレット節を追記**

`CLAUDE.md` の `## Commands` 節の末尾（型チェック行の後）に以下を追記する:

```markdown
### 接続シークレット（CONNECT_SECRET）

公開WSサーバーへの接続は単一共有シークレットでゲートされている（spec: `docs/superpowers/specs/2026-06-06-connect-secret-design.md`）。サーバーもビルドも未設定なら fail-closed で停止する。

- **生成**: token-safe な値を使う。`openssl rand -hex 32` を推奨。**`openssl rand -base64` は不可**（`+ / =` で拡張が `SyntaxError` 停止）。
- **サーバー**: Render の環境変数 `CONNECT_SECRET` に設定。
- **拡張ビルド**: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`。値はバンドルに埋め込まれるが**コミットしない**（public repo）。
- **ローテーション**: サーバーenv と 拡張埋め込み値の**両方**を同じ新値に変更し、拡張を再ビルド・再配布する。
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document CONNECT_SECRET setup and rotation"
```

---

## Task 7: 全体検証

**Files:** なし（検証のみ）

- [ ] **Step 1: 全テスト実行**

Run: `pnpm test`
Expected: 全テスト PASS（既存＋新規 `shared/secret.test.ts`・`server/auth.test.ts`・`server/server.test.ts` の追加分を含む）。

- [ ] **Step 2: 型チェック**

Run: `pnpm tsc --noEmit`
Expected: エラーなし。

- [ ] **Step 3: サーバービルド**

Run: `pnpm build:server`
Expected: "server built -> dist/server.js"。

- [ ] **Step 4: 拡張ビルド（シークレット付き）**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`
Expected: "extension built -> dist/extension"。

- [ ] **Step 5: 直接起動の fail-closed 確認（任意）**

Run: `env -u CONNECT_SECRET node dist/server.js`
Expected: "CONNECT_SECRET is unset or not token-safe" でクラッシュ（exit≠0）。確認後 Ctrl-C 不要（即終了する）。
