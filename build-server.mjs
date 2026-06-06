import { build } from "esbuild";

await build({
  entryPoints: ["server/src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/server.js",
  packages: "external",
});
console.log("server built -> dist/server.js");
