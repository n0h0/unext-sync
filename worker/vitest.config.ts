import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { CONNECT_SECRET: "0123456789abcdef0123456789abcdef" },
      },
    }),
  ],
  test: {
    include: ["worker/**/*.test.ts"],
  },
});
