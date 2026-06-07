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
export class VideoController {
  private applying = false;
  constructor(private media: MediaLike) {}

  readState(): ReadableState {
    return {
      playing: !this.media.paused,
      currentTime: this.media.currentTime,
      playbackRate: this.media.playbackRate,
    };
  }

  isApplying(): boolean {
    return this.applying;
  }

  /** SPA 話数遷移で <video> 要素が差し替わったとき、内部参照を新要素に切り替える。 */
  setMedia(media: MediaLike): void {
    this.media = media;
  }

  async apply(target: ReadableState, toleranceSec = 0): Promise<void> {
    this.applying = true;
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
          /* autoplay/NotAllowed: ignore, drift loop will retry */
        }
      } else if (!target.playing && !this.media.paused) {
        this.media.pause();
      }
    } finally {
      this.applying = false;
    }
  }
}
