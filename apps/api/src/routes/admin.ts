/**
 * apps/api/src/routes/admin.ts
 *
 * Usage: admin-only endpoints (mounted under /api):
 *   GET   /admin/overview           -> headline numbers for the admin dashboard
 *   GET   /admin/users              -> every user
 *   GET   /admin/users/:id          -> one user with servers and recent wallet activity
 *   GET   /admin/audit?limit=100&targetId=&actorId=  -> audit trail, newest first
 *   PATCH /admin/users/:id { status: "active" | "suspended" }
 *   PUT   /admin/users/:id/quotas { instances, cores, ramMb, volumes, gigabytes } | null (null = defaults)
 * Admins see every customer's servers through GET /api/servers?all=true.
 */
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { effectiveQuotas } from "../accounts.js";
import { formatAmount } from "../billing/money.js";
import { auditLogs, servers, tickets, users, walletTransactions } from "../db/schema.js";
import { enqueueAccountOp } from "../jobs/queue.js";

const idParams = z.object({ id: z.string().uuid() });
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  targetId: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
});
const patchBody = z.object({ status: z.enum(["active", "suspended"]) });
const quotaValue = z.number().int().min(-1).max(1_000_000);
const quotasBody = z
  .object({ instances: quotaValue, cores: quotaValue, ramMb: quotaValue, volumes: quotaValue, gigabytes: quotaValue })
  .nullable();

export async function adminRoutes(app: FastifyInstance, { db, queues, config }: AppDeps) {
  app.get("/admin/overview", { preHandler: app.requireAdmin }, async () => {
    const monthStart = sql`date_trunc('month', now() at time zone ${config.BILLING_TIMEZONE}) at time zone ${config.BILLING_TIMEZONE}`;
    const [counts] = await db
      .select({
        customers: sql<number>`count(*) filter (where ${users.role} = 'customer')::int`,
        suspended: sql<number>`count(*) filter (where ${users.status} = 'suspended')::int`,
        overdue: sql<number>`count(*) filter (where ${users.overdueSince} is not null)::int`,
        walletTotal: sql<string>`coalesce(sum(${users.balanceMicros}), 0)`,
      })
      .from(users);
    const [serverCounts] = await db
      .select({
        total: sql<number>`count(*) filter (where ${servers.status} <> 'deleted')::int`,
        active: sql<number>`count(*) filter (where ${servers.status} = 'active')::int`,
        error: sql<number>`count(*) filter (where ${servers.status} = 'error')::int`,
      })
      .from(servers);
    const [money] = await db
      .select({
        topups: sql<string>`coalesce(sum(${walletTransactions.amountMicros}) filter (where ${walletTransactions.type} = 'topup'), 0)`,
        usage: sql<string>`coalesce(-sum(${walletTransactions.amountMicros}) filter (where ${walletTransactions.type} = 'usage'), 0)`,
      })
      .from(walletTransactions)
      .where(gte(walletTransactions.createdAt, monthStart));
    const [openTickets] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tickets)
      .where(eq(tickets.status, "open"));
    return {
      currency: config.BILLING_CURRENCY,
      customers: counts!.customers,
      suspended: counts!.suspended,
      overdue: counts!.overdue,
      walletTotal: formatAmount(Number(counts!.walletTotal)),
      servers: serverCounts,
      thisMonth: { topups: formatAmount(Number(money!.topups)), usage: formatAmount(Number(money!.usage)) },
      openTickets: openTickets!.n,
    };
  });

  app.get("/admin/users/:id", { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) return reply.code(404).send({ error: "User not found" });
    const userServers = await db
      .select()
      .from(servers)
      .where(and(eq(servers.ownerId, id), ne(servers.status, "deleted")))
      .orderBy(desc(servers.createdAt));
    const txs = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, id))
      .orderBy(desc(walletTransactions.createdAt))
      .limit(20);
    const { passwordHash: _hash, balanceMicros, ...safe } = user;
    return {
      user: { ...safe, balance: formatAmount(balanceMicros), effectiveQuotas: effectiveQuotas(user, config) },
      servers: userServers.map((s) => ({ id: s.id, name: s.name, status: s.status, ipv4: s.ipv4, flavorId: s.flavorId, createdAt: s.createdAt })),
      transactions: txs.map((t) => ({
        id: t.id,
        type: t.type,
        amount: formatAmount(t.amountMicros),
        balanceAfter: formatAmount(t.balanceAfterMicros),
        description: t.description,
        createdAt: t.createdAt,
      })),
    };
  });

  app.get("/admin/audit", { preHandler: app.requireAdmin }, async (req) => {
    const q = auditQuery.parse(req.query);
    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        data: auditLogs.data,
        actorEmail: users.email,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(
        and(
          q.targetId ? eq(auditLogs.targetId, q.targetId) : undefined,
          q.actorId ? eq(auditLogs.actorId, q.actorId) : undefined,
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.limit);
    return { entries: rows.map((r) => ({ ...r, actorEmail: r.actorEmail ?? "system" })) };
  });

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
        balanceMicros: users.balanceMicros,
        overdueSince: users.overdueSince,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    return {
      users: rows.map(({ balanceMicros, ...u }) => ({
        ...u,
        balance: formatAmount(balanceMicros),
        effectiveQuotas: effectiveQuotas(u, config),
      })),
    };
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
