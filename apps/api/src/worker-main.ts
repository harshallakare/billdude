/**
 * apps/api/src/worker-main.ts
 *
 * Usage: starts the background worker that executes VM jobs against VHI.
 *   pnpm --filter @billdude/api dev:worker      # watch mode
 *   pnpm --filter @billdude/api start:worker    # production (after build)
 * Safe to run several copies; BullMQ hands each job to exactly one of them.
 */
import { loadConfig } from "./config.js";
import { createVmWorker } from "./jobs/worker.js";
import { createRuntime } from "./runtime.js";

const runtime = createRuntime(loadConfig());
const worker = createVmWorker({ db: runtime.db, vhi: runtime.vhi, connection: runtime.redis });

worker.on("completed", (job) => console.log(`[worker] ${job.name} ${job.data.serverId} done`));
worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} ${job?.data.serverId} failed: ${err.message}`));

const shutdown = async () => {
  await worker.close();
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[worker] waiting for VM jobs");
