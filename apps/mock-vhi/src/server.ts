/**
 * apps/mock-vhi/src/server.ts
 *
 * Usage: an in-memory imitation of the slice of VHI's OpenStack APIs that
 * billdude uses (Keystone v3 tokens, Nova servers/flavors, Glance images,
 * Neutron networks, noVNC consoles). Used for local development and tests
 * until a real VHI cluster is available.
 *
 *   import { buildMockVhi } from "@billdude/mock-vhi";
 *   const mock = buildMockVhi({ buildMs: 50, actionMs: 20 });
 *   await mock.listen({ port: 0 });           // auth URL: <address>/identity/v3
 *
 * Realistic behaviour it simulates:
 *   - VMs sit in BUILD for `buildMs`, then become ACTIVE with a fixed IP.
 *   - Any server whose name contains "fail" ends in ERROR with a Nova-style fault.
 *   - start/stop/reboot/delete complete after `actionMs`; invalid state
 *     transitions return 409 like Nova does.
 *   - Requests without a valid X-Auth-Token get 401.
 * State is computed lazily from timestamps, so no timers are left running.
 */
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

export interface MockVhiOptions {
  buildMs?: number;
  actionMs?: number;
  username?: string;
  password?: string;
  projectName?: string;
  logger?: boolean;
}

type Status = "BUILD" | "ACTIVE" | "SHUTOFF" | "REBOOT" | "ERROR" | "DELETED";

interface MockServer {
  id: string;
  name: string;
  status: Status;
  flavorId: string;
  imageId: string;
  networkId: string;
  metadata: Record<string, string>;
  created: string;
  ip: string;
  fault?: string;
  /** Pending lazy transition: becomes `to` once Date.now() >= at ("GONE" removes the server). */
  pending?: { to: Status | "GONE"; at: number; fault?: string };
}

const FLAVORS = [
  { id: "f-small", name: "s1.small", vcpus: 1, ram: 2048, disk: 0 },
  { id: "f-medium", name: "s1.medium", vcpus: 2, ram: 4096, disk: 0 },
  { id: "f-large", name: "s1.large", vcpus: 4, ram: 8192, disk: 0 },
];

const IMAGES = [
  { id: "img-ubuntu-2404", name: "Ubuntu 24.04 LTS", status: "active", min_disk: 10, min_ram: 512 },
  { id: "img-rocky-9", name: "Rocky Linux 9", status: "active", min_disk: 10, min_ram: 1024 },
  { id: "img-debian-12", name: "Debian 12", status: "active", min_disk: 8, min_ram: 512 },
];

const NETWORKS = [
  { id: "net-public", name: "public", "router:external": true, shared: true },
  { id: "net-private", name: "private", "router:external": false, shared: false },
];

export function buildMockVhi(options: MockVhiOptions = {}): FastifyInstance {
  const buildMs = options.buildMs ?? 4000;
  const actionMs = options.actionMs ?? 1500;
  const username = options.username ?? "admin";
  const password = options.password ?? "admin";
  const projectName = options.projectName ?? "billdude";

  const tokens = new Map<string, number>();
  const servers = new Map<string, MockServer>();
  const consoleTokens = new Map<string, string>();
  let nextIp = 10;

  const app = Fastify({ logger: options.logger ?? false });

  const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;

  const settle = (server: MockServer): MockServer | null => {
    if (server.pending && Date.now() >= server.pending.at) {
      const { to, fault } = server.pending;
      server.pending = undefined;
      if (to === "GONE") {
        servers.delete(server.id);
        return null;
      }
      server.status = to;
      if (fault) server.fault = fault;
    }
    return server;
  };

  const findServer = (id: string) => {
    const server = servers.get(id);
    return server ? settle(server) : null;
  };

  const novaError = (reply: FastifyReply, code: number, key: string, message: string) =>
    reply.code(code).send({ [key]: { code, message } });

  const toNova = (s: MockServer) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    flavor: { id: s.flavorId },
    image: "",
    addresses:
      s.status === "BUILD" || s.status === "ERROR"
        ? {}
        : {
            [NETWORKS.find((n) => n.id === s.networkId)?.name ?? "private"]: [
              { addr: s.ip, version: 4, "OS-EXT-IPS:type": "fixed" },
            ],
          },
    metadata: s.metadata,
    created: s.created,
    ...(s.fault ? { fault: { code: 500, message: s.fault } } : {}),
  });

  /* ---------------- Keystone ---------------- */

  app.post("/identity/v3/auth/tokens", async (req, reply) => {
    const body = req.body as {
      auth?: {
        identity?: { password?: { user?: { name?: string; password?: string } } };
        scope?: { project?: { name?: string } };
      };
    };
    const user = body.auth?.identity?.password?.user;
    if (user?.name !== username || user?.password !== password) {
      return reply.code(401).send({ error: { code: 401, message: "The request you have made requires authentication." } });
    }
    if (body.auth?.scope?.project?.name !== projectName) {
      return reply.code(401).send({ error: { code: 401, message: "Project not found or not authorized." } });
    }
    const token = randomUUID().replace(/-/g, "");
    const expiresAt = Date.now() + 60 * 60 * 1000;
    tokens.set(token, expiresAt);
    const base = baseUrl(req);
    const endpoint = (type: string, path: string) => ({
      type,
      endpoints: [{ interface: "public", region: "RegionOne", region_id: "RegionOne", url: `${base}${path}` }],
    });
    return reply
      .code(201)
      .header("X-Subject-Token", token)
      .send({
        token: {
          expires_at: new Date(expiresAt).toISOString(),
          project: { name: projectName, id: "project-billdude" },
          catalog: [
            endpoint("identity", "/identity/v3"),
            endpoint("compute", "/compute/v2.1"),
            endpoint("image", "/image"),
            endpoint("network", "/network"),
          ],
        },
      });
  });

  /* ---------------- Auth guard for every other API route ---------------- */

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/identity/") || req.url.startsWith("/console/")) return;
    const token = req.headers["x-auth-token"];
    const expiry = typeof token === "string" ? tokens.get(token) : undefined;
    if (!expiry || expiry < Date.now()) {
      return reply.code(401).send({ error: { code: 401, message: "Authentication required" } });
    }
  });

  /* ---------------- Glance / Neutron ---------------- */

  app.get("/image/v2/images", async () => ({ images: IMAGES }));
  app.get("/network/v2.0/networks", async () => ({ networks: NETWORKS }));

  /* ---------------- Nova ---------------- */

  app.get("/compute/v2.1/flavors/detail", async () => ({ flavors: FLAVORS }));

  app.get("/compute/v2.1/servers/detail", async () => ({
    servers: [...servers.values()]
      .map(settle)
      .filter((s): s is MockServer => s !== null)
      .map(toNova),
  }));

  app.get<{ Params: { id: string } }>("/compute/v2.1/servers/:id", async (req, reply) => {
    const server = findServer(req.params.id);
    if (!server) return novaError(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    return { server: toNova(server) };
  });

  app.post("/compute/v2.1/servers", async (req, reply) => {
    const body = (req.body as { server?: Record<string, unknown> }).server ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const flavorRef = body.flavorRef as string | undefined;
    const networks = (body.networks as { uuid?: string }[] | undefined) ?? [];
    const bdm = (body.block_device_mapping_v2 as { uuid?: string; boot_index?: number }[] | undefined) ?? [];
    const imageId = (body.imageRef as string | undefined) ?? bdm.find((b) => b.boot_index === 0)?.uuid;

    if (!name) return novaError(reply, 400, "badRequest", "Invalid input: 'name' is a required property");
    if (!FLAVORS.some((f) => f.id === flavorRef)) {
      return novaError(reply, 400, "badRequest", `Flavor ${flavorRef} could not be found.`);
    }
    if (!IMAGES.some((i) => i.id === imageId)) {
      return novaError(reply, 400, "badRequest", `Image ${imageId} could not be found.`);
    }
    const networkId = networks[0]?.uuid;
    if (!NETWORKS.some((n) => n.id === networkId)) {
      return novaError(reply, 400, "badRequest", `Network ${networkId} could not be found.`);
    }

    const failing = name.toLowerCase().includes("fail");
    const server: MockServer = {
      id: randomUUID(),
      name,
      status: "BUILD",
      flavorId: flavorRef!,
      imageId: imageId!,
      networkId: networkId!,
      metadata: (body.metadata as Record<string, string> | undefined) ?? {},
      created: new Date().toISOString(),
      ip: `10.0.0.${nextIp++}`,
      pending: failing
        ? { to: "ERROR", at: Date.now() + buildMs, fault: "No valid host was found. There are not enough hosts available." }
        : { to: "ACTIVE", at: Date.now() + buildMs },
    };
    servers.set(server.id, server);
    return reply.code(202).send({ server: { id: server.id, links: [] } });
  });

  app.post<{ Params: { id: string } }>("/compute/v2.1/servers/:id/action", async (req, reply) => {
    const server = findServer(req.params.id);
    if (!server) return novaError(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    const body = req.body as Record<string, unknown>;
    const conflict = (action: string) =>
      novaError(
        reply,
        409,
        "conflictingRequest",
        `Cannot '${action}' instance ${server.id} while it is in vm_state ${server.status.toLowerCase()}`,
      );
    if (server.pending) return conflict(Object.keys(body)[0] ?? "action");

    if ("os-start" in body) {
      if (server.status !== "SHUTOFF") return conflict("start");
      server.pending = { to: "ACTIVE", at: Date.now() + actionMs };
    } else if ("os-stop" in body) {
      if (server.status !== "ACTIVE" && server.status !== "ERROR") return conflict("stop");
      server.pending = { to: "SHUTOFF", at: Date.now() + actionMs };
    } else if ("reboot" in body) {
      if (server.status !== "ACTIVE" && server.status !== "SHUTOFF") return conflict("reboot");
      server.status = "REBOOT";
      server.pending = { to: "ACTIVE", at: Date.now() + actionMs };
    } else {
      return novaError(reply, 400, "badRequest", "Unsupported action");
    }
    return reply.code(202).send();
  });

  app.delete<{ Params: { id: string } }>("/compute/v2.1/servers/:id", async (req, reply) => {
    const server = findServer(req.params.id);
    if (!server) return novaError(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    server.pending = { to: "GONE", at: Date.now() + actionMs };
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/compute/v2.1/servers/:id/remote-consoles", async (req, reply) => {
    const server = findServer(req.params.id);
    if (!server) return novaError(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    if (server.status !== "ACTIVE") return novaError(reply, 409, "conflictingRequest", "Instance is not running");
    const token = randomUUID();
    consoleTokens.set(token, server.id);
    return {
      remote_console: {
        protocol: "vnc",
        type: "novnc",
        url: `${baseUrl(req)}/console/vnc_auto.html?path=%3Ftoken%3D${token}`,
      },
    };
  });

  /* ---------------- Fake noVNC page ---------------- */

  app.get<{ Querystring: { path?: string } }>("/console/vnc_auto.html", async (req, reply) => {
    const token = new URLSearchParams((req.query.path ?? "").replace(/^\?/, "")).get("token") ?? "";
    const serverId = consoleTokens.get(token);
    const server = serverId ? servers.get(serverId) : undefined;
    const label = server ? `${server.name} (${server.ip})` : "unknown server";
    return reply
      .type("text/html")
      .send(
        `<!doctype html><title>Mock console</title><body style="background:#000;color:#0f0;font-family:monospace;padding:2rem">` +
          `<p>Mock VHI noVNC console for ${escapeHtml(label)}</p><p>login: _</p></body>`,
      );
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
