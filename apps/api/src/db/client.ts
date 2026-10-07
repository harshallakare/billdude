/**
 * apps/api/src/db/client.ts
 *
 * Usage: creates the Drizzle database handle backed by a pg connection pool.
 *
 *   const { db, pool } = createDb(config.DATABASE_URL);
 *   ...
 *   await pool.end();   // on shutdown
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}
