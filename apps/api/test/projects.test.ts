/**
 * apps/api/test/projects.test.ts
 *
 * Usage: integration tests for per-customer VHI projects, quotas and the
 * network allow-list. Run with `pnpm --filter @billdude/api test`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servers, users } from "../src/db/schema.js";
import { eventually, startStack, VALID_SERVER, type Stack } from "./helpers.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ QUOTA_INSTANCES: "2", QUOTA_CORES: "3" });
});
afterAll(async () => {
  await stack.stop();
});

interface MockProject {
  id: string;
  name: string;
  quotas: { instances: number; cores: number; ram: number; volumes: number; gigabytes: number };
  servers: number;
}
const mockProjects = async () =>
  ((await stack.mock.inject({ method: "GET", url: "/_mock/projects" })).json() as { projects: MockProject[] }).projects;

const projectIdOf = async (email: string) => {
  const [u] = await stack.db.select().from(users).where(eq(users.email, email));
  return u?.vhiProjectId ?? null;
};

describe("customer projects", () => {
  it("provisions a VHI project with default quotas when a customer registers", async () => {
    await stack.signUp("alice@example.com");
    const projectId = await eventually(() => projectIdOf("alice@example.com"), (id) => id !== null);
    const project = (await mockProjects()).find((p) => p.id === projectId);
    expect(project?.name).toBe(`billdude-${await stack.userId("alice@example.com")}`);
    expect(project?.quotas).toMatchObject({ instances: 2, cores: 3 });
  });

  it("puts each customer's servers in their own project", async () => {
    const bob = await stack.signUp("bob@example.com");
    const carol = await stack.signUp("carol@example.com");
    const b = await bob.post("/api/servers", VALID_SERVER);
    const c = await carol.post("/api/servers", VALID_SERVER);
    for (const [agent, res] of [[bob, b], [carol, c]] as const) {
      await eventually(
        () => agent.get(`/api/servers/${res.body.server.id}`).then((r) => r.body.server.status),
        (s) => s === "active",
      );
    }
    const rows = await stack.db.select().from(servers);
    const bobRow = rows.find((r) => r.id === b.body.server.id)!;
    const carolRow = rows.find((r) => r.id === c.body.server.id)!;
    expect(bobRow.vhiProjectId).toBe(await projectIdOf("bob@example.com"));
    expect(carolRow.vhiProjectId).toBe(await projectIdOf("carol@example.com"));
    expect(bobRow.vhiProjectId).not.toBe(carolRow.vhiProjectId);
    // The cloud itself refuses cross-project access.
    expect(await stack.vhi.project(carolRow.vhiProjectId!).getServer(bobRow.vhiServerId!)).toBeNull();
  });

  it("enforces quotas in the portal and reports usage", async () => {
    const dave = await stack.signUp("dave@example.com");
    expect((await dave.post("/api/servers", { ...VALID_SERVER, flavorId: "f-large" })).body.error).toMatch(/vCPU quota/);
    expect((await dave.post("/api/servers", VALID_SERVER)).status).toBe(202);
    expect((await dave.post("/api/servers", { ...VALID_SERVER, name: "web-2" })).status).toBe(202);
    const third = await dave.post("/api/servers", { ...VALID_SERVER, name: "web-3" });
    expect(third.status).toBe(403);
    expect(third.body.error).toMatch(/server quota \(2 of 2 used\)/);

    const quotas = await dave.get("/api/account/quotas");
    expect(quotas.body).toMatchObject({ limits: { instances: 2, cores: 3 }, usage: { instances: 2, cores: 2, gigabytes: 40 } });
  });

  it("lets admins raise a customer's quotas and pushes them to VHI", async () => {
    const erin = await stack.signUp("erin@example.com");
    const erinId = await stack.userId("erin@example.com");
    const projectId = await eventually(() => projectIdOf("erin@example.com"), (id) => id !== null);
    const admin = await stack.createAdmin();
    const res = await admin.put(`/api/admin/users/${erinId}/quotas`, {
      instances: 4,
      cores: 8,
      ramMb: 16384,
      volumes: 4,
      gigabytes: 200,
    });
    expect(res.status).toBe(200);
    await eventually(
      async () => (await mockProjects()).find((p) => p.id === projectId)?.quotas.instances,
      (n) => n === 4,
    );
    expect((await erin.get("/api/account/quotas")).body.limits.instances).toBe(4);
    expect((await erin.put(`/api/admin/users/${erinId}/quotas`, null)).status).toBe(403);
  });

  it("falls back to VHI's own quota enforcement when the portal check is bypassed", async () => {
    const frank = await stack.signUp("frank@example.com");
    const projectId = await eventually(() => projectIdOf("frank@example.com"), (id) => id !== null);
    await stack.vhi.setProjectQuotas(projectId!, { instances: 0, cores: 10, ramMb: 20480, volumes: 10, gigabytes: 500 });
    const res = await frank.post("/api/servers", VALID_SERVER);
    const server = await eventually(
      () => frank.get(`/api/servers/${res.body.server.id}`).then((r) => r.body.server),
      (s) => s.status === "error",
    );
    expect(server.statusMessage).toMatch(/quota/i);
  });

  it("only offers shared networks to customers by default", async () => {
    const gina = await stack.signUp("gina@example.com");
    const { body } = await gina.get("/api/catalog");
    const ids = body.networks.map((n: { id: string }) => n.id);
    expect(ids).toContain("net-private");
    expect(ids).not.toContain("net-infra");
    expect((await gina.post("/api/servers", { ...VALID_SERVER, networkId: "net-infra" })).status).toBe(400);
  });
});

describe("network allow-list", () => {
  it("restricts networks to VHI_ALLOWED_NETWORK_IDS", async () => {
    // Starting a second stack resets the shared test database, so this block runs last.
    const other = await startStack({ VHI_ALLOWED_NETWORK_IDS: "net-public" });
    try {
      const henry = await other.signUp("henry@example.com");
      const { body } = await henry.get("/api/catalog");
      expect(body.networks.map((n: { id: string }) => n.id)).toEqual(["net-public"]);
    } finally {
      await other.stop();
    }
  });
});
