/**
 * apps/api/src/app.ts
 *
 * Usage: builds the Fastify application from explicit dependencies, so the
 * same function serves production (src/main.ts) and tests:
 *
 *   const app = await buildApp({ config, db, redis, queues, vhi, catalog, gateway });
 *   await app.listen({ port: config.API_PORT });
 *   // tests: await app.inject({ method: "GET", url: "/api/health" })
 *
 * All routes live under the /api prefix.
 */
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { VhiError, VhiQuotaError, type VhiConnector } from "@billdude/vhi-connector";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import type { PaymentGateway } from "./billing/gateway.js";
import type { Catalog } from "./catalog.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { Queues } from "./jobs/queue.js";
import { authPlugin } from "./plugins/auth.js";
import { accountRoutes } from "./routes/account.js";
import { adminBillingRoutes } from "./routes/admin-billing.js";
import { adminRoutes } from "./routes/admin.js";
import { billingRoutes } from "./routes/billing.js";
import { authRoutes } from "./routes/auth.js";
import { catalogRoutes } from "./routes/catalog.js";
import { healthRoutes } from "./routes/health.js";
import { serverRoutes } from "./routes/servers.js";
import { sshKeyRoutes } from "./routes/ssh-keys.js";

export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis;
  queues: Queues;
  vhi: VhiConnector;
  catalog: Catalog;
  gateway: PaymentGateway;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.NODE_ENV === "production" ? "info" : "debug" },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  });
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin, { db: deps.db, secret: config.JWT_SECRET, secure: config.NODE_ENV === "production" });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (error instanceof VhiQuotaError) {
      return reply.code(403).send({ error: "Your resource quota does not allow this." });
    }
    if (error instanceof VhiError) {
      req.log.error({ err: error }, "VHI call failed");
      return reply.code(502).send({ error: "The cloud platform is unavailable. Please try again shortly." });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ error: (error as Error).message });
    }
    req.log.error({ err: error }, "Unhandled error");
    return reply.code(500).send({ error: "Internal server error" });
  });

  await app.register(
    async (api) => {
      await healthRoutes(api, deps);
      await authRoutes(api, deps);
      await catalogRoutes(api, deps);
      await serverRoutes(api, deps);
      await sshKeyRoutes(api, deps);
      await accountRoutes(api, deps);
      await billingRoutes(api, deps);
      await adminRoutes(api, deps);
      await adminBillingRoutes(api, deps);
    },
    { prefix: "/api" },
  );

  return app;
}
