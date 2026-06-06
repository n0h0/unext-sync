import { timingSafeEqual } from "node:crypto";
import { isTokenSafe } from "../../shared/secret";

/** クライアント提示シークレットが期待値と一致するか定数時間で判定。
 *  - presented が undefined/空/非token-safe なら false
 *  - 長さが違えば timingSafeEqual を呼ばず false（例外回避） */
export function checkConnectSecret(
  presented: string | undefined,
  expected: string,
): boolean {
  if (!presented || !isTokenSafe(presented)) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
