/**
 * apps/api/src/jobs/queue.ts
 *
 * Usage: the BullMQ queues that carry slow cloud operations from the API to
 * the worker. The API only enqueues; src/jobs/worker.ts executes.
 *
 *   const queues = createQueues(redis);
 *   await enqueueVmOp(queues.vm, { serverId, op: "create", actorId });
 *   await enqueueAccountOp(queues.account, { userId, op: "provision" });
 */
import { Queue, type DefaultJobOptions } from "bullmq";
import type { Redis } from "ioredis";

export const VM_QUEUE = "vm-ops";
export const ACCOUNT_QUEUE = "account-ops";

export type VmOp = "create" | "start" | "stop" | "reboot" | "delete";

export interface VmJobData {
  /** Portal server id (servers.id), not the Nova id. */
  serverId: string;
  op: VmOp;
  /** User who requested it, for the audit log. */
  actorId: string | null;
}

export interface AccountJobData {
  userId: string;
  /** provision: create the customer's VHI project. sync-quotas: push quota changes. */
  op: "provision" | "sync-quotas";
}

export type VmQueue = Queue<VmJobData>;
export type AccountQueue = Queue<AccountJobData>;
export interface Queues {
  vm: VmQueue;
  account: AccountQueue;
}

const defaultJobOptions: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createQueues(connection: Redis, prefix?: string): Queues {
  const opts = { connection, defaultJobOptions, ...(prefix ? { prefix } : {}) };
  return {
    vm: new Queue<VmJobData>(VM_QUEUE, opts),
    account: new Queue<AccountJobData>(ACCOUNT_QUEUE, opts),
  };
}

export async function enqueueVmOp(queue: VmQueue, data: VmJobData): Promise<void> {
  await queue.add(data.op, data);
}

export async function enqueueAccountOp(queue: AccountQueue, data: AccountJobData): Promise<void> {
  await queue.add(data.op, data);
}
