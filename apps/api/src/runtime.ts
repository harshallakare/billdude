/**
 * apps/api/src/runtime.ts
 *
 * Usage: creates the long-lived resources (DB pool, Redis, queues, VHI
 * connector, catalog cache, account service) shared by the API process and
 * the worker process.
 *
 *   const rt = createRuntime(loadConfig());
 *   ...
 *   await rt.close();
 */
import { createVhiConnector } from "@billdude/vhi-connector";
import { Redis } from "ioredis";
import { createAccountService } from "./accounts.js";
import { createCatalog } from "./catalog.js";
import { vhiOptions, type Config } from "./config.js";
import { createDb } from "./db/client.js";
import { createQueues } from "./jobs/queue.js";

export function createRuntime(config: Config) {
  const { db, pool } = createDb(config.DATABASE_URL);
  // BullMQ requires maxRetriesPerRequest: null on connections used by workers.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queues = createQueues(redis);
  const vhi = createVhiConnector(vhiOptions(config));
  const catalog = createCatalog(vhi, { allowedNetworkIds: config.VHI_ALLOWED_NETWORK_IDS });
  const accounts = createAccountService({ db, vhi, config });

  return {
    config,
    db,
    redis,
    queues,
    vhi,
    catalog,
    accounts,
    async close() {
      await Promise.all([queues.vm.close(), queues.account.close()]);
      redis.disconnect();
      await pool.end();
    },
  };
}
