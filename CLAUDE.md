# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

U-NEXTの動画**再生状態のみ**（play/pause/seek/playbackRate）を複数ユーザー間で同期する。動画データ・映像・音声は一切共有しない。「完全スレーブ方式」＝参加者は常にホストに追従し、ズレたら自動seekで強制同期される。Chrome拡張（MV3）とNode.js WSリレーサーバーの2コンポーネント構成。

正典は `docs/superpowers/specs/2026-06-05-watch-sync-design.md`（設計仕様）と `docs/superpowers/plans/2026-06-05-watch-sync-mvp.md`（実装計画）。**仕様と実装が食い違ったら仕様を確認すること。** 現状はPhase 1（MVP）まで実装済み。

## Commands

パッケージマネージャは **pnpm**（npm/yarnは使わない。`pnpm-workspace.yaml` でサプライチェーン対策を設定済み）。

```bash
pnpm test                              # vitest run（全テスト）
pnpm test:watch                        # vitest ウォッチ
pnpm vitest run shared/sync-core.test.ts   # 単一ファイル
pnpm vitest run -t "projectedHostTime"     # テスト名で絞り込み

pnpm build:extension                   # extension → dist/extension（esbuild, iife, chrome120）
pnpm build:server                      # server → dist/server.js（esbuild, esm, node）
pnpm dev:server                        # tsx watch でサーバー起動（開発）
pnpm start                             # node dist/server.js（ビルド後の本番起動。PORT環境変数で待受ポート）
```

型チェックは `pnpm tsc --noEmit`（strict, `noUnusedLocals` 有効）。

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
- **サーバー**: Render の環境変数 `CONNECT_SECRET` に設定。
- **拡張ビルド**: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`（値はバンドルに埋め込まれるが**コミットしない**）。
- **ローテーション**: サーバーenv と拡張埋め込み値の**両方**を同じ新値に変更し、拡張を再ビルド・再配布する。

## Architecture

### レイヤー構成（依存方向）

```
shared/   ← プラットフォーム非依存。extension・server 両方が import する
  protocol.ts     ワイヤプロトコル型定義 + parseClientMessage（サーバー側の入力検証）
  sync-core.ts    同期計算の純粋関数群（projectedHostTime / needsCorrection / isStaleSeq / nextBackoffMs）

server/src/   Node.js + ws
  rooms.ts        RoomManager（ws非依存・依存注入）。ルーム/ホストスロット/lastState の状態機械
  server.ts       ws配線・メッセージルーティング・ping掃除・ログ

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

2. **`server/src/rooms.ts` は `ws` に依存しない。** 全副作用（時刻・ID生成・トークン生成）は `RoomManagerDeps` で注入する。将来 Cloudflare Workers + Durable Objects へ機械的に移行できるようにするため。新しいサーバー状態ロジックは rooms.ts 側（純粋）に置き、server.ts は配線だけにする。

3. **completeスレーブ＝ホストは全状態スナップショットを送り、参加者はリコンサイルするだけ。** 個別差分は送らない。順序は `seq`（ホストごと単調増加）で保証し、後退した `state` は破棄（`isStaleSeq`）。壁時計タイムスタンプは順序判定に使わない。

4. **フィードバックループ防止**：参加者が状態を適用する間 `VideoController.isApplying()` が true になり、自分のvideoイベントを送り返さない。新しいイベントハンドラを足すときも必ず `isApplying()` でガードする。

5. **WS接続は content script が持つ。** MV3 service worker はアイドルで停止するため。background worker は原則不要。

### 同期メカニズム（方式C）

ホストが5秒ごとにheartbeatで全状態を送り、サーバーが `lastState` を保持する。これ1本で「途中参加・ドリフト補正・一時切断からの復帰」を全部カバーする。heartbeatは `timeupdate` イベント駆動を主、`setInterval` を従にする（バックグラウンドタブのタイマースロットリング対策）。

ホスト本人確認は**ホストトークン**（create時にサーバー発行のランダム秘密）。ホスト切断後もスロットは60秒保持され、同一トークンで再接続すれば同じホストとして復帰でき、他人が奪えない。

### 既知の制約（post-MVP）

実E2E（U-NEXT実機ブラウザ）は未実施。サーバー側ロジックはユニットテストで実証済み。その他、ホストのページ再読込でルーム復帰しない・`seq` リセット問題などは spec §11「既知の制約」に記載。

## Workflow

このリポジトリは superpowers スキル（TDD / brainstorming / writing-plans / executing-plans）で開発されている。`docs/superpowers/` 配下に spec と plan が蓄積される。新機能は spec → plan → TDD実装 の流れに従う。`sync-core` と `protocol` の変更は特にテストファースト（純粋関数なのでTDDが効く）。

`extension/src/config.ts` の `SERVER_URL` はデプロイ先の実URL。`poc/` はPhase 0のPoC成果物（U-NEXTの`<video>`到達可否検証）で本体ビルドには含まれない。
