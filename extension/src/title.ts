/**
 * U-NEXT の document.title を表示用に浄化する純粋関数。
 * - 「… | U-NEXT…」「…｜U-NEXT…」のブランドサフィックスを除去（半角/全角パイプ両対応）
 * - ブランド名のみ（トップ/ブラウズ画面など）は作品なしとみなして空文字
 * - trim し、連続空白（全角含む）を半角スペース1つに圧縮
 * U-NEXT 以外のパイプ（例「作品名 | 第2期」）は残す。
 */
export function cleanTitle(raw: string): string {
  const withoutSuffix = raw.replace(/\s*[|｜]\s*U-?NEXT.*$/i, "").trim();
  if (/^U-?NEXT$/i.test(withoutSuffix)) return "";
  return withoutSuffix.replace(/\s+/g, " ").trim();
}
