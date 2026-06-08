# セッション中の作成/参加フォームロック — 設計

## 背景と目的

popup の「名前」「ルームID」入力と「ルーム作成」「参加」ボタンは、セッション接続中でも見た目上は操作できる。しかしこれらを変更しても**現在接続中のルームには反映されない**（名前・ルームIDはセッション開始時に確定する）。ユーザーに「変えても効かない」という誤解を与えるため、セッション中はこれらを視覚的にも無効化し、**退出するまで触れない**ようにする。

現状は click ハンドラの `isActiveSession(currentState)` による early-return ガードのみで、ボタン/入力欄は `disabled` にならず押下できてしまう。

## スコープ

- 対象: `name` 入力・`room` 入力・`create` ボタン・`join` ボタンの4要素（フォーム＋両ボタン全部）。
- 非対象: 同期ロジック・WS・content script・worker は一切変更しない。popup の表示制御のみ。

## ロックする状態

退出ボタンが出ている状態 = `leaveControlsVisible(s)` が true のときにロックする。

| 状態 | ロック | 理由 |
|---|---|---|
| `idle` | しない | 未接続。作成/参加できる |
| `connecting` | する | セッション確立中 |
| `connected` | する | セッション中 |
| `disconnected` | する | セッション継続中（自動再接続中） |
| `host_gone` | する | セッション継続中 |
| `no_room` | しない | content script が自動でセッションを解放し作り直せる状態に戻すため |

これにより「**退出ボタンが出ている ⟺ フォームがロックされている**」が1対1で対応する。`no_room` を除外する判断は既存 `leaveControlsVisible` の思想と一致する。

## 実装

### 純粋関数（`extension/src/popup-status.ts`）

```ts
/** name/room 入力をロックすべきか。セッションが生きている間（退出ボタン表示と1対1）。 */
export function setupFormLocked(s: ConnState): boolean {
  return leaveControlsVisible(s);
}

/**
 * create/join ボタンを無効化すべきか。無効化理由は2つあり、その OR を取る:
 *  - セッション中（setupFormLocked）= 退出するまで作り直せない
 *  - 再生ページ以外（!onPlayer）= 再生状態同期が意味を持たない
 * 両理由を1関数に集約し、ボタン disabled の「単一の真実源」とする。
 */
export function actionButtonsDisabled(onPlayer: boolean, s: ConnState): boolean {
  return setupFormLocked(s) || !onPlayer;
}
```

`setupFormLocked` は `leaveControlsVisible` への単純委譲だが、「フォームロック」という意図を表す名前付き関数として切り出し、テストとセマンティクスを独立させる。将来ロック条件と退出ボタン条件が分岐しても、この関数の中だけ変えれば済む。

### DOM 反映（`extension/src/popup.ts`）— 単一の書き手

`create`/`join` の `disabled` には「セッション中」と「再生ページ以外」の2つの無効化理由がある。これらを別々の箇所（`setStatus` と `showUnavailable`）から書くと最終値が呼び出し順に依存し、将来 `showUnavailable` の後に `setStatus` が走るコードが入ると非再生ページでボタンが黙って再有効化される。これを避けるため、**disabled を書くのは1箇所（`applySetupControls`）に集約**し、現在の状態（`currentState`）と再生ページ判定（モジュールスコープ `onPlayer`）の両方から毎回導出する。

```ts
// モジュールスコープ。init で確定し、以後セッション中は再生ページ上にしか遷移しない。
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
```

`setStatus` は末尾で `applySetupControls()` を呼ぶ。`showUnavailable()` は `onPlayer=false` をセットし guard 案内を表示したうえで `applySetupControls()` を呼ぶ（自身では `disabled` を直接書かない）。これにより `setStatus` と `showUnavailable` がどの順で走っても、最終 disabled は `currentState`＋`onPlayer` の全情報から再計算され、暗黙の順序依存が消える。

### 状態遷移の手詰まり防止（エスケープ経路）

`connecting`/`disconnected`/`host_gone` でフォームをロックしても閉じ込めにはならない。これらは `leaveControlsVisible` が true なので退出ボタンが表示され（`popup.ts` の `setStatus`）、`leave` → `leaveYes` → `resetToIdle()` → `setStatus("idle")` で必ずフォームが再有効化される逃げ道がある。

### 入力欄の非対称（既存挙動・本変更で導入しない）

`actionButtonsDisabled` は `!onPlayer` を OR するためボタンは非再生ページで無効になるが、`name`/`room` 入力は `setupFormLocked`（状態のみ）に従うため非再生ページでは有効のまま残る。これは本変更が導入する非対称ではなく既存挙動を踏襲したもので、非再生ページでは guard 案内文が「再生ページで開け」と明示するため、入力欄の誤解は案内側で吸収される。セッション中は入力欄もボタンも揃ってロックされる。

### click ガードは残す

click ハンドラ内の `isActiveSession(currentState)` による early-return は多重防御として残す。`disabled` が効かない経路があっても二重に守る。

### CSS（`extension/src/popup.html`）

`button:disabled`（opacity 0.4 / cursor not-allowed）は既に定義済み。`input:disabled` は未定義のため、入力欄2つにも無効化が視覚的に伝わるよう同等のスタイル（opacity 低下・`cursor: not-allowed`）を追加する。

## テスト

既存の `popup-status.ts` のテスト（`leaveControlsVisible` のテーブルテスト含む）は **`extension/src/popup.test.ts`** にある。新規ファイルは作らず、ここに追加して一貫性を保つ。

- `setupFormLocked` の状態別テーブルテスト: `idle`/`no_room` → false、`connecting`/`connected`/`disconnected`/`host_gone` → true。
- `actionButtonsDisabled` のテスト: `onPlayer=true` のときは `setupFormLocked` と一致（状態のみで決まる）、`onPlayer=false` のときは全状態で true。
- DOM 操作部分（`applySetupControls`）は既存方針どおり純粋関数（`setupFormLocked`/`actionButtonsDisabled`）に判定を寄せ、配線のみとする。

## 不変条件への影響

なし。同期ロジック・サーバー状態・WS・ヒバーネーション適格性のいずれにも触れない。popup の表示制御の追加のみ。
