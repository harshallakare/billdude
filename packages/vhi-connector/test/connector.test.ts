/**
 * packages/vhi-connector/test/connector.test.ts
 *
 * Usage: integration tests for OpenStackVhiConnector against the mock VHI
 * server (no real cluster needed). Run with:
 *
 *   pnpm --filter @billdude/mock-vhi build && pnpm --filter @billdude/vhi-connector test
 */
import type { AddressInfo } from "node:net";
import { buildMockVhi } from "@billdude/mock-vhi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createVhiConnector,
  VhiAuthError,
  VhiConflictError,
  VhiQuotaError,
  type VhiConnector,
  type VhiProject,
} from "../src/index.js";

let mock: ReturnType<typeof buildMockVhi>;
let authUrl: string;
let vhi: VhiConnector;
let project: VhiProject;

const creds = {
  username: "admin",
  password: "admin",
  userDomain: "Default",
  projectName: "billdude",
  projectDomain: "Default",
};

const SERVER = { flavorId: "f-small", imageId: "img-ubuntu-2404", networkId: "net-private", bootVolumeGb: 20 };

async function waitForStatus(p: VhiProject, id: string, status: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = await p.getServer(id);
    if (server?.status === status) return server;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`server ${id} never reached ${status}`);
}

beforeAll(async () => {
  mock = buildMockVhi({ buildMs: 40, actionMs: 20 });
  await mock.listen({ port: 0, host: "127.0.0.1" });
  const { port } = mock.server.address() as AddressInfo;
  authUrl = `http://127.0.0.1:${port}/identity/v3`;
  vhi = createVhiConnector({ authUrl, ...creds });
  project = vhi.project((await vhi.ensureProject({ name: "billdude-acct-1" })).id);
});

afterAll(async () => {
  await mock.close();
});

describe("catalog", () => {
  it("lists flavors, images and networks", async () => {
    const [flavors, images, networks] = await Promise.all([vhi.listFlavors(), vhi.listImages(), vhi.listNetworks()]);
    expect(flavors.find((f) => f.id === "f-small")).toMatchObject({ vcpus: 1, ramMb: 2048 });
    expect(images.map((i) => i.name)).toContain("Ubuntu 24.04 LTS");
    expect(networks.find((n) => n.id === "net-public")).toMatchObject({ external: true, shared: true });
    expect(networks.find((n) => n.id === "net-infra")).toMatchObject({ shared: false });
  });

  it("rejects bad credentials with VhiAuthError", async () => {
    const bad = createVhiConnector({ authUrl, ...creds, password: "wrong" });
    await expect(bad.listFlavors()).rejects.toBeInstanceOf(VhiAuthError);
  });
});

describe("projects", () => {
  it("creates a project once and grants the service user access", async () => {
    const first = await vhi.ensureProject({ name: "billdude-acct-2", description: "Customer 2" });
    const again = await vhi.ensureProject({ name: "billdude-acct-2" });
    expect(again.id).toBe(first.id);

    const { projects } = (await mock.inject({ method: "GET", url: "/_mock/projects" })).json() as {
      projects: { id: string; name: string; serviceUserRoles: string[] }[];
    };
    expect(projects.filter((p) => p.name === "billdude-acct-2")).toHaveLength(1);
    expect(projects.find((p) => p.id === first.id)?.serviceUserRoles).toContain("member");
  });

  it("isolates servers between projects", async () => {
    const other = vhi.project((await vhi.ensureProject({ name: "billdude-acct-3" })).id);
    const { id } = await project.createServer({ ...SERVER, name: "isolated" });
    expect(await other.getServer(id)).toBeNull();
    expect((await other.listServers()).map((s) => s.id)).not.toContain(id);
    expect((await project.listServers()).map((s) => s.id)).toContain(id);
    await project.deleteServer(id);
  });

  it("enforces quotas with VhiQuotaError", async () => {
    const { id: projectId } = await vhi.ensureProject({ name: "billdude-acct-4" });
    await vhi.setProjectQuotas(projectId, { instances: 1, cores: 4, ramMb: 8192, volumes: 5, gigabytes: 100 });
    const limited = vhi.project(projectId);
    await limited.createServer({ ...SERVER, name: "first" });
    await expect(limited.createServer({ ...SERVER, name: "second" })).rejects.toBeInstanceOf(VhiQuotaError);
  });
});

describe("server lifecycle", () => {
  it("creates, stops, starts, reboots and deletes a server", async () => {
    const { id } = await project.createServer({
      ...SERVER,
      name: "web-1",
      userData: "#cloud-config\n",
      metadata: { billdude_account: "acct-1" },
    });

    expect((await project.getServer(id))?.status).toBe("BUILD");
    const active = await waitForStatus(project, id, "ACTIVE");
    expect(active.addresses[0]).toMatchObject({ network: "private", version: 4, type: "fixed" });

    const mine = await project.listServers({ metadata: { billdude_account: "acct-1" } });
    expect(mine.map((s) => s.id)).toEqual([id]);
    expect(await project.listServers({ metadata: { billdude_account: "other" } })).toEqual([]);

    expect(await project.getConsoleUrl(id)).toMatch(/vnc_auto\.html/);

    await project.powerAction(id, "stop");
    await waitForStatus(project, id, "SHUTOFF");
    await expect(project.powerAction(id, "stop")).rejects.toBeInstanceOf(VhiConflictError);
    await project.powerAction(id, "start");
    await waitForStatus(project, id, "ACTIVE");
    await project.powerAction(id, "reboot");
    await waitForStatus(project, id, "ACTIVE");

    await project.deleteServer(id);
    await new Promise((r) => setTimeout(r, 40));
    expect(await project.getServer(id)).toBeNull();
    // Deleting again is a no-op.
    await project.deleteServer(id);
  });

  it("surfaces the provider fault when a build fails", async () => {
    const { id } = await project.createServer({ ...SERVER, name: "will-fail" });
    const server = await waitForStatus(project, id, "ERROR");
    expect(server.fault).toMatch(/No valid host/);
  });
});
