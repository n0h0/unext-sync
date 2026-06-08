# セッション中の作成/参加フォームロック Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** popup のセッション中（接続中・接続済み・切断・ホスト切断）に「名前」「ルームID」入力と「ルーム作成」「参加」ボタンを `disabled` にし、退出するまで触れないようにする。

**Architecture:** 判定は `popup-status.ts` の純粋関数（`setupFormLocked` / `actionButtonsDisabled`）に寄せる。DOM の `disabled` を書くのは `popup.ts` の `applySetupControls()` 1箇所だけにし、`currentState` とモジュールスコープ `onPlayer` の両方から毎回再計算する。これにより `setStatus` と `showUnavailable` の呼び出し順への暗黙依存を排除する。

**Tech Stack:** TypeScript / Chrome MV3 popup / vitest / Biome / esbuild。spec: `docs/superpowers/specs/2026-06-08-lock-setup-form-during-session-design.md`。

---

### Task 1: 純粋関数 `setupFormLocked` / `actionButtonsDisabled` を TDD で追加

**Files:**
- Modify: `extension/src/popup-status.ts`（`leaveControlsVisible` の直後に追加、`popup-status.ts:58-60`）
- Test: `extension/src/popup.test.ts`（既存の `popup-status` テスト群に追加。新規ファイルは作らない）

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/popup.test.ts` の import 文（1〜15行目）に `setupFormLocked` と `actionButtonsDisabled` を追加する。import ブロックを以下に置き換える:

```ts
import {
  type ConnState,
  actionButtonsDisabled,
  formatRosterLine,
  isActiveSession,
  isValidRoomId,
  leaveControlsVisible,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
  setupFormLocked,
  shouldDisableControls,
  unavailableNotice,
} from "./popup-status";
```

ファイル末尾（`isValidRoomId` テストの後）に以下を追加する:

```ts
test("setupFormLocked: 生きたセッション中のみ true（leaveControlsVisible と1対1）", () => {
  const cases: [ConnState, boolean][] = [
    ["idle", false],
    ["connecting", true],
    ["connected", true],
    ["disconnected", true],
    ["host_gone", true],
    ["no_room", false],
  ];
  for (const [s, expected] of cases) {
    expect(setupFormLocked(s)).toBe(expected);
  }
});

test("actionButtonsDisabled: セッション中 or 再生ページ以外なら無効化（2理由のOR）", () => {
  // onPlayer=true: 状態のみで決まる（setupFormLocked と一致）
  expect(actionButtonsDisabled(true, "idle")).toBe(false);
  expect(actionButtonsDisabled(true, "no_room")).toBe(false);
  expect(actionButtonsDisabled(true, "connecting")).toBe(true);
  expect(actionButtonsDisabled(true, "connected")).toBe(true);
  expect(actionButtonsDisabled(true, "disconnected")).toBe(true);
  expect(actionButtonsDisabled(true, "host_gone")).toBe(true);
  // onPlayer=false: 全状態で true
  expect(actionButtonsDisabled(false, "idle")).toBe(true);
  expect(actionButtonsDisabled(false, "no_room")).toBe(true);
  expect(actionButtonsDisabled(false, "connected")).toBe(true);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: FAIL（`actionButtonsDisabled`/`setupFormLocked` が export されておらず import エラー、または "is not a function"）

- [ ] **Step 3: 最小実装を書く**

`extension/src/popup-status.ts` の `leaveControlsVisible` 関数（60行目で閉じる）の直後に以下を追加する:

```ts
/** name/room 入力をロックすべきか。セッションが生きている間（退出ボタン表示と1対1）。 */
export function setupFormLocked(s: ConnState): boolean {
  return leaveControlsVisible(s);
}

/**
 * create/join ボタンを無効化すべきか。無効化理由は2つあり、その OR を取る:
 *  - セッション中（setupFormLocked）= 退出するまで作り直せない
 *  - 再生ページ以外（!onPlayer）= 再生状態同期が意味を持たない
 * ボタン disabled の「単一の真実源」とする。
 */
export function actionButtonsDisabled(onPlayer: boolean, s: ConnState): boolean {
  return setupFormLocked(s) || !onPlayer;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `pnpm vitest run extension/src/popup.test.ts`
Expected: PASS（全テスト green）

- [ ] **Step 5: コミット**

```bash
git add extension/src/popup-status.ts extension/src/popup.test.ts
git commit -m "feat(popup): setupFormLocked/actionButtonsDisabled を追加（セッション中フォームロック判定）"
```

---

### Task 2: `popup.ts` を単一書き手 `applySetupControls` に配線する

**Files:**
- Modify: `extension/src/popup.ts`（import 文 / `currentState` 宣言付近 `popup.ts:22` / `setStatus` `popup.ts:23-31` / `showUnavailable` `popup.ts:56-62`）

純粋関数のテストは Task 1 で済んでいる。本タスクは DOM 配線のみ（vitest は popup.ts の DOM 部分を実行しないため、検証は `pnpm typecheck` と `pnpm check` で行う）。

- [ ] **Step 1: import に2関数を追加**

`extension/src/popup.ts` の import ブロック（2〜14行目）を以下に置き換える:

```ts
import {
  type ConnState,
  actionButtonsDisabled,
  formatRosterLine,
  isActiveSession,
  isValidRoomId,
  leaveControlsVisible,
  nextStateForServerEvent,
  renderStatusLabel,
  renderWatchingTitle,
  rosterHeader,
  setupFormLocked,
  shouldDisableControls,
  unavailableNotice,
} from "./popup-status";
```

- [ ] **Step 2: `onPlayer` モジュール変数と `applySetupControls` を追加し、`setStatus` から呼ぶ**

`popup.ts:21-31` の `currentState` 宣言と `setStatus` のブロックを以下に置き換える:

```ts
// 表示と内部状態を一元化する。currentState は再押下ガード（isActiveSession）に使う。
let currentState: ConnState = "idle";
// 再生ページ上か。既定 true。再生ページ以外と判明したとき showUnavailable が false にする。
// popup は開くたび作り直されるためモジュール初期化で true に戻る。
let onPlayer = true;

/** name/room/create/join の disabled を currentState と onPlayer から導く唯一の書き手。 */
function applySetupControls() {
  const formLocked = setupFormLocked(currentState);
  ($("name") as HTMLInputElement).disabled = formLocked;
  ($("room") as HTMLInputElement).disabled = formLocked;
  const btnDisabled = actionButtonsDisabled(onPlayer, currentState);
  ($("create") as HTMLButtonElement).disabled = btnDisabled;
  ($("join") as HTMLButtonElement).disabled = btnDisabled;
}

const setStatus = (s: ConnState) => {
  currentState = s;
  // #status はドット＋ラベルを内包するため textContent では潰さず、ラベルだけ差し替える。
  // data-state は CSS のドット配色・脈動アニメを駆動する（popup.html 参照）。
  $("status").dataset.state = s;
  $("statusLabel").textContent = renderStatusLabel(s);
  // セッションがある間（idle 以外）だけ退出 UI を出す。
  ($("leaveBlock") as HTMLElement).hidden = !leaveControlsVisible(s);
  // 状態が変わるたびフォーム/ボタンの有効・無効を再計算する。
  applySetupControls();
};
```

- [ ] **Step 3: `showUnavailable` を「disabled を直接書かない」形に変える**

`popup.ts:55-62` の `showUnavailable` を以下に置き換える:

```ts
/** content script に到達できないページ（U-NEXT再生ページ以外）で開いたときの案内＋操作無効化。 */
function showUnavailable() {
  const guard = $("guard");
  guard.textContent = unavailableNotice();
  guard.hidden = false;
  // 再生ページ以外と確定。disabled の反映は単一書き手 applySetupControls に委ねる。
  onPlayer = false;
  applySetupControls();
}
```

- [ ] **Step 4: 型チェックと Lint を実行**

Run: `pnpm typecheck && pnpm check`
Expected: いずれもエラーなし（`actionButtonsDisabled`/`setupFormLocked` の未使用 import が解消され、`noUnusedLocals` も通る）

- [ ] **Step 5: 全テストを実行（回帰がないこと）**

Run: `pnpm test`
Expected: PASS（node suite + worker suite すべて green）

- [ ] **Step 6: コミット**

```bash
git add extension/src/popup.ts
git commit -m "feat(popup): セッション中は作成/参加フォームを無効化（単一書き手applySetupControls）"
```

---

### Task 3: `input:disabled` の CSS を追加

**Files:**
- Modify: `extension/src/popup.html`（`input:focus` ブロックの直後、`popup.html:150` の後）

`button:disabled`（opacity 0.4 / cursor not-allowed）は `popup.html:171-174` に既存。`input:disabled` は未定義なので、入力欄にも無効化が視覚的に伝わるよう追加する。

- [ ] **Step 1: `input:disabled` スタイルを追加**

`extension/src/popup.html` の `input:focus { ... }` ブロック（147〜150行目）の直後に以下を挿入する:

```css
      input:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
```

- [ ] **Step 2: 拡張ビルドが通ることを確認**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`
Expected: ビルド成功（`dist/extension` が生成される。CONNECT_SECRET はこのビルドだけの捨て値でコミットしない）

- [ ] **Step 3: コミット**

```bash
git add extension/src/popup.html
git commit -m "style(popup): input:disabled に無効化スタイルを追加"
```

---

### Task 4: 手動動作確認（DOM 反映の最終確認）

**Files:** なし（拡張をブラウザに読み込んで目視確認）

vitest は popup.ts の DOM 配線を実行しないため、最後に実機で確認する。spec の不変条件「退出ボタンが出ている ⟺ フォームがロックされている」を目で確かめる。

- [ ] **Step 1: 拡張を再読み込みして確認**

`chrome://extensions` で `dist/extension` を再読み込み → U-NEXT 再生ページで popup を開く。

確認項目:
1. **未接続（idle）**: 名前・ルームID入力と作成/参加ボタンが**有効**。
2. **ルーム作成 → 接続済み（connected）**: 4要素すべて**無効（薄く・not-allowed カーソル）**、退出ボタンが出ている。
3. **退出 → 未接続（idle）**: 4要素が**再び有効**に戻る。
4. **再生ページ以外で開く**: guard 案内が出てボタンが無効（入力欄は仕様どおり対象外で有効のまま）。

- [ ] **Step 2: 問題なければ完了（コミット不要）**

すべて期待どおりなら実装完了。期待と異なれば該当 Task に戻って修正する。

---

## Self-Review

**Spec coverage:**
- ロック状態テーブル（idle/no_room→false、他→true）→ Task 1 `setupFormLocked` テストで網羅。
- 4要素（name/room/create/join）の無効化 → Task 2 `applySetupControls`。
- 単一書き手による順序依存の排除 → Task 2 Step 2-3。
- エスケープ経路（退出で再有効化）→ Task 4 Step 1 項目3で目視確認。
- 入力欄の非対称（非再生ページで入力欄は対象外）→ Task 4 Step 1 項目4で確認。
- click ガードを残す → 既存コード（`popup.ts:76,93`）を変更しないため自動的に維持。
- `input:disabled` CSS → Task 3。
- テストは `popup.test.ts` に追加（新規ファイルを作らない）→ Task 1 で明記。

**Placeholder scan:** プレースホルダなし。全ステップに実コード・実コマンド・期待結果あり。

**Type consistency:** `setupFormLocked(s: ConnState)`・`actionButtonsDisabled(onPlayer: boolean, s: ConnState)`・`applySetupControls()` の名前と引数は Task 1〜2 で一貫。`onPlayer`（boolean）の意味も Task 2・showUnavailable で一致。
