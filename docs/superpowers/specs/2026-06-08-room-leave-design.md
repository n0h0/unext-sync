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

## スコープ

退出は **クライアント側だけの操作** として実装する。サーバーは既存のソケット close 時挙動
（`removeClient` による roster 再送・ホスト枠60秒保持・空ルーム掃除）をそのまま利用する。

- **触るファイル**: `extension/src/ws-client.ts` / `content.ts` / `popup.ts` / `popup.html` /
  `popup-status.ts`、テストは `ws-client.test.ts` / `popup.test.ts`
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
- `s.onclose` 冒頭で `if (this.stopped) { this.onClose?.(); return; }`（再接続をスケジュールしない）。

### 2. content script: セッション破棄（`extension/src/content.ts`）

`start()` がセッションに紐づけて生成する副作用をすべて解放できるようにする。

- `start()` 内で生成する破棄対象を **teardown 関数の配列** に集約する:
  - ping `setInterval` の `clearInterval`
  - host/participant tick `setInterval` の `clearInterval`
  - title 監視 `MutationObserver` の `disconnect()`（host 時のみ生成）
  - title debounce の `clearTimeout`
  - `client.close()`（§1）
  - 現在の `<video>` リスナーを `unbindListeners(currentVideo)` で外す
- モジュールレベルに `let teardown: (() => void) | null = null;` を持ち、`start()` 完了時にセット。
- 新メッセージ `leave_session` を `chrome.runtime.onMessage` で受け、`teardown?.()` 実行後に
  状態を idle にリセットする:
  - `started = false`
  - `currentStatus = "idle"`, `currentRoomId = null`, `currentRoster = []`,
    `currentSelfId = null`, `currentTitle = null`
  - `teardown = null`
- 退出後は同じタブで再度 create/join できる（`started` が false に戻るため）。

### 3. popup: 退出ボタン＋インライン2段階 confirm

#### 表示制御（純粋関数・`extension/src/popup-status.ts`）

```ts
/** セッションが存在する間（idle 以外）だけ退出 UI を表示する。 */
export function leaveControlsVisible(s: ConnState): boolean {
  return s !== "idle";
}
```

#### popup.html

`#status` 付近に退出コントロールのブロックを追加（初期 hidden）:

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
- `popup.test.ts`: `leaveControlsVisible` の真偽（idle=false / connecting・connected 等=true）。
- content script のセッション破棄は手動 E2E で確認（既存方針に準拠。teardown の網羅は実装時に
  目視確認）。

## 不変条件への影響

本体設計の不変条件（spec §設計上の不変条件）はいずれも変更しない。退出は WS を閉じてローカル
状態を捨てるだけで、同期ロジック・サーバー reducer・フィードバックループ防止には影響しない。
