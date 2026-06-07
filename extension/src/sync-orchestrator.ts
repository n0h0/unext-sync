import type { StateMessage, SyncEvent, SyncMessage } from "../../shared/protocol";
import { DEFAULTS, isStaleSeq, needsCorrection, projectedHostTime } from "../../shared/sync-core";
import type { ReadableState } from "./video-controller";

export interface OrchestratorControllerLike {
  readState(): ReadableState;
  apply(target: ReadableState, toleranceSec?: number): Promise<void>;
  isApplying(): boolean;
}
export interface OrchestratorClientLike {
  send(msg: SyncMessage): void;
  oneWayLatencySec(): number;
}
export interface OrchestratorDeps {
  role: "host" | "participant";
  controller: OrchestratorControllerLike;
  client: OrchestratorClientLike;
  now: () => number; // monotonic ms（実環境では performance.now）
  localContentKey?: () => string | undefined; // 自分が今どのエピソードを開いているか
}

export class SyncOrchestrator {
  private seq = 0;
  private lastAppliedSeq = -1;
  private lastState: StateMessage | null = null;
  private lastReceiptMs = 0;

  constructor(private deps: OrchestratorDeps) {}

  // ---- ホスト ----
  onMediaEvent(event: SyncEvent): void {
    if (this.deps.role !== "host") return;
    if (this.deps.controller.isApplying()) return; // フィードバック防止
    this.emit(event);
  }

  heartbeat(): void {
    if (this.deps.role !== "host") return;
    this.emit("heartbeat");
  }

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

  // ---- 参加者 ----
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

  async tick(): Promise<void> {
    if (this.deps.role !== "participant" || !this.lastState) return;
    if (!this.contentMatches(this.lastState.contentKey)) return; // 別エピソード中は補正しない
    const expected = this.projected();
    const local = this.deps.controller.readState();
    if (needsCorrection(local.currentTime, expected, DEFAULTS.toleranceSec)) {
      await this.deps.controller.apply(
        {
          playing: this.lastState.playing,
          currentTime: expected,
          playbackRate: this.lastState.playbackRate,
        },
        DEFAULTS.toleranceSec,
      );
    } else if (
      local.playing !== this.lastState.playing ||
      local.playbackRate !== this.lastState.playbackRate
    ) {
      await this.deps.controller.apply(
        {
          playing: this.lastState.playing,
          currentTime: local.currentTime,
          playbackRate: this.lastState.playbackRate,
        },
        DEFAULTS.toleranceSec,
      );
    }
  }

  private projected(): number {
    // biome-ignore lint/style/noNonNullAssertion: projected() is only called when lastState is set
    const s = this.lastState!;
    const elapsedSec = (this.deps.now() - this.lastReceiptMs) / 1000;
    return projectedHostTime(s, this.deps.client.oneWayLatencySec(), elapsedSec);
  }

  // ホストの contentKey が既知かつ自分の現在キーと異なるなら apply を見送る（hold）。
  // 未知（旧ホスト・非 play ページ）なら従来どおり適用する。
  private contentMatches(stateKey: string | undefined): boolean {
    if (stateKey === undefined) return true;
    return stateKey === this.deps.localContentKey?.();
  }
}
