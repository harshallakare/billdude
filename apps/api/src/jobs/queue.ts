/**
 * apps/api/src/jobs/queue.ts
 *
 * Usage: the BullMQ queues that carry slow cloud operations from the API to
 * the worker. The API only enqueues; src/jobs/worker.ts executes.
 *
 *   const queues = createQueues(redis);
 *   await enqueueVmOp(queues.vm, { serverId, op: "create", actorId });
 *   await enqueueAccountOp(queues.account, { userId, op: "provision" });
 *   await scheduleBillingTicks(queues.billing);       // worker startup: hourly metering
 *   await enqueueMail(queues.mail, { to, subject, text });
 */
import { Queue, type DefaultJobOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { MailMessage } from "../mail/mailer.js";

export const VM_QUEUE = "vm-ops";
export const ACCOUNT_QUEUE = "account-ops";
export const BILLING_QUEUE = "billing-ops";
export const MAIL_QUEUE = "mail";
export const VOLUME_QUEUE = "volume-ops";

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
  /** provision: create the customer's VHI project. sync-*: push quota or firewall changes. */
  op: "provision" | "sync-quotas" | "sync-firewall";
}

export interface BillingJobData {
  op: "tick";
}

export type MailJobData = MailMessage;

export interface VolumeJobData {
  /** Portal volume id (volumes.id). */
  volumeId: string;
  op: "create" | "attach" | "detach" | "delete";
  actorId: string | null;
}

export type VmQueue = Queue<VmJobData>;
export type AccountQueue = Queue<AccountJobData>;
export type BillingQueue = Queue<BillingJobData>;
export type MailQueue = Queue<MailJobData>;
export type VolumeQueue = Queue<VolumeJobData>;
export interface Queues {
  vm: VmQueue;
  account: AccountQueue;
  billing: BillingQueue;
  mail: MailQueue;
  volume: VolumeQueue;
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
    billing: new Queue<BillingJobData>(BILLING_QUEUE, opts),
    mail: new Queue<MailJobData>(MAIL_QUEUE, opts),
    volume: new Queue<VolumeJobData>(VOLUME_QUEUE, opts),
  };
}

export async function enqueueVmOp(queue: VmQueue, data: VmJobData): Promise<void> {
  await queue.add(data.op, data);
}

/** Registers (or updates) the hourly metering schedule. Safe to call on every worker start. */
export async function scheduleBillingTicks(queue: BillingQueue, everyMs = 3600_000): Promise<void> {
  await queue.upsertJobScheduler("billing-tick", { every: everyMs }, { name: "tick", data: { op: "tick" } });
}

export async function enqueueVolumeOp(queue: VolumeQueue, data: VolumeJobData): Promise<void> {
  await queue.add(data.op, data);
}

export async function enqueueMail(queue: MailQueue, message: MailMessage): Promise<void> {
  await queue.add("send", message);
}

export async function enqueueAccountOp(queue: AccountQueue, data: AccountJobData): Promise<void> {
  await queue.add(data.op, data);
}
