/**
 * apps/api/src/jobs/worker.ts
 *
 * Usage: wires the job processors to BullMQ workers (one per queue).
 *
 *   const workers = createWorkers({ db, vhi, accounts, connection: redis });
 *   ...
 *   await workers.close();     // graceful shutdown
 *
 * Started in production by src/worker-main.ts; tests start it in-process.
 */
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createProcessors, markJobFailed, type ProcessorDeps } from "./processor.js";
import { ACCOUNT_QUEUE, VM_QUEUE, type AccountJobData, type VmJobData } from "./queue.js";

export function createWorkers(deps: ProcessorDeps & { connection: Redis; prefix?: string; concurrency?: number }) {
  const { processVmJob, processAccountJob } = createProcessors(deps);
  const common = { connection: deps.connection, ...(deps.prefix ? { prefix: deps.prefix } : {}) };

  const vm = new Worker<VmJobData>(VM_QUEUE, (job) => processVmJob(job.data), {
    ...common,
    concurrency: deps.concurrency ?? 10,
  });
  vm.on("failed", (job, error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const finalFailure = error.name === "UnrecoverableError" || job.attemptsMade >= attempts;
    if (finalFailure) void markJobFailed(deps.db, job.data, error.message);
  });

  const account = new Worker<AccountJobData>(ACCOUNT_QUEUE, (job) => processAccountJob(job.data), {
    ...common,
    concurrency: 5,
  });

  return {
    vm,
    account,
    async close() {
      await Promise.all([vm.close(), account.close()]);
    },
  };
}
