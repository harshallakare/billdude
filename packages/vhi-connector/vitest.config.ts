/**
 * packages/vhi-connector/vitest.config.ts
 *
 * Usage: Vitest settings for the connector tests (`pnpm --filter @billdude/vhi-connector test`).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 10_000 },
});
