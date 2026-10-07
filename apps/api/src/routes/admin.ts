/**
 * apps/api/src/routes/admin.ts
 *
 * Usage: admin-only endpoints (mounted under /api):
 *   GET   /admin/users              -> every user
 *   PATCH /admin/users/:id { status: "active" | "suspended" }
 *   PUT   /admin/users/:id/quotas { instances, cores, ramMb, volumes, gigabytes } | null (null = defaults)
 * Admins see every customer's servers through GET /api/servers?all=true.
 */
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { effectiveQuotas } from "../accounts.js";
import { users } from "../db/schema.js";
import { enqueueAccountOp } from "../jobs/queue.js";

const idParams = z.object({ id: z.string().uuid() });
const patchBody = z.object({ status: z.enum(["active", "suspended"]) });
const quotaValue = z.number().int().min(-1).max(1_000_000);
const quotasBody = z
  .object({ instances: quotaValue, cores: quotaValue, ramMb: quotaValue, volumes: quotaValue, gigabytes: quotaValue })
  .nullable();

export async function adminRoutes(app: FastifyInstance, { db, queues, config }: AppDeps) {
  app.get("/admin/users", { preHandler: app.requireAdmin }, async () => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        status: users.status,
        vhiProjectId: users.vhiProjectId,
        quotas: users.quotas,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    return { users: rows.map((u) => ({ ...u, effectiveQuotas: effectiveQuotas(u, config) })) };
  });

  app.patch("/admin/users/:id", { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { status } = patchBody.parse(req.body);
    if (id === req.user.id) return reply.code(400).send({ error: "You cannot change your own status" });
    const [user] = await db.update(users).set({ status }).where(eq(users.id, id)).returning({ id: users.id });
    if (!user) return reply.code(404).send({ error: "User not found" });
    await audit(db, { actorId: req.user.id, action: `user.${status}`, targetType: "user", targetId: id });
    return { ok: true };
  });

  app.put("/admin/users/:id/quotas", { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const quotas = quotasBody.parse(req.body);
    const [user] = await db.update(users).set({ quotas }).where(eq(users.id, id)).returning();
    if (!user) return reply.code(404).send({ error: "User not found" });
    await audit(db, { actorId: req.user.id, action: "user.quotas", targetType: "user", targetId: id, data: { quotas } });
    await enqueueAccountOp(queues.account, { userId: id, op: "sync-quotas" });
    return { quotas: effectiveQuotas(user, config) };
  });
}
