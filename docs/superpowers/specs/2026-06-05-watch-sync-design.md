# Watch Sync 設計仕様書

作成日: 2026-06-05

## 1. 概要

### 1.1 目的

U-NEXTで配信される動画コンテンツを、複数ユーザーが離れた場所から同時に視聴できるようにする。動画データそのものは共有せず、各ユーザーが自身のU-NEXTアカウントで再生している動画の**再生状態のみ**を同期する。

### 1.2 想定利用者・規模

- 開発者本人と友人・知人数名（2〜10人）
- 主に土曜夜、2〜4時間程度の利用
- 常時稼働は不要

### 1.3 同期モデル（確定事項）

- **完全スレーブ方式**：参加者の動画は常にホストに追従する。ドリフトが許容差分を超えたら自動seekで強制同期。参加者が自分で操作してもホストの状態に戻される。
- **固定ホスト**：ルーム作成者がホスト。create時にサーバーが**ホストトークン（ランダム秘密）**を発行し、再接続時はトークン提示でホストスロットを再取得する（§6）。
- **方式C（リレー＋ホスト定期ハートビート）**：サーバーは基本イベント転送だが、ホストが5秒ごとに全状態を送り、サーバーは「最新状態（lastState）」を保持する。途中参加・ドリフト・一時切断からの復帰をこの1本でカバーする。
- **時刻同期は壁時計に依存しない**：クロスマシン量として使うのは片道トランジット遅延のみ。絶対時刻オフセット（NTP同期）には依存しない（§5）。

### 1.4 前提

- MVPでは**全員が手動で同じタイトルを開いている**ことが前提。システムが参加者を自動でそのタイトルに遷移させることはしない（視聴中タイトル表示・自動遷移はPhase 2以降）。

---

## 2. アーキテクチャ

### 2.1 構成

2コンポーネント構成。

- **Chrome拡張（Manifest V3）** — U-NEXTの視聴ページに注入され、`<video>`要素を監視/制御し、WSS接続を保持する。
- **WSリレーサーバー（Node.js + `ws` / Render Free）** — ルーム管理・ホストイベント中継・最新状態の保持。

```
[U-NEXTタブ]
  content script ──(WSS)── [Render: WSリレー] ──(WSS)── 他参加者のcontent script
    ├ video要素の監視/制御
    └ 同期ロジック
  popup (UI) ──chrome.tabs.sendMessage──→ content script
```

### 2.2 重要な設計判断：WSS接続は content script が持つ

MV3のservice workerはアイドルで停止するためWebSocket常時接続に不向き。一方 content script の寿命＝U-NEXTタブの寿命＝視聴セッションそのものなので、ここにWS接続と同期ロジックを置くのが最も素直。popupはUIだけ（ルームID入力・接続状態表示）でcontent scriptにメッセージで指示を出す。background service workerはMVPでは原則不要（必要なら最小ルーティングのみ）。

---

## 3. コンポーネントと責務

| ユニット | 責務 | 依存 |
|---|---|---|
| `content script` | video要素の探索（遅延ロード/iframe/Shadow DOM対応はPoC結果次第）、ホスト時のイベント送信＋5秒ハートビート、参加者時の状態適用＋ドリフト補正、WSS接続保持 | DOM, WebSocket |
| `popup` | ルームID入力、create(=host)/join(=participant)、接続状態表示（未接続/接続中/接続済み/切断） | chrome.tabs messaging |
| `server` | `rooms: roomId → {hostToken, hostId, hostState, lastState, clients}`、roomID生成、ホスト状態の保存＆参加者へ転送、途中参加者へ即`lastState`配信、ホストスロット管理（トークン照合・タイムアウト保持）、ping/pongによるゾンビ接続掃除、ログ（接続/切断/エラー） | `ws` |
| `sync-core`（純粋関数module） | 期待再生位置の計算（`oneWayLatency`引数つき）、ドリフト判定、状態リコンサイル判断、`seq`単調性チェック。**拡張・サーバー両方から使えるプラットフォーム非依存ロジック**。TDDで固める | なし |

---

## 4. メッセージプロトコル

ホストイベントは全て「全状態スナップショット」として送る。参加者は常に最新状態へリコンサイルするだけ（完全スレーブに最適）。全メッセージにプロトコルバージョン `v` を付与する。

### 4.1 型・単位

| フィールド | 型 | 単位・範囲 |
|---|---|---|
| `v` | integer | プロトコルバージョン（現行 `1`） |
| `currentTime` | number | 秒、`>= 0` |
| `playbackRate` | number | 倍率、`> 0`（例 1.0, 1.5） |
| `playing` | boolean | 再生中か |
| `seq` | integer | ホストごとに単調増加。順序・陳腐化判定に使う（壁時計は使わない） |
| `roomId` | string | サーバー生成のランダムID（例 `abcd1234`） |
| `hostToken` | string | create時にサーバー発行のランダム秘密 |

### 4.2 Client → Server

```json
{ "v": 1, "type": "create" }
{ "v": 1, "type": "join", "roomId": "abcd1234", "role": "host", "hostToken": "..." }
{ "v": 1, "type": "join", "roomId": "abcd1234", "role": "participant" }
{ "v": 1, "type": "sync", "event": "play|pause|seek|ratechange|heartbeat",
  "playing": true, "currentTime": 120.5, "playbackRate": 1.0, "seq": 42 }
```

- `create`：ルーム新規作成。`role: host` の `join` で再接続する際は、create時に受け取った `hostToken` を提示する。

### 4.3 Server → Client

```json
{ "v": 1, "type": "created", "roomId": "abcd1234", "hostToken": "..." }
{ "v": 1, "type": "joined", "role": "host|participant" }
{ "v": 1, "type": "state", "event": "...", "playing": true,
  "currentTime": 120.5, "playbackRate": 1.0, "seq": 42 }
{ "v": 1, "type": "host_taken" }
{ "v": 1, "type": "host_disconnected" }
{ "v": 1, "type": "host_resumed" }
```

- `state` は `sync` をサーバーがそのまま中継したもの。参加者は `seq` の単調性をチェックし、古い（`seq` が後退した）`state` は破棄する。
- `host_taken`：`role: host` で join したが既にホスト在席、または `hostToken` 不一致 → participant にフォールバックした通知。
- `host_disconnected`：実ホストが切断。参加者は表示「ホスト切断」、`lastState` を凍結したまま復帰待ち（ライブ更新停止・現状維持）。
- `host_resumed`：ホスト復帰。ライブ更新を再開する。

---

## 5. レイテンシ補正とドリフト補正

**設計原則：壁時計（`Date.now()`）の引き算をしない。** クロスマシンの絶対時刻オフセット（クロックスキュー）は固定バイアスとなり、heartbeatごとに再注入されて参加者を毎回ズレた位置へseekさせてしまう。これを構造的に避けるため、クロスマシン量として使うのは**片道トランジット遅延 `oneWayLatency` のみ**とし、受信後の経過時間は参加者**自身のmonotonicクロック**（`performance.now()`）で測る。

- **片道遅延の推定**：WSレベルの ping/pong で RTT を測り、`oneWayLatency = RTT / 2`（対称経路を仮定。許容差分1秒に対して十分）。これは §3 のゾンビ接続掃除と同一機構を流用する。
- **受信時の期待位置**：`expected_at_receipt = currentTime + (playing ? oneWayLatency : 0)`
- **受信後の外挿**：`expected(t) = expected_at_receipt + (t - receiptTime) × playbackRate`（`t`・`receiptTime` は参加者ローカルの `performance.now()`）
- 受信のたびに play/pause・playbackRate は即リコンサイル。
- 位置は `|local.currentTime - expected(now)| > 1秒`（許容差分）のときだけ `currentTime` を強制セットする。
- ホストは5秒ごと（補正周期）にheartbeatで全状態を送る → 途中参加・ドリフト・一時切断復帰をこの1本でカバー（方式C）。バックグラウンドタブのスロットリング対策として、heartbeatは `timeupdate` イベント駆動を主・`setInterval` を従とする（§7.2の制約も参照）。
- **順序保証**：`seq` の単調性をチェックし、後退した `state` は破棄（out-of-order / 再送対策）。`hostTimestamp`（壁時計）は使わない。
- **フィードバックループ防止**：参加者が状態をプログラム的に適用する間はガードフラグを立て、自分のvideoイベントで送り返さない（完全スレーブなので元々送信しないが、二重防御として実装する）。
- **参加者の誤操作の即時補正**：参加者の `seeking` / `play` リスナで即リコンサイルをトリガーし、次のheartbeat（最大5秒）を待たずにホスト状態へ戻す（ガードフラグと両立）。
- `sync-core` は `oneWayLatency` を引数に取る（初期値0）。RTT推定が無くても0で動作し、推定値が入れば精度が上がる。

### 初期パラメータ

| 項目 | 値 |
|---|---|
| 補正周期（heartbeat） | 5秒 |
| 許容差分 | 1秒 |

---

## 6. エラーハンドリングとホストスロット管理

### ホストスロット管理（本人確認）

- create時にサーバーが**ホストトークン**（ランダム秘密）を発行し、`created` で返す。拡張はこれを保持する。
- `role: host` の join はトークン照合が必要。トークン一致 → ホストスロット再取得。不一致または既に別ホストが活きている → `host_taken` を返し participant にフォールバック。
- **ホストスロットのタイムアウト保持**：ホストのWSが切断されてもスロットを即解放せず、一定時間（例：60秒）保持する。この間に同一トークンで再接続すれば同じホストとして復帰でき、別人がホストを奪えない。タイムアウト超過でスロット解放。
- ホスト切断中は参加者へ `host_disconnected`、復帰時に `host_resumed` を送る（§4）。

### 接続・再接続

- **WS切断** → 指数バックオフで自動再接続。状態表示は 切断 → 接続中。再接続時、参加者は再joinし、サーバーが `lastState` を返すことで自動再同期する。ホストはトークン提示でスロットを再取得する。
- **Renderコールドスタート対応** → 再接続バックオフはコールドスタート（数十秒）を見込んだ長めの上限を持ち、初回WS接続タイムアウト時もリトライを継続する（§7.2）。
- **デッドコネクション検出** → サーバーは ping/pong（30秒間隔）で半開（half-open）接続・ゾンビclientを掃除し、ホスト在席判定の正確性を保つ。

### その他

- **video要素が見つからない** → MutationObserverでリトライ。見つからなければ状態「プレイヤー未検出」を表示。
- **Mixed Content** → WSS必須（RenderがHTTPS/WSSエンドポイントを提供）。

---

## 7. 非機能要件

### 7.1 性能

- 同時接続数 10人以下。
- イベント遅延 500ms以下を目標。

### 7.2 可用性

- 常時稼働不要。土曜夜の利用に耐えればよい。
- Render Freeはアイドルで停止（スリープ）するため、**利用開始時にURLを叩いてサーバーを起こす**運用ステップが必要。
- 既知の制約（MVPでは許容）：(a) コールドスタートに数十秒かかり最初のWS接続がタイムアウトしうる → クライアント再接続の長めバックオフで吸収（§6）。(b) Render Freeには月間稼働時間上限がある。(c) アイドルスピンダウンにより、利用中でもトラフィックの谷で落ちうる → 自動再接続で復帰。
- **バックグラウンドタブのタイマースロットリング**（§5）：ホストのタブが非アクティブだと `setInterval` が最大~1分まで間引かれ、heartbeatが途切れる。play/pause/seek/rate はユーザー操作で即発火するため影響を受けないが、ドリフト補正用heartbeatは影響を受ける。対策＝`timeupdate` 駆動を主とする＋「ホストはタブを前面に保つ」運用注記。完全には防げない既知の制約として明記。

### 7.3 セキュリティ

- WSS必須。
- ルーム分離＝メッセージは同一roomId内のみ転送。
- 認証なし（仕様通り）。**ルームIDを知れば誰でも入れる**点は許容する。createでは**サーバーが推測耐性のあるランダムID**を生成（手入力不要）、joinは手入力で参加する。
- ホストトークンはホスト権限の本人確認のみに用いる秘密（§6）。

### 7.4 ログ

- 保存対象：接続・切断・エラー。
- 保存期間：任意。

---

## 8. テスト方針

- **`sync-core`（純粋関数）**：期待位置計算（`oneWayLatency`つき）・ドリフト判定・リコンサイル判断・`seq`単調性チェックをTDDでユニットテスト。
- **server**：wsテストクライアントで room/host/broadcast/lastState/再接続/ホストトークン照合/スロットタイムアウト/ping-pong掃除をユニットテスト。
- **content scriptのDOM制御**：ローカルのHTML5 `<video>` 固定ページをfixtureに自動テスト＋U-NEXT実機で手動テスト。
- **手動テスト計画**：2プロファイルで同一タイトルを開き、play / pause / seek / rate / ドリフト復帰 / 再接続 / ホスト切断→復帰 を確認する。
- **クロックスキュー回帰テスト**：壁時計を意図的にズラした2台で同期が壊れないことを確認（§5の壁時計非依存設計の回帰ガード）。

---

## 9. 技術スタック

- サーバー：Node.js + `ws`、Render Freeデプロイ。
- 拡張：Manifest V3、フレームワークなし。言語はTypeScript、ビルドは esbuild で軽量バンドル（content / popup / sync-core）。
- テスト：vitest。
- **移行容易性**：serverのルーム/状態/中継ロジックを `ws` 依存から切り離して書く → 将来 Cloudflare Workers + Durable Objects への移行を機械的にできるようにする（ワイヤプロトコルは共通）。

---

## 10. 制約事項

本システムは以下を実施しない。

- 動画データ取得、DRM解除、動画共有、映像転送、音声転送。

参加者は各自のU-NEXTアカウントを利用する。

---

## 11. フェーズ計画

### Phase 0（PoC・ゲート） ⚠️ 最重要

content scriptがU-NEXTの `<video>` を探索し、`currentTime` 読み書き・play/pause・playbackRate制御ができるかを実機検証する。

- 出力：go/no-go ＋ 要素への到達方法（直アクセス / iframe / Shadow DOM）。
- **ここが通るまで本体実装を始めない。** U-NEXTがiframe/Shadow DOM/独自プレイヤーで囲っている場合、MVPごと方針転換が必要になるため。

**検証結果（2026-06-05・go確定）：**
- 到達方法：**トップフレームの素の `document.querySelector("video")`**。iframe / Shadow DOM の介在なし。
- `currentTime` は再生に従い増加、`duration` も実値（例 1422.02s）を取得。
- **seek 書き込みが定着**（`currentTime = before - 5` 後も `verdict: OK`、プレイヤーに巻き戻されない）。完全スレーブ同期の前提が成立。
- `pause()` / `play()` 切替が機能（`toggled: true`）。
- 再生中の `playbackRate = 1.5` 書き込みが反映（`ok: true`）。
- DRM（EME）は存在するが、再生状態の制御API（currentTime/play/pause/playbackRate）はブロックしない。
- ページ内に Google Tag Manager の iframe（`sst-gtm-01.unext.jp/.../sw_iframe.html`）が存在し動画とは無関係。
  → **本番マニフェストは `all_frames: false`、`matches` を `https://video.unext.jp/*` に限定**し、解析iframeでのcontent script多重起動を防ぐ。

### Phase 1（MVP）

- ルーム create（サーバー生成ID＋ホストトークン発行）/ join（手入力）
- ホストイベント同期（play / pause / seek / ratechange）＋ `seq` 順序保証
- heartbeatベースの `lastState` ＋ 壁時計非依存のドリフト補正（RTTからの片道遅延推定＋ローカル外挿）
- ホストスロット管理（トークン照合・切断タイムアウト保持・切断/復帰通知）
- ping/pong によるデッドコネクション掃除
- 接続状態表示（未接続/接続中/接続済み/切断、ホスト切断）
- 自動再接続（Renderコールドスタートを見込んだバックオフ）
- Renderデプロイ

### 将来拡張

- **Phase 2**：Cloudflare Workers + Durable Objects への移行、ホスト委譲、参加者一覧表示、視聴中タイトル表示。
- **Phase 3**：Netflix / Prime Video / Disney+ 対応。
- **Phase 4**：汎用HTML5 Video同期プラットフォーム化。

### MVP実装対象外

- チャット、音声通話、字幕同期、複数ホスト、ホスト委譲、スマートフォン対応、U-NEXT以外への対応、参加者の自動タイトル遷移。
