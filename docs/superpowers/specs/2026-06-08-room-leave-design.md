# ルーム退出機能 設計仕様

- 日付: 2026-06-08
- ステータス: 設計確定（実装前）
- 関連: `docs/superpowers/specs/2026-06-05-watch-sync-design.md`（本体設計）

## 背景と目的

現状、作成したルーム（ホスト）・参加したルーム（参加者）から**意図的に退出する手段がない**。
`WsClient` の `socket.onclose` は常にバックオフ再接続を再スケジュールするため、ソケットを
閉じても即再接続してしまう。また `content.ts` の `start()` が張る `setInterval`・
`MutationObserver`・`WebSocket` を破棄する口がなく、セッションを停止できない。

本機能は「ルームから退出できるようにする」＋「退出前に confirm を挟む」を満たす。

退出の主目的は **「再接続ループの停止」と「セッションに紐づく副作用の解放」** である。退出ボタンは
接続済み（connected）からだけでなく、`disconnected`/`host_gone`/`no_room` 状態でも価値が高い。
これらの状態では `WsClient` がバックオフ再接続を回し続けている（`ws-client.ts:62`）ため、
ユーザーが「やめたい」局面そのものだからである。

## スコープ

退出は **クライアント側だけの操作** として実装する。サーバーは既存のソケット close 時挙動
（`removeClient` による roster 再送・ホスト枠60秒保持・空ルーム掃除）をそのまま利用する。

- **触るファイル**: `extension/src/ws-client.ts` / `content.ts` / `popup.ts` / `popup.html` /
  `popup-status.ts`、テストは `ws-client.test.ts` / `popup.test.ts`（および connecting-race の
  abort ロジックを切り出す場合はその新規テスト。テスト計画参照）
- **触らないファイル**: `shared/protocol.ts` / `shared/rooms.ts` / `worker/` / サーバーテスト

ホスト/参加者の区別は退出処理では不要（どちらもソケットを閉じるだけ）。

### スコープ外（既知の割り切り）

- 新しいプロトコルメッセージ（`leave` 等）は追加しない。
- ホストが退出してもサーバー側ホスト枠は**即時解放されず60秒保持**される。よって参加者には
  最大60秒間「ホスト切断」が表示され、その後ホストが消える（既存の `removeClient` 挙動）。
  これは意図的な割り切り。
- ページ再読込でのセッション復帰は本機能の対象外（spec §11 の既知制約のまま）。

## 設計

### 1. WsClient: 再接続停止（`extension/src/ws-client.ts`）

再接続ループを止める手段を追加する。`send`/`sendPing` 等の既存挙動は変えない。

- `private stopped = false;` を追加。
- `close()` メソッドを追加:
  - `this.stopped = true;`
  - `this.socket?.close();`
- `connect()` 冒頭で `if (this.stopped) return;`（停止後に遅延 connect が走るのを防ぐ）。
- `s.onclose` 冒頭で `if (this.stopped) return;`（再接続をスケジュールしない）。
  - **停止時は `onClose?.()` を呼ばない**。意図的退出は「切断」ではないため、将来 `onClose` に
    切断表示を載せても意図的退出で誤って「切断」が出ないようにする（現状 `content.ts` は
    `onClose` 未設定なので無害だが、意味論として停止と切断を区別しておく）。

### 2. content script: セッション破棄＋connecting-race 対策（`extension/src/content.ts`）

`start()` がセッションに紐づけて生成する副作用をすべて解放できるようにする。**かつ、
`start()` が `await` で中断中（connecting 中）に退出されても、再開した `start()` が
生きたセッションを復活させない**ように世代フラグで abort を効かせる。

#### 問題（connecting-race）

`start()` は冒頭の `started` ガード（`content.ts:61`）通過後に2回 `await` する
（`:64 await waitForVideo()`、ホストは `:182 await fetch(/create)`）。`teardown` を
「`start()` 末尾でセット」する素朴な実装だと、connecting 中（`teardown` が `null`）に
`leave_session` を受けても解放できず、`await` から再開した `start()` が冒頭ガードを再評価
しないまま WS 接続・`setInterval` 生成まで進み、遅延した `room_created`/`joined` が
`currentStatus` を `connected` に上書きしてセッションが復活する。

#### 対策: 世代フラグ + 逐次 disposer 登録

- モジュールレベルに `let sessionGen = 0;` と `let teardown: (() => void) | null = null;` を持つ。
- `start()` 冒頭で `const gen = ++sessionGen;` を取り（新しい start が古い in-flight start を
  無効化する効果も持つ）、ローカルに以下を用意する:
  - `const disposers: Array<() => void> = [];`
  - `const dispose = () => { while (disposers.length) disposers.pop()!(); };`（LIFO で解放）
  - `const aborted = () => gen !== sessionGen;`
- **リソースは生成のたびに即 `disposers` へ push する**（戻り値・参照を必ず捕捉する。現状は
  どれも捨てているため改修が必要）:
  - ping `setInterval`（`content.ts:203`）→ 戻り値を保持し `clearInterval`
  - host/participant tick `setInterval`（`:264`/`:279`）→ 同上
  - title 監視 `MutationObserver`（`:154`、現状 `new MutationObserver(...).observe(...)` で
    参照を捨てている）→ 変数に受け `disconnect()`
  - title debounce（`titleDebounce`）→ `clearTimeout`
  - `waitForVideo()` の `MutationObserver`（`:34`、`:230` navigation 時も）→ video 発見まで
    `disconnect()` されないため、connecting 中退出で取り残される。observer を呼び出し側へ
    渡せる形にして `disposers` に登録する（または `waitForVideo` を中断可能化する）
  - `client.close()`（§1）
  - 現在の `<video>` リスナーを `unbindListeners(currentVideo)` で外す
- **各 `await` の直後に abort をチェック**して早期 return する:
  ```
  const video = await waitForVideo(/* observer を disposers に登録 */);
  if (aborted()) { dispose(); return; }
  ...
  const res = await fetch(...);
  if (aborted()) { dispose(); return; }
  ```
  最後の `await` 以降は同期実行なので（JS 単一スレッド）`leave_session` が割り込めず、
  セッションは完全に形成されてから `teardown = dispose;` がセットされる。`leave_session` が
  割り込めるのは `await` 点のみで、直後のチェックが必ず捕捉する。
- `start()` 末尾（最後の abort チェック通過後の同期ブロックの最後）で `teardown = dispose;`。

> 注: `disposers`・`dispose`・`aborted` は `start()` のクロージャローカルである。`teardown`
> （モジュールレベル）には**この session の `dispose` を代入する**だけで、`titleDebounce` 等の
> クロージャ変数はその `dispose` 内から捕捉される。teardown 関数本体をモジュールレベルに
> 持つ構造ではない点に注意。

#### `leave_session` ハンドラ

新メッセージ `leave_session` を `chrome.runtime.onMessage` で受ける:

- `sessionGen++`（in-flight な `start()` を abort させる。次のチェックポイントで `dispose` される）
- `teardown?.()`（完全に形成済みのセッションがあれば解放）
- `teardown = null`
- `started = false`
- 状態を idle にリセット: `currentStatus = "idle"`, `currentRoomId = null`,
  `currentRoster = []`, `currentSelfId = null`, `currentTitle = null`

退出後は同じタブで再度 create/join できる（`started` が false に戻り、`sessionGen` も進んで
古い start が無効化されているため）。

### 3. popup: 退出ボタン＋インライン2段階 confirm

#### 表示制御（純粋関数・`extension/src/popup-status.ts`）

```ts
/** セッションが存在する間（idle 以外）だけ退出 UI を表示する。 */
export function leaveControlsVisible(s: ConnState): boolean {
  return s !== "idle";
}
```

`connecting`/`disconnected`/`host_gone`/`no_room` でも true になるのは意図どおり（これらは
再接続ループが回っている／繋がっていない局面であり、退出＝停止の価値が最も高い）。

#### popup.html

`.panel` 内（`#status` 付近）に退出コントロールのブロックを追加（初期 hidden）。
**`.stack` 直下には置かない**（`.stack > *:nth-child()` のアニメーション遅延
（`popup.html:56-61`）の番号がずれるため。`.panel` 内なら影響しない）。

- `#leave`（ボタン「退出」）
- `#leaveConfirm`（hidden）: ラベル「本当に退出しますか？」＋ `#leaveYes`（「はい、退出」）
  ＋ `#leaveCancel`（「キャンセル」）

#### popup.ts のロジック

- `setStatus()` で `leaveControlsVisible(s)` を見て `#leave` ブロックの表示/非表示を切替。
- 2段階の挙動はローカル DOM 状態のみ（余計なフラグは持たず、`#leave` と `#leaveConfirm` の
  hidden 切替だけで表現する）:
  - `#leave` クリック → `#leave` を隠し `#leaveConfirm` を表示
  - `#leaveCancel` クリック → 元に戻す
  - `#leaveYes` クリック → content script へ
    `chrome.tabs.sendMessage(tabId, { type: "leave_session" })` を送り、popup を idle にリセット
- **idle リセット**（退出確定時）:
  - `setStatus("idle")`
  - `#roomId` を隠す・`roomCode` クリア
  - roster・rosterHeader クリア
  - watchingTitle クリア
  - confirm を畳む（`#leave` 表示・`#leaveConfirm` 非表示。ただし idle では `#leave` ブロック
    自体が `leaveControlsVisible` で非表示になる）

create/join フォームは元から常時表示なのでそのまま再利用できる。

## ユーザーフロー

1. 接続済み状態で popup を開くと「退出」ボタンが見える。
2. 「退出」クリック → ボタンが「本当に退出しますか？ [はい、退出] [キャンセル]」に変化。
3. 「キャンセル」→ 元の「退出」に戻る。
4. 「はい、退出」→ content script がセッションを破棄しソケットを閉じる。popup は idle に戻り、
   create/join フォームが再び使える。
5. サーバーはソケット close を検知し、roster 再送（ホストなら host_disconnected ＋ 枠60秒保持）。

## テスト計画（TDD）

- `ws-client.test.ts`: `close()` 後に `onclose` が来ても再接続しない（既存の再接続テストと対比）。
  `FakeSocket.close()` は同期で `onclose` を呼ぶ（`ws-client.test.ts:13-16`）ため容易に書ける。
  併せて「停止時に `onClose` を呼ばない」ことも確認する。
- `popup.test.ts`: `leaveControlsVisible` の真偽（idle=false / connecting・connected・
  disconnected・host_gone・no_room=true）。
- **connecting-race の回帰テスト**: 世代フラグの abort ロジックを検証する。content.ts は
  「組み立て層」で丸ごとのユニットテストは重い（chrome/DOM/WebSocket/fetch のモックが必要）ため、
  abort 判定の核（`sessionGen` インクリメントで古い世代の `aborted()` が true になる）を
  検証できる粒度で testable に切り出してユニットテストする。実装時に「切り出すと自然か」を
  判断し、過剰になる場合は §下記の手動 E2E に降格する（その判断は実装時に明示する）。
- **手動 E2E（connecting-race の実挙動）**: ネットワークスロットリング等で `/create` を遅延させ、
  connecting 表示中に「はい、退出」を押す。遅延した `room_created`/`joined` が popup に届かず、
  popup を開き直しても idle のままであることを確認する。
- content script のセッション破棄（interval/observer 解放の網羅）は手動 E2E で目視確認
  （既存方針に準拠）。

## 不変条件への影響

本体設計の不変条件（spec §設計上の不変条件）はいずれも変更しない。退出は WS を閉じてローカル
状態を捨てるだけで、同期ロジック・サーバー reducer・フィードバックループ防止には影響しない。
