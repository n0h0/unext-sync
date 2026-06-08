export interface MediaLike {
  currentTime: number;
  playbackRate: number;
  paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ReadableState {
  playing: boolean;
  currentTime: number;
  playbackRate: number;
}

// apply 完了後も自己イベントを抑止し続ける既定の沈静化時間（ms）。programmatic な seek の
// seeked は実機で数百ms 遅れて dispatch されることがある（経験則。本リポジトリ内に実測の
// 裏付けはない）ため、これより短いと自己イベントを取りこぼしうる。
const DEFAULT_SETTLE_MS = 400;

/**
 * <video>要素（MediaLike）への状態読み書きを担う。
 * apply 実行中、および完了後 settleMs の沈静化ウィンドウ中は isApplying() が true になり、
 * 呼び出し側が自分のイベント送出を抑止できる（フィードバックループ防止＝spec §5）。
 *
 * opts の now / settleMs は決定的テストのためのペア注入を想定する（片方だけ注入すると
 * 既定 settleMs=400ms が注入クロックに対して走り、紛らわしい挙動になる点に注意）。
 */

export class VideoController {
  private applyDepth = 0;
  private settleUntil = 0;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly onPlayRejected: (err: unknown) => void;
  constructor(
    private media: MediaLike,
    opts: { now?: () => number; settleMs?: number; onPlayRejected?: (err: unknown) => void } = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    this.onPlayRejected = opts.onPlayRejected ?? (() => {});
  }

  readState(): ReadableState {
    return {
      playing: !this.media.paused,
      currentTime: this.media.currentTime,
      playbackRate: this.media.playbackRate,
    };
  }

  // apply 実行中（同期区間）に加え、完了後 settleMs の沈静化ウィンドウ中も true を返す。
  // apply が引き起こす seeking/seeked/play/pause は次のマクロタスクで非同期 dispatch される
  // ため、同期フラグだけでは取りこぼす（フィードバックループ防止＝spec §5）。
  isApplying(): boolean {
    return this.applyDepth > 0 || this.now() < this.settleUntil;
  }

  /** SPA 話数遷移で <video> 要素が差し替わったとき、内部参照を新要素に切り替える。 */
  setMedia(media: MediaLike): void {
    this.media = media;
  }

  async apply(target: ReadableState, toleranceSec = 0): Promise<void> {
    this.applyDepth++;
    try {
      if (Math.abs(this.media.currentTime - target.currentTime) > toleranceSec) {
        this.media.currentTime = target.currentTime;
      }
      if (this.media.playbackRate !== target.playbackRate) {
        this.media.playbackRate = target.playbackRate;
      }
      if (target.playing && this.media.paused) {
        try {
          await this.media.play();
        } catch (err) {
          // autoplay/NotAllowed 等で再生不可。drift loop が再試行するが、ユーザー操作が
          // 必要な NotAllowedError や回復不能エラーを無音化しないよう呼び出し側へ通知する。
          // failsafe 経路なので、通知側が投げても apply を巻き込まない（二重 failure 防止）。
          try {
            this.onPlayRejected(err);
          } catch {
            /* 通知の失敗で apply を壊さない */
          }
        }
      } else if (!target.playing && !this.media.paused) {
        this.media.pause();
      }
    } finally {
      this.applyDepth--;
      // 最外 apply の完了時にだけ沈静化ウィンドウを開く。ネスト/並行 apply 中は applyDepth>0 が
      // isApplying() を支配し、最後に完了した apply が最大の settleUntil を書くため、このガードは
      // 防御的・意図表明であり振る舞いは無条件代入と等価（除去しても挙動は変わらない）。
      if (this.applyDepth === 0) this.settleUntil = this.now() + this.settleMs;
    }
  }
}
