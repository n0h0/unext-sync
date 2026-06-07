# Cloudflare Workers + Durable Objects 移行 設計仕様書

作成日: 2026-06-07

## 1. 概要

### 1.1 目的

WS リレーサーバーのホスティングを **Render Free（Node.js + `ws`）** から **Cloudflare Workers + Durable Objects（DO）** へ移行する。狙いは2点。

1. **コールドスタートの排除** — Render Free は15分アイドルでインスタンスが停止し、復帰に30〜60秒かかる。土曜夜に久々に開くと最初の接続が大きく遅延する。CF Workers は V8 isolate で起動が実質ゼロ、DO もミリ秒級で起動するため、この遅延が構造的に消える。
2. **無料の維持** — SQLite-backed DO は Workers Free プランで利用可能。WebSocket Hibernation でアイドル中の WS 接続は duration 課金を発生させないため、無料枠（100,000 req/日・13,000 GB-s/日・SQLite 5GB）の範囲に収まる。

### 1.2 非目標（スコープ外）

- 同期アルゴリズム（`shared/sync-core`）の変更。クロックスキュー排除などの不変条件はそのまま維持する。
- 拡張側 UI（popup）の変更。接続先 URL とプロトコルの最小変更のみ。
- カスタムドメインの設定（任意の後続作業。既定は `*.workers.dev`）。
- 水平スケール・多リージョン最適化（個人〜数名規模では不要）。

### 1.3 前提・規模

- 利用規模は既存仕様（§1.2 of watch-sync-design）と同じ。開発者＋友人数名（2〜10人）、土曜夜数時間、常時稼働不要。
- 同時アクティブルームは多くても数個。無料枠に対して大きな余裕がある。

### 1.4 確定した設計判断

ブレインストーミングで以下を確定（推奨案を採用）。

| 論点 | 採用 |
|------|------|
| DO 分割単位 | **ルームごとに1 DO**（`idFromName(roomId)`）。CF の王道。各ルームが独立して hibernation でき無料枠に優しい。 |
| create フロー | **HTTP POST `/create`**（roomId/hostToken をサーバー発行）→ WS は `/r/<roomId>` に接続。 |
| 状態保持 | **Hibernation + SQLite 永続化**。退避→再起動が透過的で、複数ルーム同時でも無料。 |
| Node ランタイム | **CF に一本化**。`server.ts` の ws 配線は破棄。ローカル/E2E は `wrangler dev`。純粋ロジックと protocol は流用。 |

---

## 2. アーキテクチャ

### 2.1 構成

```
Chrome拡張 (MV3, 変更小)            Cloudflare
─────────────────────              ───────────────────────────────────────
content.ts                         Worker (worker/src/index.ts) … エッジ／ルーター
  ├ POST /create ───────────────▶    ├ CONNECT_SECRET 検証
  │   {roomId, hostToken} 取得         │   POST: Authorization ヘッダ / WS: subprotocol
  │                                   ├ POST /create → roomId 生成 → DO.fetch で初期化
  └ WS /r/<roomId> ─────────────▶    └ WS upgrade → idFromName(roomId) → DO へ転送

                                    RoomDurableObject (worker/src/room-do.ts) … 1ルーム=1 DO
                                      ├ Hibernatable WebSocket (ctx.acceptWebSocket)
                                      ├ 永続: ctx.storage.put/get（hostToken/lastState/…）
                                      ├ 接続情報: ws.serializeAttachment({clientId,name,isHost})
                                      ├ Alarm: ホストスロット60s解放 / 空ルーム掃除
                                      └ shared/rooms（純粋リデューサ）を呼ぶだけ
```

### 2.2 レイヤーと依存方向

```
shared/   ← プラットフォーム非依存。extension・worker 両方が import
  protocol.ts   ワイヤプロトコル型 + parseClientMessage（create/created を削除、その他不変）
  sync-core.ts  同期計算の純粋関数（無変更）
  secret.ts     token-safe 判定 + 定数時間比較（Workers でも動く形に整える）
  rooms.ts      単一ルームの純粋リデューサ（RoomManager から作り替え）★本移行の肝

worker/src/   Cloudflare Workers
  index.ts      Worker エントリ。認証・CORS・ルーティング・DO への転送（薄い配線）
  room-do.ts    RoomDurableObject。WS受理・storage load/save・broadcast・Alarm（薄い殻）

extension/src/   Chrome MV3（最小変更）
  content.ts    create を POST 化、WS URL に roomId を載せる
  ws-client.ts  接続 URL を動的化（factory が /r/<roomId> を組む）
  parse-server.ts  created を TYPES から削除
  （video-controller / sync-orchestrator / popup 系は無変更）
```

### 2.3 維持する不変条件

CLAUDE.md「設計上の不変条件」を本移行でも壊さない。特に：

1. **同期ロジックで壁時計の引き算をしない**（不変条件①）。サーバーはクロック計算をしないため DO への移行で影響なし。クライアント発 RTT ping/pong は維持する。
2. **状態ロジックは純粋側（`shared/rooms`）、配線は薄く**（不変条件②）。本移行で `rooms.ts` を単一ルーム純粋リデューサに作り替え、DO/Worker は IO の殻に徹する。これにより「機械的に CF へ移行できるようにする」という当初設計の意図を完遂する。
3. **complete スレーブ＝全状態スナップショット**（不変条件③）。`seq` 単調増加・`isStaleSeq` 破棄は無変更。
4. **フィードバックループ防止**（不変条件④）。拡張側 `isApplying()` ガードは無変更。
5. **WS 接続は content script が持つ**（不変条件⑤）。無変更。POST `/create` も content script から発行する。

---

## 3. `shared/rooms` の純粋リデューサ化

### 3.1 動機

WebSocket Hibernation は DO をメモリから退避させる。退避後に WS メッセージが届くと DO は再生成され、`webSocketMessage` ハンドラが走るが **インメモリ変数はリセットされている**。したがってルーム状態は毎メッセージ再構築可能でなければならない。現 `RoomManager`（`Map<roomId, Room>` をインメモリ保持）はこの前提に合わない。

### 3.2 状態の2分割

ルーム状態を保存先で2分する。

- **永続状態**（`ctx.storage` に保存）
  - `hostToken: string`
  - `hostId: string | null`（現在接続中ホストの clientId）
  - `hostName: string | null`
  - `hostDisconnectedAt: number | null`
  - `lastState: StateMessage | null`
  - `hostTitle: string | null`
- **接続状態**（`ctx.getWebSockets()` ＋各ソケットの `deserializeAttachment()` から復元）
  - `clients: Map<clientId, { name }>` … 各 WS の attachment `{clientId, name, isHost}` を集約して構築

### 3.3 リデューサ API

`RoomManager`（複数ルーム）を、単一ルームの純粋関数群へ作り替える。各関数は副作用を持たず `(state, …) → { state, effects }` を返す。

```ts
// 概念シグネチャ（実装時に確定）
type RoomState = {
  persistent: PersistentState;          // §3.2 永続
  clients: Map<string, ClientInfo>;     // §3.2 接続（attachment から復元）
};

type Effect =
  | { kind: "send"; to: string; msg: ServerMessage }       // 特定 clientId へ
  | { kind: "broadcast"; exclude?: string; msg: ServerMessage }
  | { kind: "setAlarm"; at: number }
  | { kind: "clearStorage" };                              // 空ルーム掃除

applyJoin(state, clientId, role, hostToken?, name?): { state; effects; outcome }
applySync(state, clientId, msg): { state; effects }
applyTitle(state, clientId, rawTitle): { state; effects }
removeClient(state, clientId): { state; effects }   // hostDisconnected 時は setAlarm を effect に
sweepHostTimeout(state, now): { state; effects }    // Alarm から呼ぶ
```

- `normalizeText` / `normalizeName` / roster 生成（`rosterOf`）など既存純粋ロジックはそのまま移植。
- **DO は load→reduce→apply effects→save の薄い殻**。reduce 結果の `state.persistent` を `storage.put`、`effects` を WS 送信／Alarm 設定に翻訳するだけ。
- `roomId` 生成・`hostToken` 生成・`now()` は DI（Worker/DO 側が注入）。純粋性を保つ。

### 3.4 テスト

`server/src/rooms.test.ts` を `shared/rooms.test.ts` 相当へ移植・拡充。リデューサは純粋なので TDD が効く。既存の join/sync/host-timeout/roster/title のケースを `effects` ベースのアサーションへ書き換える。

---

## 4. メッセージフローとプロトコル変更

### 4.1 変更サマリ

| 操作 | 現行 | 移行後 |
|------|------|--------|
| ホスト作成 | WS `create` → `created` | **HTTP POST `/create`**（`Authorization: Bearer <secret>`）→ JSON `{roomId, hostToken}` |
| 接続 | WS（固定 URL）+ `join` | **WS `/r/<roomId>`** + `join`（roomId を URL で運ぶ） |
| sync / title / ping-pong / roster / state / join / joined / host_taken / no_room / host_disconnected / host_resumed / room_title | — | **無変更**（WS メッセージはそのまま） |

`protocol.ts`：`CreateMessage` / `CreatedMessage` と `parseClientMessage` の `create` 分岐を削除。他は不変。`PROTOCOL_VERSION` は据え置き（破壊的だが拡張とサーバーを同時に入れ替えるため互換は不要）。

### 4.2 ホスト作成フロー

1. content.ts（ホスト・トークン未保持）が `POST <SERVER_URL_HTTP>/create`、`Authorization: Bearer <CONNECT_SECRET>`。
2. Worker が secret 検証 → `roomId`（8hex）生成 → `env.ROOM.idFromName(roomId)` の DO へ初期化要求を転送。
3. DO は `storage.get("hostToken")` を確認。
   - 既存なら **409**（roomId 衝突）→ Worker が新 roomId で数回リトライ。
   - 無ければ `hostToken` を生成して `storage.put`、`{roomId, hostToken}` を返す。
4. content.ts は受領した roomId/hostToken を保持し、`WS /r/<roomId>` に接続して `join {role:"host", hostToken}` を送る。

`onOpen` の create 分岐は廃止。ホストも参加者も「roomId を持って `/r/<roomId>` に join」へ統一される。

### 4.3 接続（join）フロー

1. content.ts が `WS <SERVER_URL_WS>/r/<roomId>`（subprotocol に CONNECT_SECRET）。
2. Worker が subprotocol を検証（現行 `verifyClient` 相当）→ `idFromName(roomId)` の DO へ upgrade を転送。
3. DO が `ctx.acceptWebSocket(server)`。`clientId = randomUUID()` を採番し `ws.serializeAttachment({clientId, name:"", isHost:false})`。
4. クライアントの `join` メッセージで `shared/rooms.applyJoin` を実行。
   - ルーム未作成（`hostToken` 不在）なら `no_room` を返して close。
   - host トークン一致＆スロット空なら host、それ以外は participant フォールバック（現行 `host_taken` と同じ）。
   - `lastState` があれば participant へ送出、roster／room_title のキャッチアップ送出（現行と同じ）。

### 4.4 CORS（POST `/create` 専用）

content script からの `/create` はクロスオリジン fetch（Authorization ヘッダ付きでプリフライト発生）。Worker が対応する。

- `OPTIONS /create` に `204` + `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: POST, OPTIONS`、`Access-Control-Allow-Headers: Authorization, Content-Type`。
- `POST /create` 応答にも `Access-Control-Allow-Origin: *`。
- 認証は Authorization ヘッダで行い Cookie/credentials は使わないため `*` で問題ない。

WS の upgrade はプリフライト対象外。subprotocol 認証は現行どおり機能する。

### 4.5 manifest 変更

- `host_permissions` に Worker ドメイン（`https://`）を追加。
- CSP `connect-src` に `https://<worker-domain>` と `wss://<worker-domain>` を追加（POST と WS の両方）。
- `parse-server.ts` の許可 TYPES から `created` を削除（新規型追加時の allowlist 漏れと逆の操作）。

---

## 5. タイマー類の置き換え（setInterval → DO 機構）

Hibernation 中は `setInterval` が動かないため、時間駆動の処理を DO の機構へ置き換える。

| 現行（server.ts） | 移行後 |
|------|------|
| `sweepTimer`（10s毎・ホストスロット60s解放） | **DO Alarm**。`removeClient` でホスト切断時に `setAlarm(now+60s)`。`alarm()` で `sweepHostTimeout` を呼びスロット解放＋roster broadcast。 |
| `deleteIfEmpty`（クライアント0で削除） | 最後のソケット close 時に `setAlarm(now+60s)`、`alarm()` でなお空なら `storage` を破棄（ストレージ肥大防止）。ホスト60s再接続猶予と同じ Alarm を共用。 |
| `pingTimer`（30s毎・ゾンビ掃除） | **廃止**。CF の `webSocketClose`/`webSocketError` ライフサイクルに委譲。 |
| クライアント発 RTT ping → pong | **維持**。`webSocketMessage` で `ping` を受けたら `pong` を echo（不変条件①の片道遅延測定に必須）。auto-response は使わない（id を echo するため）。 |

Alarm は単一スケジュールのため、「ホスト解放」と「空掃除」を1つの `alarm()` で扱い、状態を見て両方を判定する。

---

## 6. 認証・シークレット・設定

### 6.1 CONNECT_SECRET

- 保存：**Wrangler Secret**（`wrangler secret put CONNECT_SECRET`）。サーバー env として Worker に注入。
- 提示：POST は `Authorization: Bearer <secret>`、WS は従来どおり `Sec-WebSocket-Protocol`（subprotocol）。両方とも同一 secret を検証。
- `shared/secret.ts` の `isTokenSafe`/`TOKEN_SAFE_RE` は維持。定数時間比較は `node:crypto.timingSafeEqual` が Workers で使えない場合に備え、Workers でも動く実装（`nodejs_compat` の `timingSafeEqual` もしくは WebCrypto ベースの定数時間比較）に整える。ロジックは shared に残す。
- fail-closed：secret 未設定なら Worker は起動時／リクエスト時に拒否する（現行サーバーの方針を踏襲）。

### 6.2 拡張ビルド設定

- `SERVER_URL` 既定を `wss://unext-sync.<subdomain>.workers.dev` に変更（`build.mjs`）。HTTP 版 URL は WS URL から導出（`wss://`→`https://`、`/create` パス付与）するか、別 define を追加。
- `__CONNECT_SECRET__` 埋め込みは現行のまま（バンドルに埋め込み・非コミット）。
- 不正 URL のビルド時バリデーション（`isWsUrl`）は維持。

### 6.3 wrangler 設定

- `wrangler.jsonc`：
  - DO バインディング `ROOM` → `RoomDurableObject`。
  - migration に `new_sqlite_classes: ["RoomDurableObject"]`（SQLite-backed 必須。Free プランは SQLite のみ）。
  - `compatibility_date` と必要なら `nodejs_compat` フラグ。
- `build-server.mjs` を廃止し、デプロイは `wrangler deploy`。ローカル/E2E は `wrangler dev`（ローカル WS URL を E2E doc に反映）。

---

## 7. テストと依存

### 7.1 テスト戦略

- **純粋層**：`shared/rooms` リデューサのユニットテスト（既存 `rooms.test.ts` を移植・拡充）。`sync-core` / `protocol` の既存テスト（クロックスキュー回帰含む）はそのまま。
- **DO 統合**：`@cloudflare/vitest-pool-workers` を導入し、workerd 上で DO＋WS＋Alarm＋hibernation を実テスト。現 `server.test.ts`（ws 配線テスト）を置換。
  - 検証項目：create→join host、participant join＋lastState キャッチアップ、host_taken フォールバック、sync broadcast、title、roster、ホスト切断→60s Alarm でスロット解放、再接続でホスト復帰、hibernation 跨ぎでの状態復元（attachment + storage からの再構築）。

### 7.2 依存とサプライチェーン方針

新規 devDeps（`wrangler` / `@cloudflare/vitest-pool-workers` / `@cloudflare/workers-types`）は pnpm `minimumReleaseAge`（1週間クールダウン）の対象。1週間エイジング済みバージョンを使うか、`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` に明示追加する。`allowBuilds` に必要なビルドスクリプト（あれば）を追加。

---

## 8. 移行手順（段階）

1. `shared/rooms` リデューサ化（TDD、純粋層）。`protocol.ts` から create/created 削除。`shared/secret.ts` の比較を Workers 互換に。
2. `worker/`（`index.ts` + `room-do.ts`）実装。`wrangler.jsonc` 整備。`wrangler dev` で疎通。
3. DO 統合テスト（vitest-pool-workers）整備。
4. 拡張側：`content.ts` の create を POST 化、`ws-client.ts` の URL 動的化、`parse-server.ts`／`manifest`／`build.mjs` 更新。
5. `wrangler secret put CONNECT_SECRET` → `wrangler deploy`。`SERVER_URL` を新 workers.dev に向けて拡張再ビルド。
6. 擬似ホスト E2E（`docs/e2e-pseudo-host-testing.md` の URL を `wrangler dev`／workers.dev に差し替え）で疎通確認。
7. Render サービス停止・撤去。CLAUDE.md の構成記述を更新。

---

## 9. 既知の制約・留意点

- **roomId 衝突**：8hex（32bit）・`idFromName` は決定的。POST `/create` 受領 DO が既存 `hostToken` を検出したら 409 → Worker が数回リトライ。個人規模では衝突は稀。必要なら桁を増やせる。
- **workers.dev のブロック**：ネットワークによっては `*.workers.dev` がブロックされうる。問題が出たらカスタムドメインで回避（後続作業）。
- **ストレージ課金**：SQLite ストレージ課金は2026年1月開始済みだが、本件の永続状態は数キーと極小で 5GB 無料枠に対し無視できる。
- **無料枠の日次リセット**：超過時はその種別の操作が当日エラーになる（UTC 0時リセット）。個人規模では到達しない想定。
- **プロトコル互換**：`create`/`created` 削除は破壊的変更。拡張とサーバーを同時に切り替える前提で、旧クライアントとの後方互換は取らない。

---

## 10. 参考

- Cloudflare Durable Objects — Pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare Durable Objects — Overview / WebSocket Hibernation: https://developers.cloudflare.com/durable-objects/
- 関連 spec: `2026-06-06-connect-secret-design.md`（CONNECT_SECRET）、`2026-06-05-watch-sync-design.md`（同期モデル本体）
