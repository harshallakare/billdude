/**
 * apps/api/test/auth.test.ts
 *
 * Usage: integration tests for registration, login, sessions and admin user
 * management. Run with `pnpm --filter @billdude/api test` (see vitest.config.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

describe("auth", () => {
  it("reports health", async () => {
    const res = await stack.anonymous.get("/api/health");
    expect(res).toMatchObject({ status: 200, body: { ok: true, db: "up", redis: "up" } });
  });

  it("registers, reads the session and logs out", async () => {
    const alice = await stack.signUp("alice@example.com");
    const me = await alice.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: "alice@example.com", role: "customer" });
  });

  it("rejects duplicate emails, weak passwords and bad logins", async () => {
    const dup = await stack.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "ALICE@example.com", name: "x", password: "another-password" },
    });
    expect(dup.statusCode).toBe(409);

    const weak = await stack.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "weak@example.com", name: "x", password: "short" },
    });
    expect(weak.statusCode).toBe(400);

    const bad = await stack.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "alice@example.com", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("requires a session for protected routes", async () => {
    expect((await stack.anonymous.get("/api/auth/me")).status).toBe(401);
    expect((await stack.anonymous.get("/api/servers")).status).toBe(401);
  });

  it("limits admin routes to admins and applies suspensions immediately", async () => {
    const bob = await stack.signUp("bob@example.com");
    expect((await bob.get("/api/admin/users")).status).toBe(403);

    const admin = await stack.createAdmin();
    const list = await admin.get("/api/admin/users");
    expect(list.status).toBe(200);
    expect(list.body.users.map((u: { email: string }) => u.email)).toContain("bob@example.com");

    const bobId = await stack.userId("bob@example.com");
    expect((await admin.patch(`/api/admin/users/${bobId}`, { status: "suspended" })).status).toBe(200);
    expect((await bob.get("/api/auth/me")).status).toBe(401);
  });
});
