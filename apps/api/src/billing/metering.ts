/**
 * apps/api/src/billing/metering.ts
 *
 * Usage: charges wallets for server usage and enforces non-payment.
 * Runs hourly from the worker (billing-ops queue) and can be called directly:
 *
 *   const result = await runBillingTick({ db, config, queues }, new Date());
 *   // { charged: 12, totalMicros: 4_310_000, stopped: 1 }
 *
 * Billing rules (DigitalOcean-style):
 *   - A server is billed per second from the moment it first became active
 *     until it is deleted, whether it is running or stopped (its resources
 *     stay reserved on VHI).
 *   - Each run charges every server from `billed_until` up to now (or its
 *     deletion time) and posts one "usage" debit per customer.
 *   - Runs are idempotent: the server's `billed_until` is advanced with a
 *     guarded UPDATE in the same transaction as the ledger entry, so an
 *     overlapping run cannot charge the same seconds twice.
 *   - Customers below zero for longer than BILLING_GRACE_HOURS have their
 *     running servers stopped (never deleted).
 *   - Customers are emailed when less than a day of balance is left (at most
 *     daily), when they go overdue, and when servers are stopped.
 */
import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { servers, usageRecords, users, type ServerRow } from "../db/schema.js";
import { enqueueMail, enqueueVmOp, type Queues } from "../jobs/queue.js";
import { templates } from "../mail/templates.js";
import { postTransaction } from "./ledger.js";
import { formatAmount } from "./money.js";
import { charge, loadPriceBook, type PriceBook } from "./pricing.js";

export interface MeteringDeps {
  db: Db;
  config: Config;
  queues: Pick<Queues, "vm" | "mail">;
}

export interface TickResult {
  /** Servers that were charged in this run. */
  charged: number;
  totalMicros: number;
  /** Servers stopped for non-payment. */
  stopped: number;
}

export async function runBillingTick({ db, config, queues }: MeteringDeps, now = new Date()): Promise<TickResult> {
  const prices = await loadPriceBook(db, config);

  const due = await db
    .select()
    .from(servers)
    .where(
      and(
        isNotNull(servers.billingStartedAt),
        or(isNull(servers.billedUntil), lt(servers.billedUntil, sql`coalesce(${servers.deletedAt}, ${now})`)),
      ),
    );

  const byUser = new Map<string, ServerRow[]>();
  for (const row of due) byUser.set(row.ownerId, [...(byUser.get(row.ownerId) ?? []), row]);

  let charged = 0;
  let totalMicros = 0;

  for (const [userId, rows] of byUser) {
    await db.transaction(async (tx) => {
      let userTotal = 0;
      const records: (typeof usageRecords.$inferInsert)[] = [];

      for (const row of rows) {
        const start = row.billedUntil ?? row.billingStartedAt!;
        const end = row.deletedAt && row.deletedAt < now ? row.deletedAt : now;
        const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
        if (seconds <= 0) continue;
        const periodEnd = new Date(start.getTime() + seconds * 1000);

        // Guarded advance: if another run already moved billed_until, skip this server.
        const [advanced] = await tx
          .update(servers)
          .set({ billedUntil: periodEnd })
          .where(
            and(
              eq(servers.id, row.id),
              row.billedUntil ? eq(servers.billedUntil, row.billedUntil) : isNull(servers.billedUntil),
            ),
          )
          .returning({ id: servers.id });
        if (!advanced) continue;

        const flavor = { id: row.flavorId, vcpus: row.flavorVcpus, ramMb: row.flavorRamMb };
        const computeMicros = charge(seconds, prices.flavorHourly(flavor));
        const storageMicros = charge(seconds, row.bootVolumeGb * prices.storageGbHourly);
        records.push({
          userId,
          serverId: row.id,
          periodStart: start,
          periodEnd,
          flavorId: row.flavorId,
          diskGb: row.bootVolumeGb,
          computeMicros,
          storageMicros,
        });
        userTotal += computeMicros + storageMicros;
      }

      if (records.length === 0) return;
      const { transaction } = await postTransaction(tx, {
        userId,
        type: "usage",
        amountMicros: -userTotal,
        description: `Usage for ${records.length} server${records.length === 1 ? "" : "s"} (${formatAmount(userTotal)} ${config.BILLING_CURRENCY})`,
      });
      await tx.insert(usageRecords).values(records.map((r) => ({ ...r, walletTransactionId: transaction?.id })));
      charged += records.length;
      totalMicros += userTotal;
    });
  }

  const stopped = await enforceNonPayment({ db, config, queues }, now);
  await notifyBalances({ db, config, queues }, now, prices);
  return { charged, totalMicros, stopped };
}

/** Stops running servers of customers who have been overdue longer than the grace period. */
async function enforceNonPayment({ db, config, queues }: MeteringDeps, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - config.BILLING_GRACE_HOURS * 3600_000);
  const overdue = await db
    .select({ id: users.id })
    .from(users)
    .where(and(lt(users.overdueSince, cutoff), ne(users.role, "admin")));
  if (overdue.length === 0) return 0;

  const ids = overdue.map((u) => u.id);
  const running = await db
    .update(servers)
    .set({ status: "stopping", statusMessage: "Stopped because the account balance is overdue" })
    .where(and(inArray(servers.ownerId, ids), eq(servers.status, "active")))
    .returning({ id: servers.id, ownerId: servers.ownerId });

  for (const server of running) {
    await audit(db, { actorId: null, action: "server.stop.nonpayment", targetType: "server", targetId: server.id });
    await enqueueVmOp(queues.vm, { serverId: server.id, op: "stop", actorId: null });
  }

  const perUser = new Map<string, number>();
  for (const s of running) perUser.set(s.ownerId, (perUser.get(s.ownerId) ?? 0) + 1);
  for (const [userId, count] of perUser) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (user) await enqueueMail(queues.mail, { to: user.email, ...templates.serversStopped(user.name, count, billingLink(config)) });
  }
  return running.length;
}

const billingLink = (config: Config) => `${config.PUBLIC_URL.replace(/\/+$/, "")}/billing`;

/** Low-balance warnings (at most daily) and a one-off notice when an account goes overdue. */
async function notifyBalances({ db, config, queues }: MeteringDeps, now: Date, prices: PriceBook): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const candidates = await db
    .select()
    .from(users)
    .where(
      and(
        ne(users.role, "admin"),
        or(isNull(users.lowBalanceNotifiedAt), lt(users.lowBalanceNotifiedAt, dayAgo), isNotNull(users.overdueSince)),
      ),
    );

  for (const user of candidates) {
    // Overdue: notify once per overdue episode.
    if (user.overdueSince) {
      if (user.lowBalanceNotifiedAt && user.lowBalanceNotifiedAt >= user.overdueSince) continue;
      await enqueueMail(queues.mail, {
        to: user.email,
        ...templates.overdue(user.name, `${formatAmount(user.balanceMicros)} ${config.BILLING_CURRENCY}`, config.BILLING_GRACE_HOURS, billingLink(config)),
      });
      await db.update(users).set({ lowBalanceNotifiedAt: now }).where(eq(users.id, user.id));
      continue;
    }

    const live = await db
      .select()
      .from(servers)
      .where(and(eq(servers.ownerId, user.id), ne(servers.status, "deleted"), isNotNull(servers.billingStartedAt)));
    const hourly = live.reduce(
      (sum, s) => sum + prices.serverHourly({ id: s.flavorId, vcpus: s.flavorVcpus, ramMb: s.flavorRamMb }, s.bootVolumeGb),
      0,
    );
    if (hourly <= 0) continue;
    const hoursLeft = Math.floor(user.balanceMicros / hourly);
    if (hoursLeft >= 24) continue;
    await enqueueMail(queues.mail, {
      to: user.email,
      ...templates.lowBalance(user.name, `${formatAmount(user.balanceMicros)} ${config.BILLING_CURRENCY}`, hoursLeft, billingLink(config)),
    });
    await db.update(users).set({ lowBalanceNotifiedAt: now }).where(eq(users.id, user.id));
  }
}
