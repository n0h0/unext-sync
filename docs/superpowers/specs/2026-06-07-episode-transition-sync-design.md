# エピソード自動遷移時の同期維持 設計仕様書

作成日: 2026-06-07

## 0. 位置づけ

`docs/superpowers/specs/2026-06-05-watch-sync-design.md`（正典）の同期メカニズム（完全スレーブ・方式C・壁時計非依存）の上に乗る拡張。U-NEXT が TV シリーズ視聴中に**次エピソードへ自動遷移**したとき（URL が `/play/SID.../ED00720091` → `/play/SID.../ED00720092` に変わる）、ルームの同期が壊れず維持されるようにする。

正典の同期ロジック（`shared/sync-core.ts` の純粋関数群、`seq` 順序保証、ドリフト補正）には**手を加えない**。本仕様は (1) 同期状態に「どのエピソードか」という識別子を足し、(2) SPA 遷移で `<video>` 要素を取り直す、の2点を追加するだけである。

視聴中タイトル表示（`2026-06-07-watching-title-design.md`）とは**別概念・別路**。タイトルは表示用、本仕様の contentKey は同期ガード用であり、相乗りしない。

## 1. 問題

現状の同期は **currentTime ベースのみ**で、「どのエピソードを再生しているか」という概念がない（`shared/protocol.ts` の `PlaybackFields` にエピソード識別子がない）。エピソードはクライアントごとに独立して自動遷移するため、遷移のズレ時間帯に次の破綻が起きる:

- ホストが ep2 の `t=5s`、参加者がまだ ep1 の `t=1420s`。ホストが送る `currentTime=5` を参加者が受けると、**ep1 の 5秒へ誤シーク**してしまう（同じ数値が別コンテンツの別位置を指す）。

加えて、content script は `start()` の `started` ガードで一度だけ起動し、**起動時に取得した `<video>` 要素への参照を保持**し続ける（`extension/src/content.ts`）。SPA 遷移で要素が差し替わると、古い参照・古いリスナーのまま同期が静かに壊れる可能性がある。

## 2. 確定事項（ブレインストーミングでの決定）

| 論点 | 決定 |
|---|---|
| 遷移方式 | **SPA（リロードなし）**。URL は History API で差し替わり、content script・WS接続・メモリ上のセッションは生き続ける。`<video>` は src 差し替えか要素ごと入れ替わるかは不定（両方に備える） |
| 追従レベル | **受動**。参加者を能動的にナビゲートしない。各自の U-NEXT 自動遷移に任せ、システムは「遷移のズレ時間帯の誤シーク防止」と「両者が同じ ep に揃ったら同期再開」だけを担う。正典の「参加者の自動タイトル遷移は対象外」に沿う |
| エピソード識別 | URL（`SID/ED`）から導く **contentKey** を同期状態に乗せ、参加者は**自分とホストの contentKey が一致するときだけ**状態を適用する |
| 遷移検知 | 既存 tick（`setInterval(heartbeatMs)`）に `location.pathname` チェックを相乗り（案A）。即時検知の精密化（history パッチ等）は不採用 ― contentKey ガードが遅延の実害を消すため |
| `seq` | SPA で orchestrator が生き続けるため**リセットされない**。フルリロード時の seq リセット問題（正典 §11）はこの経路では発生しない |

## 3. エピソード識別子（contentKey）

### 純粋関数 `deriveContentKey(pathname): string | undefined`（`extension/src/content-key.ts`）

`location.pathname` から再生中エピソードを一意に識別するキーを導く。プラットフォーム非依存の純粋関数として切り出し、TDD 対象とする。

- play ページ `/play/{SID}/{ED}` にマッチしたら `"{SID}/{ED}"`（例 `"SID0234926/ED00720092"`）を返す。
- play ページでない（マッチしない）場合は `undefined`。
- SID と ED の両方を含めることで、別シリーズの同一話数番号の衝突を避ける。

DOM セレクタや OGP には依存せず URL のみから導く（U-NEXT の DOM 構造変更に強い）。

### プロトコル拡張（`shared/protocol.ts`）

- `SyncMessage` と `StateMessage` に **`contentKey?: string`**（オプショナル）を追加する。`PlaybackFields` には足さない ― 同期数値（play/seek/rate）とは別概念であり、順序判定（`seq`）にも使わないため、明確に分離する。
- `parseClientMessage` の `sync` 分岐で、`contentKey` が存在する場合のみ `typeof === "string"` を検証して通す。省略可。`isPlayback` は変更しない。
- オプショナルにすることで、旧ホスト（contentKey を送らない）に対し参加者が**従来どおり常時適用**へ後方互換に劣化する。

### サーバー素通し（`server/src/rooms.ts`）

- `recordSync` の `state` 構築時に `contentKey: msg.contentKey` を1行コピーする。サーバーは contentKey の**中身を一切解釈しない**（ルーム/ホストの判定に使わない）。
- `rooms.ts` は `ws` 非依存・副作用注入の不変条件を維持する（正典 §設計上の不変条件 2）。contentKey は素通しのみ。
- **途中参加（late join）にも自動で届く**: `recordSync` が `contentKey` を `room.lastState` に格納するため、`join` が返す `lastState`（`rooms.ts:88,91,93`）にも乗り、途中参加者は最初の `state` で即座にホストの contentKey を得る。別途の配線は不要。

### 受信側パーサは変更不要（`extension/src/parse-server.ts`）

`state` は新メッセージ型ではなく**既存型へのフィールド追加**である。`parseServerMessageLoose` は `state` を既に `TYPES` に含み、検証後 `return o as ServerMessage` で**全フィールドを素通し**する（`parse-server.ts:24-25`）ため、`contentKey` はそのまま `StateMessage` に届く。メモリにある「新 Server→Client 型は `parse-server.ts` の `TYPES` に追加しないと黙って破棄」の gotcha は**今回は該当しない**（型を増やさないため）。将来この loose parser を厳格化する場合は `contentKey` の通過を維持すること。

## 4. ホスト送出と参加者ガード（`extension/src/sync-orchestrator.ts`）

orchestrator は DOM 非依存を維持する。参加者自身の現在 contentKey は**依存注入**で渡す。

- `OrchestratorDeps` に `localContentKey?: () => string | undefined` を追加。content.ts が `() => deriveContentKey(location.pathname)` を渡す。この依存は role 非依存で host/participant 双方に注入されるが、**送出するのは host の `emit()` のみ**、**比較に使うのは participant のガードのみ**。

### ホスト送出（`emit()`）

- `emit()`（`sync-orchestrator.ts:41-52`）が `this.deps.localContentKey?.()` を読み、送信する `SyncMessage` の `contentKey` に乗せる。これがないと送信 `contentKey` が常に `undefined` となり、サーバーがコピーするのも `undefined`、参加者は常に「従来どおり適用」へ落ちて**誤シーク防止が一切働かない**（＝本機能が無効化される）。`emit()` への追記が本機能の根幹。
- participant では `localContentKey` を送出に使わない（`emit()` 自体が host 専用経路）。

### 参加者ガード
- `onServerState` / `tick` で、**`controller.apply` の呼び出しだけをゲート**する:
  - ホストの `msg.contentKey`（または `lastState.contentKey`）が**既知**かつ参加者の `localContentKey()` と**異なる**なら → **apply をスキップ（hold）**。
  - contentKey が `undefined`（旧ホスト・非 play ページ等）なら → 従来どおり適用。
- ガードは apply のみ。`lastState`・`lastReceiptMs`・`lastAppliedSeq` の記録（`isStaleSeq` 判定含む）は**通常どおり続ける**。これにより、参加者の video が後から同じ ep に着地したとき、次の `tick()` が最新ホスト状態から正しく projection して追従できる。

### 挙動（両ケース）

- **ホスト先行**（host=ep2, 参加者=ep1）: 参加者は hold → ep1 を最後まで再生 → 自身の自動遷移で ep2 着地 → contentKey 一致 → 次 tick でホスト位置へ追従。
- **参加者先行**（参加者=ep2, host=ep1）: 参加者は hold → ep2 を自由再生 → ホストが ep2 着地で一致 → ホスト位置へ引き戻し（**小さな巻き戻しは許容**＝完全スレーブの帰結）。

いずれも誤シーク（別エピソードへの seek）は発生しない。

## 5. `<video>` 再バインド（`extension/src/content.ts`・`video-controller.ts`）

起動時に捕捉した `video` const を直接握り続ける構造をやめ、現在の `<video>`＋付随リスナーを**差し替え可能**にする。

- `VideoController` に `setMedia(newEl: MediaLike): void` を追加し、内部参照を差し替えられるようにする（`apply` ガードの不変条件は維持）。
- content.ts に、現在の `<video>` と付随リスナー（host: `play`/`pause`/`seeked`/`ratechange`/`timeupdate`、participant: `seeking`/`play`/`pause`）を束ねて再バインドできる小さな束ね役を置く。
- 遷移検知ロジックは**1箇所に集約**する（pathname の前回値を1つ持ち、変化したら下記を実行する単一の関数）。tick の実体は role で異なる（host は `beat`＝`content.ts:206-214` の timeupdate+setInterval、participant は `orchestrator.tick`＝`content.ts:217`）ので、検知関数をそれぞれの tick から呼ぶ形にし、検知本体は二重化させない。
- 検知したら:
  1. `<video>` を再取得する（`waitForVideo` 同様の MutationObserver で新要素の出現を待つ。同一要素の src 差し替えなら即座に取得できる）。
  2. 旧要素と**異なる**ならリスナーを再バインド（古いリスナーは除去）。**同一**なら `setMedia` 更新（または何もしない）。
  3. **host は即 heartbeat を emit**（新 contentKey＋新 currentTime でズレ窓を最小化）。
- **role 別の責務差**:
  - **participant**: `localContentKey` は `location.pathname` をライブに読む関数なので、**ガード自体に pathname 変化検知は不要**。検知が必要なのは `<video>` 再バインドのためだけ。
  - **host**: 再バインドに加え、**新 contentKey での即 emit** のために検知が必要。
- host のみ、既存の `<title>` MutationObserver（視聴中タイトル用）を遷移トリガーとして併用してよい（emit 遅延の追加短縮）。ただし**正しさは pathname チェックが単独で担保**し、title Observer は任意の前倒し最適化に留める。両者が同じ再取得関数を呼ぶようにし、検知点が分散しても処理本体は集約された1箇所を通す。
- `seq` は遷移でリセットしない（orchestrator が生き続ける）。参加者の `lastAppliedSeq` も継続。

## 6. 不変条件の維持（正典 §設計上の不変条件）

1. **壁時計の引き算なし**: contentKey は順序判定に使わず単なる一致比較。projection は従来どおり monotonic クロック。
2. **`rooms.ts` は `ws` 非依存**: contentKey は素通しのみ。新しい状態ロジックを増やさない。
3. **完全スレーブ**: ホストは全状態スナップショット（＋contentKey）を送り、参加者はリコンサイルするだけ。差分は送らない。
4. **フィードバックループ防止**: 再バインド後のリスナーにも `isApplying()` ガードを適用する。
5. **WS 接続は content script が持つ**: 変更なし。

## 7. テスト（TDD）

- `deriveContentKey`（純粋関数）: play URL／別 SID／非 play ページ（undefined）／末尾スラッシュ等のバリエーション。
- `sync-orchestrator`: 
  - **`emit()` が `localContentKey()` の値を送信 `SyncMessage.contentKey` に乗せる**（クリティカル指摘の回帰テスト。`client.send` のスパイで検証する純粋ユニットテスト）。`localContentKey` 未注入なら `contentKey` は `undefined` で送る。
  - contentKey 不一致で `apply` が呼ばれない。
  - contentKey 一致で従来どおり `apply` される。
  - `contentKey` が `undefined`（注入なし／ホスト未送出）で従来どおり適用される（後方互換）。
  - hold 中も `lastState`・`lastReceiptMs`・`lastAppliedSeq` が更新され、一致後の `tick` が最新状態から projection する。
- `video-controller`: **`setMedia` 差し替え後**に `readState`／`apply` が新 `MediaLike` に向く。`apply` ガード（`isApplying()`）の不変条件が差し替え後も維持される（`MediaLike` 注入で完全にユニットテスト可能）。
- `protocol`: `parseClientMessage` が `contentKey` を通す／非 string を弾く／省略を許す。`StateMessage` 型に乗る。
- `rooms`: `recordSync` が `msg.contentKey` を `state` に乗せる。`lastState` 経由で `join` の戻り（途中参加）にも乗る。

pathname 変化検知と `<video>` 再取得は DOM 結合で E2E 寄りのため実機検証（§9）に回すが、`emit` 送出・ガード・`setMedia` は単体で書けるので TDD 対象に含める。

## 8. スコープ外（今回やらない）

- **参加者の能動的ナビゲート**（受動方式に確定。正典「参加者の自動タイトル遷移は対象外」を維持）。
- **フルリロード復帰・ホスト永続化**（正典 §11 の既知制約のまま。本仕様は SPA 遷移のみ対象）。
- **視聴中タイトル表示の変更**（既存のまま。contentKey とは別路）。
- **シリーズ完走後（最終話の次がない）や別作品への遷移**の特別扱い。contentKey 不一致 → hold で安全側に倒れる（誤シークしない）以上の制御はしない。

## 9. 既知の制約・留意点

- `<video>` が「同一要素 src 差し替え」か「要素ごと入れ替え」かは未確定。§5 はどちらでも動くよう防御的に書く（差分検出で再バインド要否を判断）。実 E2E で確認する。
- 遷移検知は最大 heartbeat 分（既定〜5s）遅れうるが、その間 contentKey 不一致で参加者は hold するため**誤シークは起きない**。揃うまで各自の再生が続くだけ。
- 参加者先行時の小さな巻き戻しは完全スレーブの設計上の帰結として許容する（§4）。
- **遷移直後の即 emit は `currentTime` が0付近になりうる**（新 `<video>` が未ロード）。だが contentKey が新しいので ep1 参加者は hold、ep2 着地済み参加者は後続 heartbeat（≤5s）で正位置に補正されるため実害は小さい。「揃った瞬間に一旦先頭近くへ、直後に正位置へ」という二段になりうる点だけ留意する。
