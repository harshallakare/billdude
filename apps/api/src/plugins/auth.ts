/**
 * apps/api/src/plugins/auth.ts
 *
 * Usage: session handling for the API. Sessions are signed JWTs stored in an
 * httpOnly cookie. Register once in buildApp(), then protect routes with:
 *
 *   app.get("/x", { preHandler: app.authenticate }, handler)    // any signed-in user
 *   app.get("/y", { preHandler: app.requireAdmin }, handler)    // admins only
 *
 * Inside handlers the signed-in user is `request.user` ({ id, email, role }).
 * The user row is re-read on every request so suspensions apply immediately.
 */
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";

export const SESSION_COOKIE = "bd_session";
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "customer";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: SessionUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyReply {
    startSession: (userId: string) => Promise<void>;
    endSession: () => void;
  }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { db: Db; secret: string; secure: boolean }) => {
  await app.register(cookie);
  await app.register(jwt, {
    secret: opts.secret,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    sign: { expiresIn: SESSION_TTL_SECONDS },
    // Resolve the full user from the token subject on every verify.
    formatUser: (payload) => ({ id: (payload as { sub: string }).sub }) as SessionUser,
  });

  app.decorateReply("startSession", async function (this: FastifyReply, userId: string) {
    const token = await this.jwtSign({ sub: userId });
    this.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: opts.secure,
      maxAge: SESSION_TTL_SECONDS,
    });
  });

  app.decorateReply("endSession", function (this: FastifyReply) {
    this.clearCookie(SESSION_COOKIE, { path: "/" });
  });

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Not signed in" });
    }
    const [user] = await opts.db.select().from(users).where(eq(users.id, req.user.id));
    if (!user || user.status !== "active") {
      reply.endSession();
      return reply.code(401).send({ error: "Account is not active" });
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  });

  app.decorate("requireAdmin", async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    if (reply.sent) return;
    if (req.user.role !== "admin") return reply.code(403).send({ error: "Admins only" });
  });
});
