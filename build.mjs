import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist/extension", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["extension/src/content.ts", "extension/src/popup.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist/extension",
});
await cp("extension/manifest.json", "dist/extension/manifest.json");
await cp("extension/src/popup.html", "dist/extension/popup.html");
console.log("extension built -> dist/extension");
