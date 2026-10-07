/**
 * apps/api/src/routes/auth.ts
 *
 * Usage: account endpoints (mounted under /api):
 *   POST /auth/register  { email, name, password }  -> creates a customer and signs in
 *   POST /auth/login     { email, password }        -> sets the session cookie
 *   POST /auth/logout                                -> clears it
 *   GET  /auth/me                                    -> current user or 401
 * Register and login are rate-limited per IP.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password.js";
import { users } from "../db/schema.js";
import { postTransaction } from "../billing/ledger.js";
import { parseAmount } from "../billing/money.js";
import { enqueueAccountOp } from "../jobs/queue.js";

const registerBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
});

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance, { db, queues, config }: AppDeps) {
  const strictLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT, timeWindow: "1 minute" } };
  app.post("/auth/register", { config: strictLimit }, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) return reply.code(409).send({ error: "An account with this email already exists" });

    const [user] = await db
      .insert(users)
      .values({ email: body.email, name: body.name, passwordHash: await hashPassword(body.password) })
      .returning();
    await audit(db, { actorId: user!.id, action: "user.register", targetType: "user", targetId: user!.id });
    const signupCredit = parseAmount(config.BILLING_SIGNUP_CREDIT);
    if (signupCredit > 0) {
      await postTransaction(db, {
        userId: user!.id,
        type: "credit",
        amountMicros: signupCredit,
        description: "Welcome credit",
        reference: `signup:${user!.id}`,
      });
    }
    // Create the customer's VHI project in the background so their first server starts faster.
    await enqueueAccountOp(queues.account, { userId: user!.id, op: "provision" });
    await reply.startSession(user!.id);
    return reply.code(201).send({ user: publicUser(user!) });
  });

  app.post("/auth/login", { config: strictLimit }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    const valid = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, body.password);
    if (!user || !valid) return reply.code(401).send({ error: "Invalid email or password" });
    if (user.status !== "active") return reply.code(403).send({ error: "This account is suspended" });

    await audit(db, { actorId: user.id, action: "user.login", targetType: "user", targetId: user.id });
    await reply.startSession(user.id);
    return { user: publicUser(user) };
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.endSession();
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req) => ({ user: req.user }));
}

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}
