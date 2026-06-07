# Watch Sync MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** U-NEXTの再生状態（play/pause/seek/rate）を、Chrome拡張とWSリレーサーバー経由で複数ユーザー間で「完全スレーブ」同期するMVPを作る。

**Architecture:** 2コンポーネント。Chrome拡張（MV3、content scriptがWSS接続と同期ロジックを保持）＋ Node.js + `ws` のWSリレーサーバー（Render Free）。同期の中核ロジックは壁時計に依存しない純粋関数 `sync-core` に切り出し、拡張・サーバー両方から使う。ホストはルーム作成者固定（ホストトークンで本人確認）。方式C＝ホストが5秒ごとに全状態を送り、サーバーが最新状態を保持して途中参加・ドリフト・再接続をカバーする。

**Tech Stack:** TypeScript / esbuild（拡張バンドル）/ Node.js + `ws`（サーバー）/ vitest（テスト）/ Render Free（デプロイ、将来Cloudflare Workers + Durable Objectsへ移行）。

**Spec:** `docs/superpowers/specs/2026-06-05-watch-sync-design.md`

---

## File Structure

```
package.json                      # ルート単一パッケージ、type:module、スクリプト群
tsconfig.json                     # strict TS
vitest.config.ts                  # node環境、**/*.test.ts
build.mjs                         # esbuildで拡張をdist/extensionへバンドル

shared/
  protocol.ts                     # メッセージ型・PROTOCOL_VERSION・parseClientMessage
  protocol.test.ts
  sync-core.ts                    # 純粋関数：projectedHostTime/needsCorrection/isStaleSeq/oneWayLatencyFromRtt/nextBackoffMs/DEFAULTS
  sync-core.test.ts

server/
  src/
    rooms.ts                      # RoomManager（ws非依存・clock注入）
    server.ts                     # ws配線・メッセージルーティング・protocol ping掃除・ログ
  rooms.test.ts
  server.test.ts

extension/
  manifest.json                   # MV3マニフェスト
  src/
    config.ts                     # SERVER_URL等の定数
    video-controller.ts           # MediaLikeインターフェース越しの状態読み書き＋ガード
    video-controller.test.ts
    ws-client.ts                  # WS接続・再接続バックオフ・app-level ping/pongでRTT測定
    ws-client.test.ts
    sync-orchestrator.ts          # video-controller + ws-client + sync-core を束ねるホスト/参加者ロジック
    sync-orchestrator.test.ts
    content.ts                    # content scriptエントリ：実DOMのvideo探索→orchestrator起動、popupメッセージ受信
    popup.ts                      # popup UIロジック＋status描画（純粋関数renderStatusは別途テスト）
    popup.test.ts
    popup.html

poc/                              # Phase 0専用（gate）。go判定後は本実装に吸収/破棄してよい
  manifest.json
  content.js
```

設計境界：壁時計に触れる・I/Oする層（`server.ts`, `content.ts`, `ws-client`のソケット部分）と、純粋ロジック層（`sync-core`, `rooms`のRoomManager, `sync-orchestrator`の判断, `protocol`のパース）を分離する。純粋層は `now`/`genId`/`genToken`/RTTなどを引数注入で受け取り、TDDで固める。

---

## Task 0: プロジェクト雛形

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `shared/smoke.test.ts`（疎通確認、後で削除）

- [ ] **Step 1: package.json を作成**

```json
{
  "name": "unext-sync",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build:extension": "node build.mjs",
    "build:server": "esbuild server/src/server.ts --bundle --platform=node --format=esm --outfile=dist/server.js --packages=external",
    "start": "node dist/server.js",
    "dev:server": "tsx watch server/src/server.ts"
  }
}
```

- [ ] **Step 2: 依存をインストール**

Run:
```bash
npm install ws
npm install -D typescript vitest esbuild tsx @types/node @types/ws @types/chrome
```
Expected: `node_modules/` 生成、`package.json` に dependencies/devDependencies 追記。

- [ ] **Step 3: tsconfig.json を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "lib": ["ES2022", "DOM"],
    "types": ["node", "chrome"]
  },
  "include": ["shared", "server", "extension"]
}
```

- [ ] **Step 4: vitest.config.ts を作成**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
```

- [ ] **Step 5: 疎通テストを書いて実行**

`shared/smoke.test.ts`:
```ts
import { test, expect } from "vitest";

test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```
Run: `npm test`
Expected: 1 passed。

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts shared/smoke.test.ts
git commit -m "chore: scaffold TS + vitest project"
```

---

## Task 1: Phase 0 PoC（gate・最重要）

> ⚠️ このタスクが go にならない限り Task 2 以降に進まない。U-NEXTがiframe/Shadow DOM/独自プレイヤーで `<video>` を囲っている場合、MVPの前提（content scriptからの再生制御）が崩れ、設計を見直す必要がある。

**Files:**
- Create: `poc/manifest.json`
- Create: `poc/content.js`

- [ ] **Step 1: PoC用マニフェストを作成**

`poc/manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "Watch Sync PoC",
  "version": "0.0.1",
  "content_scripts": [
    {
      "matches": ["https://video.unext.jp/*", "https://*.unext.jp/*"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": true
    }
  ]
}
```
注：U-NEXT視聴ページのドメイン/パスは確定情報ではない。実機で実際のURLを確認し `matches` を更新すること。

- [ ] **Step 2: video探索＋制御検証スクリプトを作成**

`poc/content.js`:
```js
// Phase 0 PoC: U-NEXTプレイヤーの<video>に到達し、読み書きできるか検証する。
// すべての結果を [WatchSync PoC] プレフィックスでconsoleに出す。
(function () {
  const TAG = "[WatchSync PoC]";
  const frame = window === window.top ? "TOP" : "IFRAME(" + location.href + ")";

  function deepFindVideo(root) {
    // 通常DOM
    const direct = root.querySelector && root.querySelector("video");
    if (direct) return { video: direct, via: "querySelector" };
    // Shadow DOMを再帰探索
    const walker = (root.querySelectorAll ? root.querySelectorAll("*") : []);
    for (const el of walker) {
      if (el.shadowRoot) {
        const found = deepFindVideo(el.shadowRoot);
        if (found) return { video: found.video, via: "shadowRoot>" + found.via };
      }
    }
    return null;
  }

  function probe() {
    const found = deepFindVideo(document);
    if (!found) {
      console.log(TAG, frame, "video NOT found yet");
      return false;
    }
    const v = found.video;
    console.log(TAG, frame, "video FOUND via", found.via, {
      readCurrentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      playbackRate: v.playbackRate,
      readonlyHint: Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(v), "currentTime"
      ),
    });
    // 制御テスト：5秒前へseekしてみる（小さく）
    try {
      const before = v.currentTime;
      v.currentTime = Math.max(0, before - 5);
      console.log(TAG, frame, "seek write attempt", { before, after: v.currentTime });
    } catch (e) {
      console.log(TAG, frame, "seek write FAILED", e);
    }
    return true;
  }

  if (!probe()) {
    const mo = new MutationObserver(() => {
      if (probe()) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 30000);
  }
})();
```

- [ ] **Step 3: 拡張を読み込んで実機検証（手動）**

手順:
1. Chromeで `chrome://extensions` を開き、デベロッパーモードON。
2. 「パッケージ化されていない拡張機能を読み込む」で `poc/` を選択。
3. U-NEXTにログインし、任意のタイトルを再生。
4. DevToolsのConsoleで `[WatchSync PoC]` ログを確認。iframe内の場合は上部のフレームセレクタで該当フレームを選ぶ。

確認項目（go/no-go判定）:
- `video FOUND via ...`（到達方法：querySelector / shadowRoot> / iframe）が出るか。
- `readCurrentTime` が実値（増えていく）か。
- `seek write attempt` で `after` が `before - 5` 付近に変わり、かつ画面の再生位置が実際に動くか。
- `paused` の読み取り、`playbackRate` の読み取りができるか。

- [ ] **Step 4: 判定を記録**

検証結果を spec の Phase 0 節に追記する。

Run:
```bash
# go の場合：到達方法を1行追記（例：直querySelector / iframe内querySelector / Shadow DOM経由）
# no-go の場合：何がブロックされたか（DRM video要素が隠蔽 / currentTime書込が無視される 等）を追記
```
（実際の追記は spec ファイルを編集して行う。go なら Task 2 へ。no-go ならここで停止し、設計の再検討に戻る。）

- [ ] **Step 5: コミット**

```bash
git add poc/ docs/superpowers/specs/2026-06-05-watch-sync-design.md
git commit -m "feat: Phase 0 PoC for U-NEXT video reachability (gate)"
```

> 以降の Task 2〜10 は **Step 4 が go の場合のみ** 着手する。`matches` パターンや到達方法（iframe/Shadow DOM）は Task 5（video-controller）の実装に反映する。

---

## Task 2: プロトコル定義とパース

**Files:**
- Create: `shared/protocol.ts`
- Test: `shared/protocol.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`shared/protocol.test.ts`:
```ts
import { test, expect } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "./protocol";

test("PROTOCOL_VERSION is 1", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

test("parses a valid sync message", () => {
  const raw = JSON.stringify({
    v: 1, type: "sync", event: "play",
    playing: true, currentTime: 120.5, playbackRate: 1, seq: 42,
  });
  expect(parseClientMessage(raw)).toEqual({
    v: 1, type: "sync", event: "play",
    playing: true, currentTime: 120.5, playbackRate: 1, seq: 42,
  });
});

test("parses create and join", () => {
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "create" }))).toEqual({
    v: 1, type: "create",
  });
  expect(parseClientMessage(JSON.stringify({
    v: 1, type: "join", roomId: "abcd1234", role: "host", hostToken: "t",
  }))).toMatchObject({ type: "join", role: "host", hostToken: "t" });
});

test("rejects wrong version, bad JSON, unknown type, missing fields", () => {
  expect(parseClientMessage(JSON.stringify({ v: 2, type: "create" }))).toBeNull();
  expect(parseClientMessage("not json")).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "bogus" }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ v: 1, type: "sync" }))).toBeNull();
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run shared/protocol.test.ts`
Expected: FAIL（`./protocol` が存在しない）。

- [ ] **Step 3: 実装する**

`shared/protocol.ts`:
```ts
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
export type ServerMessage =
  | CreatedMessage | JoinedMessage | StateMessage | HostStatusMessage | PongMessage;

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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run shared/protocol.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat: wire protocol types and parseClientMessage"
```

---

## Task 3: sync-core 純粋関数

**Files:**
- Create: `shared/sync-core.ts`
- Test: `shared/sync-core.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`shared/sync-core.test.ts`:
```ts
import { test, expect } from "vitest";
import {
  projectedHostTime, needsCorrection, isStaleSeq,
  oneWayLatencyFromRtt, nextBackoffMs, DEFAULTS,
} from "./sync-core";

const playing = { playing: true, currentTime: 100, playbackRate: 1, seq: 1 };
const paused = { playing: false, currentTime: 100, playbackRate: 1, seq: 1 };

test("projectedHostTime adds latency+elapsed scaled by rate while playing", () => {
  // latency 0.2s + elapsed 1.0s = 1.2s @ rate 1 => 101.2
  expect(projectedHostTime(playing, 0.2, 1.0)).toBeCloseTo(101.2);
  // rate 2x
  expect(projectedHostTime({ ...playing, playbackRate: 2 }, 0.2, 1.0)).toBeCloseTo(102.4);
});

test("projectedHostTime ignores latency/elapsed when paused", () => {
  expect(projectedHostTime(paused, 5, 10)).toBe(100);
});

test("needsCorrection compares absolute diff to tolerance", () => {
  expect(needsCorrection(100, 100.5, 1)).toBe(false);
  expect(needsCorrection(100, 101.5, 1)).toBe(true);
  expect(needsCorrection(103, 100, 1)).toBe(true);
});

test("isStaleSeq drops equal-or-older seq", () => {
  expect(isStaleSeq(5, 5)).toBe(true);
  expect(isStaleSeq(4, 5)).toBe(true);
  expect(isStaleSeq(6, 5)).toBe(false);
});

test("oneWayLatencyFromRtt halves RTT and converts ms->s", () => {
  expect(oneWayLatencyFromRtt(400)).toBeCloseTo(0.2);
});

test("nextBackoffMs grows exponentially and caps", () => {
  expect(nextBackoffMs(0)).toBe(500);
  expect(nextBackoffMs(1)).toBe(1000);
  expect(nextBackoffMs(3)).toBe(4000);
  expect(nextBackoffMs(20)).toBe(30000);
});

test("DEFAULTS match the spec", () => {
  expect(DEFAULTS.toleranceSec).toBe(1);
  expect(DEFAULTS.heartbeatMs).toBe(5000);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: FAIL（`./sync-core` が存在しない）。

- [ ] **Step 3: 実装する**

`shared/sync-core.ts`:
```ts
import type { PlaybackFields } from "./protocol";

export const DEFAULTS = {
  toleranceSec: 1,
  heartbeatMs: 5000,
  pingIntervalMs: 5000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 30000,
} as const;

/**
 * 参加者ローカルで推定するホストの現在再生位置。
 * 壁時計は使わない：oneWayLatencySec（RTT/2）と、受信からの経過時間（参加者の
 * monotonicクロックで測る）だけを使う。
 */
export function projectedHostTime(
  state: PlaybackFields,
  oneWayLatencySec: number,
  elapsedSinceReceiptSec: number,
): number {
  if (!state.playing) return state.currentTime;
  return state.currentTime
    + (oneWayLatencySec + elapsedSinceReceiptSec) * state.playbackRate;
}

export function needsCorrection(
  localTime: number, expected: number, toleranceSec: number,
): boolean {
  return Math.abs(localTime - expected) > toleranceSec;
}

export function isStaleSeq(incomingSeq: number, lastAppliedSeq: number): boolean {
  return incomingSeq <= lastAppliedSeq;
}

export function oneWayLatencyFromRtt(rttMs: number): number {
  return rttMs / 2 / 1000;
}

export function nextBackoffMs(
  attempt: number,
  baseMs: number = DEFAULTS.reconnectBaseMs,
  maxMs: number = DEFAULTS.reconnectMaxMs,
): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add shared/sync-core.ts shared/sync-core.test.ts
git commit -m "feat: clock-skew-free sync-core pure functions"
```

---

## Task 4: RoomManager（ws非依存）

**Files:**
- Create: `server/src/rooms.ts`
- Test: `server/rooms.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/rooms.test.ts`:
```ts
import { test, expect, beforeEach } from "vitest";
import { RoomManager } from "./src/rooms";
import type { SyncMessage } from "../shared/protocol";

let now = 1000;
const clock = () => now;
let idCounter = 0;
let tokenCounter = 0;
const genId = () => "room" + ++idCounter;
const genToken = () => "tok" + ++tokenCounter;

function makeSync(seq: number): SyncMessage {
  return {
    v: 1, type: "sync", event: "heartbeat",
    playing: true, currentTime: 10 + seq, playbackRate: 1, seq,
  };
}

let rm: RoomManager;
beforeEach(() => {
  now = 1000; idCounter = 0; tokenCounter = 0;
  rm = new RoomManager({ now: clock, genId, genToken, hostTimeoutMs: 60000 });
});

test("create returns a roomId and hostToken", () => {
  const { roomId, hostToken } = rm.create("hostClient");
  expect(roomId).toBe("room1");
  expect(hostToken).toBe("tok1");
});

test("creator joining as host with correct token becomes host", () => {
  const { roomId, hostToken } = rm.create("c1");
  const r = rm.join(roomId, "c1", "host", hostToken);
  expect(r.outcome).toBe("joined-host");
});

test("host join with wrong token falls back to participant (host_taken)", () => {
  const { roomId } = rm.create("c1");
  rm.join(roomId, "c1", "host", "tok1"); // claim host first
  const r = rm.join(roomId, "c2", "host", "WRONG");
  expect(r.outcome).toBe("host_taken");
});

test("participant join into unknown room fails", () => {
  const r = rm.join("nope", "c9", "participant");
  expect(r.outcome).toBe("no_room");
});

test("late participant receives lastState", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.recordSync(roomId, "c1", makeSync(1));
  const r = rm.join(roomId, "c2", "participant");
  expect(r.outcome).toBe("joined-participant");
  expect(r.lastState?.seq).toBe(1);
});

test("recordSync from host broadcasts to participants only", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.join(roomId, "c2", "participant");
  rm.join(roomId, "c3", "participant");
  const res = rm.recordSync(roomId, "c1", makeSync(1));
  expect(res.broadcastTo.sort()).toEqual(["c2", "c3"]);
});

test("recordSync from non-host is ignored", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.join(roomId, "c2", "participant");
  const res = rm.recordSync(roomId, "c2", makeSync(1));
  expect(res.broadcastTo).toEqual([]);
});

test("host reconnect within timeout reclaims slot with token", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  const dropped = rm.removeClient(roomId, "c1");
  expect(dropped.hostDisconnected).toBe(true);
  now += 30000; // < 60s
  const r = rm.join(roomId, "c1b", "host", hostToken);
  expect(r.outcome).toBe("joined-host");
});

test("host slot released after timeout sweep", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  rm.removeClient(roomId, "c1");
  now += 61000;
  const released = rm.sweepHostTimeouts();
  expect(released).toContain(roomId);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run server/rooms.test.ts`
Expected: FAIL（`./src/rooms` が存在しない）。

- [ ] **Step 3: 実装する**

`server/src/rooms.ts`:
```ts
import type { StateMessage, SyncMessage } from "../../shared/protocol";

export type JoinOutcome =
  | "joined-host" | "joined-participant" | "host_taken" | "no_room";

export interface JoinResult {
  outcome: JoinOutcome;
  lastState: StateMessage | null;
}

interface Room {
  id: string;
  hostToken: string;
  hostId: string | null;          // 現在接続中のホストclientId
  hostDisconnectedAt: number | null;
  lastState: StateMessage | null;
  clients: Set<string>;           // ホストを含む全接続clientId
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
      id, hostToken, hostId: null, hostDisconnectedAt: null,
      lastState: null, clients: new Set(),
    });
    return { roomId: id, hostToken };
  }

  join(
    roomId: string, clientId: string,
    role: "host" | "participant", hostToken?: string,
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
    roomId: string, clientId: string, msg: SyncMessage,
  ): { broadcastTo: string[]; state: StateMessage | null } {
    const room = this.rooms.get(roomId);
    if (!room || room.hostId !== clientId) return { broadcastTo: [], state: null };
    const state: StateMessage = {
      v: msg.v, type: "state", event: msg.event,
      playing: msg.playing, currentTime: msg.currentTime,
      playbackRate: msg.playbackRate, seq: msg.seq,
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
      if (room.hostId === null && room.hostDisconnectedAt !== null
          && t - room.hostDisconnectedAt > this.deps.hostTimeoutMs) {
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run server/rooms.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add server/src/rooms.ts server/rooms.test.ts
git commit -m "feat: ws-agnostic RoomManager with host-token slot management"
```

---

## Task 5: WSサーバー配線

**Files:**
- Create: `server/src/server.ts`
- Test: `server/server.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/server.test.ts`:
```ts
import { test, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer } from "./src/server";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  return new Promise((res, rej) => {
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
}
const send = (ws: WebSocket, o: any) => ws.send(JSON.stringify(o));

test("create returns created with roomId and hostToken", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const msg = await nextMsg(host);
  expect(msg.type).toBe("created");
  expect(typeof msg.roomId).toBe("string");
  expect(typeof msg.hostToken).toBe("string");
});

test("host sync is broadcast to participant", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await nextMsg(host);
  send(host, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: created.hostToken });
  await nextMsg(host); // joined

  const guest = await connect(port);
  send(guest, { v: 1, type: "join", roomId: created.roomId, role: "participant" });
  await nextMsg(guest); // joined

  send(host, {
    v: 1, type: "sync", event: "seek",
    playing: true, currentTime: 345.8, playbackRate: 1, seq: 1,
  });
  const state = await nextMsg(guest);
  expect(state).toMatchObject({ type: "state", event: "seek", currentTime: 345.8, seq: 1 });
});

test("late participant immediately receives lastState", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await nextMsg(host);
  send(host, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: created.hostToken });
  await nextMsg(host);
  send(host, { v: 1, type: "sync", event: "play", playing: true, currentTime: 50, playbackRate: 1, seq: 1 });

  const late = await connect(port);
  send(late, { v: 1, type: "join", roomId: created.roomId, role: "participant" });
  const joined = await nextMsg(late);
  expect(joined.type).toBe("joined");
  const state = await nextMsg(late);
  expect(state).toMatchObject({ type: "state", currentTime: 50, seq: 1 });
});

test("second host with wrong token gets host_taken", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const host = await connect(port);
  send(host, { v: 1, type: "create" });
  const created = await nextMsg(host);
  send(host, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: created.hostToken });
  await nextMsg(host);

  const imposter = await connect(port);
  send(imposter, { v: 1, type: "join", roomId: created.roomId, role: "host", hostToken: "WRONG" });
  const msg = await nextMsg(imposter);
  expect(msg.type).toBe("host_taken");
});

test("ping gets pong with same id", async () => {
  const { port, stop: s } = await startServer(0);
  stop = s;
  const ws = await connect(port);
  send(ws, { v: 1, type: "ping", id: 7 });
  const msg = await nextMsg(ws);
  expect(msg).toMatchObject({ type: "pong", id: 7 });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run server/server.test.ts`
Expected: FAIL（`./src/server` が存在しない）。

- [ ] **Step 3: 実装する**

`server/src/server.ts`:
```ts
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  parseClientMessage, PROTOCOL_VERSION,
  type ServerMessage,
} from "../../shared/protocol";
import { RoomManager } from "./rooms";
import { DEFAULTS } from "../../shared/sync-core";

interface ClientCtx {
  id: string;
  roomId: string | null;
  isAlive: boolean;
}

export interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

function log(...args: unknown[]) {
  // 接続/切断/エラーのみ
  console.log(new Date().toISOString(), ...args);
}

function genRoomId(): string {
  // 推測耐性のある短いID（8桁の英数）
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export async function startServer(port = Number(process.env.PORT) || 8080): Promise<RunningServer> {
  const rooms = new RoomManager({
    now: () => Date.now(),
    genId: genRoomId,
    genToken: () => randomUUID(),
    hostTimeoutMs: 60000,
  });
  const ctxOf = new WeakMap<WebSocket, ClientCtx>();

  const wss = new WebSocketServer({ port });
  await new Promise<void>((res) => wss.on("listening", () => res()));

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const findSocket = (clientId: string): WebSocket | undefined => {
    for (const ws of wss.clients) {
      if (ctxOf.get(ws)?.id === clientId) return ws;
    }
    return undefined;
  };
  const broadcastHostStatus = (
    roomId: string, type: "host_disconnected" | "host_resumed",
  ) => {
    for (const cid of rooms.participantsOf(roomId)) {
      const sock = findSocket(cid);
      if (sock) send(sock, { v: PROTOCOL_VERSION, type });
    }
  };

  wss.on("connection", (ws) => {
    const ctx: ClientCtx = { id: randomUUID(), roomId: null, isAlive: true };
    ctxOf.set(ws, ctx);
    log("connect", ctx.id);

    ws.on("pong", () => { ctx.isAlive = true; });

    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) { log("error", "bad message from", ctx.id); return; }

      switch (msg.type) {
        case "ping":
          send(ws, { v: PROTOCOL_VERSION, type: "pong", id: msg.id });
          break;
        case "create": {
          const { roomId, hostToken } = rooms.create(ctx.id);
          send(ws, { v: PROTOCOL_VERSION, type: "created", roomId, hostToken });
          break;
        }
        case "join": {
          const r = rooms.join(msg.roomId, ctx.id, msg.role, msg.hostToken);
          if (r.outcome === "no_room") { send(ws, { v: PROTOCOL_VERSION, type: "host_taken" }); return; }
          ctx.roomId = msg.roomId;
          if (r.outcome === "host_taken") {
            send(ws, { v: PROTOCOL_VERSION, type: "host_taken" });
          } else {
            send(ws, {
              v: PROTOCOL_VERSION, type: "joined",
              role: r.outcome === "joined-host" ? "host" : "participant",
            });
            if (r.outcome === "joined-host") broadcastHostStatus(msg.roomId, "host_resumed");
          }
          if (r.outcome === "joined-participant" && r.lastState) send(ws, r.lastState);
          break;
        }
        case "sync": {
          if (!ctx.roomId) return;
          const { broadcastTo, state } = rooms.recordSync(ctx.roomId, ctx.id, msg);
          if (!state) return;
          for (const cid of broadcastTo) {
            const sock = findSocket(cid);
            if (sock) send(sock, state);
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      log("disconnect", ctx.id);
      if (ctx.roomId) {
        const { hostDisconnected } = rooms.removeClient(ctx.roomId, ctx.id);
        if (hostDisconnected) broadcastHostStatus(ctx.roomId, "host_disconnected");
        rooms.deleteIfEmpty(ctx.roomId);
      }
    });

    ws.on("error", (e) => log("error", ctx.id, String(e)));
  });

  // protocol-level ping でゾンビ接続を掃除
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const ctx = ctxOf.get(ws);
      if (!ctx) continue;
      if (!ctx.isAlive) { ws.terminate(); continue; }
      ctx.isAlive = false;
      ws.ping();
    }
  }, 30000);

  // ホストスロットのタイムアウト掃除
  const sweepTimer = setInterval(() => rooms.sweepHostTimeouts(), 10000);

  const stop = () =>
    new Promise<void>((resolve) => {
      clearInterval(pingTimer);
      clearInterval(sweepTimer);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    });

  const addr = wss.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  log("listening", boundPort);
  return { port: boundPort, stop };
}

// 直接起動された場合（Render等）
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startServer().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run server/server.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add server/src/server.ts server/server.test.ts
git commit -m "feat: ws relay server with rooms, host status, ping/pong"
```

---

## Task 6: video-controller（MediaLikeインターフェース）

**Files:**
- Create: `extension/src/video-controller.ts`
- Test: `extension/src/video-controller.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/video-controller.test.ts`:
```ts
import { test, expect, vi } from "vitest";
import { VideoController, type MediaLike } from "./video-controller";

function fakeMedia(init: Partial<MediaLike> = {}): MediaLike & { _play: any; _pause: any } {
  const m: any = {
    currentTime: init.currentTime ?? 0,
    playbackRate: init.playbackRate ?? 1,
    paused: init.paused ?? true,
    play: vi.fn(() => { m.paused = false; return Promise.resolve(); }),
    pause: vi.fn(() => { m.paused = true; }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  m._play = m.play; m._pause = m.pause;
  return m;
}

test("readState reflects the media element", () => {
  const m = fakeMedia({ currentTime: 12.3, playbackRate: 1.5, paused: false });
  const c = new VideoController(m);
  expect(c.readState()).toEqual({ playing: true, currentTime: 12.3, playbackRate: 1.5 });
});

test("apply sets time/rate and play state", async () => {
  const m = fakeMedia({ paused: true });
  const c = new VideoController(m);
  await c.apply({ playing: true, currentTime: 100, playbackRate: 2 });
  expect(m.currentTime).toBe(100);
  expect(m.playbackRate).toBe(2);
  expect(m.play).toHaveBeenCalled();
});

test("apply pauses when playing=false", async () => {
  const m = fakeMedia({ paused: false });
  const c = new VideoController(m);
  await c.apply({ playing: false, currentTime: 100, playbackRate: 1 });
  expect(m.pause).toHaveBeenCalled();
});

test("apply does not seek when within toleranceSec", async () => {
  const m = fakeMedia({ currentTime: 100, paused: false });
  const c = new VideoController(m);
  await c.apply({ playing: true, currentTime: 100.5, playbackRate: 1 }, 1);
  expect(m.currentTime).toBe(100); // 0.5s差 < 1s → seekしない
});

test("isApplying guard is true only during apply", async () => {
  const m = fakeMedia();
  const c = new VideoController(m);
  expect(c.isApplying()).toBe(false);
  const p = c.apply({ playing: true, currentTime: 5, playbackRate: 1 });
  // applyは同期的にフラグを立てる
  expect(c.isApplying()).toBe(true);
  await p;
  expect(c.isApplying()).toBe(false);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run extension/src/video-controller.test.ts`
Expected: FAIL（`./video-controller` が存在しない）。

- [ ] **Step 3: 実装する**

`extension/src/video-controller.ts`:
```ts
export interface MediaLike {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ReadableState {
  playing: boolean;
  currentTime: number;
  playbackRate: number;
}

/**
 * <video>要素（MediaLike）への状態読み書きを担う。
 * apply中は isApplying() が true になり、呼び出し側が自分のイベント送出を抑止できる
 * （フィードバックループ防止＝spec §5）。
 */
export class VideoController {
  private applying = false;
  constructor(private media: MediaLike) {}

  readState(): ReadableState {
    return {
      playing: !this.media.paused,
      currentTime: this.media.currentTime,
      playbackRate: this.media.playbackRate,
    };
  }

  isApplying(): boolean {
    return this.applying;
  }

  async apply(target: ReadableState, toleranceSec = 0): Promise<void> {
    this.applying = true;
    try {
      if (Math.abs(this.media.currentTime - target.currentTime) > toleranceSec) {
        this.media.currentTime = target.currentTime;
      }
      if (this.media.playbackRate !== target.playbackRate) {
        this.media.playbackRate = target.playbackRate;
      }
      if (target.playing && this.media.paused) {
        await this.media.play();
      } else if (!target.playing && !this.media.paused) {
        this.media.pause();
      }
    } finally {
      this.applying = false;
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run extension/src/video-controller.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add extension/src/video-controller.ts extension/src/video-controller.test.ts
git commit -m "feat: VideoController with apply guard over MediaLike"
```

---

## Task 7: ws-client（再接続・RTT測定）

**Files:**
- Create: `extension/src/ws-client.ts`
- Test: `extension/src/ws-client.test.ts`

> このタスクでは「再接続バックオフの判断」と「RTTからの片道遅延算出」をテスト対象にする。WebSocketのソケット生成自体はファクトリ注入で差し替え可能にし、フェイクで検証する。

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/ws-client.test.ts`:
```ts
import { test, expect, vi } from "vitest";
import { WsClient, type SocketLike } from "./ws-client";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  sent: string[] = [];
  readyState = 0;
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(o: any) { this.onmessage?.(JSON.stringify(o)); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const factory = () => { const s = new FakeSocket(); sockets.push(s); return s; };
  const onMessage = vi.fn();
  const client = new WsClient("wss://x", { factory, onMessage });
  return { sockets, client, onMessage };
}

test("connect sends queued nothing until open, reports open", () => {
  const { sockets, client } = setup();
  const opened = vi.fn();
  client.onOpen = opened;
  client.connect();
  sockets[0].open();
  expect(opened).toHaveBeenCalled();
});

test("incoming messages are parsed and forwarded", () => {
  const { sockets, client, onMessage } = setup();
  client.connect();
  sockets[0].open();
  sockets[0].emit({ v: 1, type: "joined", role: "host" });
  expect(onMessage).toHaveBeenCalledWith({ v: 1, type: "joined", role: "host" });
});

test("pong updates RTT estimate (oneWayLatencySec)", () => {
  const now = vi.fn();
  const { sockets, client } = setupWithClock(now);
  client.connect();
  sockets[0].open();
  now.mockReturnValue(1000);
  client.sendPing();          // id=1 sent at t=1000
  now.mockReturnValue(1400);  // pong at t=1400 → RTT=400ms
  sockets[0].emit({ v: 1, type: "pong", id: 1 });
  expect(client.oneWayLatencySec()).toBeCloseTo(0.2);
});

function setupWithClock(now: () => number) {
  const sockets: FakeSocket[] = [];
  const factory = () => { const s = new FakeSocket(); sockets.push(s); return s; };
  const client = new WsClient("wss://x", { factory, onMessage: () => {}, now });
  return { sockets, client };
}

test("close schedules reconnect with growing backoff", () => {
  const delays: number[] = [];
  const sockets: FakeSocket[] = [];
  const factory = () => { const s = new FakeSocket(); sockets.push(s); return s; };
  const client = new WsClient("wss://x", {
    factory, onMessage: () => {},
    schedule: (fn, ms) => { delays.push(ms); /* 即時実行しない */ },
  });
  client.connect();
  sockets[0].open();
  sockets[0].close();          // attempt 0 → 500ms
  client.connect();
  sockets[1].open();
  sockets[1].close();          // attempt 1 → 1000ms
  expect(delays).toEqual([500, 1000]);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run extension/src/ws-client.test.ts`
Expected: FAIL（`./ws-client` が存在しない）。

- [ ] **Step 3: 実装する**

`extension/src/ws-client.ts`:
```ts
import { parseServerMessageLoose } from "./parse-server";
import { oneWayLatencyFromRtt, nextBackoffMs } from "../../shared/sync-core";
import type { ServerMessage, ClientMessage } from "../../shared/protocol";

export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  readyState: number;
  send(data: string): void;
  close(): void;
}

export interface WsClientDeps {
  factory: () => SocketLike;
  onMessage: (msg: ServerMessage) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

export class WsClient {
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private pingSentAt = new Map<number, number>();
  private latencySec = 0;
  private nextPingId = 1;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private url: string, private deps: WsClientDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  connect(): void {
    const s = this.deps.factory();
    this.socket = s;
    s.onopen = () => { this.attempt = 0; this.onOpen?.(); };
    s.onmessage = (data) => {
      const msg = parseServerMessageLoose(data);
      if (!msg) return;
      if (msg.type === "pong") {
        const sent = this.pingSentAt.get(msg.id);
        if (sent !== undefined) {
          this.latencySec = oneWayLatencyFromRtt(this.now() - sent);
          this.pingSentAt.delete(msg.id);
        }
        return;
      }
      this.deps.onMessage(msg);
    };
    s.onclose = () => {
      this.onClose?.();
      const delay = nextBackoffMs(this.attempt++);
      this.schedule(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  sendPing(): void {
    const id = this.nextPingId++;
    this.pingSentAt.set(id, this.now());
    this.send({ v: 1, type: "ping", id });
  }

  oneWayLatencySec(): number {
    return this.latencySec;
  }
}
```

`extension/src/parse-server.ts`（軽量バリデータ。サーバー発メッセージは信頼するが型ガードだけ行う）:
```ts
import { PROTOCOL_VERSION, type ServerMessage } from "../../shared/protocol";

const TYPES = new Set([
  "created", "joined", "state", "host_taken",
  "host_disconnected", "host_resumed", "pong",
]);

export function parseServerMessageLoose(raw: string): ServerMessage | null {
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || o.v !== PROTOCOL_VERSION || !TYPES.has(o.type)) return null;
  return o as ServerMessage;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run extension/src/ws-client.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add extension/src/ws-client.ts extension/src/parse-server.ts extension/src/ws-client.test.ts
git commit -m "feat: WsClient with reconnect backoff and RTT-based latency"
```

---

## Task 8: sync-orchestrator（ホスト/参加者ロジック）

**Files:**
- Create: `extension/src/sync-orchestrator.ts`
- Test: `extension/src/sync-orchestrator.test.ts`

> video-controller・ws-client・sync-core を束ねる純粋寄りのロジック。タイマー駆動部分は「tick()」「onMediaEvent()」「onServerState()」メソッドに分け、外部からclock/depsを注入してTDDする。

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/sync-orchestrator.test.ts`:
```ts
import { test, expect, vi } from "vitest";
import { SyncOrchestrator } from "./sync-orchestrator";
import type { StateMessage } from "../../shared/protocol";

function deps(overrides: any = {}) {
  let t = 0;
  const sent: any[] = [];
  const applied: any[] = [];
  return {
    now: () => t,
    setNow: (v: number) => { t = v; },
    sent, applied,
    controller: {
      readState: () => ({ playing: true, currentTime: 100, playbackRate: 1 }),
      apply: vi.fn(async (s: any) => { applied.push(s); }),
      isApplying: () => false,
      ...overrides.controller,
    },
    client: {
      send: (m: any) => sent.push(m),
      oneWayLatencySec: () => overrides.latency ?? 0,
    },
  };
}

function stateMsg(seq: number, currentTime: number, playing = true): StateMessage {
  return { v: 1, type: "state", event: "heartbeat", playing, currentTime, playbackRate: 1, seq };
}

test("host mode: media event sends a sync with incremented seq", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.onMediaEvent("play");
  o.onMediaEvent("seek");
  expect(d.sent.map((m) => m.seq)).toEqual([1, 2]);
  expect(d.sent[0]).toMatchObject({ type: "sync", event: "play", currentTime: 100 });
});

test("host mode: does not send while controller is applying (guard)", () => {
  const d = deps({ controller: { isApplying: () => true } });
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.onMediaEvent("play");
  expect(d.sent).toEqual([]);
});

test("participant: applies fresh state and ignores stale seq", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  await o.onServerState(stateMsg(5, 200));
  await o.onServerState(stateMsg(4, 999)); // 古い → 無視
  expect(d.applied.length).toBe(1);
  expect(d.applied[0].currentTime).toBe(200);
});

test("participant tick corrects drift beyond tolerance using projected time", async () => {
  const d = deps({ latency: 0.2,
    controller: { readState: () => ({ playing: true, currentTime: 100, playbackRate: 1 }) } });
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  d.setNow(1000);
  await o.onServerState(stateMsg(1, 100)); // 受信時刻1000, expected@receipt=100.2
  d.setNow(4000); // 3s経過 → projected ≈ 103.2、local=100 → 差3.2 > 1 → seek
  await o.tick();
  const lastApply = d.applied.at(-1);
  expect(lastApply.currentTime).toBeCloseTo(103.2, 1);
});

test("participant tick does nothing when no state received yet", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant" });
  await o.tick();
  expect(d.applied).toEqual([]);
});

test("host heartbeat() sends current state as heartbeat event", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.heartbeat();
  expect(d.sent[0]).toMatchObject({ type: "sync", event: "heartbeat", currentTime: 100 });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run extension/src/sync-orchestrator.test.ts`
Expected: FAIL（`./sync-orchestrator` が存在しない）。

- [ ] **Step 3: 実装する**

`extension/src/sync-orchestrator.ts`:
```ts
import {
  projectedHostTime, needsCorrection, isStaleSeq, DEFAULTS,
} from "../../shared/sync-core";
import type {
  SyncEvent, SyncMessage, StateMessage,
} from "../../shared/protocol";
import type { ReadableState } from "./video-controller";

export interface OrchestratorControllerLike {
  readState(): ReadableState;
  apply(target: ReadableState, toleranceSec?: number): Promise<void>;
  isApplying(): boolean;
}
export interface OrchestratorClientLike {
  send(msg: SyncMessage): void;
  oneWayLatencySec(): number;
}
export interface OrchestratorDeps {
  role: "host" | "participant";
  controller: OrchestratorControllerLike;
  client: OrchestratorClientLike;
  now: () => number; // monotonic ms（実環境では performance.now）
}

export class SyncOrchestrator {
  private seq = 0;
  private lastAppliedSeq = -1;
  private lastState: StateMessage | null = null;
  private lastReceiptMs = 0;

  constructor(private deps: OrchestratorDeps) {}

  // ---- ホスト ----
  onMediaEvent(event: SyncEvent): void {
    if (this.deps.role !== "host") return;
    if (this.deps.controller.isApplying()) return; // フィードバック防止
    this.emit(event);
  }

  heartbeat(): void {
    if (this.deps.role !== "host") return;
    this.emit("heartbeat");
  }

  private emit(event: SyncEvent): void {
    const s = this.deps.controller.readState();
    this.deps.client.send({
      v: 1, type: "sync", event,
      playing: s.playing, currentTime: s.currentTime,
      playbackRate: s.playbackRate, seq: ++this.seq,
    });
  }

  // ---- 参加者 ----
  async onServerState(msg: StateMessage): Promise<void> {
    if (this.deps.role !== "participant") return;
    if (isStaleSeq(msg.seq, this.lastAppliedSeq)) return;
    this.lastAppliedSeq = msg.seq;
    this.lastState = msg;
    this.lastReceiptMs = this.deps.now();
    const expected = this.projected();
    await this.deps.controller.apply({
      playing: msg.playing, currentTime: expected, playbackRate: msg.playbackRate,
    });
  }

  async tick(): Promise<void> {
    if (this.deps.role !== "participant" || !this.lastState) return;
    const expected = this.projected();
    const local = this.deps.controller.readState();
    if (needsCorrection(local.currentTime, expected, DEFAULTS.toleranceSec)) {
      await this.deps.controller.apply(
        { playing: this.lastState.playing, currentTime: expected, playbackRate: this.lastState.playbackRate },
        DEFAULTS.toleranceSec,
      );
    } else if (local.playing !== this.lastState.playing
            || local.playbackRate !== this.lastState.playbackRate) {
      await this.deps.controller.apply(
        { playing: this.lastState.playing, currentTime: local.currentTime, playbackRate: this.lastState.playbackRate },
        DEFAULTS.toleranceSec,
      );
    }
  }

  private projected(): number {
    const s = this.lastState!;
    const elapsedSec = (this.deps.now() - this.lastReceiptMs) / 1000;
    return projectedHostTime(s, this.deps.client.oneWayLatencySec(), elapsedSec);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run extension/src/sync-orchestrator.test.ts`
Expected: PASS（全テスト）。

- [ ] **Step 5: コミット**

```bash
git add extension/src/sync-orchestrator.ts extension/src/sync-orchestrator.test.ts
git commit -m "feat: SyncOrchestrator host/participant logic"
```

---

## Task 9: content script・popup・manifest・config

**Files:**
- Create: `extension/src/config.ts`
- Create: `extension/src/content.ts`
- Create: `extension/src/popup.ts`
- Create: `extension/src/popup.html`
- Create: `extension/src/popup.test.ts`
- Create: `extension/manifest.json`

- [ ] **Step 1: status描画の失敗するテストを書く**

`extension/src/popup.test.ts`:
```ts
import { test, expect } from "vitest";
import { renderStatusLabel, type ConnState } from "./popup-status";

test("maps connection states to Japanese labels", () => {
  const cases: [ConnState, string][] = [
    ["idle", "未接続"],
    ["connecting", "接続中"],
    ["connected", "接続済み"],
    ["disconnected", "切断"],
    ["host_gone", "ホスト切断"],
  ];
  for (const [s, label] of cases) {
    expect(renderStatusLabel(s)).toBe(label);
  }
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run extension/src/popup.test.ts`
Expected: FAIL（`./popup-status` が存在しない）。

- [ ] **Step 3: 純粋部分と各ファイルを実装する**

`extension/src/popup-status.ts`:
```ts
export type ConnState =
  | "idle" | "connecting" | "connected" | "disconnected" | "host_gone";

export function renderStatusLabel(s: ConnState): string {
  switch (s) {
    case "idle": return "未接続";
    case "connecting": return "接続中";
    case "connected": return "接続済み";
    case "disconnected": return "切断";
    case "host_gone": return "ホスト切断";
  }
}
```

`extension/src/config.ts`:
```ts
// デプロイ後の実URLに置き換える（Task 10）。
export const SERVER_URL = "wss://unext-sync.onrender.com";
```

`extension/src/content.ts`:
```ts
import { VideoController } from "./video-controller";
import { WsClient } from "./ws-client";
import { SyncOrchestrator } from "./sync-orchestrator";
import { DEFAULTS } from "../../shared/sync-core";
import { SERVER_URL } from "./config";
import type { ServerMessage, SyncEvent } from "../../shared/protocol";

// Shadow DOM/通常DOMを再帰探索（PoCの到達方法に合わせる）。
function deepFindVideo(root: Document | ShadowRoot): HTMLVideoElement | null {
  const direct = root.querySelector("video");
  if (direct) return direct;
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) {
      const found = deepFindVideo(sr);
      if (found) return found;
    }
  }
  return null;
}

function waitForVideo(): Promise<HTMLVideoElement> {
  return new Promise((resolve) => {
    const found = deepFindVideo(document);
    if (found) return resolve(found);
    const mo = new MutationObserver(() => {
      const v = deepFindVideo(document);
      if (v) { mo.disconnect(); resolve(v); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  });
}

interface Session { roomId: string; role: "host" | "participant"; hostToken?: string; }
let started = false;

async function start(session: Session): Promise<void> {
  if (started) return;
  started = true;

  const video = await waitForVideo();
  const controller = new VideoController(video as unknown as any);

  // ブラウザWebSocketをSocketLike（onmessageは文字列）に適合させるアダプタ。
  function makeBrowserSocket(url: string) {
    const raw = new WebSocket(url);
    return {
      get readyState() { return raw.readyState; },
      send: (d: string) => raw.send(d),
      close: () => raw.close(),
      set onopen(fn: (() => void) | null) { raw.onopen = fn as any; },
      set onclose(fn: (() => void) | null) { raw.onclose = fn as any; },
      set onmessage(fn: ((data: string) => void) | null) {
        raw.onmessage = fn ? (ev: MessageEvent) => fn(String(ev.data)) : null;
      },
    } as unknown as import("./ws-client").SocketLike;
  }

  let orchestrator: SyncOrchestrator;
  const client = new WsClient(SERVER_URL, {
    factory: () => makeBrowserSocket(SERVER_URL),
    onMessage: (msg: ServerMessage) => handleServer(msg),
  });

  function handleServer(msg: ServerMessage) {
    switch (msg.type) {
      case "created":
        // hostトークンを保持してhostでjoin。roomIDをpopupへ渡して表示させる。
        session.hostToken = msg.hostToken;
        session.roomId = msg.roomId;
        chrome.storage.local.set({ ["host:" + msg.roomId]: msg.hostToken });
        chrome.runtime.sendMessage({ type: "room_created", roomId: msg.roomId }).catch(() => {});
        client.send({ v: 1, type: "join", roomId: msg.roomId, role: "host", hostToken: msg.hostToken });
        break;
      case "state":
        void orchestrator.onServerState(msg);
        break;
      // host_taken / host_disconnected / host_resumed はpopupへ転送（status更新）
      default:
        chrome.runtime.sendMessage({ type: "server_event", event: msg.type }).catch(() => {});
    }
  }

  orchestrator = new SyncOrchestrator({
    role: session.role, controller: controller as any, client: client as any,
    now: () => performance.now(),
  });

  client.onOpen = () => {
    if (session.role === "host" && !session.hostToken) {
      client.send({ v: 1, type: "create" });
    } else {
      client.send({
        v: 1, type: "join", roomId: session.roomId,
        role: session.role, hostToken: session.hostToken,
      });
    }
    // 定期ping（RTT測定）
    setInterval(() => client.sendPing(), DEFAULTS.pingIntervalMs);
  };
  client.connect();

  // ホスト：mediaイベント送出＋heartbeat。timeupdate駆動を主にし、setIntervalを従に。
  if (session.role === "host") {
    const events: SyncEvent[] = ["play", "pause", "seek", "ratechange"];
    const eventMap: Record<string, SyncEvent> = { seeked: "seek" };
    for (const dom of ["play", "pause", "seeked", "ratechange"]) {
      video.addEventListener(dom, () => orchestrator.onMediaEvent(eventMap[dom] ?? (dom as SyncEvent)));
    }
    let lastBeat = 0;
    video.addEventListener("timeupdate", () => {
      const t = performance.now();
      if (t - lastBeat >= DEFAULTS.heartbeatMs) { lastBeat = t; orchestrator.heartbeat(); }
    });
    setInterval(() => orchestrator.heartbeat(), DEFAULTS.heartbeatMs); // バックグラウンド従
  } else {
    // 参加者：定期tickでドリフト補正＋自分の誤操作を即リコンサイル。
    setInterval(() => void orchestrator.tick(), DEFAULTS.heartbeatMs);
    for (const dom of ["seeking", "play", "pause"]) {
      video.addEventListener(dom, () => {
        if (!controller.isApplying()) void orchestrator.tick();
      });
    }
  }
}

// popupからの開始指示を受ける
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "start_session") {
    void start({ roomId: msg.roomId, role: msg.role });
  }
});
```

`extension/src/popup.html`:
```html
<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><style>
    body { font: 14px sans-serif; width: 240px; padding: 12px; }
    input, button { width: 100%; margin: 4px 0; padding: 6px; box-sizing: border-box; }
    #status { margin-top: 8px; font-weight: bold; }
  </style></head>
  <body>
    <input id="room" placeholder="ルームID（参加時）" />
    <button id="create">ルーム作成（ホスト）</button>
    <button id="join">参加（参加者）</button>
    <div id="roomId"></div>
    <div id="status">未接続</div>
    <script src="popup.js"></script>
  </body>
</html>
```

`extension/src/popup.ts`:
```ts
import { renderStatusLabel, type ConnState } from "./popup-status";

const $ = (id: string) => document.getElementById(id)!;
const setStatus = (s: ConnState) => { $("status").textContent = renderStatusLabel(s); };

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id!;
}

$("create").addEventListener("click", async () => {
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "host" });
});

$("join").addEventListener("click", async () => {
  const roomId = ($("room") as HTMLInputElement).value.trim();
  if (!roomId) return;
  setStatus("connecting");
  chrome.tabs.sendMessage(await activeTabId(), { type: "start_session", role: "participant", roomId });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "room_created") {
    $("roomId").textContent = "ルームID: " + msg.roomId + "（共有してください）";
    setStatus("connected");
    return;
  }
  if (msg?.type !== "server_event") return;
  if (msg.event === "host_disconnected") setStatus("host_gone");
  else if (msg.event === "host_resumed") setStatus("connected");
  else if (msg.event === "host_taken") setStatus("connected"); // participantフォールバック
});
```

`extension/manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "Watch Sync (U-NEXT)",
  "version": "0.1.0",
  "description": "U-NEXTの再生状態を複数ユーザーで同期する",
  "permissions": ["tabs", "storage"],
  "host_permissions": ["https://video.unext.jp/*"],
  "action": { "default_popup": "popup.html" },
  "content_scripts": [
    {
      "matches": ["https://video.unext.jp/*"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ]
}
```
注：Task 1 のPoC（go確定）の結果を反映済み。動画はトップフレームの素の `querySelector` で取得できるため `all_frames: false`、`matches` は `https://video.unext.jp/*` に限定（GTM解析iframeでの多重起動を防ぐ）。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run extension/src/popup.test.ts`
Expected: PASS。

- [ ] **Step 5: コミット**

```bash
git add extension/src/config.ts extension/src/content.ts extension/src/popup.ts \
  extension/src/popup-status.ts extension/src/popup.test.ts extension/src/popup.html \
  extension/manifest.json
git commit -m "feat: content script, popup UI, manifest"
```

---

## Task 10: ビルド・デプロイ・E2E

**Files:**
- Create: `build.mjs`
- Modify: `extension/src/config.ts`（デプロイ後の実URL）

- [ ] **Step 1: 拡張ビルドスクリプトを作成**

`build.mjs`:
```js
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["extension/src/content.ts", "extension/src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist/extension",
});
await cp("extension/manifest.json", "dist/extension/manifest.json");
await cp("extension/src/popup.html", "dist/extension/popup.html");
console.log("extension built -> dist/extension");
```

- [ ] **Step 2: 全テスト＋ビルドを実行**

Run:
```bash
npm test
npm run build:extension
npm run build:server
```
Expected: テスト全PASS、`dist/extension/{content.js,popup.js,popup.html,manifest.json}` と `dist/server.js` が生成される。

- [ ] **Step 3: Renderにサーバーをデプロイ**

手順（Render Web Service / Free）:
1. GitHubにpush（`main`）。
2. Renderで New > Web Service、リポジトリを接続。
3. Build Command: `npm install && npm run build:server`
4. Start Command: `npm start`
5. `PORT` はRenderが注入（`server.ts` は `process.env.PORT` を読む）。
6. デプロイ後のURL（例 `https://unext-sync.onrender.com`）を控える。WSSは `wss://unext-sync.onrender.com`。

- [ ] **Step 4: 実URLを設定して再ビルド**

`extension/src/config.ts` の `SERVER_URL` をデプロイURLの `wss://...` に更新し、`npm run build:extension`。

Run:
```bash
npm run build:extension
git add build.mjs extension/src/config.ts
git commit -m "chore: build script and production server URL"
```

- [~] **Step 5: 手動E2Eテスト（spec §8）**

> **実施方法（2026-06-07）**: U-NEXTアカウントが同一だと「複数ブラウザ・同一動画の同時再生」がアカウント
> 制限で不可のため、当初の2プロファイル方式は不可能だった。代わりに **Node.jsスクリプトで「擬似ホスト」**
> を立て（`create`→`join(role:host)`でホストスロット確保→再生状態sync送信）、参加者だけを実ブラウザで
> 検証した。動画データを共有しない方式C設計だからこそ成立する（ホストは実ブラウザ不要）。
> サーバーは `ws://localhost:8080` ローカル起動、拡張も同URL・同CONNECT_SECRETで再ビルドして使用。
> **再利用可能な手順とスクリプトは `docs/e2e-pseudo-host-testing.md` / `scripts/e2e-host.mjs`。**

- [x] 参加者がルームIDで参加し popup が「接続済み」になる（参加者popupが「接続中」で固まる `joined`未処理の
      UI表示ギャップは本検証で発見→`popup-status.ts` の `nextStateForServerEvent` 追加で修正・確認済み）。
- [x] ホストのplay/pause/seek/ratechangeが参加者に反映される（全イベント実機確認：1:00へジャンプ＆再生 / 2:00へseek / 一時停止 / 1.5倍速）。
- [x] 参加者が手動でずらすと、最大5秒以内（または `seeking` 即時）でホスト位置に戻る（**即座に復帰**を確認）。
- [x] ホスト切断→再接続→ 参加者statusが「ホスト切断」→「接続済み」へ（**実機でpopup遷移を確認**。サーバー側 broadcast と60秒以内の同一トークン再joinもログで確認）。
- [ ] **クロックスキュー回帰**：未実施（設計上 `performance.now()`+RTT/2 のみ使用で構造的に担保、ユニットテスト済み）。
- [ ] Renderコールドスタート：ローカル検証のため対象外（本番Render接続時に別途確認）。

> **検証中に発見した別のUIギャップ（未修正）**: 拡張popupは開くたびに新規ページとして生成され初期値「未接続」で
> 始まるため、**接続中でもpopupを閉じて再度開くと「未接続」と表示される**（content scriptが接続状態の実体を持つが
> popupが開いた時に問い合わせる仕組みがない）。表示のみの問題で接続自体は維持されている。修正するなら content script
> に現在の `ConnState` を持たせ、popup起動時に問い合わせて反映する。

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "test: manual E2E pass for Watch Sync MVP"
```

---

## Self-Review メモ（spec対応表）

| spec項目 | 対応Task |
|---|---|
| §1.3 完全スレーブ / 固定ホスト / 方式C | Task 4,5,8 |
| §2 アーキテクチャ（WS接続はcontent script） | Task 9 |
| §3 コンポーネント責務 | Task 4,5,6,7,8,9 |
| §4 プロトコル（v / 型 / seq / create-join-sync / state / host_*） | Task 2,5 |
| §5 壁時計非依存・RTT片道遅延・seq・即時リコンサイル・ガード | Task 3,6,7,8 |
| §6 ホストトークン・スロットタイムアウト・再接続・ping/pong・video未検出 | Task 4,5,7,9 |
| §7.2 Renderコールドスタート・バックグラウンドスロットリング | Task 7,9,10 |
| §7.3 サーバー生成ID・推測耐性 | Task 5 |
| §8 テスト方針（sync-core/server/DOM/手動/スキュー回帰） | Task 3,4,5,6,10 |
| §11 Phase 0 PoCゲート | Task 1 |
| §11 Phase 1 実装対象 | Task 2–10 |
