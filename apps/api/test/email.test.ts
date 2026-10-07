/**
 * apps/api/test/email.test.ts
 *
 * Usage: integration tests for email verification, password reset/change
 * (with session invalidation) and notification emails.
 * Run with `pnpm --filter @billdude/api test`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBillingTick } from "../src/billing/metering.js";
import { servers } from "../src/db/schema.js";
import { eventually, startStack, VALID_SERVER, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ REQUIRE_EMAIL_VERIFICATION: "true", SUPPORT_NOTIFY_EMAILS: "support@billdude.test" });
});
afterAll(async () => {
  await stack.stop();
});

/** Waits for an email to `to` whose subject matches, and returns the link in it. */
async function linkFromEmail(to: string, subject: RegExp): Promise<string> {
  const mail = await eventually(
    async () => stack.outbox.find((m) => m.to === to && subject.test(m.subject)),
    (m) => m !== undefined,
  );
  return /https:\/\/\S+/.exec(mail!.text)![0];
}
const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

describe("email verification", () => {
  it("requires a confirmed email before creating servers", async () => {
    const alice = await stack.signUp("alice@example.com");
    expect((await alice.get("/api/auth/me")).body.user.emailVerified).toBe(false);
    expect((await alice.post("/api/servers", VALID_SERVER)).status).toBe(403);

    const link = await linkFromEmail("alice@example.com", /Confirm your email/);
    expect(link).toMatch(/^https:\/\/portal\.test\/verify-email\?token=/);
    expect((await stack.anonymous.post("/api/auth/verify-email", { token: tokenOf(link) })).status).toBe(200);
    // Tokens are single-use.
    expect((await stack.anonymous.post("/api/auth/verify-email", { token: tokenOf(link) })).status).toBe(400);

    expect((await alice.get("/api/auth/me")).body.user.emailVerified).toBe(true);
    expect((await alice.post("/api/servers", VALID_SERVER)).status).toBe(202);
  });
});

describe("password reset", () => {
  it("resets the password via an emailed link and signs out every session", async () => {
    const bob = await stack.signUp("bob@example.com", "original-password-1");
    expect((await stack.anonymous.post("/api/auth/forgot-password", { email: "bob@example.com" })).status).toBe(200);
    // Unknown addresses get the same answer and no email.
    expect((await stack.anonymous.post("/api/auth/forgot-password", { email: "nobody@example.com" })).status).toBe(200);

    const link = await linkFromEmail("bob@example.com", /Reset your password/);
    expect((await stack.anonymous.post("/api/auth/reset-password", { token: tokenOf(link), password: "short" })).status).toBe(400);
    expect(
      (await stack.anonymous.post("/api/auth/reset-password", { token: tokenOf(link), password: "brand-new-password-2" })).status,
    ).toBe(200);
    await eventually(
      async () => stack.outbox.some((m) => m.to === "bob@example.com" && /password was changed/.test(m.subject)),
      (sent) => sent,
    );

    // The old session is dead; the old password no longer works; the new one does.
    expect((await bob.get("/api/auth/me")).status).toBe(401);
    const old = await stack.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bob@example.com", password: "original-password-1" },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await stack.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "bob@example.com", password: "brand-new-password-2" },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("changes the password while keeping the current session", async () => {
    const carol = await stack.signUp("carol@example.com", "original-password-1");
    expect(
      (await carol.post("/api/auth/change-password", { currentPassword: "wrong-password-0", newPassword: "another-password-3" })).status,
    ).toBe(400);
    const res = await stack.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: (await loginCookie("carol@example.com", "original-password-1"))! },
      payload: { currentPassword: "original-password-1", newPassword: "another-password-3" },
    });
    expect(res.statusCode).toBe(200);
    const newCookie = res.cookies.find((c) => c.name === "bd_session")!;
    const me = await stack.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `bd_session=${newCookie.value}` } });
    expect(me.statusCode).toBe(200);
    // The session from sign-up was invalidated.
    expect((await carol.get("/api/auth/me")).status).toBe(401);
  });
});

describe("notifications", () => {
  it("emails support about new tickets and customers about staff replies", async () => {
    const dave = await stack.signUp("dave@example.com");
    const { body } = await dave.post("/api/tickets", { subject: "Help", body: "Please" });
    await linkFromEmail("support@billdude.test", /New support ticket: Help/);
    const admin = await stack.createAdmin();
    await admin.post(`/api/tickets/${body.ticket.id}/messages`, { body: "On it" });
    const link = await linkFromEmail("dave@example.com", /Support replied: Help/);
    expect(link).toBe(`https://portal.test/support/${body.ticket.id}`);
  });

  it("warns once a day when the balance runs low", async () => {
    await stack.signUp("erin@example.com");
    const erinId = await stack.userId("erin@example.com");
    const admin = await stack.createAdmin("ops@example.com");
    // Test users start with 1000.00 of sign-up credit; leave them with 10.00.
    await admin.post(`/api/admin/users/${erinId}/wallet`, { amount: "-990", description: "Test setup" });
    // A running server that costs ~1.36/h leaves ~7 hours of balance.
    await stack.db
      .insert(servers)
      .values({ ...VALID_SERVER, ownerId: erinId, flavorVcpus: 1, flavorRamMb: 2048, status: "active", billingStartedAt: new Date() });

    const deps = { db: stack.db, config: stack.config, queues: stack.queues };
    await runBillingTick(deps);
    await linkFromEmail("erin@example.com", /balance is running low/);
    const count = () => stack.outbox.filter((m) => m.to === "erin@example.com" && /running low/.test(m.subject)).length;
    await runBillingTick(deps);
    await new Promise((r) => setTimeout(r, 200));
    expect(count()).toBe(1);
  });
});

async function loginCookie(email: string, password: string) {
  const res = await stack.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const c = res.cookies.find((x) => x.name === "bd_session");
  return c ? `bd_session=${c.value}` : null;
}
