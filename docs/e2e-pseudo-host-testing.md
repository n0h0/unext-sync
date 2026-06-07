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

> **話数遷移の同期を検証する場合**は、擬似ホストの視聴中エピソード（`contentKey`）を
> **参加者が実際に開く U-NEXT URL の SID/ED に一致させる**こと。一致しないと参加者は hold（同期されない）。
> URL `https://video.unext.jp/play/SID0234926/ED00720091` なら contentKey は `SID0234926/ED00720091`。
> 起動時に env で渡す（既定は `SID0234926/ED00720091`）:
>
> ```bash
> CONNECT_SECRET=$SECRET HOST_CONTENT_KEY="SID0234926/ED00720091" node scripts/e2e-host.mjs &
> ```

## ブラウザ操作（参加者）

1. `chrome://extensions` で `dist/extension` を読み込み（既読込なら**再読込ボタン**で最新ビルドを反映）。
2. U-NEXT で **5分以上**のタイトルを開いて再生開始（`<video>` を生成させる。擬似ホストの currentTime は
   60〜200秒程度なのでタイトル長に余裕を持たせる）。
3. 拡張 popup → **「あなたの名前」**を入力（`chrome.storage` に保存され次回プリフィル）→ ROOM ID を入力 →
   **「参加（参加者）」**をクリック（「ルーム作成」は押さない）。

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
{"n": 8, "cmd": "title", "value": "別の作品 第2話"} // 視聴中タイトル変更（SPA話数遷移を模擬）
{"n": 9, "cmd": "episode", "value": "SID0234926/ED00720092"} // 次エピソードへ遷移（contentKey 切替＋先頭から再生）
```

`episode` はホストの `contentKey` を切り替え、`currentTime` を 0 にリセットして heartbeat を送る（実拡張で
content.ts が遷移検知 → `<video>` 取り直し → `orchestrator.heartbeat()` を即送出する挙動に対応）。`value` は
`SID…/ED…` 形式。参加者は**自分の URL の SID/ED がこの値に一致するまで hold**し、誤シークしない。
再生/停止状態は変えない（直前が `pause` なら新エピソードも先頭で停止状態になる）。再生中の遷移を試すなら
先に `play` を送っておく。

擬似ホストは host-join 直後に既定タイトル `テスト作品 第1話` を送る（実拡張では content.ts が
`joined`（role:host）で `cleanTitle(document.title)` を送出する箇所に対応）。`title` コマンドで変更すると
サーバーが `room_title` を全員へ再配信する。ホスト自身にも `room_title` が返り `[RECVTTL]` 行に出る。

ホスト切断→再接続の popup 遷移を見るときは、**popup を開いたまま**コマンドを送る必要がある
（拡張 popup はフォーカスを外すと閉じる）。切断と再接続を数秒間隔でタイマー送信し、その間 popup を
注視するとよい。

## 検証チェックリスト（参加者側）

- [ ] 参加成功で popup が「接続済み」になる。
- [ ] ホストの play / pause / seek / ratechange が動画に反映される。
- [ ] 参加者が手動でシークバーをずらすと、即時〜5秒以内にホスト位置へ戻る。
- [ ] `disconnect` → popup「ホスト切断」、`reconnect` → popup「接続済み」。

### ロスター（参加者一覧）表示

擬似ホストは join 時に名前 `ホスト(擬似)` を送り、受信した roster を `[ROSTER]` 行でログ出力する
（`/tmp/e2e_host.log` 等で確認可）。サーバー側のロスター配信は `node scripts/e2e-host.mjs` のログと
ユニットテスト（`server/server.test.ts`, `server/rooms.test.ts`）で実証済み。popup の**描画**を実機確認する。

- [ ] 参加後、popup に「参加者 (2)」ヘッダと2行が出る：`👑 ホスト(擬似)` と `<自分の名前> (あなた)`。
- [ ] `disconnect` → ホスト行が `👑 ホスト(擬似) (切断)`（灰色）に変わり、自分の行は残る。
- [ ] `reconnect` → ホスト行の `(切断)` が消えて通常表示に戻る。
- [ ] popup を閉じて開き直しても（get_status 復元）一覧が再表示される。
- [ ] 名前を空欄のまま参加すると、ホスト側 `[ROSTER]` ログに `ゲスト-xxxx` が出る（サーバー合成名）。

### 視聴中タイトル表示

擬似ホストが送る視聴中タイトルが参加者 popup に「🎬 視聴中: …」で表示されることを実機確認する。
WSレベルの配信（host→server `title` → 全員へ `room_title`・途中参加キャッチアップ・ライブ更新）は
ユニット/サーバー統合テスト（`server/server.test.ts`）と擬似ホスト＋Node参加者で実証済み。ここでは
popup の**描画**を確認する。

- [ ] 参加後、popup の状態行の下に `🎬 視聴中: テスト作品 第1話` が出る（途中参加キャッチアップ）。
- [ ] `{"cmd":"title","value":"別の作品 第2話"}` を送ると、開いている popup の表示が
      `🎬 視聴中: 別の作品 第2話` に更新される（popup を開いたまま送る）。
- [ ] popup を閉じて開き直しても（get_status 復元）視聴中タイトル行が再表示される。
- [ ] タイトル変更後に新規参加した参加者は、最新タイトルをキャッチアップ表示する。

### エピソード自動遷移時の同期維持（contentKey ガード）

spec: `docs/superpowers/specs/2026-06-07-episode-transition-sync-design.md`。U-NEXT の話数自動遷移（SPA）で
同期が維持されることを実機確認する。WSレベルの配信路（host が `contentKey` 送出 → server `recordSync` 素通し
→ 参加者ガード hold→catch-up → 途中参加 lastState）はヘッドレス E2E と
ユニットテスト（`shared/protocol.test.ts` / `server/rooms.test.ts` / `extension/src/sync-orchestrator.test.ts`）で
実証済み。ここでは**ブラウザ側**（`deriveContentKey` の実 URL 評価・pathname 検知・`<video>` 再バインド）を確認する。

**準備**: 擬似ホストを `HOST_CONTENT_KEY` に**参加者が開く第1話の SID/ED**を指定して起動し、参加者は同じ
第1話を開いて参加する（contentKey 一致状態から始める）。第2話の URL（SID は同じ・ED が次番号）も控えておく。

- [ ] 一致状態では従来どおり host の play / pause / seek が参加者に反映される（contentKey ガードが正常系を妨げない）。
- [ ] **ホスト先行**: `{"cmd":"episode","value":"<第2話のSID/ED>"}` を送る（host だけ第2話へ）。参加者はまだ
      第1話 → 動画が**勝手にシークされない**（hold。host の `t=0` へ飛ばされない）。
- [ ] 続いて参加者のタブを第2話 URL（`…/ED…次番号`）へ遷移させる（次話リンク／自動遷移）→ contentKey が一致し、
      数秒以内に host のエピソード位置へ追従する。`<video>` が差し替わっても同期が復帰する。
- [ ] **参加者先行**: 参加者だけ先に第2話へ遷移し、host はまだ第1話（`episode` 未送）→ 参加者は hold
      （第1話の host 位置へ引き戻されない）。その後 `episode` で host を第2話にすると host 位置へ追従する。
- [ ] 遷移直後に一瞬先頭（`t≈0`）付近へ寄っても、後続 heartbeat（≤5s）で正位置に補正される。

> 補足: 参加者の追従は**参加者自身がそのエピソードへ遷移して初めて**起きる（受動方式。システムは参加者を
> 能動的にナビゲートしない）。host の `episode` 送出だけでは参加者は遷移せず hold を続ける。

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
