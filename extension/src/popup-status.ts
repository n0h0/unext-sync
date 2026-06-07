import type { RosterEntry } from "../../shared/protocol";

export type ConnState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "host_gone"
  | "no_room";

export function renderStatusLabel(s: ConnState): string {
  switch (s) {
    case "idle":
      return "未接続";
    case "connecting":
      return "接続中";
    case "connected":
      return "接続済み";
    case "disconnected":
      return "切断";
    case "host_gone":
      return "ホスト切断";
    case "no_room":
      return "ルームが存在しません";
  }
}

/**
 * サーバーイベント（content script が server_event として転送する ServerMessage の type）を
 * 次のステータスへ写像する。該当しないイベント（pong 等）は null＝表示変更なし。
 * `joined` を含めることで、参加者が参加成功しても「接続中」のまま固まる表示ギャップを防ぐ。
 */
export function nextStateForServerEvent(event: string): ConnState | null {
  switch (event) {
    case "joined":
    case "host_resumed":
    case "host_taken": // host枠が埋まっていた場合の participant フォールバック
      return "connected";
    case "host_disconnected":
      return "host_gone";
    case "no_room":
      return "no_room";
    default:
      return null;
  }
}

/** 接続中／接続済みなら true。再度の参加・作成ボタンで表示を巻き戻さない判定に使う。 */
export function isActiveSession(s: ConnState): boolean {
  return s === "connecting" || s === "connected";
}

/** セッションが存在する間（idle 以外）だけ退出 UI を表示する。再接続中・切断中・ホスト切断・
 *  ルーム不在のいずれでも退出（＝停止）できるべきなので idle のみ false。 */
export function leaveControlsVisible(s: ConnState): boolean {
  return s !== "idle";
}

export function rosterHeader(entries: RosterEntry[]): string {
  return `参加者 (${entries.length})`;
}

/** ロスター1行の表示文字列。XSS回避のため呼び出し側は textContent で描画すること。 */
export function formatRosterLine(entry: RosterEntry, selfId: string | null): string {
  const crown = entry.host ? "👑 " : "";
  const you = selfId !== null && entry.id === selfId ? " (あなた)" : "";
  const offline = entry.connected ? "" : " (切断)";
  return `${crown}${entry.name}${you}${offline}`;
}

/**
 * content script に到達できない（＝U-NEXTの再生ページ以外で popup を開いた）ときの案内文。
 * このページでは作成／参加が機能しないことをユーザーに伝える。
 */
export function unavailableNotice(): string {
  return "⚠️ U-NEXTの再生ページ（video.unext.jp）で開いてください。";
}

/**
 * 視聴中タイトルの表示文字列。title が null/空なら null（行を描画しない）。
 * XSS回避のため呼び出し側は textContent で描画すること。
 */
export function renderWatchingTitle(title: string | null): string | null {
  if (!title) return null;
  return `🎬 視聴中: ${title}`;
}
