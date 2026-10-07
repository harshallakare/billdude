/**
 * apps/api/drizzle.config.ts
 *
 * Usage: drizzle-kit settings. After editing src/db/schema.ts run
 *   pnpm db:generate     # writes a new SQL migration into apps/api/drizzle/
 *   pnpm db:migrate      # applies pending migrations to DATABASE_URL
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billdude" },
});
