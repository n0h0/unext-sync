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

await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["extension/src/content.ts", "extension/src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist/extension",
  define: { __CONNECT_SECRET__: JSON.stringify(secret) },
});
await cp("extension/manifest.json", "dist/extension/manifest.json");
await cp("extension/src/popup.html", "dist/extension/popup.html");
console.log("extension built -> dist/extension");
