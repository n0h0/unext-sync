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
- **固定ホスト**：ルーム作成者がホスト。再接続時はサーバーが保持するホストスロットを再取得する。
- **方式C（リレー＋ホスト定期ハートビート）**：サーバーは基本イベント転送だが、ホストが5秒ごとに全状態を送り、サーバーは「最新状態（lastState）」を保持する。途中参加・ドリフト・一時切断からの復帰をこの1本でカバーする。

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
| `server` | `rooms: roomId → {hostId, lastState, clients}`、ホスト状態の保存＆参加者へ転送、途中参加者へ即`lastState`配信、ホストスロット管理、ログ（接続/切断/エラー） | `ws` |
| `sync-core`（純粋関数module） | 期待再生位置の計算、ドリフト判定、状態リコンサイル判断。**拡張・サーバー両方から使えるプラットフォーム非依存ロジック**。TDDで固める | なし |

---

## 4. メッセージプロトコル

ホストイベントは全て「全状態スナップショット」として送る。参加者は常に最新状態へリコンサイルするだけ（完全スレーブに最適）。

**Client → Server:**
```json
{ "type": "join", "roomId": "abcd1234", "role": "host" }
```
```json
{ "type": "sync", "event": "play|pause|seek|ratechange|heartbeat",
  "playing": true, "currentTime": 120.5, "playbackRate": 1.0,
  "hostTimestamp": 1733400000000 }
```

**Server → Client:**
```json
{ "type": "joined", "role": "host|participant" }
```
```json
{ "type": "state", "event": "...", "playing": true, "currentTime": 120.5,
  "playbackRate": 1.0, "hostTimestamp": 1733400000000 }
```
```json
{ "type": "host_unavailable" }
```

- `join` のroleが `host` でも、既にホスト在席なら participant にフォールバックし `host_unavailable` を通知する。
- `state` は `sync` をサーバーがそのまま中継したもの。

---

## 5. レイテンシ補正とドリフト補正

- ホストは送信時に `hostTimestamp` を付与する。
- 参加者は**期待ホスト位置**を計算する：
  `expected = currentTime + (playing ? (受信時刻 - hostTimestamp) / 1000 × playbackRate : 0)`
- 受信のたびに play/pause・playbackRate は即リコンサイル。
- 位置は `|local.currentTime - expected| > 1秒`（許容差分）のときだけ `currentTime` を強制セットする。
- ホストは5秒ごと（補正周期）にheartbeatで全状態を送る → 途中参加・ドリフト・一時切断復帰をこの1本でカバー（方式C）。
- **クロックスキューはMVPでは無視**する。マシン間の時計ズレは1秒許容＋heartbeat吸収で土曜夜のカジュアル用途には十分。将来、join時のping/pongによるオフセット推定に差し替え可能（拡張ポイント）。
- **フィードバックループ防止**：参加者が状態をプログラム的に適用する間はガードフラグを立て、自分のvideoイベントで送り返さない（完全スレーブなので元々送信しないが、二重防御として実装する）。

### 初期パラメータ

| 項目 | 値 |
|---|---|
| 補正周期（heartbeat） | 5秒 |
| 許容差分 | 1秒 |

---

## 6. エラーハンドリング

- **WS切断** → 指数バックオフで自動再接続。状態表示は 切断 → 接続中。再接続時、参加者は再joinし、サーバーが `lastState` を返すことで自動再同期する。ホストはホストスロットを再取得する。
- **video要素が見つからない** → MutationObserverでリトライ。見つからなければ状態「プレイヤー未検出」を表示。
- **Mixed Content** → WSS必須（RenderがHTTPS/WSSエンドポイントを提供）。
- **ホスト二重** → 固定ホストモデル。createでスロット確保、joinは参加者。既にホスト在席でhost要求が来たらparticipantにフォールバックし通知。

---

## 7. 非機能要件

### 7.1 性能

- 同時接続数 10人以下。
- イベント遅延 500ms以下を目標。

### 7.2 可用性

- 常時稼働不要。土曜夜の利用に耐えればよい。
- Render Freeはアイドルで停止（スリープ）するため、**利用開始時にURLを叩いてサーバーを起こす**運用ステップが必要。

### 7.3 セキュリティ

- WSS必須。
- ルーム分離＝メッセージは同一roomId内のみ転送。
- 認証なし（仕様通り）。**ルームIDを知れば誰でも入れる**点は許容する。推測されにくいランダムめのID（例 `abcd1234`）を推奨する旨をドキュメントに記載。

### 7.4 ログ

- 保存対象：接続・切断・エラー。
- 保存期間：任意。

---

## 8. テスト方針

- **`sync-core`（純粋関数）**：期待位置計算・ドリフト判定・リコンサイル判断をTDDでユニットテスト。
- **server**：wsテストクライアントで room/host/broadcast/lastState/再接続をユニットテスト。
- **content scriptのDOM制御**：ローカルのHTML5 `<video>` 固定ページをfixtureに自動テスト＋U-NEXT実機で手動テスト。
- **手動テスト計画**：2プロファイルで同一タイトルを開き、play / pause / seek / rate / ドリフト復帰 / 再接続 を確認する。

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

### Phase 1（MVP）

- ルーム create / join
- ホストイベント同期（play / pause / seek / ratechange）
- heartbeatベースの `lastState` ＋ ドリフト補正
- 接続状態表示
- 自動再接続
- Renderデプロイ

### 将来拡張

- **Phase 2**：Cloudflare Workers + Durable Objects への移行、ホスト委譲、参加者一覧表示、視聴中タイトル表示。
- **Phase 3**：Netflix / Prime Video / Disney+ 対応。
- **Phase 4**：汎用HTML5 Video同期プラットフォーム化。

### MVP実装対象外

- チャット、音声通話、字幕同期、複数ホスト、ホスト委譲、スマートフォン対応、U-NEXT以外への対応、参加者の自動タイトル遷移。
