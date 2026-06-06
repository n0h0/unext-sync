/** RFC 7230 token のうち、hex と base64url を許容する安全な部分集合。
 *  Sec-WebSocket-Protocol に載せる値はこの文字種でなければ
 *  ブラウザの new WebSocket(url, [secret]) が SyntaxError を投げる。 */
export const TOKEN_SAFE_RE = /^[A-Za-z0-9_-]+$/;

export function isTokenSafe(value: string): boolean {
  return TOKEN_SAFE_RE.test(value);
}
