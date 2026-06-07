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
