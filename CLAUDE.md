# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

U-NEXTの動画**再生状態のみ**（play/pause/seek/playbackRate）を複数ユーザー間で同期する。動画データ・映像・音声は一切共有しない。「完全スレーブ方式」＝参加者は常にホストに追従し、ズレたら自動seekで強制同期される。Chrome拡張（MV3）と Cloudflare Workers + Durable Objects のWSリレーの2コンポーネント構成。

正典は `docs/superpowers/specs/2026-06-05-watch-sync-design.md`（設計仕様）と `docs/superpowers/plans/2026-06-05-watch-sync-mvp.md`（実装計画）。**仕様と実装が食い違ったら仕様を確認すること。** MVP＋後続機能（接続シークレット・roster・視聴中タイトル・話数遷移同期）を実装し、サーバーは Cloudflare Workers + Durable Objects へ移行・本番デプロイ済み。

## Commands

パッケージマネージャは **pnpm**（npm/yarnは使わない。`pnpm-workspace.yaml` でサプライチェーン対策を設定済み）。

```bash
pnpm test                              # vitest run（全テスト: node suite + worker suite 両方）
pnpm test:watch                        # vitest ウォッチ
pnpm vitest run shared/sync-core.test.ts   # 単一ファイル
pnpm vitest run -t "projectedHostTime"     # テスト名で絞り込み

pnpm build:extension                   # extension → dist/extension（esbuild, iife, chrome120）
pnpm dev:worker                        # wrangler dev（Worker ローカル開発、デフォルト port 8787）
pnpm test:worker                       # Worker テストスイートのみ実行
pnpm deploy                            # wrangler deploy（本番デプロイ）
```

型チェックは `pnpm typecheck`（`tsc --noEmit && tsc -p worker/tsconfig.json --noEmit`、strict, `noUnusedLocals` 有効）。

Worker テストは `worker/vitest.config.ts`（`@cloudflare/vitest-pool-workers` の `cloudflareTest` プラグイン。v0.16.10 に `defineWorkersConfig` は無い）。`cloudflare:test` の型は `worker/tsconfig.json` の `paths` で解決。ローカル `wrangler dev` の `CONNECT_SECRET` は `.dev.vars` に置く（`.dev.vars`/`.wrangler/` は gitignore 済）。

デプロイ（`wrangler login`→`wrangler secret put CONNECT_SECRET`→`pnpm deploy`）・拡張ビルド・友人への配布（zip 手渡し）の運用手順は `docs/deploy-and-distribute.md`。

### Biome（Lint + Format）

```bash
pnpm check                             # lint + format + import チェック（書き込みなし）
pnpm check:fix                         # lint + format + import を自動修正
pnpm lint                              # lint のみ
pnpm format                            # format のみ（書き込みあり）
pnpm biome ci .                        # CI モード（修正なし、警告もエラー扱い）
```

インデント: スペース2 / クォート: ダブル / セミコロン: あり（既存スタイル準拠）。設定は `biome.json`。テストファイル（`*.test.ts`）では `noExplicitAny` を無効化済み。

### 接続シークレット（CONNECT_SECRET）

公開WSサーバーへの接続は単一共有シークレットでゲートされている（spec: `docs/superpowers/specs/2026-06-06-connect-secret-design.md`）。サーバーもビルドも未設定なら fail-closed で停止する。

- **生成**: `openssl rand -hex 32` を推奨。**`openssl rand -base64` は不可**（`+ / =` で拡張が `SyntaxError` 停止）。
- **サーバー**: Wrangler secret に設定（`wrangler secret put CONNECT_SECRET`）。
- **拡張ビルド**: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`（値はバンドルに埋め込まれるが**コミットしない**）。
- **ローテーション**: サーバーenv と拡張埋め込み値の**両方**を同じ新値に変更し、拡張を再ビルド・再配布する。

## Architecture

### レイヤー構成（依存方向）

```
shared/   ← プラットフォーム非依存。extension・worker 両方が import する
  protocol.ts     ワイヤプロトコル型定義 + parseClientMessage（PROTOCOL_VERSION 2）
  sync-core.ts    同期計算の純粋関数群（projectedHostTime / needsCorrection / isStaleSeq / nextBackoffMs）
  rooms.ts        単一ルーム純粋 reducer（makeRoomLogic(deps) → {state, effects}）。副作用は
                  send/broadcast/setAttachment/setAlarm/clearStorage で表現し IO を持たない
  secret.ts       constantTimeEqual（Workers-portable、node:crypto 非依存）
  server-url.ts   httpBaseFrom（ws(s)://→http(s):// 変換、POST /create ベースURL導出）

worker/src/   Cloudflare Workers + Durable Objects
  index.ts        Worker エントリ。auth（POST Bearer / WS Sec-WebSocket-Protocol、定数時間比較）・
                  CORS・ルーティング（POST /create → roomId 発行 → DO /__init；
                  WS /r/<roomId> → idFromName(roomId) → DO フォワード）
  room-do.ts      RoomDurableObject（thin IO シェル）。Hibernatable WS（ctx.acceptWebSocket）・
                  永続状態（ctx.storage key "p"）・load→reduce→apply-effects→save の commit サイクル・
                  DO Alarm でホストスロット60秒解放＋空ルームクリーンアップ

extension/src/   Chrome MV3
  content.ts            video要素探索 + 全モジュールの組み立て（WS接続はここが持つ）
  video-controller.ts   <video>への状態読み書き + applyガード
  ws-client.ts          WS接続・再接続バックオフ・app-level ping/pongでRTT測定
  sync-orchestrator.ts  controller + client + sync-core を束ねるホスト/参加者ロジック
  popup.ts / popup-status.ts   UI（ルームID入力・接続状態表示）
```

### 設計上の不変条件（壊さないこと）

これらは仕様で意図的に選択された制約で、テストでも守られている。コード変更時は必ず維持する。

1. **同期ロジックで壁時計（`Date.now()`）の引き算をしない。** クロスマシン量として使うのは片道遅延 `oneWayLatencySec`（RTT/2）のみ。受信後の経過時間は参加者**自身のmonotonicクロック**（`performance.now()`）で測る。クロックスキューを構造的に排除するため（spec §5）。`shared/sync-core.test.ts` にクロックスキュー回帰テストがある。

2. **純粋ルーム状態ロジックは `shared/rooms.ts`（単一ルーム reducer）に置く。** 全副作用（時刻・ID生成・トークン生成）は `deps` 注入で表現し、IO は持たない。DO シェル（`worker/src/room-do.ts`）が唯一の impure 実装で、load→reduce→apply-effects→save のみを担う。CF Workers + DO への移行は**完了済み**（Node.js `server/` は削除）。新しいサーバー状態ロジックは `shared/rooms.ts` 側に置き、`room-do.ts` は配線だけにする。

3. **completeスレーブ＝ホストは全状態スナップショットを送り、参加者はリコンサイルするだけ。** 個別差分は送らない。順序は `seq`（ホストごと単調増加）で保証し、後退した `state` は破棄（`isStaleSeq`）。壁時計タイムスタンプは順序判定に使わない。

4. **フィードバックループ防止**：参加者が状態を適用する間 `VideoController.isApplying()` が true になり、自分のvideoイベントを送り返さない。新しいイベントハンドラを足すときも必ず `isApplying()` でガードする。

5. **WS接続は content script が持つ。** MV3 service worker はアイドルで停止するため。background worker は原則不要。

6. **DO はヒバーネーション適格を維持する（free tier の経済的生命線）。** `setInterval`/`setTimeout` は使わない（タイマーは DO Alarm のみ）。WS は `ctx.acceptWebSocket` で受け入れる。未解決の Promise をリクエストハンドラ外に漏らさない。これを破るとヒバーネーションが無効化され常時課金になる。

### 同期メカニズム（方式C）

ホストが5秒ごとにheartbeatで全状態を送り、サーバーが `lastState` を保持する。これ1本で「途中参加・ドリフト補正・一時切断からの復帰」を全部カバーする。heartbeatは `timeupdate` イベント駆動を主、`setInterval` を従にする（バックグラウンドタブのタイマースロットリング対策）。

ホスト本人確認は**ホストトークン**（create時にサーバー発行のランダム秘密）。ホスト切断後もスロットは60秒保持され、同一トークンで再接続すれば同じホストとして復帰でき、他人が奪えない。

### 既知の制約（post-MVP）

参加者側のU-NEXT実機ブラウザE2Eは擬似ホスト方式で実施済み（手順 `docs/e2e-pseudo-host-testing.md`、本番スモークは `scripts/e2e-prod-smoke.mjs`）。ホスト側の実機E2Eはその鏡像（実ブラウザがホスト ↔ 擬似参加者オブザーバ `scripts/e2e-observer.mjs`、手順 `docs/e2e-real-host-testing.md`）。その他、ホストのページ再読込でルーム復帰しない・`seq` リセット問題などは spec §11「既知の制約」に記載。

**CF Workers ロールバック手順**: 旧 Node.js ランタイム（`server/`・`build-server.mjs`）は git 履歴に残っている（削除コミットを `git revert` で復元し Render に再デプロイ）。CF が不健全な場合の退避策として使える。移行仕様は `docs/superpowers/specs/2026-06-07-cloudflare-workers-do-migration-design.md` 参照。

## Workflow

このリポジトリは superpowers スキル（TDD / brainstorming / writing-plans / executing-plans）で開発されている。`docs/superpowers/` 配下に spec と plan が蓄積される。新機能は spec → plan → TDD実装 の流れに従う。`sync-core` と `protocol` の変更は特にテストファースト（純粋関数なのでTDDが効く）。

`SERVER_URL` は `CONNECT_SECRET` と同様にビルド時 esbuild `define` で注入する（`config.ts` の `__SERVER_URL__`）。既定は本番 `wss://unext-sync.<subdomain>.workers.dev`（`<subdomain>` はデプロイ先 CF アカウントのサブドメイン）。`shared/server-url.ts` の `httpBaseFrom` で ws(s):// → http(s):// に変換し POST /create のベース URL を導出する。環境変数 `SERVER_URL` で上書き可能（E2E時は `SERVER_URL=ws://localhost:8787 CONNECT_SECRET=… pnpm build:extension`、`config.ts` の編集は不要）。ローカル Worker は `pnpm dev:worker`（`wrangler dev`、port 8787）で起動する。不正なURL（`ws://|wss://` 以外）は `build.mjs` がビルド時に弾く。E2E手順は `docs/e2e-pseudo-host-testing.md`。`poc/` はPhase 0のPoC成果物（U-NEXTの`<video>`到達可否検証）で本体ビルドには含まれない。
