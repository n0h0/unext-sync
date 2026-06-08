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
/** セッションが生きている間は作成/参加フォームをロックする。退出ボタン表示と1対1で対応。 */
export function setupFormLocked(s: ConnState): boolean {
  return leaveControlsVisible(s);
}
```

`leaveControlsVisible` への単純委譲だが、「フォームロック」という意図を表す名前付き関数として切り出し、テストとセマンティクスを独立させる。将来ロック条件と退出ボタン条件が分岐しても、この関数の中だけ変えれば済む。

### DOM 反映（`extension/src/popup.ts`）

`setStatus` の中で、状態が変わるたびに4要素の `disabled` を更新する。

```ts
const locked = setupFormLocked(s);
($("name") as HTMLInputElement).disabled = locked;
($("room") as HTMLInputElement).disabled = locked;
($("create") as HTMLButtonElement).disabled = locked;
($("join") as HTMLButtonElement).disabled = locked;
```

### 既存無効化（再生ページ以外）との合成

`showUnavailable()` は再生ページ以外で `create`/`join` を `disabled=true` にする独立した無効化理由。両者は矛盾しない:

- 再生ページ以外では状態が `idle` のまま `showUnavailable` が勝ち、ボタンは無効を維持する（`setupFormLocked("idle")=false` だが `showUnavailable` が後から無効化する起動順）。
- 退出 → `resetToIdle()` → `setStatus("idle")` の経路は**再生ページ上でのみ**起こる（content script が到達できているからセッションがある）。よって `setupFormLocked("idle")=false` で正しく再有効化される。

### click ガードは残す

click ハンドラ内の `isActiveSession(currentState)` による early-return は多重防御として残す。`disabled` が効かない経路があっても二重に守る。

### CSS（`extension/src/popup.html`）

`button:disabled`（opacity 0.4 / cursor not-allowed）は既に定義済み。`input:disabled` は未定義のため、入力欄2つにも無効化が視覚的に伝わるよう同等のスタイル（opacity 低下・`cursor: not-allowed`）を追加する。

## テスト

- `extension/src/popup-status.test.ts` に `setupFormLocked` の状態別テーブルテストを追加: `idle`/`no_room` → false、`connecting`/`connected`/`disconnected`/`host_gone` → true。
- DOM 操作部分（`setStatus` の `disabled` 反映）は既存方針どおり純粋関数（`setupFormLocked`）に判定を寄せ、配線のみとする。

## 不変条件への影響

なし。同期ロジック・サーバー状態・WS・ヒバーネーション適格性のいずれにも触れない。popup の表示制御の追加のみ。
