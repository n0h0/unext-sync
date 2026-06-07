/** RFC 7230 token のうち、hex と base64url を許容する安全な部分集合。
 *  Sec-WebSocket-Protocol に載せる値はこの文字種でなければ
 *  ブラウザの new WebSocket(url, [secret]) が SyntaxError を投げる。 */
export const TOKEN_SAFE_RE = /^[A-Za-z0-9_-]+$/;

export function isTokenSafe(value: string): boolean {
  return TOKEN_SAFE_RE.test(value);
}

/** Node/Workers 共通の定数時間比較。presented が非 token-safe／長さ不一致なら false。 */
export function constantTimeEqual(presented: string, expected: string): boolean {
  if (!isTokenSafe(presented)) return false;
  const enc = new TextEncoder();
  const a = enc.encode(presented);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
