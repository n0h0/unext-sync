# エピソード自動遷移時の同期維持 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** U-NEXT の SPA 話数自動遷移が起きても、エピソード識別子（contentKey）で誤シークを防ぎつつルームの再生同期を維持する。

**Architecture:** URL（`SID/ED`）から導く contentKey を host の `sync` に乗せ、サーバーが `lastState`／`state` に素通しで貫通させる。参加者は自分とホストの contentKey が一致するときだけ状態を適用（不一致は hold）。SPA 遷移で `<video>` が差し替わっても content script は生き続けるので、既存 tick で pathname 変化を検知して `<video>` を再取得・リスナー再バインドし、host は即 heartbeat を送る。同期コアロジック（完全スレーブ・方式C・壁時計非依存・seq 順序）には手を入れない。

**Tech Stack:** TypeScript（strict）, vitest, esbuild, pnpm。正典: `docs/superpowers/specs/2026-06-05-watch-sync-design.md`。本計画の spec: `docs/superpowers/specs/2026-06-07-episode-transition-sync-design.md`。

---

## ファイル構成

| ファイル | 責務 | 種別 |
|---|---|---|
| `extension/src/content-key.ts` | `deriveContentKey(pathname)` 純粋関数。URL から `SID/ED` を導く | 新規 |
| `extension/src/content-key.test.ts` | 上記のユニットテスト | 新規 |
| `shared/protocol.ts` | `SyncMessage`/`StateMessage` に `contentKey?`、`parseClientMessage` で検証・素通し | 修正 |
| `shared/protocol.test.ts` | contentKey の通過・拒否・省略テスト | 修正 |
| `server/src/rooms.ts` | `recordSync` が `contentKey` を `state`/`lastState` にコピー | 修正 |
| `server/rooms.test.ts` | contentKey 貫通＋途中参加テスト | 修正 |
| `extension/src/sync-orchestrator.ts` | `emit` が contentKey 送出、参加者 apply ガード、`localContentKey` 依存 | 修正 |
| `extension/src/sync-orchestrator.test.ts` | 送出・ガード・後方互換・hold 中の lastState 更新テスト | 修正 |
| `extension/src/video-controller.ts` | `setMedia(media)` で内部 `<video>` 参照を差し替え | 修正 |
| `extension/src/video-controller.test.ts` | 差し替え後の read/apply・ガード不変条件テスト | 修正 |
| `extension/src/content.ts` | `localContentKey` 注入・pathname 遷移検知・`<video>` 再バインド・host 即 emit | 修正 |

`extension/src/parse-server.ts` は**変更不要**（`state` は既に `TYPES` にあり、`return o as ServerMessage` で全フィールド素通し。spec §3 参照）。

---

## Task 1: `deriveContentKey` 純粋関数

**Files:**
- Create: `extension/src/content-key.ts`
- Test: `extension/src/content-key.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/content-key.test.ts`:

```ts
import { expect, test } from "vitest";
import { deriveContentKey } from "./content-key";

test("play ページの pathname から SID/ED を導く", () => {
  expect(deriveContentKey("/play/SID0234926/ED00720091")).toBe("SID0234926/ED00720091");
  expect(deriveContentKey("/play/SID0234926/ED00720092")).toBe("SID0234926/ED00720092");
});

test("末尾スラッシュやクエリが付いても SID/ED を導く", () => {
  expect(deriveContentKey("/play/SID0234926/ED00720091/")).toBe("SID0234926/ED00720091");
});

test("別シリーズは別キーになる（SID を含むため衝突しない）", () => {
  expect(deriveContentKey("/play/SID9999999/ED00720091")).toBe("SID9999999/ED00720091");
});

test("play ページでなければ undefined", () => {
  expect(deriveContentKey("/")).toBeUndefined();
  expect(deriveContentKey("/browse/foo")).toBeUndefined();
  expect(deriveContentKey("/play/SID0234926")).toBeUndefined();
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/content-key.test.ts`
Expected: FAIL（`deriveContentKey` が存在しない）

- [ ] **Step 3: 最小実装**

`extension/src/content-key.ts`:

```ts
/**
 * U-NEXT の location.pathname から再生中エピソードを一意に識別するキーを導く純粋関数。
 * `/play/{SID}/{ED}` → `"{SID}/{ED}"`。play ページでなければ undefined。
 * SID と ED の両方を含めることで、別シリーズの同一話数番号の衝突を避ける。
 * DOM/OGP に依存せず URL のみから導く（U-NEXT の DOM 構造変更に強い）。
 */
export function deriveContentKey(pathname: string): string | undefined {
  const m = pathname.match(/\/play\/(SID\w+)\/(ED\w+)/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/content-key.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: コミット**

```bash
git add extension/src/content-key.ts extension/src/content-key.test.ts
git commit -m "feat(extension): deriveContentKey で URL から SID/ED 識別子を導く"
```

---

## Task 2: プロトコルに contentKey を追加

**Files:**
- Modify: `shared/protocol.ts`
- Test: `shared/protocol.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`shared/protocol.test.ts` の末尾に追記:

```ts
test("parses sync with contentKey", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
    contentKey: "SID0234926/ED00720092",
  });
  expect(parseClientMessage(raw)).toMatchObject({
    type: "sync",
    contentKey: "SID0234926/ED00720092",
  });
});

test("rejects sync with non-string contentKey", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
    contentKey: 42,
  });
  expect(parseClientMessage(raw)).toBeNull();
});

test("sync without contentKey is still valid (contentKey undefined)", () => {
  const raw = JSON.stringify({
    v: 1,
    type: "sync",
    event: "play",
    playing: true,
    currentTime: 1,
    playbackRate: 1,
    seq: 1,
  });
  expect(parseClientMessage(raw)).toMatchObject({ type: "sync" });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: FAIL（`rejects sync with non-string contentKey` が null にならず失敗）

- [ ] **Step 3: 実装**

`shared/protocol.ts` の `SyncMessage` に `contentKey?` を追加:

```ts
export interface SyncMessage extends PlaybackFields {
  v: number;
  type: "sync";
  event: SyncEvent;
  contentKey?: string;
}
```

`StateMessage` にも追加:

```ts
export interface StateMessage extends PlaybackFields {
  v: number;
  type: "state";
  event: SyncEvent;
  contentKey?: string;
}
```

`parseClientMessage` の `case "sync"` を差し替え（`contentKey` 検証＋素通しを追加）:

```ts
    case "sync":
      if (!SYNC_EVENTS.includes(o.event) || !isPlayback(o)) return null;
      if (o.contentKey !== undefined && typeof o.contentKey !== "string") return null;
      return {
        v: 1,
        type: "sync",
        event: o.event,
        playing: o.playing,
        currentTime: o.currentTime,
        playbackRate: o.playbackRate,
        seq: o.seq,
        contentKey: o.contentKey,
      };
```

注: `contentKey` 省略時は返り値に `contentKey: undefined` が入るが、vitest の `toEqual` は undefined プロパティを無視するため既存の `parses a valid sync message`（`toEqual`）は壊れない。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run shared/protocol.test.ts`
Expected: PASS（既存＋新規 3 tests）

- [ ] **Step 5: コミット**

```bash
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(protocol): SyncMessage/StateMessage に contentKey を追加"
```

---

## Task 3: サーバーが contentKey を素通し

**Files:**
- Modify: `server/src/rooms.ts:103-111`
- Test: `server/rooms.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/rooms.test.ts` の末尾に追記:

```ts
test("recordSync carries contentKey into state and lastState (late join)", () => {
  const { roomId, hostToken } = rm.create("c1");
  rm.join(roomId, "c1", "host", hostToken);
  const res = rm.recordSync(roomId, "c1", { ...makeSync(1), contentKey: "SID0234926/ED00720092" });
  expect(res.state?.contentKey).toBe("SID0234926/ED00720092");
  // 途中参加者は join が返す lastState 経由で contentKey を受け取る
  const late = rm.join(roomId, "c9", "participant");
  expect(late.lastState?.contentKey).toBe("SID0234926/ED00720092");
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: FAIL（`state.contentKey` が undefined）

- [ ] **Step 3: 実装**

`server/src/rooms.ts` の `recordSync` 内、`state` 構築に `contentKey` を1行追加:

```ts
    const state: StateMessage = {
      v: msg.v,
      type: "state",
      event: msg.event,
      playing: msg.playing,
      currentTime: msg.currentTime,
      playbackRate: msg.playbackRate,
      seq: msg.seq,
      contentKey: msg.contentKey,
    };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run server/rooms.test.ts`
Expected: PASS（既存＋新規 1 test）

- [ ] **Step 5: コミット**

```bash
git add server/src/rooms.ts server/rooms.test.ts
git commit -m "feat(server): recordSync が contentKey を state/lastState に貫通"
```

---

## Task 4: orchestrator の contentKey 送出と参加者ガード

**Files:**
- Modify: `extension/src/sync-orchestrator.ts`
- Test: `extension/src/sync-orchestrator.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/sync-orchestrator.test.ts` の末尾に追記:

```ts
test("host emit: localContentKey の値を SyncMessage.contentKey に乗せる", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host", localContentKey: () => "SID/ED2" });
  o.heartbeat();
  expect(d.sent[0]).toMatchObject({ type: "sync", contentKey: "SID/ED2" });
});

test("host emit: localContentKey 未注入なら contentKey は undefined", () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "host" });
  o.heartbeat();
  expect(d.sent[0].contentKey).toBeUndefined();
});

test("participant: contentKey 不一致なら apply しない（hold）", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => "SID/ED1" });
  await o.onServerState({ ...stateMsg(1, 200), contentKey: "SID/ED2" });
  expect(d.applied).toEqual([]);
});

test("participant: contentKey 一致なら従来どおり apply する", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => "SID/ED2" });
  await o.onServerState({ ...stateMsg(1, 200), contentKey: "SID/ED2" });
  expect(d.applied[0].currentTime).toBe(200);
});

test("participant: state.contentKey が undefined なら従来どおり apply（後方互換）", async () => {
  const d = deps();
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => "SID/ED1" });
  await o.onServerState(stateMsg(1, 200)); // contentKey なし
  expect(d.applied[0].currentTime).toBe(200);
});

test("participant: hold 中も lastState は更新され、一致後の tick が projection で追従", async () => {
  let key = "SID/ED1";
  const d = deps({ latency: 0 });
  const o = new SyncOrchestrator({ ...d, role: "participant", localContentKey: () => key });
  d.setNow(1000);
  // ホストは ep2 にいるが参加者はまだ ep1 → hold（apply されない）
  await o.onServerState({ ...stateMsg(1, 100), contentKey: "SID/ED2" });
  expect(d.applied).toEqual([]);
  // 参加者が ep2 に着地 → tick で最新 lastState から projection して追従
  key = "SID/ED2";
  d.setNow(4000); // 3s 経過 → projected ≈ 103
  await o.tick();
  expect(d.applied.at(-1).currentTime).toBeCloseTo(103, 1);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/sync-orchestrator.test.ts`
Expected: FAIL（contentKey が送出されない／不一致でも apply される）

- [ ] **Step 3: 実装**

`extension/src/sync-orchestrator.ts` の `OrchestratorDeps` に `localContentKey` を追加:

```ts
export interface OrchestratorDeps {
  role: "host" | "participant";
  controller: OrchestratorControllerLike;
  client: OrchestratorClientLike;
  now: () => number; // monotonic ms（実環境では performance.now）
  localContentKey?: () => string | undefined; // 自分が今どのエピソードを開いているか
}
```

`emit` に contentKey 送出を追加（host のみがこの経路を通る）:

```ts
  private emit(event: SyncEvent): void {
    const s = this.deps.controller.readState();
    this.deps.client.send({
      v: 1,
      type: "sync",
      event,
      playing: s.playing,
      currentTime: s.currentTime,
      playbackRate: s.playbackRate,
      seq: ++this.seq,
      contentKey: this.deps.localContentKey?.(),
    });
  }
```

`onServerState` のクラスに、一致判定の private ヘルパを追加（`projected()` の直前あたり）:

```ts
  // ホストの contentKey が既知かつ自分の現在キーと異なるなら apply を見送る（hold）。
  // 未知（旧ホスト・非 play ページ）なら従来どおり適用する。
  private contentMatches(stateKey: string | undefined): boolean {
    if (stateKey === undefined) return true;
    return stateKey === this.deps.localContentKey?.();
  }
```

`onServerState` に、bookkeeping の後・apply の前にガードを挿入:

```ts
  async onServerState(msg: StateMessage): Promise<void> {
    if (this.deps.role !== "participant") return;
    if (isStaleSeq(msg.seq, this.lastAppliedSeq)) return;
    this.lastAppliedSeq = msg.seq;
    this.lastState = msg;
    this.lastReceiptMs = this.deps.now();
    if (!this.contentMatches(msg.contentKey)) return; // hold: bookkeeping 済み、apply のみ見送り
    const expected = this.projected();
    const tol = msg.event === "heartbeat" ? DEFAULTS.toleranceSec : 0;
    await this.deps.controller.apply(
      {
        playing: msg.playing,
        currentTime: expected,
        playbackRate: msg.playbackRate,
      },
      tol,
    );
  }
```

`tick` の先頭にもガードを挿入:

```ts
  async tick(): Promise<void> {
    if (this.deps.role !== "participant" || !this.lastState) return;
    if (!this.contentMatches(this.lastState.contentKey)) return; // 別エピソード中は補正しない
    const expected = this.projected();
    const local = this.deps.controller.readState();
    // ...（以降は既存のまま）
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/sync-orchestrator.test.ts`
Expected: PASS（既存＋新規 6 tests）

- [ ] **Step 5: コミット**

```bash
git add extension/src/sync-orchestrator.ts extension/src/sync-orchestrator.test.ts
git commit -m "feat(orchestrator): host が contentKey を送出し、参加者は不一致時 hold"
```

---

## Task 5: VideoController.setMedia で `<video>` 差し替え

**Files:**
- Modify: `extension/src/video-controller.ts`
- Test: `extension/src/video-controller.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`extension/src/video-controller.test.ts` の末尾に追記:

```ts
test("setMedia 差し替え後は read が新 media を指す", () => {
  const m1 = fakeMedia({ currentTime: 10, paused: true });
  const m2 = fakeMedia({ currentTime: 50, paused: false });
  const c = new VideoController(m1);
  c.setMedia(m2);
  expect(c.readState()).toEqual({ playing: true, currentTime: 50, playbackRate: 1 });
});

test("setMedia 後の apply は新 media を操作し、ガード不変条件を維持", async () => {
  const m1 = fakeMedia();
  const m2 = fakeMedia({ paused: true });
  const c = new VideoController(m1);
  c.setMedia(m2);
  const p = c.apply({ playing: true, currentTime: 7, playbackRate: 1 });
  expect(c.isApplying()).toBe(true); // ガードは同期的に立つ
  await p;
  expect(m2.currentTime).toBe(7);
  expect(m2.play).toHaveBeenCalled();
  expect(m1.play).not.toHaveBeenCalled(); // 旧 media は触らない
  expect(c.isApplying()).toBe(false);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm vitest run extension/src/video-controller.test.ts`
Expected: FAIL（`setMedia` が存在しない）

- [ ] **Step 3: 実装**

`extension/src/video-controller.ts` の `VideoController` クラスに `setMedia` を追加（`readState` の直前など）:

```ts
  /** SPA 話数遷移で <video> 要素が差し替わったとき、内部参照を新要素に切り替える。 */
  setMedia(media: MediaLike): void {
    this.media = media;
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run extension/src/video-controller.test.ts`
Expected: PASS（既存＋新規 2 tests）

- [ ] **Step 5: コミット**

```bash
git add extension/src/video-controller.ts extension/src/video-controller.test.ts
git commit -m "feat(video-controller): setMedia で <video> 参照を差し替え可能に"
```

---

## Task 6: content.ts で遷移検知・再バインド・localContentKey 注入

DOM 結合のため単体テストは置かず、`tsc` と拡張ビルドで検証する（pathname 検知・`<video>` 再取得は spec §9 の実機 E2E で確認）。

**Files:**
- Modify: `extension/src/content.ts`

- [ ] **Step 1: import を追加**

`extension/src/content.ts` の import 群に追加:

```ts
import { deriveContentKey } from "./content-key";
```

- [ ] **Step 2: orchestrator deps に localContentKey を注入**

`orchestrator = new SyncOrchestrator({ ... })`（現状 172-177 行）を差し替え:

```ts
  orchestrator = new SyncOrchestrator({
    role: session.role,
    controller,
    client,
    now: () => performance.now(),
    localContentKey: () => deriveContentKey(location.pathname),
  });
```

- [ ] **Step 3: role 別のリスナー＋heartbeat ブロックを再バインド対応版に差し替える**

現状の「ホスト：mediaイベント送出＋heartbeat」から始まる `if (session.role === "host") { ... } else { ... }` ブロック（現状 197-223 行）を、以下で**丸ごと置き換える**:

```ts
  // ---- SPA 話数遷移に追従するための <video> 再バインド機構 ----
  // 起動時の要素を握りっぱなしにせず、遷移で差し替わったら付け替える。
  let currentVideo = video;
  let lastPathname = location.pathname;

  // ホスト heartbeat：timeupdate 駆動を主、setInterval を従に（バックグラウンドのタイマースロットリング対策）。
  let lastBeat = 0;
  const beat = () => {
    const t = performance.now();
    if (t - lastBeat >= DEFAULTS.heartbeatMs) {
      lastBeat = t;
      orchestrator.heartbeat();
    }
  };

  // 要素非依存の安定リスナー束（再バインドで付け外しするため参照を保持する）。
  const eventMap: Record<string, SyncEvent> = { seeked: "seek" };
  const mediaListeners: Array<[string, () => void]> =
    session.role === "host"
      ? [
          ...["play", "pause", "seeked", "ratechange"].map(
            (dom) =>
              [dom, () => orchestrator.onMediaEvent(eventMap[dom] ?? (dom as SyncEvent))] as [
                string,
                () => void,
              ],
          ),
          ["timeupdate", beat] as [string, () => void],
        ]
      : ["seeking", "play", "pause"].map(
          (dom) =>
            [
              dom,
              () => {
                if (!controller.isApplying()) void orchestrator.tick();
              },
            ] as [string, () => void],
        );

  const bindListeners = (el: HTMLVideoElement) => {
    for (const [type, fn] of mediaListeners) el.addEventListener(type, fn);
  };
  const unbindListeners = (el: HTMLVideoElement) => {
    for (const [type, fn] of mediaListeners) el.removeEventListener(type, fn);
  };
  bindListeners(currentVideo);

  // 遷移検知は1箇所に集約。各 tick から呼ぶ（host は beat、participant は orchestrator.tick と並走）。
  let navigating = false;
  const maybeHandleNavigation = async () => {
    if (navigating || location.pathname === lastPathname) return;
    navigating = true;
    lastPathname = location.pathname;
    try {
      // 同一要素の src 差し替えなら即座に取得、要素ごと差し替えなら新要素の出現を待つ。
      const next = await waitForVideo();
      if (next !== currentVideo) {
        unbindListeners(currentVideo);
        controller.setMedia(next);
        bindListeners(next);
        currentVideo = next;
      }
      // 新 contentKey＋新 currentTime で即時通知し、ズレ窓を最小化する（host のみ）。
      if (session.role === "host") orchestrator.heartbeat();
    } finally {
      navigating = false;
    }
  };

  if (session.role === "host") {
    setInterval(() => {
      beat();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
  } else {
    setInterval(() => {
      void orchestrator.tick();
      void maybeHandleNavigation();
    }, DEFAULTS.heartbeatMs);
  }
```

注: `waitForVideo` は既存要素があれば即 resolve（observer を作らない）ため、遷移ごとに呼んでもリークしない。同一要素再利用なら `next === currentVideo` で再バインドをスキップし、host のみ即 emit する。

- [ ] **Step 4: 型チェックが通ることを確認**

Run: `pnpm tsc --noEmit`
Expected: エラーなし（特に未使用変数 `eventMap`/`beat` がない＝`noUnusedLocals` を満たす。両者とも mediaListeners 経由で使用される）

- [ ] **Step 5: 全テストと Lint を確認**

Run: `pnpm test && pnpm check`
Expected: 全テスト PASS、Biome の lint/format/import に違反なし

- [ ] **Step 6: 拡張がビルドできることを確認**

Run: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`
Expected: `dist/extension` に成功出力（ビルドエラーなし）

- [ ] **Step 7: コミット**

```bash
git add extension/src/content.ts
git commit -m "feat(content): 話数遷移を検知し <video> 再バインド・host 即 emit・localContentKey 注入"
```

---

## 完了条件の最終確認

- [ ] `pnpm test` 全 PASS（新規: content-key 4・protocol 3・rooms 1・orchestrator 6・video-controller 2）
- [ ] `pnpm tsc --noEmit` エラーなし
- [ ] `pnpm biome ci .` 違反なし
- [ ] 拡張ビルド成功

## 実機 E2E（spec §9・本計画のユニット範囲外、別途）

`docs/e2e-pseudo-host-testing.md` の擬似ホスト方式を流用し、以下を確認する:

- ホスト先行: host が ep2 へ自動遷移 → 参加者は ep1 を最後まで再生 → 自動遷移で ep2 着地 → ホスト位置へ追従（誤シークなし）。
- 参加者先行: 参加者が ep2 へ先行 → hold → host が ep2 着地でホスト位置へ引き戻し。
- `<video>` が「同一要素 src 差し替え」か「要素ごと差し替え」かを実機で確認し、再バインドが両方で機能すること。
- 遷移直後の emit で `currentTime≈0` になっても後続 heartbeat（≤5s）が正位置に補正すること。
