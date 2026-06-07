/** WSリレーサーバーのURLか判定する。
 *  ブラウザの new WebSocket(url, ...) は ws:// / wss:// 以外で TypeError を投げるため、
 *  ビルド時・モジュール読込時に早期に弾いて原因を明示する。 */
export function isWsUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "ws:" || u.protocol === "wss:";
}
