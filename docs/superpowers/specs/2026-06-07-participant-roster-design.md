# 参加者一覧表示（ロスター）設計仕様書

作成日: 2026-06-07

## 0. 位置づけ

`docs/superpowers/specs/2026-06-05-watch-sync-design.md`（正典）の **Phase 2** に含まれる4機能のうち、**参加者一覧表示**を独立した1サイクル（spec → plan → 実装）として切り出したもの。

Phase 2 の他の3機能との関係：

- **CF Workers + DO 移行**：本仕様と独立。いつ実施してもよい。
- **ホスト委譲**：本仕様が導入する「参加者の識別（名前・id）」を前提にできる。
- **視聴中タイトル表示**：本仕様が導入するロスター配信路に相乗りできる。

つまり本仕様は他機能の**土台**になる。各機能はそれぞれ別 spec で扱う。

## 1. 目的

複数ユーザーが同じルームで視聴している際、**「いま誰がルームにいるか」を全員のpopupに表示**する。2〜10人の知人利用で「全員揃ったか」「同じ作品を開けているか」を各自で確認できるようにする。

動画の同期ロジック（完全スレーブ・方式C・壁時計非依存）には一切変更を加えない。本仕様は**表示のための名簿（ロスター）配信**を足すだけである。

## 2. 確定事項（ブレインストーミングでの決定）

| 論点 | 決定 |
|---|---|
| 識別方法 | **ユーザー入力のニックネーム**（人間に分かる名前を表示） |
| 入力・永続化 | popupで入力 → `chrome.storage.local` に保存 → 次回プリフィル |
| 空欄時 | **接続をブロックしない**。サーバーが `ゲスト-<4桁hex>` を自動付与 |
| 配信方式 | **サーバーが唯一の真実源**。変化のたびに**全ロスターのスナップショット**を全員へ push（差分は送らない） |
| 受信者 | **全員**（ホストも参加者も） |
| 参加者の切断 | **即リストから消す → 再接続で再出現**（猶予つきオフライン表示はしない） |
| ホストの見せ方 | **リストに1行**（👑）。切断中は60秒保持しつつ「(切断)」表示、復帰で戻す |
| 改名 | **対象外**（変えたければ再接続する） |

## 3. データモデル（`server/src/rooms.ts`）

不変条件#2（`rooms.ts` は `ws` 非依存・全副作用は `RoomManagerDeps` で注入）を維持する。ロスター関連の状態・ロジックはすべて `rooms.ts`（純粋）側に置き、`server.ts` は配線のみ。

### 変更点

- `Room.clients` を `Set<string>` → **`Map<string, ClientInfo>`** に変更。`ClientInfo = { name: string }`。
- `Room` に **`hostName: string | null`** を追加。ホスト切断の保持期間中（`hostId === null` かつ `hostDisconnectedAt !== null`）も「👑 <名前> (切断)」行を出し続けるため、名前を覚えておく。
- ロールは派生で判定する（`clientId === hostId` ⇔ ホスト）。専用フィールドは増やさない。

#### `Set → Map` に伴う既存呼び出し箇所の修正（漏らさないこと）

`clients` を Set 前提で走査している既存コードを全て直す。特に `[...room.clients]` は Map では `[key, value]` ペア配列になり、`string[]` を期待するブロードキャストが**コンパイルは通るがサイレントに壊れる**。

| 箇所 | 現状 | Map化後 |
|---|---|---|
| `join`（`rooms.ts:52`） | `room.clients.add(clientId)` | `room.clients.set(clientId, { name })` |
| `recordSync`（`rooms.ts:85`） | `[...room.clients].filter(...)` | `[...room.clients.keys()].filter(...)` |
| `participantsOf`（`rooms.ts:121`） | `[...room.clients].filter(...)` | `[...room.clients.keys()].filter(...)` |
| `deleteIfEmpty`（`rooms.ts:126`） | `room.clients.size === 0` | 変更不要（`.size` は Map でも有効） |

#### `join()` シグネチャと名前の格納

- `join(roomId, clientId, role, hostToken?, name?)` に拡張する。
- §「名前の正規化」を `join` の入口で適用し、**outcome を問わず**（`joined-host` / `joined-participant` / `host_taken` フォールバックのいずれでも）正規化済み name を `ClientInfo` に格納する。`host_taken` でも参加者として `clients` に乗る（`rooms.ts:52`）ため名前が要る。
- host 確定時（`joined-host`）は同じ正規化済み name を `hostName` にも保存する（切断保持中の合成行で使う）。

### 名前の正規化（サーバー側）

`join` で受け取った `name` を以下で正規化してから保存する。実装は純粋関数として切り出し、`rooms.ts` から使う。

1. 文字列でなければ未指定扱い。
2. trim、制御文字（U+0000–U+001F, U+007F）を除去。
3. **最大24文字**で切り詰め（超過はブロックせず切る）。
4. 結果が空文字なら **`ゲスト-<4桁hex>`** を割り当てる。hex は `deps.genId()` 由来の値から取り、注入された乱数源のみを使う（`Math.random` は使わない）。

### 新メソッド `rosterOf(roomId): RosterEntry[]`（純粋）

- 戻り値の先頭が**ホスト行**、続けて参加者行（`clients` の挿入順）。
- ホスト接続中は**ホストも `clients` に居る**ため、二重に出さないこと。手順：(1) `hostId` の clientId を `clients` から取り出して `{ id: hostId, name, host: true, connected: true }` を先頭に置く、(2) **残りの clientId**（`id !== hostId`）を挿入順で `{ id, name, host: false, connected: true }` として続ける。
- ホスト保持中（`hostId === null && hostName !== null && hostDisconnectedAt !== null`）は、合成のホスト行 `{ id: "__host__", name: hostName, host: true, connected: false }` を先頭に加える（このときホスト本人は `clients` に居ないので二重化しない）。id は実 clientId（`randomUUID`）と衝突しない固定センチネルを使う。
- ルーム不在なら空配列。

## 4. メッセージプロトコル（`shared/protocol.ts`）

プロトコルバージョンは **`v: 1` のまま**。追加のみで後方互換。古いクライアントは未知の `name` を無視する。未知の `roster` 型は、現状の `content.ts:106` の default 分岐で `server_event` として popup へ転送されるが、`nextStateForServerEvent("roster")` が `null`（`popup-status.ts`）を返すため表示は変化せず、実害なく無視される。

### 4.1 Client → Server（`join` に `name` を追加）

```jsonc
{ "v":1, "type":"join", "roomId":"abcd1234", "role":"host", "hostToken":"...", "name":"たろう" }
{ "v":1, "type":"join", "roomId":"abcd1234", "role":"participant", "name":"はなこ" }
```

- `name` は任意（`string` か未指定）。`parseClientMessage` は `name` が存在して文字列でない場合のみ `null`（不正メッセージ）を返す。正規化（trim/切詰/空→既定）は §3 のサーバー側で行い、`parseClientMessage` は型チェックのみ。

### 4.2 Server → Client（`roster` を新設、`joined`/`host_taken` に `clientId` を追加）

```jsonc
{ "v":1, "type":"roster", "participants":[
  { "id":"...", "name":"たろう", "host":true,  "connected":true  },
  { "id":"...", "name":"はなこ", "host":false, "connected":true  },
  { "id":"...", "name":"じろう", "host":false, "connected":true  }
]}

{ "v":1, "type":"joined", "role":"participant", "clientId":"..." }
{ "v":1, "type":"host_taken", "clientId":"..." }
```

- `RosterEntry = { id: string; name: string; host: boolean; connected: boolean }`。
- `joined` / `host_taken` に自分の **`clientId`** を載せる。クライアントは自分の id を覚え、ロスター上で自分の行を「(あなた)」と強調する（名前が衝突しても一意に判定できる）。
- **型設計**：`clientId` を持つのは `joined` と `host_taken` のみ。現状この2つは `host_disconnected`/`host_resumed` と合わせて `HostStatusMessage` 合併型だが、`clientId` を全メンバーに付けるのは不自然。**`joined` と `host_taken` を独立メッセージ型に切り出し**、`clientId: string` を必須フィールドとして持たせる（`host_disconnected`/`host_resumed` は従来どおり `clientId` なし）。

### 4.3 配信契機（`server.ts`）

`broadcastRoster(roomId)`：`rosterOf` の結果を**ルーム内の全クライアント**（ホスト＋参加者）へ送る。呼ぶのは以下のロスター変化時のみ。

- `join` 成功（host / participant）
- `host_taken` フォールバック（新規参加者として `clients` に乗る）
- クライアント切断（`close` → `removeClient`）
- ホスト切断（`host_disconnected` と同時）
- ホスト復帰（`host_resumed` と同時）
- ホストスロットの timeout 掃除（`sweepHostTimeouts` でスロット解放したルーム）

`sync` / heartbeat ではロスターを触らない（再生状態の流量でロスターを再送しない）。

**送信順序**：join した本人には、まず `joined` / `host_taken`（自分の `clientId` 付き）を送り、**その後に** `broadcastRoster` を呼ぶ。こうすると本人が roster を受け取った時点で既に自分の `selfId` を知っており、「(あなた)」強調が初回から安定する。

## 5. UI（`extension`）

### popup（`popup.html` / `popup.ts`）

- 先頭に **名前入力 `<input id="name">`** を追加。`chrome.storage.local` から読んでプリフィルし、create/join 時に保存する。
- ルームID/状態の下に **ロスター表示 `<div id="roster">`** を追加。ヘッダは `参加者 (N)`。

```
┌────────────────────────────┐
│ [ あなたの名前: たろう    ] │  ← chrome.storage 保存・プリフィル
│ [ ルームID（参加時）      ] │
│ [   ルーム作成（ホスト）  ] │
│ [   参加（参加者）        ] │
│ ルームID: abcd1234（共有…） │
│ 状態: 接続済み              │
│ ─ 参加者 (3) ───────────── │
│  👑 たろう (あなた)         │
│  はなこ                     │
│  じろう (切断)   ← 灰色      │
└────────────────────────────┘
```

- 行の装飾：`host` なら先頭に 👑、自分（`id === selfId`）なら末尾に「(あなた)」、`connected:false` なら「(切断)」＋灰色。
- 描画ロジックは純粋関数 **`renderRoster(entries, selfId)`** に切り出し、`popup-status.ts` の `renderStatusLabel` と同じ流儀でユニットテストする。

### content script（`content.ts`）

- ロスターの **source of truth は content script** が保持する（popupは開くたび破棄されるため。`currentStatus` と同じ扱い）。
  - サーバーからの `roster` を受けたら `currentRoster` を更新し、popupへ `{ type:"roster", participants }` を転送する。
  - 自分の `clientId`（`joined`/`host_taken` 受信時）を `currentSelfId` として保持する。
  - `get_status` 応答に `roster` と `selfId` を含め、popup再オープン時に復元できるようにする。
- `start_session` メッセージに **`name`** を含めて受け取り、`session.name` として保持。`onOpen` で送る `create` 後の host-join、および participant-join の `join` に `name` を乗せる。

## 6. テスト方針（TDD）

純粋なロジックはテストファースト（不変条件・既存方針に準拠）。

- **`rooms.ts`**
  - `rosterOf`：先頭ホスト・参加者順序・`id`/`host`/`connected` の値。
  - 名前正規化：trim / 制御文字除去 / 24文字切り詰め / 空→`ゲスト-xxxx`（注入乱数源を使うこと）。
  - ホスト保持中の合成ホスト行（`connected:false`）が出ること。
  - 参加者 leave / ホスト復帰でロスターが正しく変化すること。
- **`protocol.ts`**：`join` の `name` 型チェック（文字列以外で `null`、未指定はOK、文字列はそのまま透過）。
- **`renderRoster`**：👑 / (あなた) / (切断)＋灰色 / 件数ヘッダの描画。
- **server（任意・既存の ws テストがあれば）**：join → `roster` ブロードキャストが全員に届く、切断で名簿から消える、ホスト切断で `connected:false` 行が残る。

## 7. 非機能・制約

- 性能：同時10人以下。ロスターはイベント駆動（join/leave/host状態変化）でのみ送るので流量は小さい。
- セキュリティ：名前は**信頼しない表示文字列**。サーバーで長さ上限・制御文字除去を行う。XSS回避のため popup 側は `textContent` で描画し、`innerHTML` を使わない。
- 改名・アバター・在席時刻などは対象外（YAGNI）。
- **既存挙動とのクロスリファレンス（本仕様で導入する問題ではない）**：ホスト切断の60秒保持中（`hostId=null`）に最後の参加者が抜けると、`deleteIfEmpty`（`rooms.ts:124`）が `clients.size===0` でルームごと削除し、ホストの再接続枠が消える。本仕様の「(切断)」表示中に裏でルームが消えうるが、これは既存の挙動。恒久対応は正典 §11「既知の制約」側で扱う（本サイクルでは変更しない）。

## 8. 不変条件チェック（正典 §「設計上の不変条件」との整合）

- **#2（rooms非依存・DI）**：ロスター状態・ロジックは `rooms.ts`（純粋・注入乱数源）に置き、`server.ts` は配線のみ。CF Workers + DO への機械的移行性を維持。✓
- **#3（差分でなくスナップショット）**：`roster` は毎回ルーム全員分を送る。クライアントは届いた名簿で丸ごと置き換える。✓
- **#1（壁時計非依存）/ #4（フィードバックループ防止）/ #5（WS接続はcontent script）**：同期ロジックに変更なし。影響なし。✓

## 9. 対象外（このサイクルでやらないこと）

- ホスト委譲（別 spec。本仕様の id/name を前提にできる）。
- 視聴中タイトル表示（別 spec。本仕様の配信路に相乗り可）。
- CF Workers + DO 移行（別 spec）。
- 改名、参加者アバター、入退室の通知音・トースト、参加者数の上限変更。
