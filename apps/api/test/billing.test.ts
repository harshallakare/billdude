/**
 * apps/api/test/billing.test.ts
 *
 * Usage: integration tests for wallets, pricing, metering, top-ups (fake and
 * Razorpay signatures), statements and non-payment enforcement.
 * Run with `pnpm --filter @billdude/api test`.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_SIGNATURE, RazorpayGateway } from "../src/billing/gateway.js";
import { runBillingTick } from "../src/billing/metering.js";
import { formatAmount, parseAmount, toMinorUnits } from "../src/billing/money.js";
import { settlePayment } from "../src/billing/payments.js";
import { payments, servers, users, walletTransactions } from "../src/db/schema.js";
import { eventually, startStack, VALID_SERVER, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({
    BILLING_SIGNUP_CREDIT: "0",
    BILLING_VCPU_HOURLY: "0.60",
    BILLING_RAM_GB_HOURLY: "0.30",
    BILLING_STORAGE_GB_MONTHLY: "7.30",
    BILLING_GRACE_HOURS: "24",
  });
});
afterAll(async () => {
  await stack.stop();
});

type Agent = Awaited<ReturnType<Stack["signUp"]>>;

async function topUp(agent: Agent, amount: number) {
  const order = await agent.post("/api/billing/topups", { amount });
  expect(order.status).toBe(201);
  const verify = await agent.post("/api/billing/topups/verify", {
    orderId: order.body.orderId,
    paymentId: `pay_fake_${order.body.orderId}`,
    signature: FAKE_SIGNATURE,
  });
  expect(verify.status).toBe(200);
  return verify.body;
}

async function activeServer(agent: Agent, name = "web-1") {
  const res = await agent.post("/api/servers", { ...VALID_SERVER, name });
  expect(res.status).toBe(202);
  await eventually(
    () => agent.get(`/api/servers/${res.body.server.id}`).then((r) => r.body.server.status),
    (s) => s === "active",
  );
  return res.body.server.id as string;
}

/** Rewinds a server's billing clock so a tick has something to charge. */
async function backdate(serverId: string, hours: number, now = new Date()) {
  await stack.db
    .update(servers)
    .set({ billingStartedAt: new Date(now.getTime() - hours * 3600_000), billedUntil: null })
    .where(eq(servers.id, serverId));
}

describe("money", () => {
  it("parses and formats exactly", () => {
    expect(parseAmount("0.1")).toBe(100_000);
    expect(parseAmount("12.345678")).toBe(12_345_678);
    expect(formatAmount(-3_075_000)).toBe("-3.08");
    expect(toMinorUnits(12_345_678)).toBe(1235);
  });
});

describe("wallet and top-ups", () => {
  it("blocks server creation until the wallet is funded", async () => {
    const alice = await stack.signUp("alice@example.com");
    const res = await alice.post("/api/servers", VALID_SERVER);
    expect(res.status).toBe(402);
    expect((await alice.get("/api/billing/wallet")).body).toMatchObject({ balance: "0.00", currency: "INR", gateway: "fake" });
  });

  it("credits the wallet once per payment, however often it is confirmed", async () => {
    const bob = await stack.signUp("bob@example.com");
    const order = await bob.post("/api/billing/topups", { amount: 500 });
    const confirm = () =>
      bob.post("/api/billing/topups/verify", {
        orderId: order.body.orderId,
        paymentId: `pay_fake_${order.body.orderId}`,
        signature: FAKE_SIGNATURE,
      });
    expect((await confirm()).body).toMatchObject({ status: "paid", balance: "500.00" });
    expect((await confirm()).body).toMatchObject({ status: "paid", balance: "500.00" });

    const txs = await bob.get("/api/billing/transactions");
    expect(txs.body.transactions).toHaveLength(1);
    expect(txs.body.transactions[0]).toMatchObject({ type: "topup", amount: "500.00", balanceAfter: "500.00" });
  });

  it("rejects bad signatures, foreign orders and out-of-range amounts", async () => {
    const carol = await stack.signUp("carol@example.com");
    const dave = await stack.signUp("dave@example.com");
    expect((await carol.post("/api/billing/topups", { amount: 5 })).status).toBe(400);
    const order = await carol.post("/api/billing/topups", { amount: 200 });
    const paymentId = `pay_fake_${order.body.orderId}`;
    expect(
      (await carol.post("/api/billing/topups/verify", { orderId: order.body.orderId, paymentId, signature: "forged" })).status,
    ).toBe(400);
    expect(
      (await dave.post("/api/billing/topups/verify", { orderId: order.body.orderId, paymentId, signature: FAKE_SIGNATURE }))
        .status,
    ).toBe(404);
    expect((await carol.get("/api/billing/wallet")).body.balance).toBe("0.00");
  });
});

describe("metering", () => {
  it("charges per second for compute and storage, exactly once per period", async () => {
    const erin = await stack.signUp("erin@example.com");
    await topUp(erin, 1000);
    const serverId = await activeServer(erin);

    const now = new Date();
    await backdate(serverId, 10, now);
    const first = await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, now);
    // s1.small: 1 vCPU * 0.60 + 2 GB * 0.30 = 1.20/h; 20 GB * 7.30/730 = 0.20/h  -> 1.40/h * 10 h = 14.00
    expect(first.charged).toBeGreaterThanOrEqual(1);
    expect((await erin.get("/api/billing/wallet")).body.balance).toBe("986.00");

    // Running again at the same instant charges nothing more.
    await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, now);
    expect((await erin.get("/api/billing/wallet")).body.balance).toBe("986.00");

    // Half an hour later: 0.70 more.
    await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, new Date(now.getTime() + 1800_000));
    expect((await erin.get("/api/billing/wallet")).body).toMatchObject({ balance: "985.30", hourlyBurn: "1.40" });
  });

  it("uses admin price overrides and stops charging after deletion", async () => {
    const admin = await stack.createAdmin();
    expect((await admin.put("/api/admin/pricing/flavors/f-medium", { hourly: "2.50" })).status).toBe(200);
    const pricing = await admin.get("/api/admin/pricing");
    expect(pricing.body.flavors.find((f: { flavorId: string }) => f.flavorId === "f-medium")).toMatchObject({
      hourly: "2.50",
      monthly: "1825.00",
      override: true,
    });

    const frank = await stack.signUp("frank@example.com");
    await topUp(frank, 1000);
    const res = await frank.post("/api/servers", { ...VALID_SERVER, flavorId: "f-medium", bootVolumeGb: 10, name: "big" });
    const id = res.body.server.id as string;
    await eventually(
      () => frank.get(`/api/servers/${id}`).then((r) => r.body.server.status),
      (s) => s === "active",
    );
    await frank.delete(`/api/servers/${id}`);
    await eventually(
      () => stack.db.select().from(servers).where(eq(servers.id, id)).then((r) => r[0]!.status),
      (s) => s === "deleted",
    );
    // Pretend it lived for exactly 2 hours before deletion.
    const [row] = await stack.db.select().from(servers).where(eq(servers.id, id));
    await stack.db
      .update(servers)
      .set({ billingStartedAt: new Date(row!.deletedAt!.getTime() - 2 * 3600_000), billedUntil: null })
      .where(eq(servers.id, id));

    // Billing well after deletion only charges up to deletion: 2 h * (2.50 + 10 GB * 0.01) = 5.20
    await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, new Date(Date.now() + 5 * 3600_000));
    expect((await frank.get("/api/billing/wallet")).body.balance).toBe("994.80");

    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
      .format(row!.deletedAt!)
      .slice(0, 7);
    const statement = await frank.get(`/api/billing/statements/${month}`);
    expect(statement.body).toMatchObject({ usageTotal: "5.20", openingBalance: "0.00", closingBalance: "994.80" });
    expect(statement.body.lines[0]).toMatchObject({ name: "big", hours: 2, compute: "5.00", storage: "0.20" });
    expect(statement.body.payments[0]).toMatchObject({ type: "topup", amount: "1000.00" });
  });

  it("stops running servers once an overdue balance outlasts the grace period", async () => {
    const gina = await stack.signUp("gina@example.com");
    await topUp(gina, 100);
    const serverId = await activeServer(gina);

    const now = new Date();
    await backdate(serverId, 100, now); // 100 h * 1.40 = 140.00 > 100.00 balance
    await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, now);
    const wallet = (await gina.get("/api/billing/wallet")).body;
    expect(wallet.balance).toBe("-40.00");
    expect(wallet.overdueSince).not.toBeNull();
    expect((await gina.post("/api/servers", { ...VALID_SERVER, name: "more" })).status).toBe(402);

    // Within the grace period nothing is stopped...
    expect((await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, now)).stopped).toBe(0);
    // ...after it, the server is.
    const later = new Date(now.getTime() + 25 * 3600_000);
    expect((await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, later)).stopped).toBe(1);
    await eventually(
      () => gina.get(`/api/servers/${serverId}`).then((r) => r.body.server.status),
      (s) => s === "stopped",
    );

    // Topping up clears the overdue state and allows starting again.
    await topUp(gina, 200);
    const [user] = await stack.db.select().from(users).where(eq(users.email, "gina@example.com"));
    expect(user!.overdueSince).toBeNull();
    expect((await gina.post(`/api/servers/${serverId}/actions`, { action: "start" })).status).toBe(202);
  });
});

describe("admin wallet adjustments", () => {
  it("credits and debits through the ledger", async () => {
    const henry = await stack.signUp("henry@example.com");
    const henryId = await stack.userId("henry@example.com");
    const admin = await stack.createAdmin("root@example.com");
    expect((await admin.post(`/api/admin/users/${henryId}/wallet`, { amount: "50", description: "Goodwill" })).body.balance).toBe(
      "50.00",
    );
    expect(
      (await admin.post(`/api/admin/users/${henryId}/wallet`, { amount: "-12.50", description: "Correction" })).body.balance,
    ).toBe("37.50");
    expect((await henry.post(`/api/admin/users/${henryId}/wallet`, { amount: "1000", description: "free money" })).status).toBe(
      403,
    );
    const types = (await henry.get("/api/billing/transactions")).body.transactions.map((t: { type: string }) => t.type);
    expect(types).toEqual(["adjustment", "credit"]);
  });
});

describe("razorpay", () => {
  const keySecret = "test_key_secret";
  const webhookSecret = "test_webhook_secret";

  /** A Razorpay gateway whose HTTP calls are answered locally. */
  function fakeRazorpay(payment: { id: string; order_id: string; amount: number; currency: string; status: string }) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const body = url.endsWith("/capture") ? { ...payment, status: "captured" } : payment;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return { gateway: new RazorpayGateway("rzp_test_key", keySecret, webhookSecret, fetchImpl), calls };
  }

  it("verifies checkout and webhook signatures with HMAC-SHA256", () => {
    const { gateway } = fakeRazorpay({ id: "pay_1", order_id: "order_1", amount: 100, currency: "INR", status: "captured" });
    const good = createHmac("sha256", keySecret).update("order_1|pay_1").digest("hex");
    expect(gateway.verifyCheckoutSignature("order_1", "pay_1", good)).toBe(true);
    expect(gateway.verifyCheckoutSignature("order_1", "pay_2", good)).toBe(false);

    const raw = Buffer.from('{"event":"payment.captured"}');
    const sig = createHmac("sha256", webhookSecret).update(raw).digest("hex");
    expect(gateway.verifyWebhookSignature(raw, sig)).toBe(true);
    expect(gateway.verifyWebhookSignature(Buffer.from("{}"), sig)).toBe(false);
  });

  it("captures authorized payments and refuses amount mismatches", async () => {
    await stack.signUp("ivan@example.com");
    const ivanId = await stack.userId("ivan@example.com");
    await stack.db.insert(payments).values({
      userId: ivanId,
      gateway: "razorpay",
      orderId: "order_rzp_1",
      amountMinor: 50000,
      currency: "INR",
    });

    const tampered = fakeRazorpay({ id: "pay_x", order_id: "order_rzp_1", amount: 100, currency: "INR", status: "captured" });
    await expect(
      settlePayment(stack.db, tampered.gateway, { id: "pay_x", orderId: "order_rzp_1", amount: 100, currency: "INR", status: "captured" }),
    ).rejects.toThrow(/does not match/);

    const ok = fakeRazorpay({ id: "pay_ok", order_id: "order_rzp_1", amount: 50000, currency: "INR", status: "authorized" });
    const result = await settlePayment(stack.db, ok.gateway, {
      id: "pay_ok",
      orderId: "order_rzp_1",
      amount: 50000,
      currency: "INR",
      status: "authorized",
    });
    expect(result.credited).toBe(true);
    expect(ok.calls).toContain("POST /v1/payments/pay_ok/capture");
    const [user] = await stack.db.select().from(users).where(eq(users.id, ivanId));
    expect(formatAmount(user!.balanceMicros)).toBe("500.00");
    const ledger = await stack.db.select().from(walletTransactions).where(eq(walletTransactions.userId, ivanId));
    expect(ledger).toHaveLength(1);
  });

  it("rejects webhooks with a bad signature", async () => {
    const res = await stack.app.inject({
      method: "POST",
      url: "/api/billing/razorpay/webhook",
      headers: { "content-type": "application/json", "x-razorpay-signature": "nope" },
      payload: '{"event":"payment.captured"}',
    });
    expect(res.statusCode).toBe(400);
  });
});
