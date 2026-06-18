# 実ブラウザホスト＋擬似参加者による E2E テスト手順

U-NEXT の **ホスト側**の挙動を、実ブラウザ1台と Node の擬似参加者オブザーバで検証するための手順。

参加者（スレーブ）側の手順は [`e2e-pseudo-host-testing.md`](./e2e-pseudo-host-testing.md)（擬似ホスト ↔ 実ブラウザ参加者）。
本書はその**鏡像**で、**実ブラウザホスト ↔ 擬似参加者オブザーバ**を扱う。

## なぜこの方式か

[`e2e-pseudo-host-testing.md`](./e2e-pseudo-host-testing.md) の擬似ホスト方式は、ホストを Node
（`scripts/e2e-host.mjs`）が演じて WS メッセージ送出を模すだけで、**実ブラウザの `<video>` イベント
（実 `timeupdate` 駆動 heartbeat・実 `play`/`pause`/`seeked`/`ratechange` 発火・拡張からの `POST /create`・
SPA 話数遷移検知）は検証しない**（あちらの「既知の制約」末尾に明記）。本書はその穴を埋める。

アカウント制限（同一 U-NEXT アカウントでの「複数ブラウザ・同一動画の同時再生」が不可）は、
**実ブラウザ1台だけがホストとして再生し、Node は再生状態を受信観測するだけ**（＝同一動画の二重再生が
発生しない）なので回避できる。擬似参加者オブザーバ `scripts/e2e-observer.mjs` は participant として
ルームに join し、ホストから配信される全メッセージ（`state`/`roster`/`room_title`/`host_*`）をログするだけで、
動画は一切再生しない。

## 仕組みの要点

- **方向が逆**: 擬似ホスト方式は Node がホスト・実ブラウザが参加者。本方式は**実ブラウザがホスト**・
  Node が参加者オブザーバ。検証対象は「拡張の実 video イベント捕捉・送出ロジック」。
- **ROOM ID はブラウザ発行**: 実ブラウザの拡張 popup で「ルーム作成」すると拡張が `POST /create` して
  roomId を得る（content.ts）。その roomId を `ROOM_ID` env でオブザーバへ渡す。
- **オブザーバは受信に徹する**: 操作（play/pause/seek 等）は**人間が U-NEXT の実プレイヤーを手で操作**して
  引き起こす。オブザーバはアサートを能動実行せず、受信を整形ログするのみ（操作の正否は人間が目視照合）。
- **受動アサート**: 人間が数えづらい破綻だけ `[WARN]` で目立たせる（後述）。

## セットアップ（2段ブートストラップ）

`<SECRET>` は token-safe な hex（`openssl rand -hex 32`。base64 は不可）。

### 段1: 擬似ホストでオブザーバの配線を固める（実ブラウザ不要）

まず `scripts/e2e-host.mjs`（擬似ホスト）を相手にオブザーバの配線（WS 接続・サブプロトコル・join・
ログ整形・アサート）を確認する。実ブラウザ操作の手間なしに配線バグを潰せる。

```bash
SECRET=$(openssl rand -hex 32)

# 1. ローカル Worker 起動（CONNECT_SECRET は .dev.vars から読む）
echo "CONNECT_SECRET=$SECRET" > .dev.vars
pnpm dev:worker &                       # wrangler dev（port 8787）

# 2. 擬似ホスト起動。出力される ROOM ID を控える
SERVER_URL=ws://localhost:8787 CONNECT_SECRET=$SECRET node scripts/e2e-host.mjs &

# 3. オブザーバ起動（擬似ホストの roomId を渡す）
SERVER_URL=ws://localhost:8787 ROOM_ID=<擬似ホストのroomId> CONNECT_SECRET=$SECRET node scripts/e2e-observer.mjs
```

`scripts/e2e-control.json` の `n` をインクリメントして擬似ホストにコマンドを送り（手順は
[`e2e-pseudo-host-testing.md`](./e2e-pseudo-host-testing.md) 参照）、オブザーバのログに
`[STATE]`/`[ROSTER]`/`[TITLE]` が正しく出ること・誤 `[WARN]` が出ないことを確認する。配線が緑になったら段2へ。

### 段2: 実ブラウザをホストに差し替える

擬似ホストを止め、実ブラウザの拡張をホストにする。

```bash
# 擬似ホストだけ止める（Worker とオブザーバの起動方法は段1と同じ）
pkill -f "scripts/e2e-host.mjs"

# 拡張を localhost 向けにビルド（SERVER_URL を環境変数で注入）
SERVER_URL=ws://localhost:8787 CONNECT_SECRET=$SECRET pnpm build:extension
```

ブラウザ操作（ホスト）:

1. `chrome://extensions` で `dist/extension` を読み込み（既読込なら**再読込ボタン**で最新ビルド反映）。
2. U-NEXT で **5分以上**のタイトルを開いて再生開始（`<video>` を生成させる）。
3. 拡張 popup → 名前を入力 → **「ルーム作成」**をクリック（「参加」ではない）。popup に表示された
   **ROOM ID** を控える。
4. その roomId でオブザーバを起動:

   ```bash
   SERVER_URL=ws://localhost:8787 ROOM_ID=<popupのroomId> CONNECT_SECRET=$SECRET node scripts/e2e-observer.mjs
   ```

5. オブザーバの `[STATE]` ログを見ながら、ブラウザの U-NEXT プレイヤーを手で操作して下のチェックリストを消す。

> **本番サーバーで最後に1回通す**: 配布する拡張は本番ビルドなので、最後に本番 `SERVER_URL`
> （`wss://unext-sync.<subdomain>.workers.dev`）でビルドした拡張でホストになり、オブザーバを
> `SERVER_URL=wss://… ROOM_ID=<id> CONNECT_SECRET=<本番値> node scripts/e2e-observer.mjs` で
> 本番に向けて通す。`CONNECT_SECRET` は `wrangler secret put` で設定した本番値。コールドスタート/
> Hibernation 復帰も付随で確認できる。

## オブザーバの受動アサート（`[WARN]`/`[INFO]`）

`scripts/e2e-observer.mjs` は人間が数えづらい破綻だけ自動で目立たせる。操作の正否判定は人間が行う。

- **`[WARN] state スキーマ不正`**: `state` の `playing`/`currentTime`/`playbackRate`/`seq`/`event` が
  protocol（`shared/protocol.ts` の `isPlayback`/`isSyncEvent` と等価）に適合しない。
- **`[WARN] seq 後退`**: 同一ホストの `seq` 単調増加が崩れた（受信順序の乱れ・重複の疑い）。
- **`[INFO] seq 再起点`**: `seq` が 0/1 へ落ちた。ホストのページ再読込で content script が再起動し
  `seq` がリセットされる**既知制約（spec §11）**と整合する正常系。後退 WARN と区別して INFO で出す。
- **`[WARN] state 間隔 …s > 8s`**: 前回 `state` から 8 秒超（heartbeat 想定 5s）。heartbeat 欠落の疑い。
  **ホストタブを背景にするとタイマースロットリングで出うる**ため、ホストタブは前面にして観測する。

## 検証チェックリスト（ホスト側）

実ブラウザがホストで、オブザーバのログを見ながら確認する。

### コア（実 video イベントの捕捉・送出）

- [ ] **1. POST /create**: popup「ルーム作成」で room が発行され popup に roomId が表示される
      （拡張が `POST /create` 成功）。
- [ ] **2. 初期タイトル送出**: オブザーバ起動直後、`[TITLE] room_title → "<作品名>"` を受信
      （join 時キャッチアップ＋ホストが `joined(host)` で視聴中タイトル送出）。
- [ ] **3. play / pause**: ブラウザで再生/一時停止すると、オブザーバに `[STATE] play playing=true …` /
      `[STATE] pause playing=false …` が出る。
- [ ] **4. seek（seq 単調増加）**: シークバーをドラッグすると `[STATE] seek … t=<移動先>s` が出て、
      `seq` が増え続ける（後退 WARN が出ない）。
- [ ] **5. ratechange**: 再生速度を変えると `[STATE] ratechange … rate=<新速度>x` が出る。
- [ ] **6. timeupdate heartbeat ~5s**: 再生を流しっぱなしにすると `[STATE] heartbeat …` が
      おおむね 5 秒間隔で出続ける（間隔 WARN が出ない＝実 `timeupdate` 駆動が効いている）。

### 拡張（SPA 話数遷移・タイトル）

- [ ] **7. 話数自動遷移**: 次話へ自動/手動遷移すると、オブザーバの `state` の `ck=`（contentKey）が
      新エピソードの `SID…/ED…` に切り替わり、遷移直後に新 `ck` の heartbeat が出る
      （`<video>` 再バインド → 新 contentKey＋新 currentTime の即時 heartbeat）。SPA 遷移では content
      script は再起動しないので `seq` は連続する（リセットしない）。
      > 注: `currentTime` は**新 `<video>` の実際の位置**で、必ずしも 0 ではない（U-NEXT のレジューム
      > 再生では途中から始まる。2026-06-18 実機では第2話が t=217s から開始）。`currentTime=0` 固定は
      > 擬似ホスト `e2e-host.mjs` の `episode` コマンド**だけ**の挙動で、実拡張は新要素の実 currentTime を読む。
- [ ] **8. 遷移時タイトル更新**: 話数遷移後、`[TITLE] room_title → "<新しい話のタイトル>"` を受信する。

## 実施実績と発見事項（2026-06-18 ローカル実機）

実ブラウザ（U-NEXT「笑顔のたえない職場です。」）をホストに、ローカル Worker＋`e2e-observer.mjs` で
チェックリスト 1〜8 を全て確認（合格）。実機でしか出ない挙動を2件発見（**いずれも同期の正しさには影響なし**）:

- **A. 停止中の heartbeat 間隔が ~10s に倍化**: 再生中は実 `timeupdate` 駆動でクリーンに 5s だが、
  一時停止中は唯一の駆動が `setInterval(beat, heartbeatMs)` になる。`content.ts` の `beat()` の閾値
  （`t - lastBeat >= heartbeatMs`）と `setInterval` 周期がどちらも 5000ms で等しいため、タイマー
  jitter で約半数の tick が「経過 4999.x ms < 5000」と判定されスキップ → 実効 10s になる
  フェンスポスト。停止中は currentTime が進まずドリフトせず、途中参加者は join 時に lastState を即受信
  するため**無害**。ただし observer の 8s 間隔 WARN が停止中に鳴り続ける（誤検出ではなく実 10s を報告）。
- **B. ドラッグシーク中の中間 sync 取りこぼし**: 大きなドラッグシーク中に中間の sync が数件
  オブザーバへ届かないことがある（`seq` に飛び。例: 24→30）。`host_disconnected` は出ず、最終位置・
  速度は正しく伝播し直後の heartbeat で定常化するため**無害**（方式C は最新 state だけでリコンサイル）。
  サーバーは sync を間引かない（`shared/rooms.ts` `applySync`）ので、有力仮説は「重いシーク/バッファ
  リング中に WS が一時的に `OPEN` でない瞬間、`orchestrator.emit()` が `seq` を進めつつ `WsClient.send`
  が no-op になり外へ出ない」（完全 close ではないので disconnect は出ない）。**要追加調査**（WsClient の
  readyState 遷移ログ等）。

## 既知の制約（この方式で確認しないもの）

- **ホスト切断 → 同一トークン再接続**: 拡張は `hostToken` を content script のメモリにのみ保持し、
  **ページ再読込で喪失する**（spec §11 既知制約）。リロードからの同一ホスト復帰は拡張仕様上未対応のため
  本方式でも対象外。WS レベルのトークン再接続（60秒スロット保持）はサーバー側 E2E スモーク
  `scripts/e2e-prod-smoke.mjs`（項目 7〜9）で実証済み。
- **背景タブの `setInterval` heartbeat フォールバック**: タイマースロットリング依存で決定的に再現
  しづらく、間隔 WARN との切り分けも曖昧なため対象外。設計（timeupdate 主・setInterval 従）は
  content.ts のコードレビューで担保する。
- **クロックスキュー回帰**: 別マシンの時計ズレ。設計上 `performance.now()`+RTT/2 のみ使用で構造的に
  担保され、`shared/sync-core.test.ts` にユニット回帰テストあり。

## 後始末

```bash
pkill -f "scripts/e2e-observer.mjs"  # オブザーバ停止
pkill -f "scripts/e2e-host.mjs"      # （段1を使った場合）擬似ホスト停止
pkill -f "wrangler dev"              # ローカル Worker 停止
printf '{"n":0,"cmd":""}' > scripts/e2e-control.json   # 制御ファイルを no-op に戻す
# 配布用に本番URLで拡張を作り直すなら: CONNECT_SECRET=<本番値> pnpm build:extension
```

`scripts/e2e-observer.mjs` は再利用のため残置（`scripts/e2e-host.mjs`/`scripts/e2e-prod-smoke.mjs` と同列の E2E 道具）。
