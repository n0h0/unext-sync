# デプロイ・拡張ビルド・友人への配布 手順

サーバー（Cloudflare Workers + Durable Objects）のデプロイ、Chrome 拡張のビルド、友人への配布までの運用 runbook。

ローカル開発・E2E テストは別ドキュメント [`e2e-pseudo-host-testing.md`](./e2e-pseudo-host-testing.md) を参照。

> **前提となる ToS 方針**: 本ツールは「再生状態のみ同期・コンテンツ非共有・各自が個別契約・非営利・少人数の私的利用」を前提とする。配布は**私的経路に限定**し、公開ストアでの一般配布はしない（詳細は [README の利用規約に関する注意](../README.md)）。

---

## 全体像

3つの値が**一致**している必要がある。ズレると拡張がサーバーに接続できない。

| 値 | 置き場所 | 設定方法 |
|----|----------|----------|
| `CONNECT_SECRET` | サーバー（Wrangler secret）と拡張バンドル（埋め込み） | 両方に同じ hex を設定 |
| サーバー URL | 拡張バンドル（埋め込み） | `build.mjs` 既定 = 本番 workers.dev |

本番 URL: `https://unext-sync.kusakatsubasa-dba.workers.dev`（WS は `wss://…`）。`build.mjs` の既定 `SERVER_URL` に設定済み。

---

## A. Cloudflare Workers デプロイ

### 前提
- Cloudflare アカウント（無料プランで可）。
- `wrangler` はリポジトリの devDependency 済（追加インストール不要）。pnpm を使う。

### 初回のみ：ログイン
```bash
wrangler login        # ブラウザで OAuth 認証（一回）
```

### CONNECT_SECRET をサーバーに設定
```bash
wrangler secret put CONNECT_SECRET
# プロンプトに hex を貼り付ける。生成は: openssl rand -hex 32
```
- **`openssl rand -base64` は不可**（`+ / =` が混ざると拡張の `new WebSocket(url, [secret])` が `SyntaxError` で停止する）。
- secret は **書き込み専用**で読み戻せない。値は安全な場所に控えておく（拡張ビルドでも同じ値を使う）。

### デプロイ
```bash
pnpm deploy           # = wrangler deploy
```
- 出力に払い出し URL（`https://unext-sync.<subdomain>.workers.dev`）が出る。
- 構成は `wrangler.jsonc`：Durable Object バインディング `ROOM`→`RoomDurableObject`、SQLite migration（無料プランは SQLite-backed DO のみ）、`workers_dev:true`（本番 URL 維持）、`preview_urls:false`（不要なバージョン別 URL を無効化）。

### デプロイ確認
```bash
# CORS プリフライト
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS "https://unext-sync.kusakatsubasa-dba.workers.dev/create"   # → 204
# 認証付き create（secret は設定値）
curl -s -X POST -H "Authorization: Bearer <CONNECT_SECRET>" "https://unext-sync.kusakatsubasa-dba.workers.dev/create"   # → {"roomId":...,"hostToken":...}
```
または、サーバー側 WS リレーを丸ごと検証するヘッドレススモーク（host+participant を Node から接続、9 項目）:
```bash
CONNECT_SECRET=<設定値> node scripts/e2e-prod-smoke.mjs    # → 9 passed, 0 failed
```
Cloudflare の MCP/ダッシュボード（observability）でデプロイ後ログも確認できる。

### 無料枠の目安
無料枠は 100,000 req/日・13,000 GB-s/日・SQLite 5GB。WebSocket Hibernation により待機中の WS 接続は duration 課金が発生せず、受信 WS メッセージは request 課金で 20:1 に圧縮される。6人×5時間セッションでも ≈720 request / ≈9 GB-s に収まる（根拠は spec `docs/superpowers/specs/2026-06-07-cloudflare-workers-do-migration-design.md` §5.2）。

### ロールバック
- 直前バージョンへ戻す: `wrangler deployments list` で版を確認し、`wrangler rollback [<version-id>]`。
- ランタイムごと退避: 旧 Node.js + ws サーバー（`server/`・`build-server.mjs`）は git 履歴に残っている。CF が不健全なら削除コミットを `git revert` で復元し Render 等に再デプロイできる。

---

## B. Chrome 拡張のビルド

拡張はビルド時に `CONNECT_SECRET` とサーバー URL をバンドルへ**埋め込む**（esbuild define。`extension/src/config.ts`）。

### 本番ビルド（配布用）
```bash
CONNECT_SECRET=<デプロイと同じ値> pnpm build:extension
```
- 出力: `dist/extension/`（`manifest.json` + `content.js` / `popup.js` + アイコン）。
- 既定 `SERVER_URL` が本番 workers.dev なので、本番向けは `SERVER_URL` の指定**不要**。
- **secret がデプロイ側とズレると接続できない**ので必ず同じ値を使う。

### ローカル/E2E ビルド
ローカル `wrangler dev`（:8787）に向けるときだけ `SERVER_URL` で上書きする:
```bash
SERVER_URL=ws://localhost:8787 CONNECT_SECRET=<値> pnpm build:extension
```
詳細手順は [`e2e-pseudo-host-testing.md`](./e2e-pseudo-host-testing.md)。

### 注意
- `dist/` と埋め込み secret は**コミットしない**（`.gitignore` 済）。
- リリースごとに `extension/manifest.json` の `"version"` をバンプすると、友人側で版を識別しやすい。

---

## C. 友人への配布（zip 手渡し方式）

unpacked 拡張を zip で手渡しし、各自が「デベロッパー モード」で読み込む。無料・完全非公開で、ストア審査も不要。

> **配布前の必須確認**: zip には `CONNECT_SECRET`（共有シークレット）が埋め込まれている。**公開せず、信頼できる相手にのみ私的経路（DM 等）で渡す**こと。また各自が U-NEXT を個別契約していること・同時視聴制限に触れない使い方であることを共有する（[README 注意](../README.md)）。

### メンテナ側：パッケージング
```bash
# 1. 本番ビルド（B 参照。secret はデプロイ値）
CONNECT_SECRET=<本番値> pnpm build:extension

# 2. dist/extension を zip 化
cd dist && zip -r ../watch-sync-extension.zip extension && cd ..
# → watch-sync-extension.zip（解凍すると extension/ フォルダができる）
```
この zip を私的経路で友人に渡す。

### 友人側：インストール手順（このまま転送可）

> **Watch Sync 拡張のインストール手順（Chrome / Edge など Chromium 系）**
>
> 1. 受け取った `watch-sync-extension.zip` を、**今後消さない場所**に解凍する（例: ドキュメント内に専用フォルダを作る）。
>    → 拡張はこのフォルダを直接読むため、**フォルダを消したり移動したりすると動かなくなる**。
> 2. Chrome のアドレスバーに `chrome://extensions` と入力して開く。
> 3. 画面右上の「**デベロッパー モード**」をオンにする。
> 4. 左上に出る「**パッケージ化されていない拡張機能を読み込む**」を押し、**手順1で解凍した `extension` フォルダ**を選ぶ。
> 5. ツールバーのパズルピース型アイコンから「Watch Sync (U-NEXT)」を**ピン留め**しておくと使いやすい。
> 6. U-NEXT で動画を再生し、拡張アイコンを押して開くパネルから「ルーム作成」（ホスト）または ROOM ID を入れて「参加」（参加者）。
>
> ※ Chrome を起動するたびに「**デベロッパー モードの拡張機能を無効にする**」という確認が出ることがあります。これは正常です。**「キャンセル」または「×」で閉じてください**（「無効にする」は押さないこと）。

### 更新（新しい zip を配ったとき）
1. 友人は新しい zip を、**前と同じフォルダに上書き解凍**する。
2. `chrome://extensions` を開き、Watch Sync の**再読み込みアイコン（↻）**を押す。
   - うまくいかない場合は、一度「削除」してから手順4で読み込み直す。

### この方式の割り切り
- 自動更新はない（更新のたびに zip を配り直す）。
- Chrome 起動時に Dev モードの警告が出る（無効化しないよう周知する）。

---

## D. CONNECT_SECRET のローテーション

シークレットを変える場合は、サーバーと全員の拡張を**同じ新値**に揃える必要がある（spec: `docs/superpowers/specs/2026-06-06-connect-secret-design.md`）。

```bash
# 1. 新しい値を生成
NEW=$(openssl rand -hex 32)

# 2. サーバーに設定
wrangler secret put CONNECT_SECRET     # プロンプトに $NEW を貼る
#   （再デプロイは不要。secret 更新は即時反映）

# 3. 新値で拡張を再ビルド → 再 zip
CONNECT_SECRET=$NEW pnpm build:extension
cd dist && zip -r ../watch-sync-extension.zip extension && cd ..

# 4. 全員へ再配布（C の更新手順）
```

> **全員が同時に更新する必要がある。** サーバー secret を変えた瞬間、古い値を埋め込んだ拡張は接続を弾かれる（401）。ローテーションは全員へ周知してから行う。
