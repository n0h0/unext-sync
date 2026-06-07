/**
 * U-NEXT の location.pathname から再生中エピソードを一意に識別するキーを導く純粋関数。
 * `/play/{SID}/{ED}` → `"{SID}/{ED}"`。play ページでなければ undefined。
 * SID と ED の両方を含めることで、別シリーズの同一話数番号の衝突を避ける。
 * DOM/OGP に依存せず URL のみから導く（U-NEXT の DOM 構造変更に強い）。
 */
export function deriveContentKey(pathname: string): string | undefined {
  const m = pathname.match(/\/play\/(SID\w+)\/(ED\w+)/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
