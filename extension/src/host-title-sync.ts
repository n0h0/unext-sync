import { pickWatchTitle } from "./title";

export interface TitleInputs {
  docTitle: string;
  ogTitle: string | null;
  workTitle: string | null;
  episodeTitle: string | null;
}

export interface HostTitleSyncDeps {
  readInputs(): TitleInputs;
  sendTitle(title: string): void;
  /** head の変化監視を設置し、解除関数を返す。 */
  observeHead(onChange: () => void): () => void;
  debounceMs?: number;
}

export interface HostTitleSync {
  /**
   * (再)join 時に呼ぶ。重複抑制をリセットして現在値を確実に1回送り（サーバーが同値を弾く）、
   * デバウンス後に再取得する（join 直後はプレイヤーヘッダ DOM が未描画のことがあり、
   * head の observer は body の h2/h3 変化を拾わないため）。observer は初回のみ設置する。
   */
  start(): void;
  /** デバウンス付き再送出。話数遷移検知など、head 変化以外のトリガーから呼ぶ。join 前でも安全。 */
  schedule(): void;
  /** 保留中のデバウンスを破棄し、observer を解除する（セッション終了時に呼ぶ）。 */
  dispose(): void;
}

/**
 * ホストのみ：視聴中タイトルを取得して送る。空なら送らず直前値を維持する。
 * DOM 読み取り・送信・監視は deps 注入で、本体はテスト可能なロジックのみを持つ。
 */
export function makeHostTitleSync(deps: HostTitleSyncDeps): HostTitleSync {
  const debounceMs = deps.debounceMs ?? 1000;
  let lastSent: string | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let disposeObserver: (() => void) | null = null;

  function sendIfChanged() {
    const t = pickWatchTitle(deps.readInputs());
    if (!t || t === lastSent) return;
    lastSent = t;
    deps.sendTitle(t);
  }
  function schedule() {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(sendIfChanged, debounceMs);
  }

  return {
    start() {
      lastSent = null;
      sendIfChanged();
      schedule();
      if (!disposeObserver) disposeObserver = deps.observeHead(schedule);
    },
    schedule,
    dispose() {
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = undefined;
      disposeObserver?.();
      disposeObserver = null;
    },
  };
}

/**
 * U-NEXT の DOM から視聴中タイトルの入力群を読む（壊れやすいセレクタをこの module に集約）。
 * 再生ページの document.title は「再生 | U-NEXT」で作品名を含まないため、
 * 再生ページ限定でプレイヤーヘッダ DOM（作品名 h2＋話数 h3）を優先し、og:title をフォールバックにする。
 */
export function readTitleInputsFromDom(doc: Document, pathname: string): TitleInputs {
  const onPlayer = pathname.includes("/play/");
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
  const workTitle = onPlayer
    ? doc.querySelector('h2[class*="__Title"]')?.textContent?.trim() || null
    : null;
  const episodeTitle = onPlayer
    ? doc.querySelector('h3[class*="__SubTitle"]')?.textContent?.trim() || null
    : null;
  return { docTitle: doc.title, ogTitle, workTitle, episodeTitle };
}
