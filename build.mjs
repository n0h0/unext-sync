import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const secret = process.env.CONNECT_SECRET;
// TOKEN_SAFE_RE（shared/secret.ts）のミラー。.mjs は .ts を import できないため重複。文字種を変えるなら両方更新する。
if (!secret || !/^[A-Za-z0-9_-]+$/.test(secret)) {
  console.error(
    "CONNECT_SECRET is unset or not token-safe.\n" +
      "Build the extension with a hex secret, e.g.:\n" +
      "  CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension",
  );
  process.exit(1);
}

// 既定は本番URL。環境変数 SERVER_URL で上書き可能（E2E時に config.ts を編集せず済む）。
const serverUrl = process.env.SERVER_URL ?? "wss://unext-sync.onrender.com";
// isWsUrl（shared/server-url.ts）のミラー。.mjs は .ts を import できないため重複。
function isWsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "ws:" || u.protocol === "wss:";
  } catch {
    return false;
  }
}
if (!isWsUrl(serverUrl)) {
  console.error(
    `SERVER_URL is not a ws://|wss:// URL: ${JSON.stringify(serverUrl)}\n` +
      "Build with a valid URL, e.g.:\n" +
      "  SERVER_URL=ws://localhost:8080 CONNECT_SECRET=$(openssl rand -hex 32) pnpm build:extension",
  );
  process.exit(1);
}

await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["extension/src/content.ts", "extension/src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist/extension",
  define: {
    __CONNECT_SECRET__: JSON.stringify(secret),
    __SERVER_URL__: JSON.stringify(serverUrl),
  },
});
await cp("extension/manifest.json", "dist/extension/manifest.json");
await cp("extension/src/popup.html", "dist/extension/popup.html");
await cp("extension/icons", "dist/extension/icons", { recursive: true });
console.log("extension built -> dist/extension");
