/**
 * apps/api/test/support.test.ts
 *
 * Usage: integration tests for support tickets and the admin overview,
 * customer detail and audit endpoints. Run with `pnpm --filter @billdude/api test`.
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

describe("support tickets", () => {
  it("runs a conversation between a customer and support", async () => {
    const alice = await stack.signUp("alice@example.com");
    const admin = await stack.createAdmin();

    const created = await alice.post("/api/tickets", { subject: "Cannot SSH", body: "Connection refused on port 22" });
    expect(created.status).toBe(201);
    const id = created.body.ticket.id as string;
    expect(created.body.ticket.status).toBe("open");

    const queue = await admin.get("/api/admin/tickets?status=open");
    expect(queue.body.tickets.map((t: { id: string }) => t.id)).toContain(id);

    expect((await admin.post(`/api/tickets/${id}/messages`, { body: "Please check your security group." })).body.status).toBe(
      "answered",
    );
    const view = await alice.get(`/api/tickets/${id}`);
    expect(view.body.ticket.status).toBe("answered");
    expect(view.body.messages.map((m: { authorName: string }) => m.authorName)).toEqual(["alice@example.com", "Support"]);

    expect((await alice.post(`/api/tickets/${id}/close`)).body.status).toBe("closed");
    // A customer reply reopens it.
    expect((await alice.post(`/api/tickets/${id}/messages`, { body: "Still broken" })).body.status).toBe("open");
  });

  it("keeps tickets private to their owner", async () => {
    const bob = await stack.signUp("bob@example.com");
    const carol = await stack.signUp("carol@example.com");
    const { body } = await bob.post("/api/tickets", { subject: "Billing question", body: "Why was I charged?" });
    expect((await carol.get(`/api/tickets/${body.ticket.id}`)).status).toBe(404);
    expect((await carol.post(`/api/tickets/${body.ticket.id}/messages`, { body: "hi" })).status).toBe(404);
    expect((await carol.get("/api/tickets")).body.tickets).toEqual([]);
    expect((await carol.get("/api/admin/tickets")).status).toBe(403);
  });
});

describe("admin views", () => {
  it("summarises the platform and shows a customer's detail and audit trail", async () => {
    const dave = await stack.signUp("dave@example.com");
    const daveId = await stack.userId("dave@example.com");
    await dave.post("/api/tickets", { subject: "Hello", body: "Just saying hi" });
    const admin = await stack.createAdmin("ops@example.com");

    const overview = await admin.get("/api/admin/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.customers).toBeGreaterThanOrEqual(1);
    expect(overview.body.openTickets).toBeGreaterThanOrEqual(1);

    const detail = await admin.get(`/api/admin/users/${daveId}`);
    expect(detail.body.user).toMatchObject({ email: "dave@example.com", balance: "1000.00" });
    expect(detail.body.user.passwordHash).toBeUndefined();
    expect(detail.body.transactions[0]).toMatchObject({ type: "credit", amount: "1000.00" });

    const audit = await admin.get(`/api/admin/audit?actorId=${daveId}`);
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["user.register", "ticket.create"]),
    );
    expect((await dave.get("/api/admin/overview")).status).toBe(403);
  });
});
