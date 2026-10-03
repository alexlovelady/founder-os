import { defineConfig } from "vitest/config";

// Tool tests run against a real Postgres (founderos_test). One file at a time so tests do not fight over the schema setup.
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./shell/src", import.meta.url)) } },
  test: { include: ["modules/*/test/**/*.test.ts", "shell/tests/**/*.test.ts"], fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 },
});
