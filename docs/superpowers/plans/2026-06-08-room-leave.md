# ルーム退出機能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 作成/参加したルームから（confirm を挟んで）退出できるようにし、退出時に再接続ループとセッションの副作用を確実に停止する。

**Architecture:** 退出はクライアント側のみで完結（プロトコル・worker 非変更）。`WsClient` に再接続停止用の `close()` を足し、content script はセッションの副作用をライフサイクルゲート（`session-gate.ts`）で一括解放する。ゲートは世代フラグで `start()` の `await` 中断中（connecting 中）の退出も abort できるため、生きたセッションが復活しない。popup には退出ボタンとインライン2段階 confirm を追加する。

**Tech Stack:** TypeScript / Chrome MV3 拡張 / esbuild / vitest / Biome

正典: `docs/superpowers/specs/2026-06-08-room-leave-design.md`

---

## File Structure

- **Create** `extension/src/session-gate.ts` — セッションのライフサイクル管理（世代フラグ＋disposer 登録）。純粋・DOM 非依存・テスト可能。
- **Create** `extension/src/session-gate.test.ts` — 上記のユニットテスト（connecting-race の核を担保）。
- **Modify** `extension/src/ws-client.ts` — `stopped` フラグ＋`close()` 追加。停止時は再接続せず `onClose` も呼ばない。
- **Modify** `extension/src/ws-client.test.ts` — `close()` 後に再接続しない／`onClose` を呼ばないテスト。
- **Modify** `extension/src/popup-status.ts` — `leaveControlsVisible(s)` 追加（純粋関数）。
- **Modify** `extension/src/popup.test.ts` — `leaveControlsVisible` のテスト。
- **Modify** `extension/src/content.ts` — ゲート配線・disposer 登録・abort チェック・`waitForVideo` 中断可能化・`leave_session` ハンドラ。
- **Modify** `extension/src/popup.html` — 退出ブロック（`.panel` 内）＋CSS。
- **Modify** `extension/src/popup.ts` — 退出ボタン配線・2段階 confirm・idle リセット。

---

## Task 1: WsClient に再接続停止（`close()`）を追加

**Files:**
- Modify: `extension/src/ws-client.ts`
- Test: `extension/src/ws-client.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/ws-client.test.ts` の末尾（line 100 の後）に追加:

```ts
test("close() stops reconnect and does not call onClose", () => {
  const delays: number[] = [];
  const sockets: FakeSocket[] = [];
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const onClose = vi.fn();
  const client = new WsClient("wss://x", {
    factory,
    onMessage: () => {},
    schedule: (_fn, ms) => {
      delays.push(ms); /* 即時実行しない */
    },
  });
  client.onClose = onClose;
  client.connect();
  sockets[0].open();
  client.close(); // stopped を立て、FakeSocket.close() → onclose を同期発火させる
  expect(delays).toEqual([]); // 再接続をスケジュールしない
  expect(onClose).not.toHaveBeenCalled(); // 意図的停止では切断扱いにしない
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/ws-client.test.ts`
Expected: FAIL（`client.close is not a function`）

- [ ] **Step 3: 実装する**

`extension/src/ws-client.ts` を編集。

まず private フィールドを追加（`private socket: SocketLike | null = null;` の直後、line 24 付近）:

```ts
  private stopped = false;
```

`connect()`（line 40-65）を以下に置き換える:

```ts
  connect(): void {
    if (this.stopped) return;
    const s = this.deps.factory();
    this.socket = s;
    s.onopen = () => {
      this.onOpen?.();
    };
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
      this.pingSentAt.clear();
      if (this.stopped) return; // 意図的停止：再接続もせず onClose も呼ばない
      this.onClose?.();
      const delay = nextBackoffMs(this.attempt++);
      this.schedule(() => this.connect(), delay);
    };
  }

  close(): void {
    this.stopped = true;
    this.socket?.close();
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/ws-client.test.ts`
Expected: PASS（既存テストも全 PASS）

- [ ] **Step 5: コミット**

```bash
git add extension/src/ws-client.ts extension/src/ws-client.test.ts
git commit -m "feat(ws-client): 再接続を止める close() を追加（停止時は onClose を呼ばない）"
```

---

## Task 2: popup-status に `leaveControlsVisible` を追加

**Files:**
- Modify: `extension/src/popup-status.ts`
- Test: `extension/src/popup.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/popup.test.ts` の import に `leaveControlsVisible` を足す（line 3-12 の import 群に追加）:

```ts
import {
  type ConnState,
  formatRosterLine,
  isActiveSession,
  leaveControlsVisible,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
  unavailableNotice,
} from "./popup-status";
```

ファイル末尾に追加:

```ts
test("leaveControlsVisible: idle 以外で true（セッションがある間だけ退出UIを出す）", () => {
  const cases: [ConnState, boolean][] = [
    ["idle", false],
    ["connecting", true],
    ["connected", true],
    ["disconnected", true],
    ["host_gone", true],
    ["no_room", true],
  ];
  for (const [s, expected] of cases) {
    expect(leaveControlsVisible(s)).toBe(expected);
  }
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: FAIL（`leaveControlsVisible` 未定義）

- [ ] **Step 3: 実装する**

`extension/src/popup-status.ts` の `isActiveSession`（line 48-51）の直後に追加:

```ts
/** セッションが存在する間（idle 以外）だけ退出 UI を表示する。再接続中・切断中・ホスト切断・
 *  ルーム不在のいずれでも退出（＝停止）できるべきなので idle のみ false。 */
export function leaveControlsVisible(s: ConnState): boolean {
  return s !== "idle";
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add extension/src/popup-status.ts extension/src/popup.test.ts
git commit -m "feat(popup-status): 退出UIの表示判定 leaveControlsVisible を追加"
```

---

## Task 3: セッションライフサイクルゲート（`session-gate.ts`）

connecting-race 対策の核。世代フラグで「古い `start()` の無効化」を、disposer 登録で「副作用の一括解放」を担う純粋モジュール。

**Files:**
- Create: `extension/src/session-gate.ts`
- Test: `extension/src/session-gate.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/session-gate.test.ts` を新規作成:

```ts
import { expect, test, vi } from "vitest";
import { makeSessionGate } from "./session-gate";

test("begin で開始したセッションは現行、end で aborted になる", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  expect(s.aborted()).toBe(false);
  gate.end();
  expect(s.aborted()).toBe(true);
});

test("add で登録した解放処理を dispose が LIFO で実行する", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  const order: number[] = [];
  s.add(() => order.push(1));
  s.add(() => order.push(2));
  s.dispose();
  expect(order).toEqual([2, 1]);
});

test("end は登録済みの解放処理をすべて実行する", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  const d1 = vi.fn();
  const d2 = vi.fn();
  s.add(d1);
  s.add(d2);
  gate.end();
  expect(d1).toHaveBeenCalledTimes(1);
  expect(d2).toHaveBeenCalledTimes(1);
});

test("新しい begin は直前のセッションを無効化する（古い start の復活を防ぐ）", () => {
  const gate = makeSessionGate();
  const first = gate.begin();
  const second = gate.begin();
  expect(first.aborted()).toBe(true);
  expect(second.aborted()).toBe(false);
});

test("dispose は冪等（二度呼んでも解放処理を再実行しない）", () => {
  const gate = makeSessionGate();
  const s = gate.begin();
  const d = vi.fn();
  s.add(d);
  s.dispose();
  s.dispose();
  expect(d).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/session-gate.test.ts`
Expected: FAIL（`session-gate` モジュールが存在しない）

- [ ] **Step 3: 実装する**

`extension/src/session-gate.ts` を新規作成:

```ts
/**
 * セッションのライフサイクル管理。content script が WS 接続・タイマー・オブザーバ等の副作用を
 * 1セッションにまとめて確実に解放するためのゲート。さらに connecting 中（start() の await
 * 中断中）に退出されても、再開した start() が abort を検知して生きたセッションを復活させない
 * ようにする（spec: 2026-06-08-room-leave-design.md §2）。
 *
 * - begin(): 新しい世代のセッションを開始する（直前の世代は無効化＝aborted() が true になる）。
 * - Session.add(): 解放処理を登録する（リソース生成のたびに即登録する）。
 * - Session.aborted(): 自分の世代が現行でなくなったら true（await 直後に確認し早期 return する）。
 * - Session.dispose(): 登録済み解放処理を LIFO で1回ずつ実行する（冪等）。
 * - end(): 現行セッションを abort し、登録済み解放処理を実行する（退出時に呼ぶ）。
 */
export interface Session {
  aborted(): boolean;
  add(dispose: () => void): void;
  dispose(): void;
}

export interface SessionGate {
  begin(): Session;
  end(): void;
}

export function makeSessionGate(): SessionGate {
  let gen = 0;
  let currentDisposers: Array<() => void> | null = null;

  return {
    begin(): Session {
      const myGen = ++gen;
      const disposers: Array<() => void> = [];
      currentDisposers = disposers;
      return {
        aborted: () => myGen !== gen,
        add: (dispose) => disposers.push(dispose),
        dispose: () => {
          while (disposers.length) disposers.pop()?.();
        },
      };
    },
    end(): void {
      gen++; // 現行セッションの aborted() を true にする
      if (currentDisposers) {
        while (currentDisposers.length) currentDisposers.pop()?.();
        currentDisposers = null;
      }
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/session-gate.test.ts`
Expected: PASS（5件）

- [ ] **Step 5: コミット**

```bash
git add extension/src/session-gate.ts extension/src/session-gate.test.ts
git commit -m "feat(session-gate): セッション副作用の一括解放＋世代abortゲートを追加"
```

---

## Task 4: content.ts にゲートを配線（disposer 登録＋abort チェック＋leave_session）

content.ts は「組み立て層」でユニットテストは持たない（chrome/DOM/WebSocket/fetch 依存）。検証は型チェック＋ビルド＋手動 E2E。実挙動の回帰は本タスクで配線した `session-gate`（Task 3 でテスト済み）が担保する。

> 注意: content.ts には既に接続設定用の `interface Session`（roomId/role…）があるため、ゲートの戻り値は `life` という変数名で受ける（型注釈は付けない＝名前衝突を避ける）。

**Files:**
- Modify: `extension/src/content.ts`

- [ ] **Step 1: import を追加**

`extension/src/content.ts` の import 群末尾（line 14 `import { WsClient } from "./ws-client";` の直後）に追加:

```ts
import { makeSessionGate } from "./session-gate";
```

- [ ] **Step 2: `waitForVideo` を中断可能化**

現在の `waitForVideo`（line 30-43）を以下に置き換える:

```ts
function waitForVideo(onCleanup?: (dispose: () => void) => void): Promise<HTMLVideoElement> {
  return new Promise((resolve) => {
    const found = deepFindVideo(document);
    if (found) return resolve(found);
    const mo = new MutationObserver(() => {
      const v = deepFindVideo(document);
      if (v) {
        mo.disconnect();
        resolve(v);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // video 発見まで disconnect されないため、セッション破棄時に取り残さないよう解放処理を渡す
    onCleanup?.(() => mo.disconnect());
  });
}
```

- [ ] **Step 3: モジュールレベルにゲートを追加**

`let currentTitle: string | null = null;`（line 58）の直後に追加:

```ts
const gate = makeSessionGate();
```

- [ ] **Step 4: start() 冒頭でセッション開始＋waitForVideo の abort チェック**

現在の start() 冒頭（line 60-65）:

```ts
async function start(session: Session): Promise<void> {
  if (started) return;
  started = true;

  const video = await waitForVideo();
  const controller = new VideoController(video);
```

を以下に置き換える:

```ts
async function start(session: Session): Promise<void> {
  if (started) return;
  started = true;
  const life = gate.begin();

  const video = await waitForVideo((d) => life.add(d));
  if (life.aborted()) {
    life.dispose();
    return;
  }
  const controller = new VideoController(video);
```

- [ ] **Step 5: WsClient 生成時に close() を解放処理として登録**

現在の client 生成（line 90-93）:

```ts
  const client = new WsClient(roomUrl(), {
    factory: () => makeBrowserSocket(roomUrl()),
    onMessage: (msg: ServerMessage) => handleServer(msg),
  });
```

の直後に追加:

```ts
  life.add(() => client.close());
```

- [ ] **Step 6: title 監視オブザーバと debounce を解放処理に登録**

現在の `startHostTitleSync`（line 148-159）:

```ts
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

を以下に置き換える:

```ts
  function startHostTitleSync() {
    lastSentTitle = null; // (再)join のたびに現在値を確実に1回送る（サーバーが同値を弾く）
    sendTitleIfChanged();
    if (titleObserverInstalled) return;
    titleObserverInstalled = true;
    // <title> の差し替え・テキスト変更の両方を拾うため head を subtree 監視する。
    const titleObs = new MutationObserver(scheduleTitleSend);
    titleObs.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    life.add(() => titleObs.disconnect());
    life.add(() => {
      if (titleDebounce) clearTimeout(titleDebounce);
    });
  }
```

- [ ] **Step 7: ホスト create の fetch 前後で abort チェックと副作用順序を修正**

現在の fetch ブロック（line 180-200）:

```ts
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
      chrome.runtime
        .sendMessage({ type: "server_event", event: "host_disconnected" })
        .catch(() => {});
      started = false; // 作成失敗時はセッションを開始済みにせず、popup から再試行できるようにする
      return;
    }
  }
```

を以下に置き換える（json() 解決後・副作用適用**前**に abort を確認し、connecting 中退出で room_created を popup へ漏らさない）:

```ts
  if (session.role === "host" && !session.hostToken) {
    try {
      const res = await fetch(`${httpBaseFrom(SERVER_URL)}/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CONNECT_SECRET}` },
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      const data = (await res.json()) as { roomId: string; hostToken: string };
      if (life.aborted()) {
        life.dispose();
        return;
      }
      session.roomId = data.roomId;
      session.hostToken = data.hostToken;
      currentRoomId = data.roomId;
      chrome.runtime.sendMessage({ type: "room_created", roomId: data.roomId }).catch(() => {});
    } catch {
      life.dispose();
      currentStatus = "disconnected";
      chrome.runtime
        .sendMessage({ type: "server_event", event: "host_disconnected" })
        .catch(() => {});
      started = false; // 作成失敗時はセッションを開始済みにせず、popup から再試行できるようにする
      return;
    }
  }
```

- [ ] **Step 8: ping interval を解放処理に登録**

現在（line 202-203）:

```ts
  // 定期ping（RTT測定）— 接続ごとではなく一度だけ。WsClient.sendは未接続時no-op。
  setInterval(() => client.sendPing(), DEFAULTS.pingIntervalMs);
```

を以下に置き換える:

```ts
  // 定期ping（RTT測定）— 接続ごとではなく一度だけ。WsClient.sendは未接続時no-op。
  const pingTimer = setInterval(() => client.sendPing(), DEFAULTS.pingIntervalMs);
  life.add(() => clearInterval(pingTimer));
```

- [ ] **Step 9: navigation 内 waitForVideo に解放処理を渡し abort チェック**

現在の `maybeHandleNavigation` 内（line 228-238 付近）:

```ts
    try {
      // 同一要素の src 差し替えなら即座に取得、要素ごと差し替えなら新要素の出現を待つ。
      const next = await waitForVideo();
      if (next !== currentVideo) {
        unbindListeners(currentVideo);
        controller.setMedia(next);
        bindListeners(next);
        currentVideo = next;
      }
      // 新 contentKey＋新 currentTime で即時通知し、ズレ窓を最小化する（host のみ）。
      if (session.role === "host") orchestrator.heartbeat();
    } finally {
      navigating = false;
    }
```

を以下に置き換える:

```ts
    try {
      // 同一要素の src 差し替えなら即座に取得、要素ごと差し替えなら新要素の出現を待つ。
      const next = await waitForVideo((d) => life.add(d));
      if (life.aborted()) return;
      if (next !== currentVideo) {
        unbindListeners(currentVideo);
        controller.setMedia(next);
        bindListeners(next);
        currentVideo = next;
      }
      // 新 contentKey＋新 currentTime で即時通知し、ズレ窓を最小化する（host のみ）。
      if (session.role === "host") orchestrator.heartbeat();
    } finally {
      navigating = false;
    }
```

- [ ] **Step 10: host の tick interval と media リスナーを解放処理に登録**

現在の host ブロック末尾（line 262-267）:

```ts
    mediaListeners.push(["timeupdate", beat]);
    bindListeners(currentVideo);
    setInterval(() => {
      beat();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
```

を以下に置き換える:

```ts
    mediaListeners.push(["timeupdate", beat]);
    bindListeners(currentVideo);
    life.add(() => unbindListeners(currentVideo));
    const hostTick = setInterval(() => {
      beat();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
    life.add(() => clearInterval(hostTick));
```

- [ ] **Step 11: participant の tick interval と media リスナーを解放処理に登録**

現在の participant ブロック末尾（line 278-282）:

```ts
    bindListeners(currentVideo);
    setInterval(() => {
      void orchestrator.tick();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
  }
```

を以下に置き換える:

```ts
    bindListeners(currentVideo);
    life.add(() => unbindListeners(currentVideo));
    const participantTick = setInterval(() => {
      void orchestrator.tick();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
    life.add(() => clearInterval(participantTick));
  }
```

- [ ] **Step 12: leave_session ハンドラを追加**

現在の onMessage リスナー内 start_session ブロック（line 288-293）:

```ts
  if (msg?.type === "start_session") {
    if (started) return; // 既存セッション中は重複指示を無視（currentStatus を汚さない）
    currentStatus = "connecting";
    void start({ roomId: msg.roomId, role: msg.role, name: msg.name });
    return;
  }
```

の直後に追加:

```ts
  if (msg?.type === "leave_session") {
    gate.end(); // in-flight な start() を abort＋登録済み副作用を一括解放
    started = false;
    currentStatus = "idle";
    currentRoomId = null;
    currentRoster = [];
    currentSelfId = null;
    currentTitle = null;
    return;
  }
```

- [ ] **Step 13: 型チェックとテスト全体を実行**

Run: `pnpm typecheck && pnpm test`
Expected: PASS（既存テスト＋Task 1-3 の新テストがすべて通る。content.ts に型エラーがない）

- [ ] **Step 14: Biome チェック**

Run: `pnpm check`
Expected: エラーなし（必要なら `pnpm check:fix` で整形してから再実行）

- [ ] **Step 15: コミット**

```bash
git add extension/src/content.ts
git commit -m "feat(content): 退出でセッションを一括解放しconnecting-raceを防ぐゲートを配線"
```

---

## Task 5: popup に退出ボタン＋インライン2段階 confirm

**Files:**
- Modify: `extension/src/popup.html`
- Modify: `extension/src/popup.ts`

- [ ] **Step 1: popup.html に CSS を追加**

`extension/src/popup.html` の `#roster div.offline { ... }` ブロック（line 289-292）の直後、`</style>`（line 293）の前に追加:

```css
      /* ---- 退出 ---- */
      #leaveBlock {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--border);
      }
      #leave {
        color: var(--text-dim);
        background: transparent;
        border: 1px solid var(--border);
      }
      #leave:hover {
        color: var(--danger);
        border-color: var(--danger);
      }
      #leaveConfirm {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .confirm-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--text);
      }
      #leaveYes {
        color: #fff;
        background: var(--danger);
        border: 1px solid var(--danger);
      }
      #leaveCancel {
        color: var(--text);
        background: transparent;
        border: 1px solid var(--border);
      }
```

- [ ] **Step 2: popup.html に退出ブロックを追加**

`.panel` 内の `<div id="roster"></div>`（line 332）の直後、`.panel` を閉じる `</div>`（line 333）の前に追加:

```html
        <div id="leaveBlock" hidden>
          <button id="leave">退出</button>
          <div id="leaveConfirm" hidden>
            <span class="confirm-label">本当に退出しますか？</span>
            <button id="leaveYes">はい、退出</button>
            <button id="leaveCancel">キャンセル</button>
          </div>
        </div>
```

- [ ] **Step 3: popup.ts の import に leaveControlsVisible を追加**

`extension/src/popup.ts` の import（line 2-11）を以下に置き換える:

```ts
import {
  type ConnState,
  formatRosterLine,
  isActiveSession,
  leaveControlsVisible,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
  unavailableNotice,
} from "./popup-status";
```

- [ ] **Step 4: setStatus で退出ブロックの表示を切替**

現在の `setStatus`（line 20-26）:

```ts
const setStatus = (s: ConnState) => {
  currentState = s;
  // #status はドット＋ラベルを内包するため textContent では潰さず、ラベルだけ差し替える。
  // data-state は CSS のドット配色・脈動アニメを駆動する（popup.html 参照）。
  $("status").dataset.state = s;
  $("statusLabel").textContent = renderStatusLabel(s);
};
```

を以下に置き換える:

```ts
const setStatus = (s: ConnState) => {
  currentState = s;
  // #status はドット＋ラベルを内包するため textContent では潰さず、ラベルだけ差し替える。
  // data-state は CSS のドット配色・脈動アニメを駆動する（popup.html 参照）。
  $("status").dataset.state = s;
  $("statusLabel").textContent = renderStatusLabel(s);
  // セッションがある間（idle 以外）だけ退出 UI を出す。
  ($("leaveBlock") as HTMLElement).hidden = !leaveControlsVisible(s);
};
```

- [ ] **Step 5: 退出ハンドラと idle リセットを追加**

`copyRoom` のクリックハンドラ（line 93-103）の直後に追加:

```ts
function collapseLeaveConfirm() {
  ($("leave") as HTMLElement).hidden = false;
  ($("leaveConfirm") as HTMLElement).hidden = true;
}

/** 退出確定後に popup を未接続表示へ戻す。create/join フォームは常時表示なのでそのまま使える。 */
function resetToIdle() {
  setStatus("idle"); // leaveBlock もここで隠れる
  ($("roomId") as HTMLElement).hidden = true;
  $("roomCode").textContent = "";
  $("rosterHeader").textContent = "";
  $("roster").textContent = "";
  $("watchingTitle").textContent = "";
  collapseLeaveConfirm();
}

$("leave").addEventListener("click", () => {
  ($("leave") as HTMLElement).hidden = true;
  ($("leaveConfirm") as HTMLElement).hidden = false;
});

$("leaveCancel").addEventListener("click", collapseLeaveConfirm);

$("leaveYes").addEventListener("click", async () => {
  chrome.tabs.sendMessage(await activeTabId(), { type: "leave_session" });
  resetToIdle();
});
```

- [ ] **Step 6: 型チェックを実行**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Biome チェック**

Run: `pnpm check`
Expected: エラーなし（必要なら `pnpm check:fix`）

- [ ] **Step 8: 拡張ビルドが通ることを確認**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`
Expected: `dist/extension` が生成され、エラーなく完了する

- [ ] **Step 9: コミット**

```bash
git add extension/src/popup.html extension/src/popup.ts
git commit -m "feat(popup): 退出ボタンとインライン2段階confirmを追加"
```

---

## Task 6: 仕上げ（全体検証＋手動 E2E チェックリスト）

**Files:** なし（検証のみ）

- [ ] **Step 1: 全テスト・型・Lint・ビルドを通す**

```bash
pnpm typecheck && pnpm test && pnpm check && CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension
```
Expected: すべて成功

- [ ] **Step 2: 手動 E2E（接続済みからの退出）**

`dist/extension` を Chrome に読み込み、U-NEXT 再生ページで:
- ルーム作成（または参加）→「接続済み」表示・退出ボタンが見えること
- 「退出」→「本当に退出しますか？ [はい、退出][キャンセル]」に変化
- 「キャンセル」→ 元の「退出」に戻る
- 「はい、退出」→ popup が未接続に戻り、create/join が再び使えること
- popup を閉じて開き直しても「未接続」のままであること（セッションが残っていない）

- [ ] **Step 3: 手動 E2E（connecting 中の退出＝race 検証）**

- DevTools の Network スロットリングや遅延で `POST /create` を遅らせる
- ルーム作成を押し「接続中」表示の間に popup を開いたまま「退出」→「はい、退出」
- 遅延後に `room_created`/`joined` が届いても popup が「接続済み」に戻らないこと
- popup を開き直しても「未接続」のままであること（生きたセッションが復活しない）

- [ ] **Step 4: 退出後の再接続停止を確認**

- 接続済みで退出後、DevTools の Network/WS で WebSocket 再接続が走っていないこと
- 退出 → 再度ルーム作成/参加が正常に動くこと

- [ ] **Step 5: spec のステータスを更新してコミット**

`docs/superpowers/specs/2026-06-08-room-leave-design.md` の `ステータス` を「実装完了」に更新:

```bash
git add docs/superpowers/specs/2026-06-08-room-leave-design.md
git commit -m "docs(spec): ルーム退出機能を実装完了に更新"
```

---

## Self-Review メモ

- **Spec coverage**: §1 WsClient停止=Task 1 / §2 セッション破棄＋race=Task 3+4 / §3 popup UI=Task 2+5 / テスト計画=各タスクのTDD＋Task 6手動E2E。すべて対応済み。
- **命名整合**: `makeSessionGate`/`Session.aborted/add/dispose`/`gate.end()`/`leaveControlsVisible`/`leave_session` はタスク間で一貫。content.ts では既存 `interface Session` との衝突回避のため変数名 `life` を使用。
- **abort チェックは全 await 後**: `waitForVideo`（start・navigation）と `fetch`+`res.json()` の直後に配置。json() 後の副作用前チェックで room_created の漏れを防止。
