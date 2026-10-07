/**
 * apps/api/test/volumes.test.ts
 *
 * Usage: integration tests for data volumes: lifecycle through the worker and
 * mock VHI, quotas, ownership, server deletion and storage billing.
 * Run with `pnpm --filter @billdude/api test`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBillingTick } from "../src/billing/metering.js";
import { volumes } from "../src/db/schema.js";
import { eventually, startStack, VALID_SERVER, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ QUOTA_GIGABYTES: "200", BILLING_STORAGE_GB_MONTHLY: "7.30" });
});
afterAll(async () => {
  await stack.stop();
});

type Agent = Awaited<ReturnType<Stack["signUp"]>>;

const volumeStatus = (agent: Agent, id: string) => () =>
  agent.get("/api/volumes").then((r) => r.body.volumes.find((v: { id: string }) => v.id === id)?.status ?? "gone");

async function activeServer(agent: Agent, name = "web-1") {
  const res = await agent.post("/api/servers", { ...VALID_SERVER, name });
  await eventually(
    () => agent.get(`/api/servers/${res.body.server.id}`).then((r) => r.body.server.status),
    (s) => s === "active",
  );
  return res.body.server.id as string;
}

describe("volumes", () => {
  it("creates, attaches, detaches and deletes a volume", async () => {
    const alice = await stack.signUp("alice@example.com");
    const serverId = await activeServer(alice);

    const created = await alice.post("/api/volumes", { name: "data", sizeGb: 50 });
    expect(created.status).toBe(202);
    const id = created.body.volume.id as string;
    await eventually(volumeStatus(alice, id), (s) => s === "available");

    expect((await alice.post(`/api/volumes/${id}/attach`, { serverId })).status).toBe(202);
    await eventually(volumeStatus(alice, id), (s) => s === "attached");
    const listed = (await alice.get("/api/volumes")).body.volumes[0];
    expect(listed).toMatchObject({ serverId, serverName: "web-1" });

    expect((await alice.delete(`/api/volumes/${id}`)).body.error).toMatch(/Detach the volume/);
    expect((await alice.post(`/api/volumes/${id}/detach`)).status).toBe(202);
    await eventually(volumeStatus(alice, id), (s) => s === "available");
    expect((await alice.delete(`/api/volumes/${id}`)).status).toBe(202);
    await eventually(volumeStatus(alice, id), (s) => s === "gone");
  });

  it("counts volumes against the disk quota", async () => {
    const bob = await stack.signUp("bob@example.com");
    expect((await bob.post("/api/volumes", { name: "huge", sizeGb: 500 })).body.error).toMatch(/disk \(GB\) quota/);
    expect((await bob.post("/api/volumes", { name: "ok", sizeGb: 150 })).status).toBe(202);
    const quotas = (await bob.get("/api/account/quotas")).body;
    expect(quotas.usage).toMatchObject({ volumes: 1, gigabytes: 150 });
    // A 20 GB boot disk would now exceed the 200 GB quota... 150 + 20 = 170 is fine, 150 + 60 is not.
    expect((await bob.post("/api/servers", { ...VALID_SERVER, bootVolumeGb: 60 })).status).toBe(403);
  });

  it("keeps volumes private and frees them when their server is deleted", async () => {
    const carol = await stack.signUp("carol@example.com");
    const dave = await stack.signUp("dave@example.com");
    const serverId = await activeServer(carol, "app");
    const { body } = await carol.post("/api/volumes", { name: "db", sizeGb: 10 });
    const id = body.volume.id as string;
    await eventually(volumeStatus(carol, id), (s) => s === "available");

    const daveServer = await activeServer(dave, "other");
    expect((await dave.post(`/api/volumes/${id}/attach`, { serverId: daveServer })).status).toBe(404);
    expect((await carol.post(`/api/volumes/${id}/attach`, { serverId: daveServer })).status).toBe(400);

    await carol.post(`/api/volumes/${id}/attach`, { serverId });
    await eventually(volumeStatus(carol, id), (s) => s === "attached");
    await carol.delete(`/api/servers/${serverId}`);
    await eventually(volumeStatus(carol, id), (s) => s === "available");
    const [row] = await stack.db.select().from(volumes).where(eq(volumes.id, id));
    expect(row!.serverId).toBeNull();
  });

  it("bills volume storage per second and shows it on the statement", async () => {
    const erin = await stack.signUp("erin@example.com");
    const { body } = await erin.post("/api/volumes", { name: "archive", sizeGb: 100 });
    const id = body.volume.id as string;
    await eventually(volumeStatus(erin, id), (s) => s === "available");

    const now = new Date();
    await stack.db
      .update(volumes)
      .set({ billingStartedAt: new Date(now.getTime() - 10 * 3600_000), billedUntil: null })
      .where(eq(volumes.id, id));
    await runBillingTick({ db: stack.db, config: stack.config, queues: stack.queues }, now);
    // 100 GB * 7.30 / 730 = 1.00 per hour -> 10.00 for 10 hours (from 1000.00 sign-up credit).
    expect((await erin.get("/api/billing/wallet")).body).toMatchObject({ balance: "990.00", hourlyBurn: "1.00" });

    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
      .format(new Date(now.getTime() - 10 * 3600_000))
      .slice(0, 7);
    const statement = (await erin.get(`/api/billing/statements/${month}`)).body;
    expect(statement.lines.find((l: { name: string }) => l.name === "archive (volume)")).toMatchObject({
      storage: "10.00",
      compute: "0.00",
    });
  });
});
