/**
 * apps/api/test/servers.test.ts
 *
 * Usage: end-to-end VM lifecycle tests: API -> queue -> worker -> mock VHI ->
 * database. Run with `pnpm --filter @billdude/api test` (see vitest.config.ts).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servers } from "../src/db/schema.js";
import { createProcessors, SERVER_TAG } from "../src/jobs/processor.js";
import { eventually, startStack, VALID_SERVER, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

type Agent = Awaited<ReturnType<Stack["signUp"]>>;
const statusOf = (agent: Agent, id: string) => () => agent.get(`/api/servers/${id}`).then((r) => r.body.server);

describe("servers", () => {
  it("exposes the VHI catalog", async () => {
    const alice = await stack.signUp("catalog@example.com");
    const res = await alice.get("/api/catalog");
    expect(res.status).toBe(200);
    expect(res.body.flavors.length).toBeGreaterThan(0);
    expect(res.body.images.length).toBeGreaterThan(0);
    expect(res.body.networks.length).toBeGreaterThan(0);
  });

  it("runs a full lifecycle: create, stop, start, reboot, console, delete", async () => {
    const alice = await stack.signUp("alice@example.com");
    const created = await alice.post("/api/servers", VALID_SERVER);
    expect(created.status).toBe(202);
    const id = created.body.server.id as string;
    expect(created.body.server.status).toBe("pending");

    const active = await eventually(statusOf(alice, id), (s) => s.status === "active");
    expect(active.ipv4).toMatch(/^10\.0\.0\./);

    // Two quick clicks: the second is refused while the first is in flight.
    expect((await alice.post(`/api/servers/${id}/actions`, { action: "stop" })).status).toBe(202);
    expect((await alice.post(`/api/servers/${id}/actions`, { action: "stop" })).status).toBe(409);
    await eventually(statusOf(alice, id), (s) => s.status === "stopped");

    expect((await alice.get(`/api/servers/${id}/console`)).status).toBe(409);

    expect((await alice.post(`/api/servers/${id}/actions`, { action: "start" })).status).toBe(202);
    await eventually(statusOf(alice, id), (s) => s.status === "active");
    expect((await alice.post(`/api/servers/${id}/actions`, { action: "reboot" })).status).toBe(202);
    await eventually(statusOf(alice, id), (s) => s.status === "active");

    const console = await alice.get(`/api/servers/${id}/console`);
    expect(console.status).toBe(200);
    expect(console.body.url).toMatch(/vnc_auto\.html/);

    expect((await alice.delete(`/api/servers/${id}`)).status).toBe(202);
    await eventually(
      () => alice.get("/api/servers").then((r) => r.body.servers as { id: string }[]),
      (list) => !list.some((s) => s.id === id),
    );
    const [row] = await stack.db.select().from(servers).where(eq(servers.id, id));
    expect(row?.status).toBe("deleted");
    expect(await stack.vhi.project(row!.vhiProjectId!).getServer(row!.vhiServerId!)).toBeNull();
  });

  it("shows the provider fault when VHI fails the build", async () => {
    const carol = await stack.signUp("carol@example.com");
    const created = await carol.post("/api/servers", { ...VALID_SERVER, name: "please-fail" });
    const server = await eventually(statusOf(carol, created.body.server.id), (s) => s.status === "error");
    expect(server.statusMessage).toMatch(/No valid host/);
  });

  it("validates input against the catalog", async () => {
    const dave = await stack.signUp("dave@example.com");
    expect((await dave.post("/api/servers", { ...VALID_SERVER, name: "bad name!" })).status).toBe(400);
    expect((await dave.post("/api/servers", { ...VALID_SERVER, flavorId: "nope" })).status).toBe(400);
    expect((await dave.post("/api/servers", { ...VALID_SERVER, bootVolumeGb: 5 })).status).toBe(400);
  });

  it("keeps customers out of each other's servers", async () => {
    const erin = await stack.signUp("erin@example.com");
    const frank = await stack.signUp("frank@example.com");
    const { body } = await erin.post("/api/servers", VALID_SERVER);
    const id = body.server.id as string;

    expect((await frank.get(`/api/servers/${id}`)).status).toBe(404);
    expect((await frank.delete(`/api/servers/${id}`)).status).toBe(404);
    expect((await frank.get("/api/servers")).body.servers).toEqual([]);

    const admin = await stack.createAdmin("root@example.com");
    const all = await admin.get("/api/servers?all=true");
    expect(all.body.servers.map((s: { id: string }) => s.id)).toContain(id);
  });

  it("adopts an already-created VM instead of creating a duplicate on retry", async () => {
    const gina = await stack.signUp("gina@example.com");
    const ownerId = await stack.userId("gina@example.com");
    // Simulate a crash after createServer() but before the id was saved.
    const projectId = await stack.accounts.ensureProject(ownerId);
    const [row] = await stack.db
      .insert(servers)
      .values({ ...VALID_SERVER, name: "crashy", ownerId, vhiProjectId: projectId })
      .returning();
    const project = stack.vhi.project(projectId);
    const { id: vmId } = await project.createServer({ ...VALID_SERVER, name: "crashy", metadata: { [SERVER_TAG]: row!.id } });

    const { processVmJob } = createProcessors({ db: stack.db, vhi: stack.vhi, accounts: stack.accounts, pollMs: 10 });
    await processVmJob({ serverId: row!.id, op: "create", actorId: null });

    const [after] = await stack.db.select().from(servers).where(eq(servers.id, row!.id));
    expect(after).toMatchObject({ vhiServerId: vmId, status: "active" });
    const tagged = await project.listServers({ metadata: { [SERVER_TAG]: row!.id } });
    expect(tagged).toHaveLength(1);
    expect((await gina.get(`/api/servers/${row!.id}`)).body.server.status).toBe("active");
  });
});
