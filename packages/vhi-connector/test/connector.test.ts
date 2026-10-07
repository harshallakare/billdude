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
import { createVhiConnector, VhiAuthError, VhiConflictError, type VhiConnector } from "../src/index.js";

let mock: ReturnType<typeof buildMockVhi>;
let authUrl: string;
let vhi: VhiConnector;

const creds = {
  username: "admin",
  password: "admin",
  userDomain: "Default",
  projectName: "billdude",
  projectDomain: "Default",
};

async function waitForStatus(id: string, status: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const server = await vhi.getServer(id);
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
});

afterAll(async () => {
  await mock.close();
});

describe("catalog", () => {
  it("lists flavors, images and networks", async () => {
    const [flavors, images, networks] = await Promise.all([vhi.listFlavors(), vhi.listImages(), vhi.listNetworks()]);
    expect(flavors.find((f) => f.id === "f-small")).toMatchObject({ vcpus: 1, ramMb: 2048 });
    expect(images.map((i) => i.name)).toContain("Ubuntu 24.04 LTS");
    expect(networks.find((n) => n.id === "net-public")).toMatchObject({ external: true });
  });

  it("rejects bad credentials with VhiAuthError", async () => {
    const bad = createVhiConnector({ authUrl, ...creds, password: "wrong" });
    await expect(bad.listFlavors()).rejects.toBeInstanceOf(VhiAuthError);
  });
});

describe("server lifecycle", () => {
  it("creates, stops, starts, reboots and deletes a server", async () => {
    const { id } = await vhi.createServer({
      name: "web-1",
      flavorId: "f-small",
      imageId: "img-ubuntu-2404",
      networkId: "net-private",
      bootVolumeGb: 20,
      userData: "#cloud-config\n",
      metadata: { billdude_account: "acct-1" },
    });

    expect((await vhi.getServer(id))?.status).toBe("BUILD");
    const active = await waitForStatus(id, "ACTIVE");
    expect(active.addresses[0]).toMatchObject({ network: "private", version: 4, type: "fixed" });

    const mine = await vhi.listServers({ metadata: { billdude_account: "acct-1" } });
    expect(mine.map((s) => s.id)).toEqual([id]);
    expect(await vhi.listServers({ metadata: { billdude_account: "other" } })).toEqual([]);

    expect(await vhi.getConsoleUrl(id)).toMatch(/vnc_auto\.html/);

    await vhi.powerAction(id, "stop");
    await waitForStatus(id, "SHUTOFF");
    await expect(vhi.powerAction(id, "stop")).rejects.toBeInstanceOf(VhiConflictError);
    await vhi.powerAction(id, "start");
    await waitForStatus(id, "ACTIVE");
    await vhi.powerAction(id, "reboot");
    await waitForStatus(id, "ACTIVE");

    await vhi.deleteServer(id);
    await new Promise((r) => setTimeout(r, 40));
    expect(await vhi.getServer(id)).toBeNull();
    // Deleting again is a no-op.
    await vhi.deleteServer(id);
  });

  it("surfaces the provider fault when a build fails", async () => {
    const { id } = await vhi.createServer({
      name: "will-fail",
      flavorId: "f-small",
      imageId: "img-ubuntu-2404",
      networkId: "net-private",
      bootVolumeGb: 20,
    });
    const server = await waitForStatus(id, "ERROR");
    expect(server.fault).toMatch(/No valid host/);
  });
});
