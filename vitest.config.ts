import { defineConfig } from "vitest/config";

// Tool tests run against a real Postgres (founderos_test). One file at a time so tests do not fight over the schema setup.
export default defineConfig({
  test: { include: ["modules/*/test/**/*.test.ts"], fileParallelism: false, testTimeout: 20000, hookTimeout: 30000 },
});
