import { isTokenSafe } from "../../shared/secret";

// デプロイ後の実URLに置き換える（Task 10）。
export const SERVER_URL = "wss://unext-sync.onrender.com";

// ビルド時に build.mjs が esbuild define で実値へ置換する。コミットしない。
declare const __CONNECT_SECRET__: string;
export const CONNECT_SECRET = __CONNECT_SECRET__;

// 非token-safeな値は new WebSocket(url, [secret]) で SyntaxError を起こし
// 拡張が無言停止するため、原因を明示するためここで早期に弾く。
if (!isTokenSafe(CONNECT_SECRET)) {
  throw new Error(
    "CONNECT_SECRET is missing or not token-safe. " +
      "Rebuild with a hex secret: `CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension`.",
  );
}
