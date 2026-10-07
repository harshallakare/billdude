/**
 * apps/api/src/routes/firewall.ts
 *
 * Usage: the customer's inbound firewall (mounted under /api, signed-in users).
 * Rules apply to every server in the customer's VHI project.
 *   GET    /firewall                         -> rules
 *   POST   /firewall { protocol, portMin?, portMax?, cidr, description? } -> add a rule
 *   DELETE /firewall/:id                     -> remove a rule
 * Changes are pushed to VHI in the background by the worker (sync-firewall job).
 */
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { firewallRules } from "../db/schema.js";
import { firewallRuleInput, MAX_FIREWALL_RULES } from "../firewall.js";
import { enqueueAccountOp } from "../jobs/queue.js";

const idParams = z.object({ id: z.string().uuid() });

export async function firewallRoutes(app: FastifyInstance, { db, queues }: AppDeps) {
  app.get("/firewall", { preHandler: app.authenticate }, async (req) => ({
    rules: await db.select().from(firewallRules).where(eq(firewallRules.userId, req.user.id)).orderBy(asc(firewallRules.createdAt)),
  }));

  app.post("/firewall", { preHandler: app.authenticate }, async (req, reply) => {
    const rule = firewallRuleInput.parse(req.body);
    const existing = await db.select().from(firewallRules).where(eq(firewallRules.userId, req.user.id));
    if (existing.length >= MAX_FIREWALL_RULES) {
      return reply.code(403).send({ error: `You can have at most ${MAX_FIREWALL_RULES} firewall rules` });
    }
    const duplicate = existing.some(
      (r) => r.protocol === rule.protocol && r.portMin === rule.portMin && r.portMax === rule.portMax && r.cidr === rule.cidr,
    );
    if (duplicate) return reply.code(409).send({ error: "This rule already exists" });

    const [row] = await db
      .insert(firewallRules)
      .values({ ...rule, userId: req.user.id })
      .returning();
    await audit(db, { actorId: req.user.id, action: "firewall.add", targetType: "firewall_rule", targetId: row!.id, data: rule });
    await enqueueAccountOp(queues.account, { userId: req.user.id, op: "sync-firewall" });
    return reply.code(201).send({ rule: row });
  });

  app.delete("/firewall/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [row] = await db
      .delete(firewallRules)
      .where(and(eq(firewallRules.id, id), eq(firewallRules.userId, req.user.id)))
      .returning();
    if (!row) return reply.code(404).send({ error: "Rule not found" });
    await audit(db, { actorId: req.user.id, action: "firewall.remove", targetType: "firewall_rule", targetId: id });
    await enqueueAccountOp(queues.account, { userId: req.user.id, op: "sync-firewall" });
    return { ok: true };
  });
}
