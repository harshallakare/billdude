/**
 * apps/api/src/routes/billing.ts
 *
 * Usage: customer billing endpoints (mounted under /api, signed-in users unless noted):
 *   GET  /billing/wallet                 -> balance, overdue state, hourly burn and runway
 *   GET  /billing/transactions?limit=50  -> wallet ledger, newest first
 *   GET  /billing/pricing                -> hourly/monthly price per flavor + storage price
 *   POST /billing/topups { amount }      -> creates a gateway order; returns checkout parameters
 *   POST /billing/topups/verify { orderId, paymentId, signature } -> confirms and credits the wallet
 *   GET  /billing/statements             -> months with usage
 *   GET  /billing/statements/:month      -> one month (YYYY-MM): per-server usage, top-ups, balances
 *   POST /billing/razorpay/webhook       -> Razorpay webhook (no session; HMAC-verified raw body)
 * Amounts in responses are decimal strings in the billing currency ("12.50").
 */
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { paymentFromWebhook } from "../billing/gateway.js";
import { formatAmount, HOURS_PER_MONTH } from "../billing/money.js";
import { PaymentMismatchError, settlePayment } from "../billing/payments.js";
import { loadPriceBook } from "../billing/pricing.js";
import { payments, servers, usageRecords, users, walletTransactions } from "../db/schema.js";

const topupBody = z.object({ amount: z.number().int().positive() });
const verifyBody = z.object({ orderId: z.string().min(1), paymentId: z.string().min(1), signature: z.string().min(1) });
const monthParams = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export async function billingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, catalog, gateway } = deps;
  const currency = config.BILLING_CURRENCY;
  const money = (micros: number) => formatAmount(micros);

  app.get("/billing/wallet", { preHandler: app.authenticate }, async (req) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.user.id));
    const prices = await loadPriceBook(db, config);
    const live = await db
      .select()
      .from(servers)
      .where(and(eq(servers.ownerId, req.user.id), ne(servers.status, "deleted")));
    const hourly = live
      .filter((s) => s.billingStartedAt)
      .reduce((sum, s) => sum + prices.serverHourly({ id: s.flavorId, vcpus: s.flavorVcpus, ramMb: s.flavorRamMb }, s.bootVolumeGb), 0);
    const balance = user!.balanceMicros;
    return {
      currency,
      balance: money(balance),
      hourlyBurn: money(hourly),
      runwayHours: hourly > 0 && balance > 0 ? Math.floor(balance / hourly) : null,
      overdueSince: user!.overdueSince,
      graceHours: config.BILLING_GRACE_HOURS,
      minTopup: config.BILLING_MIN_TOPUP,
      maxTopup: config.BILLING_MAX_TOPUP,
      gateway: gateway.name,
    };
  });

  app.get("/billing/transactions", { preHandler: app.authenticate }, async (req) => {
    const { limit } = listQuery.parse(req.query);
    const rows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, req.user.id))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(limit);
    return {
      currency,
      transactions: rows.map((t) => ({
        id: t.id,
        type: t.type,
        amount: money(t.amountMicros),
        balanceAfter: money(t.balanceAfterMicros),
        description: t.description,
        createdAt: t.createdAt,
      })),
    };
  });

  app.get("/billing/pricing", { preHandler: app.authenticate }, async () => {
    const prices = await loadPriceBook(db, config);
    const flavors = await catalog.flavors();
    return {
      currency,
      storageGbMonthly: money(prices.storageGbHourly * HOURS_PER_MONTH),
      flavors: flavors.map((f) => {
        const hourly = prices.flavorHourly(f);
        return { flavorId: f.id, hourly: money(hourly), monthly: money(hourly * HOURS_PER_MONTH) };
      }),
    };
  });

  app.post("/billing/topups", { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { amount } = topupBody.parse(req.body);
    if (amount < config.BILLING_MIN_TOPUP || amount > config.BILLING_MAX_TOPUP) {
      return reply
        .code(400)
        .send({ error: `Top-ups must be between ${config.BILLING_MIN_TOPUP} and ${config.BILLING_MAX_TOPUP} ${currency}` });
    }
    const amountMinor = amount * 100;
    const receipt = `topup_${Date.now()}_${req.user.id.slice(0, 8)}`;
    const { orderId } = await gateway.createOrder({ amountMinor, currency, receipt, notes: { userId: req.user.id } });
    await db.insert(payments).values({ userId: req.user.id, gateway: gateway.name, orderId, amountMinor, currency });
    await audit(db, { actorId: req.user.id, action: "wallet.topup.order", targetType: "payment", targetId: orderId, data: { amount } });
    return reply.code(201).send({
      gateway: gateway.name,
      keyId: gateway.publicKey,
      orderId,
      amountMinor,
      currency,
      companyName: config.BILLING_COMPANY_NAME,
      prefill: { name: req.user.name, email: req.user.email },
    });
  });

  app.post("/billing/topups/verify", { preHandler: app.authenticate }, async (req, reply) => {
    const body = verifyBody.parse(req.body);
    const [order] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, body.orderId), eq(payments.userId, req.user.id)));
    if (!order) return reply.code(404).send({ error: "Top-up not found" });
    if (!gateway.verifyCheckoutSignature(body.orderId, body.paymentId, body.signature)) {
      return reply.code(400).send({ error: "Payment signature is invalid" });
    }
    const payment = await gateway.fetchPayment(body.paymentId);
    if (payment.orderId !== body.orderId) return reply.code(400).send({ error: "Payment does not belong to this order" });
    try {
      await settlePayment(db, gateway, payment);
    } catch (error) {
      if (error instanceof PaymentMismatchError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const [user] = await db.select({ balance: users.balanceMicros }).from(users).where(eq(users.id, req.user.id));
    const [updated] = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, order.id));
    return { status: updated!.status, balance: money(user!.balance), currency };
  });

  app.get("/billing/statements", { preHandler: app.authenticate }, async (req) => {
    const month = sql<string>`to_char(${usageRecords.periodStart} at time zone ${config.BILLING_TIMEZONE}, 'YYYY-MM')`;
    const rows = await db
      .select({
        month,
        total: sql<string>`sum(${usageRecords.computeMicros} + ${usageRecords.storageMicros})`,
      })
      .from(usageRecords)
      .where(eq(usageRecords.userId, req.user.id))
      .groupBy(month)
      .orderBy(desc(month));
    return { currency, statements: rows.map((r) => ({ month: r.month, usage: money(Number(r.total)) })) };
  });

  app.get("/billing/statements/:month", { preHandler: app.authenticate }, async (req) => {
    const { month } = monthParams.parse(req.params);
    const tz = config.BILLING_TIMEZONE;
    const start = sql`(${`${month}-01`}::date)::timestamp at time zone ${tz}`;
    const end = sql`((${`${month}-01`}::date + interval '1 month')::date)::timestamp at time zone ${tz}`;

    const lines = await db
      .select({
        serverId: usageRecords.serverId,
        name: servers.name,
        flavorId: usageRecords.flavorId,
        diskGb: sql<number>`max(${usageRecords.diskGb})`,
        seconds: sql<string>`sum(extract(epoch from ${usageRecords.periodEnd} - ${usageRecords.periodStart}))`,
        compute: sql<string>`sum(${usageRecords.computeMicros})`,
        storage: sql<string>`sum(${usageRecords.storageMicros})`,
      })
      .from(usageRecords)
      .innerJoin(servers, eq(servers.id, usageRecords.serverId))
      .where(and(eq(usageRecords.userId, req.user.id), gte(usageRecords.periodStart, start), lt(usageRecords.periodStart, end)))
      .groupBy(usageRecords.serverId, servers.name, usageRecords.flavorId)
      .orderBy(servers.name);

    const txs = await db
      .select()
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, req.user.id),
          gte(walletTransactions.createdAt, start),
          lt(walletTransactions.createdAt, end),
        ),
      )
      .orderBy(walletTransactions.createdAt);
    const [before] = await db
      .select({ balance: walletTransactions.balanceAfterMicros })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, req.user.id), lt(walletTransactions.createdAt, start)))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(1);

    const opening = before?.balance ?? 0;
    const closing = txs.at(-1)?.balanceAfterMicros ?? opening;
    const usageTotal = lines.reduce((sum, l) => sum + Number(l.compute) + Number(l.storage), 0);
    return {
      month,
      currency,
      openingBalance: money(opening),
      closingBalance: money(closing),
      usageTotal: money(usageTotal),
      lines: lines.map((l) => ({
        serverId: l.serverId,
        name: l.name,
        flavorId: l.flavorId,
        diskGb: l.diskGb,
        hours: Math.round((Number(l.seconds) / 3600) * 100) / 100,
        compute: money(Number(l.compute)),
        storage: money(Number(l.storage)),
        total: money(Number(l.compute) + Number(l.storage)),
      })),
      payments: txs
        .filter((t) => t.type !== "usage")
        .map((t) => ({ type: t.type, amount: money(t.amountMicros), description: t.description, createdAt: t.createdAt })),
    };
  });

  // Razorpay webhooks need the exact raw body for signature verification, so they
  // get their own encapsulated scope with a buffer JSON parser.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/billing/razorpay/webhook", async (req, reply) => {
      const raw = req.body as Buffer;
      const signature = req.headers["x-razorpay-signature"];
      if (typeof signature !== "string" || !gateway.verifyWebhookSignature(raw, signature)) {
        return reply.code(400).send({ error: "Invalid signature" });
      }
      const event = JSON.parse(raw.toString("utf8")) as { event?: string };
      if (event.event === "payment.captured" || event.event === "order.paid") {
        const payment = paymentFromWebhook(event);
        if (payment) {
          try {
            await settlePayment(db, gateway, payment);
          } catch (error) {
            // Not one of ours (or tampered amounts): acknowledge so Razorpay stops retrying.
            if (!(error instanceof PaymentMismatchError)) throw error;
            req.log.warn({ err: error }, "Ignoring Razorpay webhook");
          }
        }
      }
      return { ok: true };
    });
  });
}
