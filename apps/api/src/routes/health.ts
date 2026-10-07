/**
 * apps/api/src/routes/health.ts
 *
 * Usage: liveness/readiness probe for load balancers and Docker.
 *   GET /api/health  -> 200 { ok: true, db: "up", redis: "up" } or 503
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";

export async function healthRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get("/health", async (_req, reply) => {
    const db = await deps.db.execute(sql`select 1`).then(
      () => "up",
      () => "down",
    );
    const redis = await deps.redis.ping().then(
      () => "up",
      () => "down",
    );
    const ok = db === "up" && redis === "up";
    return reply.code(ok ? 200 : 503).send({ ok, db, redis });
  });
}
