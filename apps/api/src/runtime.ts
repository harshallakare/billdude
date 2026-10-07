/**
 * apps/api/src/runtime.ts
 *
 * Usage: creates the long-lived resources (DB pool, Redis, queue, VHI
 * connector) shared by the API process and the worker process.
 *
 *   const rt = createRuntime(loadConfig());
 *   ...
 *   await rt.close();
 */
import { createVhiConnector } from "@billdude/vhi-connector";
import { Redis } from "ioredis";
import { createCatalog } from "./catalog.js";
import { vhiOptions, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { createVmQueue } from "./jobs/queue.js";

export function createRuntime(config: Config) {
  const { db, pool } = createDb(config.DATABASE_URL);
  // BullMQ requires maxRetriesPerRequest: null on connections used by workers.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = createVmQueue(redis);
  const vhi = createVhiConnector(vhiOptions(config));
  const catalog = createCatalog(vhi);

  return {
    config,
    db,
    redis,
    queue,
    vhi,
    catalog,
    async close() {
      await queue.close();
      redis.disconnect();
      await pool.end();
    },
  };
}
