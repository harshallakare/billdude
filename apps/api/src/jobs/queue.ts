/**
 * apps/api/src/jobs/queue.ts
 *
 * Usage: the BullMQ queue that carries every slow VM operation from the API
 * to the worker. The API only enqueues; src/jobs/worker.ts executes.
 *
 *   const queue = createVmQueue(redis);
 *   await enqueueVmOp(queue, { serverId, op: "create" });
 */
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const VM_QUEUE = "vm-ops";

export type VmOp = "create" | "start" | "stop" | "reboot" | "delete";

export interface VmJobData {
  /** Portal server id (servers.id), not the Nova id. */
  serverId: string;
  op: VmOp;
  /** User who requested it, for the audit log. */
  actorId: string | null;
}

export type VmQueue = Queue<VmJobData>;

export function createVmQueue(connection: Redis, prefix?: string): VmQueue {
  return new Queue<VmJobData>(VM_QUEUE, {
    connection,
    ...(prefix ? { prefix } : {}),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

export async function enqueueVmOp(queue: VmQueue, data: VmJobData): Promise<void> {
  await queue.add(data.op, data);
}
