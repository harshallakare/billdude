/**
 * apps/api/src/jobs/worker.ts
 *
 * Usage: wires the job processors to BullMQ workers (one per queue).
 *
 *   const workers = createWorkers({ db, vhi, accounts, config, queues, mailer, connection: redis });
 *   ...
 *   await workers.close();     // graceful shutdown
 *
 * Started in production by src/worker-main.ts; tests start it in-process.
 */
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { runBillingTick } from "../billing/metering.js";
import type { Config } from "../config.js";
import type { Mailer } from "../mail/mailer.js";
import { createProcessors, markJobFailed, type ProcessorDeps } from "./processor.js";
import {
  ACCOUNT_QUEUE,
  BILLING_QUEUE,
  MAIL_QUEUE,
  VM_QUEUE,
  type AccountJobData,
  type BillingJobData,
  type MailJobData,
  type Queues,
  type VmJobData,
} from "./queue.js";

export function createWorkers(
  deps: ProcessorDeps & {
    config: Config;
    queues: Queues;
    mailer: Mailer;
    connection: Redis;
    prefix?: string;
    concurrency?: number;
  },
) {
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

  const billing = new Worker<BillingJobData>(
    BILLING_QUEUE,
    async () => runBillingTick({ db: deps.db, config: deps.config, queues: deps.queues }),
    { ...common, concurrency: 1 },
  );

  const mail = new Worker<MailJobData>(MAIL_QUEUE, (job) => deps.mailer.send(job.data), { ...common, concurrency: 5 });

  return {
    vm,
    account,
    billing,
    mail,
    async close() {
      await Promise.all([vm.close(), account.close(), billing.close(), mail.close()]);
    },
  };
}
