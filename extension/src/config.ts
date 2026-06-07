import { isTokenSafe } from "../../shared/secret";
import { isWsUrl } from "../../shared/server-url";
export { httpBaseFrom } from "../../shared/server-url";

// ビルド時に build.mjs が esbuild define で実値へ置換する。
// 既定は本番URL、環境変数 SERVER_URL で上書き可能（E2E時は ws://localhost:8080 等）。
declare const __SERVER_URL__: string;
export const SERVER_URL = __SERVER_URL__;

if (!isWsUrl(SERVER_URL)) {
  throw new Error(
    "SERVER_URL is missing or not a ws://|wss:// URL. " +
      "Rebuild with a valid URL, e.g. `SERVER_URL=ws://localhost:8080 pnpm build:extension`.",
  );
}

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
