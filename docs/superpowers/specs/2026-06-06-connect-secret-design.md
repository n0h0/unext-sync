# 接続シークレットによる部外者排除 設計仕様書

作成日: 2026-06-06

## 1. 背景と目的

### 1.1 問題

`extension/src/config.ts` の `SERVER_URL`（`wss://unext-sync.onrender.com`）は**認証なしで誰でもWS接続できる**公開エンドポイントである。接続後にできることは以下に限定されている。

- `create` → ランダムな `roomId`（8桁hex ≒ 約42億通り）と `hostToken` を発行
- `join` → `roomId` を知っていれば participant として参加し、ホストの再生状態を受信
- `sync` → ホスト本人（`hostId === clientId`）以外は無視される（`server/src/rooms.ts`）

設計上、**動画・映像・音声・個人情報は一切流れず**、ホスト状態の注入・改ざん・乗っ取りも既存の hostToken 機構で防がれている。したがって機密漏洩リスクは極めて低い。

### 1.2 残る脅威

現実的に残るのは**リソース乱用 / DoS** である。接続数・`create` 回数にレート制限が無く、`RoomManager` の `rooms` は in-memory の `Map` であるため、悪意ある匿名接続が大量にルームを作ればメモリを枯渇させられる。Render無料枠では容易に巻き込まれる。副次的に、roomId 総当たり（32bit空間）による他人ルームへの participant 参加＝再生位置の覗き見も理論上可能だが、内容の機密性は極めて低い。

### 1.3 方針（確定事項）

本ツールは**非公開ツール**（開発者本人＋知人数名）である。よって「乱用に耐える」のではなく、**接続段階で部外者を弾く**方針を採る。

- アクセス管理の粒度: **単一の共有シークレット**（方式A）。人ごとの個別トークン・許可リストは持たない。失効は全員ローテーションで対応する。
- リポジトリは **public** であるため、**シークレットはコミットせず、ビルド時に環境変数から注入**する。
- 鍵の受け渡しは **WSサブプロトコルヘッダ（`Sec-WebSocket-Protocol`）** を用い、**接続成立前（ハンドシェイク時）に検証**する。

## 2. 設計

### 2.1 データフロー

```
[ビルド時]  CONNECT_SECRET (env) ──esbuild define──> 拡張バンドルに埋め込み
                                  ※コミットしない（public repo対策）

[接続時]    拡張: new WebSocket(url, [SECRET])     ← Sec-WebSocket-Protocol ヘッダ
              │
              ▼
            サーバー: verifyClient でヘッダ検証
              ├─ 一致   → ハンドシェイク成立 → 既存の connection 処理へ
              └─ 不一致 → 401 で拒否（connection イベント発火せず＝資源ゼロ消費）
```

ハンドシェイク段階で弾くことで、匿名接続は `wss.on("connection")` に到達せず、ルーム/クライアントの状態を一切消費しない。これがDoS耐性上もっとも強い。

### 2.2 鍵の受け渡し方式の選択（採用: 案A）

| 案 | 方式 | 採否 | 理由 |
|----|------|------|------|
| A | サブプロトコルヘッダ `new WebSocket(url, [secret])` | **採用** | URLに乗らずログに残らない／接続成立前に弾ける |
| B | URLクエリパラメータ `?k=secret` | 不採用 | シークレットがアクセスログ・エラーログに平文で残りうる |
| C | 接続後の最初のアプリ `auth` メッセージ | 不採用 | 匿名接続が一旦成立してしまい、DoS耐性が弱い |

ブラウザ `WebSocket` の第2引数（subprotocols）はハンドシェイクの `Sec-WebSocket-Protocol` ヘッダとして送出される。RFC 6455 上、クライアントがサブプロトコルを提示してサーバーが1つも選択しなくても接続は成立するため、サーバー側でサブプロトコルを echo する必要はない。

### 2.3 シークレットの文字種制約（token-safe・重大）

`Sec-WebSocket-Protocol` に載せる値は RFC 6455 §4.1 / WHATWG HTML 仕様上 **token**（RFC 7230）でなければならない。`/` `=` `+` `,` `:` `;` 等の separator は使用不可。

ブラウザの `new WebSocket(url, [secret])` は、`secret` が token に違反すると**同期的に `SyntaxError` を throw** する。本実装では `makeBrowserSocket` → `factory()` → `WsClient.connect()` が例外で落ち、**拡張が無言で機能停止する**（ハンドシェイク以前に死ぬ）。これは衛生上の問題ではなく本番を起動直後に壊す制約のため、設計本文の必須要件として扱う。

- **`CONNECT_SECRET` は token-safe な文字種で生成すること。hex を推奨**（例: `openssl rand -hex 32`）。base64url（`A–Z a–z 0–9 - _`、パディング無し）も可。
- **標準 base64（`openssl rand -base64 32`）は不可**（`+ / =` を含みうる）。
- 安全側に倒すため、クライアント（§3.4）とサーバー（§3.1）の双方で、シークレットが token 文字種に合致するかを軽くバリデーションする。正規表現は `^[A-Za-z0-9_-]+$`（hex / base64url を許容、separator を排除）を用いる。

## 3. コンポーネント変更

### 3.1 `server/src/auth.ts`（新規・純粋関数）

```
checkConnectSecret(presented: string | undefined, expected: string): boolean
```

- 定数時間比較（`crypto.timingSafeEqual`）。長さが違う場合は `timingSafeEqual` が例外を投げるため、先に長さチェックして `false` を返す。
- `presented` が `undefined`／空文字なら `false`。
- 起動時に `expected`（＝`CONNECT_SECRET`）が token 文字種（`^[A-Za-z0-9_-]+$`、§2.3）に合致するか検証し、違反していれば fail-closed で起動拒否する。token 違反のシークレットはクライアント側で `SyntaxError` を起こし接続不能になるため、サーバー側でも早期に弾く。
- ws非依存・副作用なし。既存の「状態ロジックは純粋に保ち、`server.ts` は配線だけ」という不変条件（CLAUDE.md / 設計不変条件#2）に沿う。**TDDで単体テストする。**

定数時間比較は、本脅威モデル（知人＋低機密）に対しては過剰気味だが、コストが小さく衛生的に良いので採用する。

### 3.2 `server/src/server.ts`（配線）

- 起動時に `process.env.CONNECT_SECRET` を読む。**未設定ならサーバー起動を拒否（fail closed）**。明示的なエラーメッセージで `process.exit`／throw する。「うっかり認証なしデプロイ」を構造的に防ぐ。
- `new WebSocketServer({ port })` → `new WebSocketServer({ port, verifyClient })` に変更。
- `verifyClient(info, cb)` のコールバック形 `cb(result, code, name)` を使う。`info.req.headers["sec-websocket-protocol"]` を取得する。これはカンマ区切りの文字列になりうるため、分割・トリムし、クライアントは常に1個しか送らない前提で先頭候補を `checkConnectSecret` にかける。
- 一致 → `cb(true)`。不一致 → `cb(false, 401, "Unauthorized")`。
- 実装上の補足: `ws` では `verifyClient` で十分だが、ライブラリ的には `server.on('upgrade')` の手動ハンドリングが推奨方向。本用途では `verifyClient` を採用する。

### 3.3 `extension/src/config.ts`

- ビルド時 define された `__CONNECT_SECRET__` を経由して `CONNECT_SECRET` を公開する。

```ts
declare const __CONNECT_SECRET__: string;
export const CONNECT_SECRET = __CONNECT_SECRET__;
```

- 実値はコミットしない。

### 3.4 `extension/src/content.ts`

- ソケット生成箇所 `makeBrowserSocket` 内の `new WebSocket(url)` を `new WebSocket(url, [CONNECT_SECRET])` に変更する（1行）。`CONNECT_SECRET` を `config` から import する。
- `config.ts` 側で `CONNECT_SECRET` が token 文字種（`^[A-Za-z0-9_-]+$`、§2.3）に合致するかをモジュール初期化時に検証し、違反していれば明示メッセージで早期に throw する（`new WebSocket` の不透明な `SyntaxError` で無言停止するのを防ぎ、原因を分かりやすくする）。

### 3.5 `build.mjs`

- ビルド冒頭で `process.env.CONNECT_SECRET` を読む。**未設定なら明示メッセージでビルド失敗**（鍵なし拡張を作らせない）。
- esbuild に `define: { __CONNECT_SECRET__: JSON.stringify(secret) }` を渡す。

### 3.6 `.env.example` / ドキュメント

- `.env.example` に `CONNECT_SECRET=` プレースホルダを追加（`.env` は gitignore 済み）。
- README / CLAUDE.md に以下を追記:
  - **鍵の生成**: token-safe な値を使う。`openssl rand -hex 32`（hex）を推奨。**`openssl rand -base64 32` は使わない**（`+ / =` で拡張が `SyntaxError` で停止、§2.3）。
  - サーバー: Render の環境変数に `CONNECT_SECRET` を設定する。
  - 拡張ビルド: `CONNECT_SECRET=... pnpm build:extension`（またはローカル `.env` 読み込み）。
  - ローテーション手順: サーバーenv と 拡張埋め込み値の**両方**を新しい値に変更し、拡張を再ビルド・再配布する。

## 4. エラーハンドリング

- **サーバー env 未設定** → 起動時に明示エラーで停止（fail closed）。
- **誤シークレットでの接続** → 401でハンドシェイク拒否。クライアントは既存の再接続バックオフ（`ws-client.ts` の `onclose` → `nextBackoffMs(attempt++)`）で再試行する。**鍵が間違っている限り再接続し続け、自然回復しない**点に注意（仕様上の既知挙動）。`nextBackoffMs` は `Math.min(maxMs, baseMs * 2**attempt)` で **`reconnectMaxMs`（=30秒）に cap される**（`sync-core.ts`）ため無限増加はせず、500ms から倍々に増えて最終的に**30秒間隔の定期リトライ**に収束する。なお `connect()` の `onopen` は `attempt` をリセットしない（既存挙動）ため、長時間セッションで断続的に切断が起きると次回バックオフが cap 寄りから始まりうるが、本変更の範囲外。
- **ビルド env 未設定** → 明示メッセージでビルド失敗。

## 5. テスト

- `server/src/auth.test.ts`（TDD・純粋関数）: 一致／不一致／`undefined`／空文字／長さ違いで例外を投げないこと。token 文字種バリデーション（hex・base64url は通る／`+ / = ,` 等を含む値は拒否）。
- 任意（推奨）: サーバーを実起動し「サブプロトコル無しは接続拒否・正しいサブプロトコルは接続成立」を確認する小さな統合テスト1本。

## 6. 既知の制約 / 残存リスク

1. **単一共有シークレット**: 拡張を持つ全員が同じ鍵を持つ。特定個人だけの失効はできず、失効＝全員ローテーション（選択した方式Aのトレードオフ）。
2. **鍵はクライアントバンドルに載る**: ビルド済み拡張を配布した時点で知人のディスクに鍵が存在する。信頼する知人前提のモデルでは想定内。
3. **DoS残渣**: 拒否ハンドシェイクも僅かにCPUを消費する。per-IPレート制限は入れない（YAGNI）。匿名フラッドは「安く弾ける」が「ゼロコスト」ではない。
4. **E2E暗号化ではない**: サーバー（Render）は従来通り再生状態を観測できる。本変更の範囲外（挙動変更なし）。
5. **鍵はブラウザからも観測可能**: wss でも、拡張を実行する本人のブラウザ DevTools の Network タブでハンドシェイク（`Sec-WebSocket-Protocol` ヘッダ）に平文で見える。信頼する知人前提のモデルでは結論は変わらないが、脅威モデルの透明性として明記する。
