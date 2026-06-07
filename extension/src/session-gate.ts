/**
 * セッションのライフサイクル管理。content script が WS 接続・タイマー・オブザーバ等の副作用を
 * 1セッションにまとめて確実に解放するためのゲート。さらに connecting 中（start() の await
 * 中断中）に退出されても、再開した start() が abort を検知して生きたセッションを復活させない
 * ようにする（spec: 2026-06-08-room-leave-design.md §2）。
 *
 * - begin(): 新しい世代のセッションを開始する（直前の世代は無効化＝aborted() が true になる）。
 * - Session.add(): 解放処理を登録する（リソース生成のたびに即登録する）。
 * - Session.aborted(): 自分の世代が現行でなくなったら true（await 直後に確認し早期 return する）。
 * - Session.dispose(): 登録済み解放処理を LIFO で1回ずつ実行する（冪等）。
 * - end(): 現行セッションを abort し、登録済み解放処理を実行する（退出時に呼ぶ）。
 * - 呼び出し側の責務: `aborted()` が true になったら `dispose()` を呼ぶこと。`begin()` は前の
 *   セッションの disposers を自動解放しない（連続 begin で古い disposers は破棄され呼ばれない）。
 */
export interface Session {
  aborted(): boolean;
  add(dispose: () => void): void;
  dispose(): void;
}

export interface SessionGate {
  begin(): Session;
  end(): void;
}

export function makeSessionGate(): SessionGate {
  let gen = 0;
  let currentDisposers: Array<() => void> | null = null;

  return {
    begin(): Session {
      const myGen = ++gen;
      const disposers: Array<() => void> = [];
      currentDisposers = disposers;
      return {
        aborted: () => myGen !== gen,
        add: (dispose) => disposers.push(dispose),
        dispose: () => {
          while (disposers.length) disposers.pop()?.();
        },
      };
    },
    end(): void {
      gen++; // 現行セッションの aborted() を true にする
      if (currentDisposers) {
        while (currentDisposers.length) currentDisposers.pop()?.();
        currentDisposers = null;
      }
    },
  };
}
