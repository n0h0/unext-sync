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

/**
 * U-NEXT の og:title から作品名だけを取り出す純粋関数。
 * 例「作品名(アニメ / 2025) - 動画配信 | U-NEXT 31日間無料トライアル」→「作品名」。
 * ブランドサフィックスは cleanTitle で除去し、末尾のメタ情報
 * 「(ジャンル / 年) - 動画配信…」「- 動画配信…」を落とす（全角括弧/ダッシュ対応）。
 */
export function cleanOgTitle(raw: string): string {
  const base = cleanTitle(raw);
  return base
    .replace(/\s*[(（][^)）]*[)）]\s*[-–—―]\s*動画配信.*$/, "")
    .replace(/\s*[-–—―]\s*動画配信.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * U-NEXT 再生ページの document.title に出る汎用プレイヤー状態語かどうか。
 * これらは作品名ではないので視聴中タイトルとして使わない。
 */
function isGenericPlayerTitle(s: string): boolean {
  return /^(再生|一時停止|停止|読み込み中|ロード中|loading|play|pause)$/i.test(s.trim());
}

/**
 * 視聴中タイトルの最終決定（純粋関数）。DOM 読み取りは呼び出し側（content.ts）が行い、
 * 取得済みの文字列をここに渡す。優先順位:
 *   1. DOM プレイヤーヘッダの作品名（＋話数があれば連結）
 *   2. document.title（汎用プレイヤー状態語でなければ）
 *   3. og:title から抽出した作品名
 *   4. いずれも無ければ空文字
 */
export function pickWatchTitle(input: {
  docTitle: string;
  ogTitle?: string | null;
  workTitle?: string | null;
  episodeTitle?: string | null;
}): string {
  const work = (input.workTitle ?? "").trim();
  if (work) {
    const episode = (input.episodeTitle ?? "").trim();
    return `${work} ${episode}`.replace(/\s+/g, " ").trim();
  }
  const fromDoc = cleanTitle(input.docTitle);
  if (fromDoc && !isGenericPlayerTitle(fromDoc)) return fromDoc;
  const fromOg = input.ogTitle ? cleanOgTitle(input.ogTitle) : "";
  return fromOg;
}
