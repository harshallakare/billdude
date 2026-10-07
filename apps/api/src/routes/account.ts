/**
 * apps/api/src/routes/account.ts
 *
 * Usage: the signed-in customer's own account details (mounted under /api):
 *   GET /account/quotas  -> { limits, usage } in instances / cores / ramMb / volumes / gigabytes
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { computeUsage, effectiveQuotas } from "../accounts.js";
import { users } from "../db/schema.js";

export async function accountRoutes(app: FastifyInstance, { db, catalog, config }: AppDeps) {
  app.get("/account/quotas", { preHandler: app.authenticate }, async (req) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.user.id));
    return {
      limits: effectiveQuotas(user!, config),
      usage: await computeUsage(db, await catalog.flavors(), req.user.id),
    };
  });
}
