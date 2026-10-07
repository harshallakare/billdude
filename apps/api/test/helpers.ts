/**
 * apps/api/test/helpers.ts
 *
 * Usage: spins up a complete, isolated test stack for API integration tests:
 * a fresh database schema, the mock VHI server, the Fastify app and
 * in-process workers on a unique Redis key prefix.
 *
 *   const stack = await startStack();                       // or startStack({ QUOTA_INSTANCES: "1" })
 *   const agent = await stack.signUp("alice@example.com");
 *   await agent.post("/api/servers", {...});
 *   await stack.stop();
 *
 * Environment: TEST_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/billdude_test)
 * and REDIS_URL (default redis://localhost:6379).
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildMockVhi } from "@billdude/mock-vhi";
import { createVhiConnector } from "@billdude/vhi-connector";
import { eq, sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { createCatalog } from "../src/catalog.js";
import { loadConfig, vhiOptions } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { users } from "../src/db/schema.js";
import { createAccountService } from "../src/accounts.js";
import { createGateway } from "../src/billing/gateway.js";
import { createQueues } from "../src/jobs/queue.js";
import { createWorkers } from "../src/jobs/worker.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/billdude_test";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function startStack(env: Record<string, string> = {}) {
  // Fresh schema for every test file.
  const reset = createDb(DATABASE_URL);
  await reset.db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await reset.pool.end();
  await runMigrations(DATABASE_URL);

  const mock = buildMockVhi({ buildMs: 60, actionMs: 30 });
  await mock.listen({ port: 0, host: "127.0.0.1" });
  const { port } = mock.server.address() as AddressInfo;

  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL,
    REDIS_URL,
    VHI_AUTH_URL: `http://127.0.0.1:${port}/identity/v3`,
    VHI_USERNAME: "admin",
    VHI_PASSWORD: "admin",
    VHI_PROJECT_NAME: "billdude",
    // Enough credit that tests unrelated to billing can create servers.
    BILLING_SIGNUP_CREDIT: "1000",
    AUTH_RATE_LIMIT: "1000",
    ...env,
  });

  const { db, pool } = createDb(DATABASE_URL);
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const prefix = `bdtest-${randomUUID()}`;
  const queues = createQueues(redis, prefix);
  const vhi = createVhiConnector(vhiOptions(config));
  const catalog = createCatalog(vhi, { allowedNetworkIds: config.VHI_ALLOWED_NETWORK_IDS });
  const accounts = createAccountService({ db, vhi, config });
  const gateway = createGateway(config);
  const app = await buildApp({ config, db, redis, queues, vhi, catalog, gateway });
  const workers = createWorkers({ db, vhi, accounts, config, queues, connection: redis, prefix, pollMs: 10, concurrency: 5 });

  const agentFor = (cookie: string) => {
    const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, payload: payload as object, headers: { cookie } });
      return { status: res.statusCode, body: res.body ? res.json() : undefined };
    };
    return {
      get: (url: string) => call("GET", url),
      post: (url: string, payload?: unknown) => call("POST", url, payload ?? {}),
      put: (url: string, payload?: unknown) => call("PUT", url, payload),
      patch: (url: string, payload?: unknown) => call("PATCH", url, payload),
      delete: (url: string) => call("DELETE", url),
    };
  };

  const login = async (email: string, password: string) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    const cookie = res.cookies.find((c) => c.name === "bd_session");
    return agentFor(`bd_session=${cookie!.value}`);
  };

  return {
    app,
    db,
    vhi,
    accounts,
    config,
    queues,
    gateway,
    mock,
    anonymous: agentFor(""),
    async signUp(email: string, password = "correct-horse-battery") {
      const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name: email, password } });
      if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
      return login(email, password);
    },
    async createAdmin(email = "admin@example.com", password = "admin-password-123") {
      await db.insert(users).values({ email, name: "Admin", role: "admin", passwordHash: await hashPassword(password) });
      return login(email, password);
    },
    async userId(email: string) {
      const [u] = await db.select().from(users).where(eq(users.email, email));
      return u!.id;
    },
    async stop() {
      await workers.close();
      for (const queue of [queues.vm, queues.account, queues.billing]) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      await app.close();
      redis.disconnect();
      await pool.end();
      await mock.close();
    },
  };
}

/** Polls `fn` until `predicate` holds or the timeout elapses. */
export async function eventually<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() < deadline);
  throw new Error(`condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}

export const VALID_SERVER = {
  name: "web-1",
  flavorId: "f-small",
  imageId: "img-ubuntu-2404",
  networkId: "net-private",
  bootVolumeGb: 20,
};
