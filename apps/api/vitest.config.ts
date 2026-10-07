/**
 * apps/api/vitest.config.ts
 *
 * Usage: Vitest settings for API integration tests. Needs Postgres and Redis:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/billdude_test \
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @billdude/api test
 * Test files run one at a time because they share the test database.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
