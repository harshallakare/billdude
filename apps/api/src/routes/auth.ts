/**
 * apps/api/src/routes/auth.ts
 *
 * Usage: account endpoints (mounted under /api):
 *   POST /auth/register  { email, name, password }  -> creates a customer, signs in, emails a verification link
 *   POST /auth/login     { email, password }        -> sets the session cookie
 *   POST /auth/logout                                -> clears it
 *   GET  /auth/me                                    -> current user (incl. emailVerified) or 401
 *   POST /auth/verify-email { token }                -> confirms the email address
 *   POST /auth/resend-verification                   -> new verification email (signed in)
 *   POST /auth/forgot-password { email }             -> always 200; emails a reset link if the account exists
 *   POST /auth/reset-password { token, password }    -> sets a new password, signs out all sessions
 *   POST /auth/change-password { currentPassword, newPassword } -> signed in; signs out other sessions
 * Unauthenticated endpoints are rate-limited per IP (AUTH_RATE_LIMIT per minute).
 */
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password.js";
import { consumeToken, issueToken } from "../auth/tokens.js";
import { postTransaction } from "../billing/ledger.js";
import { parseAmount } from "../billing/money.js";
import { firewallRules, users, type User } from "../db/schema.js";
import { DEFAULT_FIREWALL_RULES } from "../firewall.js";
import { enqueueAccountOp, enqueueMail } from "../jobs/queue.js";
import { templates } from "../mail/templates.js";

const password = z.string().min(10, "Password must be at least 10 characters").max(200);
const email = z.string().trim().toLowerCase().email().max(254);

const registerBody = z.object({ email, name: z.string().trim().min(1).max(100), password });
const loginBody = z.object({ email, password: z.string().min(1).max(200) });
const tokenBody = z.object({ token: z.string().min(20).max(200) });
const forgotBody = z.object({ email });
const resetBody = z.object({ token: z.string().min(20).max(200), password });
const changeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });

const VERIFY_TTL_MS = 48 * 3600_000;
const RESET_TTL_MS = 3600_000;

export async function authRoutes(app: FastifyInstance, { db, queues, config }: AppDeps) {
  const strictLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT, timeWindow: "1 minute" } };
  const link = (path: string) => `${config.PUBLIC_URL.replace(/\/+$/, "")}${path}`;

  async function sendVerification(user: Pick<User, "id" | "name" | "email">) {
    const token = await issueToken(db, user.id, "email_verify", VERIFY_TTL_MS);
    await enqueueMail(queues.mail, { to: user.email, ...templates.verifyEmail(user.name, link(`/verify-email?token=${token}`)) });
  }

  app.post("/auth/register", { config: strictLimit }, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) return reply.code(409).send({ error: "An account with this email already exists" });

    const [user] = await db
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        emailVerifiedAt: config.REQUIRE_EMAIL_VERIFICATION ? null : new Date(),
      })
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
    await db.insert(firewallRules).values(DEFAULT_FIREWALL_RULES.map((r) => ({ ...r, userId: user!.id })));
    if (config.REQUIRE_EMAIL_VERIFICATION) await sendVerification(user!);
    // Create the customer's VHI project in the background so their first server starts faster.
    await enqueueAccountOp(queues.account, { userId: user!.id, op: "provision" });
    await reply.startSession(user!);
    return reply.code(201).send({ user: publicUser(user!) });
  });

  app.post("/auth/login", { config: strictLimit }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    const valid = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, body.password);
    if (!user || !valid) return reply.code(401).send({ error: "Invalid email or password" });
    if (user.status !== "active") return reply.code(403).send({ error: "This account is suspended" });

    await audit(db, { actorId: user.id, action: "user.login", targetType: "user", targetId: user.id });
    await reply.startSession(user);
    return { user: publicUser(user) };
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.endSession();
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (req) => ({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, emailVerified: req.user.emailVerified },
  }));

  app.post("/auth/verify-email", { config: strictLimit }, async (req, reply) => {
    const { token } = tokenBody.parse(req.body);
    const userId = await consumeToken(db, token, "email_verify");
    if (!userId) return reply.code(400).send({ error: "This link is invalid or has expired" });
    await db.update(users).set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }).where(eq(users.id, userId));
    await audit(db, { actorId: userId, action: "user.verify_email", targetType: "user", targetId: userId });
    return { ok: true };
  });

  app.post(
    "/auth/resend-verification",
    { preHandler: app.authenticate, config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    async (req) => {
      if (!req.user.emailVerified) await sendVerification(req.user);
      return { ok: true };
    },
  );

  app.post("/auth/forgot-password", { config: strictLimit }, async (req) => {
    const body = forgotBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    // Same response whether or not the account exists, so emails cannot be enumerated.
    if (user && user.status === "active") {
      const token = await issueToken(db, user.id, "password_reset", RESET_TTL_MS);
      await enqueueMail(queues.mail, { to: user.email, ...templates.passwordReset(user.name, link(`/reset-password?token=${token}`)) });
      await audit(db, { actorId: user.id, action: "user.password_reset_requested", targetType: "user", targetId: user.id });
    }
    return { ok: true };
  });

  app.post("/auth/reset-password", { config: strictLimit }, async (req, reply) => {
    const body = resetBody.parse(req.body);
    const userId = await consumeToken(db, body.token, "password_reset");
    if (!userId) return reply.code(400).send({ error: "This link is invalid or has expired" });
    const [user] = await db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.password),
        sessionVersion: sql`${users.sessionVersion} + 1`,
        // Receiving the reset email proves the address.
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
      })
      .where(eq(users.id, userId))
      .returning();
    await audit(db, { actorId: userId, action: "user.password_reset", targetType: "user", targetId: userId });
    await enqueueMail(queues.mail, { to: user!.email, ...templates.passwordChanged(user!.name) });
    reply.endSession();
    return { ok: true };
  });

  app.post("/auth/change-password", { preHandler: app.authenticate, config: strictLimit }, async (req, reply) => {
    const body = changeBody.parse(req.body);
    const [current] = await db.select().from(users).where(eq(users.id, req.user.id));
    if (!(await verifyPassword(current!.passwordHash, body.currentPassword))) {
      return reply.code(400).send({ error: "Your current password is incorrect" });
    }
    const [user] = await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, req.user.id))
      .returning();
    await audit(db, { actorId: req.user.id, action: "user.password_change", targetType: "user", targetId: req.user.id });
    await enqueueMail(queues.mail, { to: user!.email, ...templates.passwordChanged(user!.name) });
    // Keep this browser signed in with the new session version; every other session is now invalid.
    await reply.startSession(user!);
    return { ok: true };
  });
}

function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, emailVerified: u.emailVerifiedAt !== null };
}
