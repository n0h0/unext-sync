# 視聴中タイトル表示 設計仕様書

作成日: 2026-06-07

## 0. 位置づけ

`docs/superpowers/specs/2026-06-05-watch-sync-design.md`（正典）の **Phase 2** に含まれる4機能のうち、**視聴中タイトル表示**を独立した1サイクル（spec → plan → 実装）として切り出したもの。

`docs/superpowers/specs/2026-06-07-participant-roster-design.md`（参加者一覧表示）で導入された配信基盤（content script を source of truth とする状態保持・popup への転送・`get_status` 復元）の上に乗る。ロスター spec（§0 の位置づけ・§9 の対象外）で「視聴中タイトル表示はロスター配信路に相乗り可」とされていたが、**タイトルは話数遷移で join とは別タイミングに変わる**ため、ロスター（参加者の入退室で変化）とは更新頻度が異なる。本仕様は両者を疎結合にするため **専用メッセージ路** を採る。

同期ロジック（完全スレーブ・方式C・壁時計非依存）には一切変更を加えない。本仕様は **ホストが見ている作品名の配信と表示** を足すだけである。

## 1. 目的

複数ユーザーが同じルームで視聴している際、**「ホストがいま何の作品を開いているか」を全員のpopupに表示**する。正典 §1 の前提「全員が手動で同じタイトルを開いている」に対し、各参加者が **自分の画面とホストの作品名を見比べて一致を確認できる** ようにする。

## 2. 確定事項（ブレインストーミングでの決定）

| 論点 | 決定 |
|---|---|
| コア挙動 | **ホストのタイトルのみ表示**。参加者ごとのタイトル報告・不一致警告はしない（最小構成） |
| タイトル取得 | **`document.title` を浄化**。DOMセレクタ/OGPには依存しない（U-NEXTのDOM構造変更に強い） |
| 変化追従 | `<title>` への `MutationObserver` で SPA の話数遷移を検知（host のみ） |
| 配信路 | **専用メッセージで独立**（ロスターに相乗りしない）。更新頻度の違いを疎結合に保つ |
| 真実源 | サーバーが `room.hostTitle` を保持。変化時に全員へ push、途中参加者には join 直後に現在値を送る |
| 受信者 | **全員**（ホスト本人も含む。検知が効いていることの確認になる） |
| ホスト切断時 | `hostTitle` は60秒保持中も残す（`hostName` と同じ扱い。復帰でそのまま継続） |

## 3. タイトル取得（`extension`・ホストのみ）

### 純粋関数 `cleanTitle(raw): string`（`extension/src/title.ts`）

`document.title` を表示用に浄化する。プラットフォーム非依存の純粋関数として切り出し、TDD対象とする。

1. 末尾の U-NEXT サフィックスを除去する。全角パイプ `｜` または半角パイプ `|`（前後空白許容）以降に `U-NEXT` を含む末尾セグメントを落とす。
2. `trim` する。
3. 連続する空白（全角・半角・タブ・改行）を半角スペース1つに圧縮する。

結果が空文字になった場合も空文字をそのまま返す（送信側で「空なら送らない」を判断する。§5）。

### 送信ロジック（`content.ts`・送信ゲートは「`joined` かつ `role: "host"` を受けた時」のみ）

> **送信ゲートを `session.role` で判定しないこと。** `session.role` はホスト降格後も `"host"` のまま残る。role: host で join しても、トークン不一致・ホスト在席時はサーバーが `host_taken` を返して参加者として `clients` に乗せる（`server.ts:118-119` / `rooms.ts:82-83`）。このとき `joined` は来ない。素朴に `if (session.role === "host")` を条件にすると、降格したホストが（サーバーは `clientId !== hostId` で弾くので実害はないが）無駄に MutationObserver を張り初回送信してしまう。**唯一のゲートは「`handleServer` で `joined` かつ `role: "host"` を受信したこと」**とする。

- **ホストの join 確定後**（`handleServer` の `joined`（`role: "host"`）受信時）に送信を開始する。サーバーは `ctx.roomId` 未設定（join 前）の `title` を無視するため、`onOpen` 直後ではなく join 確定を待つ。`host_taken` 受信時は開始しない。
  - join 確定時に `cleanTitle(document.title)` を1回送る。空文字なら送らない。
  - 同じく join 確定時に `<title>` 要素へ `MutationObserver` を張る。変化を **約1秒デバウンス** し、`cleanTitle` の結果が **前回送信値と異なる時だけ** `title` メッセージを送る。空文字になった場合は送らない（直前の値を維持）。
- 参加者は一切送らない。

## 4. メッセージプロトコル（`shared/protocol.ts`）

プロトコルバージョンは **`v: 1` のまま**。追加のみで後方互換。古いクライアントは未知の型を無視する。

### 4.1 Client → Server（`title` を新設・ホストのみ送る）

```jsonc
{ "v":1, "type":"title", "title":"作品名 第3話 サブタイトル" }
```

- `roomId` は持たない。サーバーは接続コンテキスト（`ctx.roomId` / `ctx.id`）から所属ルームとホスト判定を行う（既存 `sync` と同じ）。
- 新 `TitleMessage = { v:number; type:"title"; title:string }` を定義し、`ClientMessage` 合併型に加える（§4.2 の `RoomTitleMessage`／`ServerMessage` と対称）。
- `parseClientMessage` に `title` ケースを追加。`title` が文字列でなければ `null`（不正メッセージ）を返す。正規化（trim/制御文字除去/長さ上限）は §5 のサーバー側で行い、`parseClientMessage` は型チェックのみ。

### 4.2 Server → Client（`room_title` を新設）

```jsonc
{ "v":1, "type":"room_title", "title":"作品名 第3話" }
```

- 新 `RoomTitleMessage = { v:number; type:"room_title"; title:string }` を定義し、`ServerMessage` 合併型に加える。
- `title` は常に非空文字列（サーバーは空タイトルをブロードキャストしない。§5）。

## 5. サーバー状態とロジック（`server/src/rooms.ts`）

不変条件#2（`rooms.ts` は `ws` 非依存・全副作用は `RoomManagerDeps` で注入）を維持する。タイトル関連の状態・ロジックはすべて `rooms.ts`（純粋）側に置き、`server.ts` は配線のみ。

### 状態

- `Room` に **`hostTitle: string | null`** を追加。初期値 `null`。
- ホスト切断の60秒保持中（`hostId === null`）も `hostTitle` は保持する。ホスト復帰でそのまま継続。ルーム削除（`deleteIfEmpty`）でのみ消える。

### 新メソッド `setHostTitle(roomId, clientId, rawTitle): { changed: boolean }`（純粋）

- ルーム不在、または `clientId !== room.hostId`（＝ホスト以外）の場合は `{ changed: false }` を返し、状態を変えない。
- ホストの場合、`rawTitle` を正規化する（trim・制御文字 U+0000–U+001F/U+007F 除去・**最大120文字**で切り詰め）。
  - **既存 `normalizeName`（`rooms.ts:8-11`）を `normalizeText(raw, maxLen)` に一般化して再利用する。** `normalizeName` は上限24だけが違う同一処理で、`[...raw]...slice` によりコードポイント単位で切り詰めてサロゲートペアを壊さない。仕様文面どおりに新規実装して `str.slice(0,120)` とするとサロゲート分割バグを埋め込むため、必ず一般化版を使う（`CONTROL_CHARS` 正規表現の重複も避ける）。`normalizeName(raw)` は `normalizeText(raw, 24)` に委譲する形にする。
- 正規化後が空文字なら状態を変えず `{ changed: false }` を返す（空タイトルは保持・配信しない）。
- 正規化後が現在の `hostTitle` と異なれば更新して `{ changed: true }`、同じなら `{ changed: false }`。

### 新メソッド `hostTitleOf(roomId): string | null`（純粋）

- ルームの `hostTitle` を返す。ルーム不在なら `null`。

## 6. 配信契機（`server.ts`）

`broadcastRoomTitle(roomId)`：`hostTitleOf` が非null のとき、`{ type:"room_title", title }` を **ルーム内の全クライアント**（`clientIdsOf`）へ送る。呼ぶのは以下のみ。

- `title` メッセージ受信時：`setHostTitle(ctx.roomId, ctx.id, msg.title)` の結果が `changed:true` のときだけ `broadcastRoomTitle`。ホスト以外・未参加（`ctx.roomId` が null）からの `title` は黙って無視。
- `join` 成功時：`broadcastRoster` の後、`hostTitleOf(roomId)` が非null なら **join した本人へのみ** `room_title` を1通送る（途中参加のキャッチアップ）。**`host_taken` フォールバック（ホスト志望→参加者降格）も含む。** `host_taken` も `ctx.roomId` がセットされ `broadcastRoster` 対象になる完全なルーム参加者（`server.ts:117-130`）なので、ここを漏らすと降格した参加者だけ視聴中タイトルが初期表示されない。宛先はロスターと同じ「その本人」。

`sync` / heartbeat ではタイトルを触らない（再生状態の流量でタイトルを再送しない）。

## 7. UI（`extension`）

### content script（`content.ts`）

- タイトルの **source of truth は content script** が保持する（`currentTitle: string | null`。`currentStatus` / `currentRoster` と同じ扱い）。
  - サーバーからの `room_title` を受けたら `currentTitle` を更新し、popupへ `{ type:"room_title", title }` を転送する。`handleServer`（`content.ts:88-130`）の switch に **専用 `case "room_title"` を追加する**（`roster` と同様）。`default` 分岐は `nextStateForServerEvent` + `server_event` 転送なので、ここに落とすと誤って status 更新経路に流れる。
  - `get_status` 応答に `title` を含め、popup再オープン時に復元できるようにする。
- ホストの場合は §3 の送信ロジックを組み込む。

### `parse-server.ts`

- `TYPES` に **`"room_title"` を追加**する。漏らすと `WsClient` が `room_title` を黙って破棄する（既知の落とし穴）。

### popup（`popup.html` / `popup.ts` / `popup-status.ts`）

- 純粋関数 **`renderWatchingTitle(title): string | null`** を追加。`null` または空文字なら `null`（行を描画しない）、それ以外は表示文字列を返す。`renderRoster` / `renderStatusLabel` と同じ流儀でユニットテストする。
- 描画は **`textContent`**（XSS回避。`innerHTML` を使わない）。
- 配置はロスターの直上、状態行の下。タイトルが無ければ行ごと非表示。

```
┌────────────────────────────┐
│ [ あなたの名前: たろう    ] │
│ [ ルームID（参加時）      ] │
│ [   ルーム作成（ホスト）  ] │
│ [   参加（参加者）        ] │
│ ルームID: abcd1234（共有…） │
│ 状態: 接続済み              │
│ 🎬 視聴中: 作品名 第3話      │  ← title が無ければ非表示
│ ─ 参加者 (3) ───────────── │
│  👑 たろう (あなた)         │
│  はなこ                     │
└────────────────────────────┘
```

## 8. テスト方針（TDD）

純粋なロジックはテストファースト（不変条件・既存方針に準拠）。

- **`cleanTitle`（`extension/src/title.ts`）**：U-NEXTサフィックス除去（半角/全角パイプ・前後空白）/ trim / 連続空白の圧縮 / 既に綺麗な文字列はそのまま / 空入力。
- **`protocol.ts`**：`title` の型チェック（非文字列で `null`、文字列はそのまま透過、未知フィールド無視）。
- **`rooms.ts`**：`setHostTitle` がホストのみ受理・非ホスト/不在ルームで `changed:false`・正規化（trim/制御文字/120文字切詰）・空タイトルで `changed:false`・同値で `changed:false`。`hostTitleOf`。ホスト切断保持中も `hostTitle` が残る。
- **`renderWatchingTitle`**：null/空で `null`（非表示）、通常文字列で表示。
- **server（任意・既存の ws テストがあれば）**：host の `title` → ルーム全員に `room_title` が届く、途中参加で現在のタイトルを受領する、非ホストの `title` は無視される。

## 9. 非機能・制約

- 性能：同時10人以下。タイトルはイベント駆動（接続時・話数遷移時）でのみ送るので流量は小さい。デバウンスで連続変化を抑える。
- セキュリティ：タイトルは **信頼しない表示文字列**。サーバーで長さ上限・制御文字除去を行い、popup側は `textContent` で描画する。
- ホストのページ再読込で content script が再起動した場合の挙動は正典 §11「既知の制約」（ホスト再読込でルーム復帰しない）に従う。本仕様で新たな対応はしない。
- **stale タイトルの残置（意図的な選択）**：「空タイトルは送らない・直前値を維持」のため、ホストが視聴ページを離れてブラウズ画面（`document.title` が `U-NEXT` のみ → 浄化後空）へ移動しても、全員には旧タイトルが出続ける。U-NEXT のページ間遷移で一瞬空になっても表示がちらつかない利点を優先した。明示クリアは sentinel 設計が要り複雑化するため対象外（§11）。

## 10. 不変条件チェック（正典「設計上の不変条件」との整合）

- **#1（壁時計非依存）**：タイトルは順序判定に関与しない。`seq` にも触れない。影響なし。✓
- **#2（rooms非依存・DI）**：`hostTitle` 状態・`setHostTitle`/`hostTitleOf` ロジックは `rooms.ts`（純粋）に置き、`server.ts` は配線のみ。CF Workers + DO への機械的移行性を維持。✓
- **#3（差分でなくスナップショット）**：`room_title` は常にタイトル全体を送る。クライアントは届いた値で丸ごと置き換える。✓
- **#4（フィードバックループ防止）**：タイトル送出は video イベントと独立。`isApplying()` ガード下のロジックには触れない。参加者は title を送らない。✓
- **#5（WS接続はcontent script）**：送信もcontent scriptが持つ。background worker は不要。✓

## 11. 対象外（このサイクルでやらないこと）

- 参加者ごとのタイトル報告・ホストとの不一致警告（コア挙動で不採用）。
- 自動タイトル遷移（正典の非対象）。
- 話数・シーズンの構造化抽出、URL/作品IDでの照合。
- 改名と同様、タイトルの編集・履歴・通知音。
