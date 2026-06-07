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
  - `clients: Map<clientId, { name; joinedAt }>` … 各 WS の attachment `{clientId, name, isHost, joinedAt}` を集約して構築
  - **`joinedAt`（accept 時に採番する単調連番）を attachment に持たせる**。`ctx.getWebSockets()` の返却順は accept 順を保証しない（特に hibernation 跨ぎ）ため、roster の挿入順を安定させる唯一の根拠が連番になる（§3.5）。

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
  | { kind: "setAttachment"; clientId: string; attachment: Attachment }  // 接続状態の書き戻し
  | { kind: "setAlarm"; at: number }                       // §5 の最小締切で再武装
  | { kind: "clearStorage" };                              // 空ルーム掃除

applyJoin(state, clientId, role, hostToken?, name?): { state; effects; outcome }
applySync(state, clientId, msg): { state; effects }
applyTitle(state, clientId, rawTitle): { state; effects }
removeClient(state, clientId): { state; effects }   // hostDisconnected 時は setAlarm を effect に
sweepHostTimeout(state, now): { state; effects }    // Alarm から呼ぶ
```

- `normalizeText` / `normalizeName` / roster 生成（`rosterOf`）など既存純粋ロジックはそのまま移植。
- **接続状態（attachment）の書き戻しも effect で表現する**。`applyJoin` はゲスト名合成（現 `rooms.ts:78` 相当）で `clients` の name と `isHost` を確定させる。これは永続状態ではなく **WS の `serializeAttachment()` への副作用**なので、`{kind:"setAttachment"}` effect として返し、DO がそのソケットの attachment に反映する。これを effect 化しないと「effects→IO 翻訳の薄い殻」という設計が join 経路だけ崩れる。
- **DO は load→reduce→apply effects→save の薄い殻**。`state.persistent` を `storage.put`、`send`/`broadcast` を WS 送信、`setAttachment` を `ws.serializeAttachment()`、`setAlarm`/`clearStorage` を storage 操作に翻訳するだけ。
- **DI 対象の副作用源**：`roomId` 生成・`hostToken` 生成・`now()` に加え、**ゲスト名サフィックス用の乱数源**（現 `rooms.ts:78` の `genId().slice(0,4)`）と **`joinedAt` 連番採番**も DI で注入し、リデューサの純粋性を保つ。

### 3.4 テスト

`server/src/rooms.test.ts` を `shared/rooms.test.ts` 相当へ移植・拡充。リデューサは純粋なので TDD が効く。既存の join/sync/host-timeout/roster/title のケースを `effects` ベースのアサーションへ書き換える。

### 3.5 roster 順序保証

現 `rosterOf`（`rooms.ts:174`「参加者を挿入順で」）は `Map` の挿入順に依存していた。DO では `clients` を `ctx.getWebSockets()` から再構築するが、**この返却順は accept 順を保証しない（特に hibernation 跨ぎ）**。したがって roster は各 attachment の `joinedAt` 連番で **明示 sort** して安定化させる（ホスト行は先頭、続けて参加者を `joinedAt` 昇順）。§7.1 のテストに「hibernation 跨ぎで roster 順序が安定」を追加する。

---

## 4. メッセージフローとプロトコル変更

### 4.1 変更サマリ

| 操作 | 現行 | 移行後 |
|------|------|--------|
| ホスト作成 | WS `create` → `created` | **HTTP POST `/create`**（`Authorization: Bearer <secret>`）→ JSON `{roomId, hostToken}` |
| 接続 | WS（固定 URL）+ `join` | **WS `/r/<roomId>`** + `join`（roomId を URL で運ぶ） |
| sync / title / ping-pong / roster / state / join / joined / host_taken / no_room / host_disconnected / host_resumed / room_title | — | **無変更**（WS メッセージはそのまま） |

`protocol.ts`：`CreateMessage` / `CreatedMessage` と `parseClientMessage` の `create` 分岐を削除。他は不変。**`PROTOCOL_VERSION` は 2 へ bump する**。create/created 削除は破壊的変更であり、拡張とサーバーを同時に入れ替える前提だが、万一 stale な旧拡張（v=1）が新サーバーに刺さった場合、`parseClientMessage` の `v` 不一致弾き（`protocol.ts:133`）で **即座にバージョン不整合として検知できる**（据え置きだと旧拡張の `create` が「bad message」として静かに失敗するだけで原因が見えにくい）。

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

**経路の実証性**：content script からのクロスオリジン接続は、WS が既に同じ経路（content script が `host_permissions` / CSP `connect-src` 経由で Render の wss へ接続）で実証済みである。POST `/create` も同じ `host_permissions` / `connect-src` 経路に乗るだけで、U-NEXT ページ側 CSP の影響は受けない（接続元は拡張のコンテキスト）。新規に増えるのは CORS プリフライト対応（Worker 側）のみ。

### 4.5 manifest 変更

- `host_permissions` に Worker ドメイン（`https://`）を追加。
- CSP `connect-src` に `https://<worker-domain>` と `wss://<worker-domain>` を追加（POST と WS の両方）。
- `parse-server.ts` の許可 TYPES から `created` を削除（新規型追加時の allowlist 漏れと逆の操作）。

---

## 5. タイマー類の置き換え（setInterval → DO 機構）

Hibernation 中は `setInterval` が動かないため、時間駆動の処理を DO の機構へ置き換える。

| 現行（server.ts） | 移行後 |
|------|------|
| `sweepTimer`（10s毎・ホストスロット60s解放） | **DO Alarm**。`removeClient` でホスト切断時に締切 `hostDisconnectedAt+60s` を立てる。 |
| `deleteIfEmpty`（クライアント0で削除） | 最後のソケット close 時に締切 `emptiedAt+60s` を立て、`alarm()` でなお空なら `storage` を破棄（ストレージ肥大防止）。 |
| `pingTimer`（30s毎・ゾンビ掃除） | **廃止**。CF の `webSocketClose`/`webSocketError` ライフサイクルに委譲（regression リスクは§9）。 |
| クライアント発 RTT ping → pong | **維持**。`webSocketMessage` で `ping` を受けたら `pong` を echo（不変条件①の片道遅延測定に必須）。auto-response は使わない（id を echo するため）。 |

#### 5.1 Alarm の多重化と re-arm（必須の不変条件）

DO の alarm スロットは**1つだけ**。ホストスロット解放（例: t=60）と空ルーム掃除（例: t=90）は締切が異なり、後発の `setAlarm` が前を上書きしてしまう。「同じ持続時間」と「同じ alarm インスタンス」を混同しないこと——**1つの alarm スロットを複数締切で多重化する**。

不変条件として明文化する：

- 締切を立てる側（`removeClient` 等）は、**現在 storage に保持する全締切の最小値**で `setAlarm` する（既存 alarm より早ければ前倒し、遅ければ据え置き）。締切自体は storage（`hostDisconnectedAt`・`emptiedAt`）から導出する。
- **`alarm()` は発火時に全締切を再評価する**。到来済みの締切（ホスト解放・空掃除）を処理し、**未到来の締切が残っていれば、その最小値で `setAlarm` し直して再武装(re-arm)する**。
  - 例：t=60 発火 → ホストスロット解放＋roster broadcast → まだ空掃除猶予(t=90)が残る → t=90 へ再武装。
- これを書かないと「上書きで片方の処理が消える」「再武装漏れで空掃除が永久に走らない」バグを実装者が確実に踏む。§7.1 のテストに「2締切が前後する場合の re-arm」を含める。

#### 5.2 hibernation の恩恵範囲（期待値の明示）

hibernation が duration 課金を消すのは**アイドル時のみ**。再生中はホストの heartbeat が5秒ごと（＋seek 毎）に届き DO を都度 wake させるため、視聴セッション中は実質常時アクティブに近い。恩恵は「パーティ前後・参加者全員一時停止中・ルーム放置」といったアイドル区間に効く。これにより複数ルームが時間差で点在しても無料枠に収まる、というのが本移行の経済性の根拠。「常時 hibernation で無料」という過度な期待はしない。`lastState` の `storage.put` は sync/heartbeat 毎（再生中5s毎＋seek 毎）に走るが、規模的に無料枠・課金とも問題ない（§9）。

---

## 6. 認証・シークレット・設定

### 6.1 CONNECT_SECRET

- 保存：**Wrangler Secret**（`wrangler secret put CONNECT_SECRET`）。サーバー env として Worker に注入。
- 提示：POST は `Authorization: Bearer <secret>`、WS は従来どおり `Sec-WebSocket-Protocol`（subprotocol）。両方とも同一 secret を検証。
- `shared/secret.ts` の `isTokenSafe`/`TOKEN_SAFE_RE` は維持。定数時間比較は `node:crypto.timingSafeEqual` が Workers で使えない場合に備え、Workers でも動く実装（`nodejs_compat` の `timingSafeEqual` もしくは WebCrypto ベースの定数時間比較）に整える。ロジックは shared に残す。
- fail-closed：secret 未設定なら Worker は起動時／リクエスト時に拒否する（現行サーバーの方針を踏襲）。

### 6.2 拡張ビルド設定

- `SERVER_URL` 既定を `wss://unext-sync.<subdomain>.workers.dev` に変更（`build.mjs`）。**HTTP 版 URL は WS URL から導出する（決定事項）**：`wss://`→`https://`（`ws://`→`http://`）に置換し、POST 時に `/create` パスを付与する。define を増やさず `__CONNECT_SECRET__`／`__SERVER_URL__` の埋め込み管理対象を増やさないため。WS 接続は `${SERVER_URL}/r/<roomId>`、create は `${httpFrom(SERVER_URL)}/create`。導出ヘルパは extension 側（content.ts もしくは config.ts）に置く。
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
  - **追加検証**：(1) **hibernation 跨ぎで roster 順序が安定**（`getWebSockets()` の順に依らず `joinedAt` で安定 sort、§3.5）。(2) **Alarm re-arm**：ホスト解放(t=60)と空掃除(t=90)の2締切が前後する場合に、t=60 発火後 t=90 へ正しく再武装される（§5.1）。(3) **attachment 書き戻し**：join 後にゲスト名／isHost が attachment に反映され、再構築後の roster に出る。

### 7.2 依存とサプライチェーン方針

新規 devDeps（`wrangler` / `@cloudflare/vitest-pool-workers` / `@cloudflare/workers-types`）は pnpm `minimumReleaseAge`（1週間クールダウン）の対象。1週間エイジング済みバージョンを使うか、`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` に明示追加する。`allowBuilds` に必要なビルドスクリプト（あれば）を追加。

---

## 8. 移行手順（段階）

1. `shared/rooms` リデューサ化（TDD、純粋層）。`protocol.ts` から create/created 削除。`shared/secret.ts` の比較を Workers 互換に。
2. `worker/`（`index.ts` + `room-do.ts`）実装。`wrangler.jsonc` 整備。`wrangler dev` で疎通。
3. DO 統合テスト（vitest-pool-workers）整備。
4. 拡張側：`content.ts` の create を POST 化、`ws-client.ts` の URL 動的化、`manifest`／`build.mjs` 更新、`parse-server.ts` の `created` 削除。`PROTOCOL_VERSION` を 2 へ bump。
   - **`parse-server.ts` の `created` 削除は最後でよい**：[[parse-server-allowlist-gotcha]] は「新型を TYPES に**追加し忘れる**と黙って破棄」だが、本件は既存型を**消す**逆操作。消し忘れても害は無い（使われない許可が残るだけ）ので、他の変更を優先してよい。
5. `wrangler secret put CONNECT_SECRET` → `wrangler deploy`。`SERVER_URL` を新 workers.dev に向けて拡張再ビルド。
6. 擬似ホスト E2E（`docs/e2e-pseudo-host-testing.md` の URL を `wrangler dev`／workers.dev に差し替え）で疎通確認。
7. Render サービス停止・撤去。CLAUDE.md の構成記述を更新。
   - **ロールバック**：create/created 削除は破壊的で拡張・サーバーを同時切替するため、CF 不調時の退避を確保しておく。Render の設定（`build-server.mjs`・起動コマンド等）は削除コミットを git に残し、CF が不調なら旧 commit を再ビルド・再 deploy して Render を復帰できるようにする（個人規模なので手順は軽量で可）。Render サービス自体の即時削除は、CF 安定稼働を E2E で確認してから。

---

## 9. 既知の制約・留意点

- **roomId 衝突**：8hex（32bit）・`idFromName` は決定的。POST `/create` 受領 DO が既存 `hostToken` を検出したら 409 → Worker が数回リトライ。個人規模では衝突は稀。必要なら桁を増やせる。
- **workers.dev のブロック**：ネットワークによっては `*.workers.dev` がブロックされうる。問題が出たらカスタムドメインで回避（後続作業）。
- **ストレージ課金**：SQLite ストレージ課金は2026年1月開始済みだが、本件の永続状態は数キーと極小で 5GB 無料枠に対し無視できる。
- **無料枠の日次リセット**：超過時はその種別の操作が当日エラーになる（UTC 0時リセット）。個人規模では到達しない想定。
- **zombie ホストのスロット解放遅延（regression）**：現 `server.ts` の 30s ws ping は、close フレーム無しで死んだ TCP（half-open）を検出→`terminate()`→close→スロット解放を担っていた。これを廃止すると、ホストのソケットが zombie 化した場合、CF が `webSocketClose` を発火するまで**ホストスロットが占有されたまま**になり、60s 解放 Alarm も起動しない。CF は最終的に close を発火するため「いずれ解放される」が、**その間ホストスロットを他者が奪えない遅延が生じうる**。個人規模では許容。必要なら後続で alarm ベースの app-level liveness（ホスト heartbeat 途絶検知でスロット解放）を追加できる。
- **プロトコル互換**：`create`/`created` 削除は破壊的変更で、`PROTOCOL_VERSION` を 2 へ bump する（§4.1）。拡張とサーバーを同時に切り替える前提で、旧クライアント（v=1）との後方互換は取らない。stale な旧拡張はバージョン不整合として即弾かれる。

---

## 10. 参考

- Cloudflare Durable Objects — Pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare Durable Objects — Overview / WebSocket Hibernation: https://developers.cloudflare.com/durable-objects/
- 関連 spec: `2026-06-06-connect-secret-design.md`（CONNECT_SECRET）、`2026-06-05-watch-sync-design.md`（同期モデル本体）
