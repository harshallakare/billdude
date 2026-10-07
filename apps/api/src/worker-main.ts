/**
 * apps/api/src/worker-main.ts
 *
 * Usage: starts the background workers that execute VM and account jobs against
 * VHI, and the hourly billing tick.
 *   pnpm --filter @billdude/api dev:worker      # watch mode
 *   pnpm --filter @billdude/api start:worker    # production (after build)
 * Safe to run several copies; BullMQ hands each job to exactly one of them.
 */
import { loadConfig } from "./config.js";
import { scheduleBillingTicks } from "./jobs/queue.js";
import { createWorkers } from "./jobs/worker.js";
import { createRuntime } from "./runtime.js";

const runtime = createRuntime(loadConfig());
const workers = createWorkers({
  db: runtime.db,
  vhi: runtime.vhi,
  accounts: runtime.accounts,
  config: runtime.config,
  queues: runtime.queues,
  connection: runtime.redis,
});
await scheduleBillingTicks(runtime.queues.billing);

workers.vm.on("completed", (job) => console.log(`[worker] ${job.name} server ${job.data.serverId} done`));
workers.vm.on("failed", (job, err) => console.error(`[worker] ${job?.name} server ${job?.data.serverId} failed: ${err.message}`));
workers.account.on("completed", (job) => console.log(`[worker] ${job.name} account ${job.data.userId} done`));
workers.account.on("failed", (job, err) => console.error(`[worker] ${job?.name} account ${job?.data.userId} failed: ${err.message}`));
workers.billing.on("completed", (_job, result) => console.log(`[worker] billing tick ${JSON.stringify(result)}`));
workers.billing.on("failed", (_job, err) => console.error(`[worker] billing tick failed: ${err.message}`));

const shutdown = async () => {
  await workers.close();
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("[worker] waiting for VM jobs");
