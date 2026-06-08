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

/**
 * 退出 UI を表示すべきか。セッションが生きている間（接続中・接続済み・切断・ホスト切断）は true。
 * idle と no_room は false：idle は未接続、no_room は content script が自動でセッションを解放して
 * 作成/参加をやり直せる状態に戻すため、ユーザーが押す「退出」は不要。
 */
export function leaveControlsVisible(s: ConnState): boolean {
  return s !== "idle" && s !== "no_room";
}

/** name/room 入力をロックすべきか。セッションが生きている間（退出ボタン表示と1対1）。 */
export function setupFormLocked(s: ConnState): boolean {
  return leaveControlsVisible(s);
}

/**
 * create/join ボタンを無効化すべきか。無効化理由は2つあり、その OR を取る:
 *  - セッション中（setupFormLocked）= 退出するまで作り直せない
 *  - 再生ページ以外（!onPlayer）= 再生状態同期が意味を持たない
 * ボタン disabled の「単一の真実源」とする。
 */
export function actionButtonsDisabled(onPlayer: boolean, s: ConnState): boolean {
  return setupFormLocked(s) || !onPlayer;
}

/**
 * サーバーが WS ルーティングを受理するルームID形式（英数字1〜32文字、worker の
 * `/^\/r\/([A-Za-z0-9]{1,32})$/` と一致）。これ以外（日本語・記号・空白など）で接続すると
 * worker が 404 を返し WS が確立せず「接続中」で固着するため、参加前にここで弾く。
 * 生成IDは8桁の小文字hexだが、サーバー受理範囲に合わせて広めに許可する。
 */
export function isValidRoomId(s: string): boolean {
  return /^[A-Za-z0-9]{1,32}$/.test(s);
}

/**
 * 再生ページ以外の「再生ページで開いてください」案内（showUnavailable）を出すべきか。
 * 再生ページ以外（onPlayer=false）かつセッション未確立のとき true。再生状態の同期は再生ページ
 * （/play/{SID}/{ED}）でしか意味を持たないため。既存セッション中（接続中/接続済み）は案内を出さない。
 * ボタン自体の disabled 判定は actionButtonsDisabled が「単一の真実源」として担う（このフラグは案内の表示ゲート）。
 */
export function shouldShowUnavailable(onPlayer: boolean, status: ConnState): boolean {
  return !onPlayer && !isActiveSession(status);
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
