/**
 * apps/api/src/routes/admin-billing.ts
 *
 * Usage: admin-only billing endpoints (mounted under /api):
 *   GET    /admin/pricing                         -> every flavor's effective price + storage price
 *   PUT    /admin/pricing/flavors/:flavorId { hourly: "0.75" }  -> override one flavor's hourly price
 *   DELETE /admin/pricing/flavors/:flavorId       -> back to the vCPU/RAM formula
 *   POST   /admin/users/:id/wallet { amount: "-10.00" | "50", description } -> manual credit/adjustment
 *   POST   /admin/billing/run                     -> run the metering tick now
 * Every change is audited; wallet changes go through the ledger.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { postTransaction } from "../billing/ledger.js";
import { runBillingTick } from "../billing/metering.js";
import { formatAmount, HOURS_PER_MONTH, parseAmount } from "../billing/money.js";
import { loadPriceBook } from "../billing/pricing.js";
import { flavorPrices, users } from "../db/schema.js";

const amountPattern = /^\d+(\.\d{1,6})?$/;
const flavorParams = z.object({ flavorId: z.string().min(1).max(255) });
const priceBody = z.object({ hourly: z.string().regex(amountPattern, "Use a decimal amount like 0.75") });
const idParams = z.object({ id: z.string().uuid() });
const walletBody = z.object({
  amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Use an amount like 50 or -12.50"),
  description: z.string().trim().min(3).max(200),
});

export async function adminBillingRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config, catalog, queues } = deps;

  app.get("/admin/pricing", { preHandler: app.requireAdmin }, async () => {
    const prices = await loadPriceBook(db, config);
    const flavors = await catalog.flavors();
    return {
      currency: config.BILLING_CURRENCY,
      defaults: {
        vcpuHourly: config.BILLING_VCPU_HOURLY,
        ramGbHourly: config.BILLING_RAM_GB_HOURLY,
        storageGbMonthly: config.BILLING_STORAGE_GB_MONTHLY,
      },
      flavors: flavors.map((f) => {
        const hourly = prices.flavorHourly(f);
        return {
          flavorId: f.id,
          name: f.name,
          vcpus: f.vcpus,
          ramMb: f.ramMb,
          hourly: formatAmount(hourly),
          hourlyExact: (hourly / 1_000_000).toFixed(6),
          monthly: formatAmount(hourly * HOURS_PER_MONTH),
          override: prices.hasOverride(f.id),
        };
      }),
    };
  });

  app.put("/admin/pricing/flavors/:flavorId", { preHandler: app.requireAdmin }, async (req) => {
    const { flavorId } = flavorParams.parse(req.params);
    const { hourly } = priceBody.parse(req.body);
    const hourlyMicros = parseAmount(hourly);
    await db
      .insert(flavorPrices)
      .values({ flavorId, hourlyMicros })
      .onConflictDoUpdate({ target: flavorPrices.flavorId, set: { hourlyMicros } });
    await audit(db, { actorId: req.user.id, action: "pricing.flavor.set", targetType: "flavor", targetId: flavorId, data: { hourly } });
    return { ok: true };
  });

  app.delete("/admin/pricing/flavors/:flavorId", { preHandler: app.requireAdmin }, async (req) => {
    const { flavorId } = flavorParams.parse(req.params);
    await db.delete(flavorPrices).where(eq(flavorPrices.flavorId, flavorId));
    await audit(db, { actorId: req.user.id, action: "pricing.flavor.reset", targetType: "flavor", targetId: flavorId });
    return { ok: true };
  });

  app.post("/admin/users/:id/wallet", { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { amount, description } = walletBody.parse(req.body);
    const negative = amount.startsWith("-");
    const micros = parseAmount(negative ? amount.slice(1) : amount) * (negative ? -1 : 1);
    if (micros === 0) return reply.code(400).send({ error: "Amount must not be zero" });
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!user) return reply.code(404).send({ error: "User not found" });

    const { transaction } = await postTransaction(db, {
      userId: id,
      type: micros > 0 ? "credit" : "adjustment",
      amountMicros: micros,
      description,
    });
    await audit(db, { actorId: req.user.id, action: "wallet.adjust", targetType: "user", targetId: id, data: { amount, description } });
    return { balance: formatAmount(transaction!.balanceAfterMicros), currency: config.BILLING_CURRENCY };
  });

  app.post("/admin/billing/run", { preHandler: app.requireAdmin }, async (req) => {
    const result = await runBillingTick({ db, config, queues });
    await audit(db, { actorId: req.user.id, action: "billing.run", targetType: "billing", data: { ...result } });
    return { ...result, total: formatAmount(result.totalMicros) };
  });
}
