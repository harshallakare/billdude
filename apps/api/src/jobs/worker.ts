/**
 * apps/api/src/jobs/worker.ts
 *
 * Usage: wires the VM processor to a BullMQ worker.
 *
 *   const worker = createVmWorker({ db, vhi, connection: redis });
 *   ...
 *   await worker.close();     // graceful shutdown
 *
 * Started in production by src/worker-main.ts; tests start it in-process.
 */
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { createVmProcessor, markJobFailed, type ProcessorDeps } from "./processor.js";
import { VM_QUEUE, type VmJobData } from "./queue.js";

export function createVmWorker(
  deps: ProcessorDeps & { connection: Redis; prefix?: string; concurrency?: number },
): Worker<VmJobData> {
  const process = createVmProcessor(deps);
  const worker = new Worker<VmJobData>(VM_QUEUE, (job) => process(job.data), {
    connection: deps.connection,
    concurrency: deps.concurrency ?? 10,
    ...(deps.prefix ? { prefix: deps.prefix } : {}),
  });

  worker.on("failed", (job, error) => {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const finalFailure = error.name === "UnrecoverableError" || job.attemptsMade >= attempts;
    if (finalFailure) void markJobFailed(deps.db, job.data, error.message);
  });

  return worker;
}
