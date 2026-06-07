# ローカルサーバー＋擬似ホストによる E2E テスト手順

U-NEXT の **参加者（スレーブ）側**の挙動を、実ブラウザ1台だけで検証するための手順。

## なぜこの方式か

当初の手動E2E（spec §8 / plan Task 10 Step 5）は「2つのChromeプロファイルでホストと参加者を立てる」
想定だった。しかし **U-NEXTアカウントが同一だと「複数ブラウザ・同一動画の同時再生」がアカウント制限で
不可能**なため、2プロファイル方式は実施できない。

Watch Sync は**動画データ・映像・音声を一切共有せず、ホストは再生状態（play/pause/seek/currentTime/
playbackRate）の WS メッセージを送るだけ**（完全スレーブ / 方式C）。したがって **ホストは実ブラウザで
ある必要がない**。Node.js の擬似ホスト（`scripts/e2e-host.mjs`）を立てて再生状態を送れば、参加者だけを
実ブラウザで検証でき、アカウント制限を完全に回避できる。擬似ホストとブラウザは同一マシン上なので、
両者とも `localhost` のローカルサーバーに到達できる（ネットワーク公開不要）。

## 仕組みの要点

- **接続ゲート**: `CONNECT_SECRET` は WebSocket サブプロトコルヘッダで送る → `new WebSocket(url, [secret])`。
  サーバーは `verifyClient`（`server/src/server.ts`）で検証。Node `ws` でも第2引数で同様に送れる。
- **ホストスロット確保が必須**: サーバーは `room.hostId !== clientId` の sync を破棄する（`server/src/rooms.ts`）。
  擬似ホストは必ず `create` →（払い出された `hostToken` で）`join(role:"host")` してから `sync` を送る。
- **lastState**: ホストの直近 state をサーバーが保持し途中参加者へ即送信。擬似ホストは 5 秒ごとに
  heartbeat を送り続け、途中参加・ドリフト補正をカバーする。
- **sync ペイロード検証**: `playing:boolean` / `currentTime>=0` / `playbackRate>0` / `seq` 整数（`shared/protocol.ts`）。

## セットアップ

`<SECRET>` は token-safe な hex（`openssl rand -hex 32`。base64 は不可）。サーバー・拡張ビルド・擬似ホストの
3か所で**同じ値**を使う。

```bash
SECRET=$(openssl rand -hex 32)

# 1. ローカルサーバー起動（バックグラウンド）
pnpm build:server                       # dist/server.js を生成（サーバーコード変更時のみ）
CONNECT_SECRET=$SECRET PORT=8080 node dist/server.js &

# 2. 拡張を localhost 向けにビルド（SERVER_URL を環境変数で注入。config.ts の編集は不要）
SERVER_URL=ws://localhost:8080 CONNECT_SECRET=$SECRET pnpm build:extension

# 3. 擬似ホスト起動（バックグラウンド）。出力される ROOM ID を控える
CONNECT_SECRET=$SECRET node scripts/e2e-host.mjs &
```

> **`SERVER_URL` は環境変数で注入する**（`ws://` であって `wss://` ではない。ローカルはTLSなし）。
> 既定（未指定）では本番 `wss://unext-sync.onrender.com` が埋め込まれるので、`extension/src/config.ts` を
> 編集する必要はない。不正なURL（`ws://|wss://` 以外）は `build.mjs` がビルド時に弾く。

## ブラウザ操作（参加者）

1. `chrome://extensions` で `dist/extension` を読み込み（既読込なら**再読込ボタン**で最新ビルドを反映）。
2. U-NEXT で **5分以上**のタイトルを開いて再生開始（`<video>` を生成させる。擬似ホストの currentTime は
   60〜200秒程度なのでタイトル長に余裕を持たせる）。
3. 拡張 popup → ROOM ID を入力 → **「参加（参加者）」**をクリック（「ルーム作成」は押さない）。

## 擬似ホストの操作（制御ファイル方式）

`scripts/e2e-control.json` の `n` を**前回より大きい値**にして書き換えるとコマンドが実行される
（擬似ホストが 200ms ポーリング）。

```jsonc
{"n": 1, "cmd": "play"}              // 再生開始
{"n": 2, "cmd": "seek", "value": 120} // 120秒へシーク
{"n": 3, "cmd": "pause"}             // 一時停止
{"n": 4, "cmd": "rate", "value": 1.5} // 1.5倍速
{"n": 5, "cmd": "disconnect"}        // ホスト切断シミュレート（→参加者popup「ホスト切断」）
{"n": 6, "cmd": "reconnect"}         // 同一トークンで再join（→「接続済み」）
{"n": 7, "cmd": "status"}            // 現在の内部状態をログ出力
```

ホスト切断→再接続の popup 遷移を見るときは、**popup を開いたまま**コマンドを送る必要がある
（拡張 popup はフォーカスを外すと閉じる）。切断と再接続を数秒間隔でタイマー送信し、その間 popup を
注視するとよい。

## 検証チェックリスト（参加者側）

- [ ] 参加成功で popup が「接続済み」になる。
- [ ] ホストの play / pause / seek / ratechange が動画に反映される。
- [ ] 参加者が手動でシークバーをずらすと、即時〜5秒以内にホスト位置へ戻る。
- [ ] `disconnect` → popup「ホスト切断」、`reconnect` → popup「接続済み」。

## 後始末

```bash
pkill -f "scripts/e2e-host.mjs"      # 擬似ホスト停止
pkill -f "node dist/server.js"       # サーバー停止
# SERVER_URL は環境変数注入なので config.ts の差し戻しは不要。
# 配布用に本番URLで拡張を作り直すなら: CONNECT_SECRET=<本番値> pnpm build:extension
```

`scripts/e2e-control.json` は実行時ファイルで `.gitignore` 済み。`scripts/e2e-host.mjs` は再利用のため残置。

## 既知の制約（この方式で確認できないもの）

- **クロックスキュー回帰**: 別マシンの時計ズレ検証。設計上 `performance.now()`+RTT/2 のみ使用で構造的に
  担保され、`shared/sync-core.test.ts` にユニット回帰テストあり。
- **Renderコールドスタート**: 本番 Render 接続時のみ。ローカル検証では対象外。
- **ホスト側の実機挙動**: 擬似ホストはサーバーへの WS メッセージ送出を模すだけで、実ブラウザの
  `<video>` イベント（timeupdate 駆動 heartbeat 等）は検証しない。
