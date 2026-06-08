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

/**
 * <video>要素（MediaLike）への状態読み書きを担う。
 * apply中は isApplying() が true になり、呼び出し側が自分のイベント送出を抑止できる
 * （フィードバックループ防止＝spec §5）。
 */
// apply 完了後も自己イベントを抑止し続ける既定の沈静化時間（ms）。programmatic な seek の
// seeked は実機で数百ms 遅れて dispatch されるため、これより短いと自己イベントを取りこぼす。
const DEFAULT_SETTLE_MS = 400;

export class VideoController {
  private applyDepth = 0;
  private settleUntil = 0;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly onPlayRejected: () => void;
  constructor(
    private media: MediaLike,
    opts: { now?: () => number; settleMs?: number; onPlayRejected?: () => void } = {},
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
        } catch {
          // autoplay/NotAllowed: drift loop が再試行するが、ユーザー操作が必要な場合は
          // 永続的に reject し続け参加者が再生開始できない。呼び出し側に通知して可視化する。
          this.onPlayRejected();
        }
      } else if (!target.playing && !this.media.paused) {
        this.media.pause();
      }
    } finally {
      this.applyDepth--;
      if (this.applyDepth === 0) this.settleUntil = this.now() + this.settleMs;
    }
  }
}
