/**
 * apps/mock-vhi/src/server.ts
 *
 * Usage: an in-memory imitation of the slice of VHI's OpenStack APIs that
 * billdude uses (Keystone v3 tokens/projects/roles, Nova servers/flavors/
 * quotas, Cinder quotas, Glance images, Neutron networks, noVNC consoles).
 * Used for local development and tests until a real VHI cluster is available.
 *
 *   import { buildMockVhi } from "@billdude/mock-vhi";
 *   const mock = buildMockVhi({ buildMs: 50, actionMs: 20 });
 *   await mock.listen({ port: 0 });           // auth URL: <address>/identity/v3
 *
 * Realistic behaviour it simulates:
 *   - The service user (admin/admin) logs in to the "billdude" project and
 *     has admin rights there: it can create projects, grant roles and set quotas.
 *   - Tokens are project-scoped. Scoping to another project requires a role
 *     assignment on it; servers are only visible inside their own project.
 *   - Nova/Cinder quotas (instances, cores, RAM, volumes, gigabytes) are
 *     enforced on create with Nova-style 403 "Quota exceeded" errors.
 *   - Every project gets a Neutron-style "default" security group (egress
 *     allowed, inbound only from the same group) on first use; rules can be
 *     listed, added (duplicates -> 409) and deleted.
 *   - VMs sit in BUILD for `buildMs`, then become ACTIVE with a fixed IP.
 *   - Any server whose name contains "fail" ends in ERROR with a Nova-style fault.
 *   - start/stop/reboot/delete complete after `actionMs`; invalid state
 *     transitions return 409 like Nova does.
 *   - GET /_mock/servers/:id and /_mock/projects expose internal state for tests.
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
  projectId: string;
  name: string;
  status: Status;
  flavorId: string;
  imageId: string;
  networkId: string;
  bootVolumeGb: number;
  metadata: Record<string, string>;
  created: string;
  ip: string;
  /** Decoded cloud-init user data, exposed through the /_mock inspection endpoint. */
  userData?: string;
  fault?: string;
  /** Pending lazy transition: becomes `to` once Date.now() >= at ("GONE" removes the server). */
  pending?: { to: Status | "GONE"; at: number; fault?: string };
}

interface MockProject {
  id: string;
  name: string;
  domainId: string;
  description: string;
}

interface Quotas {
  instances: number;
  cores: number;
  ram: number;
  volumes: number;
  gigabytes: number;
}

interface SecurityGroupRule {
  id: string;
  security_group_id: string;
  direction: "ingress" | "egress";
  ethertype: "IPv4" | "IPv6";
  protocol: string | null;
  port_range_min: number | null;
  port_range_max: number | null;
  remote_ip_prefix: string | null;
  remote_group_id: string | null;
}

interface TokenInfo {
  expiresAt: number;
  projectId: string;
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
  { id: "net-private", name: "private", "router:external": false, shared: true },
  { id: "net-infra", name: "infra", "router:external": false, shared: false },
];

/** OpenStack's out-of-the-box defaults. */
const DEFAULT_QUOTAS: Quotas = { instances: 10, cores: 20, ram: 51200, volumes: 10, gigabytes: 1000 };

const DOMAIN = { id: "domain-default", name: "Default" };
const SERVICE_USER_ID = "user-service";
const ROLES = [
  { id: "role-admin", name: "admin" },
  { id: "role-member", name: "member" },
  { id: "role-reader", name: "reader" },
];

export function buildMockVhi(options: MockVhiOptions = {}): FastifyInstance {
  const buildMs = options.buildMs ?? 4000;
  const actionMs = options.actionMs ?? 1500;
  const username = options.username ?? "admin";
  const password = options.password ?? "admin";
  const serviceProject: MockProject = {
    id: "project-service",
    name: options.projectName ?? "billdude",
    domainId: DOMAIN.id,
    description: "billdude service project",
  };

  const tokens = new Map<string, TokenInfo>();
  const projects = new Map<string, MockProject>([[serviceProject.id, serviceProject]]);
  const assignments = new Set<string>([`${serviceProject.id}:${SERVICE_USER_ID}:role-admin`]);
  const quotas = new Map<string, Quotas>();
  const servers = new Map<string, MockServer>();
  const consoleTokens = new Map<string, string>();
  const securityGroups = new Map<string, { id: string; name: string; project_id: string }>();
  const sgRules = new Map<string, SecurityGroupRule>();
  let nextIp = 10;

  /** Neutron creates a project's default group lazily; so do we. */
  const defaultGroup = (projectId: string) => {
    const existing = [...securityGroups.values()].find((g) => g.project_id === projectId && g.name === "default");
    if (existing) return existing;
    const group = { id: randomUUID(), name: "default", project_id: projectId };
    securityGroups.set(group.id, group);
    const base = { security_group_id: group.id, protocol: null, port_range_min: null, port_range_max: null, remote_ip_prefix: null };
    for (const ethertype of ["IPv4", "IPv6"] as const) {
      sgRules.set(randomUUID(), { ...base, id: "", direction: "egress", ethertype, remote_group_id: null });
      sgRules.set(randomUUID(), { ...base, id: "", direction: "ingress", ethertype, remote_group_id: group.id });
    }
    for (const [id, rule] of sgRules) if (!rule.id) rule.id = id;
    return group;
  };
  const visibleGroup = (req: FastifyRequest, id: string) => {
    const group = securityGroups.get(id);
    return group && (group.project_id === scopeOf(req).projectId || isAdmin(req)) ? group : null;
  };

  const app = Fastify({ logger: options.logger ?? false });
  app.decorateRequest("scope", null);

  const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;
  const scopeOf = (req: FastifyRequest) => (req as FastifyRequest & { scope: TokenInfo }).scope;
  const isAdmin = (req: FastifyRequest) => scopeOf(req).projectId === serviceProject.id;
  const quotasFor = (projectId: string) => quotas.get(projectId) ?? { ...DEFAULT_QUOTAS };
  const hasRole = (projectId: string) => [...assignments].some((a) => a.startsWith(`${projectId}:${SERVICE_USER_ID}:`));

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

  const liveServers = (projectId: string) =>
    [...servers.values()]
      .map(settle)
      .filter((s): s is MockServer => s !== null && s.projectId === projectId);

  /** Finds a server visible to the caller's project. */
  const findServer = (req: FastifyRequest, id: string) => {
    const server = servers.get(id);
    if (!server || server.projectId !== scopeOf(req).projectId) return null;
    return settle(server);
  };

  const error = (reply: FastifyReply, code: number, key: string, message: string) =>
    reply.code(code).send({ [key]: { code, message } });

  const forbidden = (reply: FastifyReply) =>
    error(reply, 403, "error", "You are not authorized to perform the requested action.");

  const toNova = (s: MockServer) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    tenant_id: s.projectId,
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

  /* ---------------- Keystone: tokens ---------------- */

  app.post("/identity/v3/auth/tokens", async (req, reply) => {
    const body = req.body as {
      auth?: {
        identity?: { password?: { user?: { name?: string; password?: string } } };
        scope?: { project?: { id?: string; name?: string } };
      };
    };
    const user = body.auth?.identity?.password?.user;
    if (user?.name !== username || user?.password !== password) {
      return error(reply, 401, "error", "The request you have made requires authentication.");
    }
    const scope = body.auth?.scope?.project;
    const project = scope?.id
      ? projects.get(scope.id)
      : [...projects.values()].find((p) => p.name === scope?.name);
    if (!project || !hasRole(project.id)) {
      return error(reply, 401, "error", "The request you have made requires authentication.");
    }

    const token = randomUUID().replace(/-/g, "");
    const expiresAt = Date.now() + 60 * 60 * 1000;
    tokens.set(token, { expiresAt, projectId: project.id });
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
          user: { id: SERVICE_USER_ID, name: username, domain: DOMAIN },
          project: { id: project.id, name: project.name, domain: { id: project.domainId, name: DOMAIN.name } },
          catalog: [
            endpoint("identity", "/identity/v3"),
            endpoint("compute", "/compute/v2.1"),
            endpoint("volumev3", `/volume/v3/${project.id}`),
            endpoint("image", "/image"),
            endpoint("network", "/network"),
          ],
        },
      });
  });

  /* ---------------- Auth guard for every other API route ---------------- */

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/identity/v3/auth/tokens" || req.url.startsWith("/console/") || req.url.startsWith("/_mock/")) {
      return;
    }
    const token = req.headers["x-auth-token"];
    const info = typeof token === "string" ? tokens.get(token) : undefined;
    if (!info || info.expiresAt < Date.now()) {
      return error(reply, 401, "error", "Authentication required");
    }
    (req as FastifyRequest & { scope: TokenInfo }).scope = info;
  });

  /* ---------------- Keystone: projects and roles (admin only) ---------------- */

  app.get<{ Querystring: { name?: string; domain_id?: string } }>("/identity/v3/projects", async (req, reply) => {
    if (!isAdmin(req)) return forbidden(reply);
    const list = [...projects.values()].filter(
      (p) => (!req.query.name || p.name === req.query.name) && (!req.query.domain_id || p.domainId === req.query.domain_id),
    );
    return { projects: list.map((p) => ({ id: p.id, name: p.name, domain_id: p.domainId, description: p.description, enabled: true })) };
  });

  app.post("/identity/v3/projects", async (req, reply) => {
    if (!isAdmin(req)) return forbidden(reply);
    const body = (req.body as { project?: { name?: string; domain_id?: string; description?: string } }).project ?? {};
    if (!body.name || !body.domain_id) return error(reply, 400, "error", "name and domain_id are required");
    if ([...projects.values()].some((p) => p.name === body.name && p.domainId === body.domain_id)) {
      return error(reply, 409, "error", `Conflict occurred attempting to store project - Duplicate entry ${body.name}.`);
    }
    const project: MockProject = {
      id: randomUUID().replace(/-/g, ""),
      name: body.name,
      domainId: body.domain_id,
      description: body.description ?? "",
    };
    projects.set(project.id, project);
    return reply.code(201).send({ project: { id: project.id, name: project.name, domain_id: project.domainId } });
  });

  app.get<{ Querystring: { name?: string } }>("/identity/v3/roles", async (req) => ({
    roles: ROLES.filter((r) => !req.query.name || r.name === req.query.name),
  }));

  app.put<{ Params: { projectId: string; userId: string; roleId: string } }>(
    "/identity/v3/projects/:projectId/users/:userId/roles/:roleId",
    async (req, reply) => {
      if (!isAdmin(req)) return forbidden(reply);
      const { projectId, userId, roleId } = req.params;
      if (!projects.has(projectId) || userId !== SERVICE_USER_ID || !ROLES.some((r) => r.id === roleId)) {
        return error(reply, 404, "error", "Could not find project, user or role.");
      }
      assignments.add(`${projectId}:${userId}:${roleId}`);
      return reply.code(204).send();
    },
  );

  /* ---------------- Glance / Neutron ---------------- */

  app.get("/image/v2/images", async () => ({ images: IMAGES }));
  app.get("/network/v2.0/networks", async (req) => ({
    // Non-admin projects only see shared networks, like Neutron's default policy.
    networks: isAdmin(req) ? NETWORKS : NETWORKS.filter((n) => n.shared),
  }));

  /* ---------------- Neutron security groups ---------------- */

  app.get<{ Querystring: { name?: string; project_id?: string } }>("/network/v2.0/security-groups", async (req) => {
    defaultGroup(scopeOf(req).projectId);
    const groups = [...securityGroups.values()].filter(
      (g) =>
        (isAdmin(req) || g.project_id === scopeOf(req).projectId) &&
        (!req.query.name || g.name === req.query.name) &&
        (!req.query.project_id || g.project_id === req.query.project_id),
    );
    return { security_groups: groups.map((g) => ({ ...g, tenant_id: g.project_id })) };
  });

  app.get<{ Querystring: { security_group_id?: string } }>("/network/v2.0/security-group-rules", async (req) => {
    const rules = [...sgRules.values()].filter(
      (r) => visibleGroup(req, r.security_group_id) && (!req.query.security_group_id || r.security_group_id === req.query.security_group_id),
    );
    return { security_group_rules: rules };
  });

  app.post("/network/v2.0/security-group-rules", async (req, reply) => {
    const body = (req.body as { security_group_rule?: Partial<SecurityGroupRule> }).security_group_rule ?? {};
    if (!body.security_group_id || !visibleGroup(req, body.security_group_id)) {
      return error(reply, 404, "NeutronError", `Security group ${body.security_group_id} does not exist`);
    }
    const rule: SecurityGroupRule = {
      id: randomUUID(),
      security_group_id: body.security_group_id,
      direction: body.direction ?? "ingress",
      ethertype: body.ethertype ?? "IPv4",
      protocol: body.protocol ?? null,
      port_range_min: body.port_range_min ?? null,
      port_range_max: body.port_range_max ?? null,
      remote_ip_prefix: body.remote_ip_prefix ?? null,
      remote_group_id: body.remote_group_id ?? null,
    };
    const same = (a: SecurityGroupRule) =>
      (["security_group_id", "direction", "ethertype", "protocol", "port_range_min", "port_range_max", "remote_ip_prefix", "remote_group_id"] as const).every(
        (k) => a[k] === rule[k],
      );
    if ([...sgRules.values()].some(same)) {
      return error(reply, 409, "NeutronError", "Security group rule already exists.");
    }
    sgRules.set(rule.id, rule);
    return reply.code(201).send({ security_group_rule: rule });
  });

  app.delete<{ Params: { id: string } }>("/network/v2.0/security-group-rules/:id", async (req, reply) => {
    const rule = sgRules.get(req.params.id);
    if (!rule || !visibleGroup(req, rule.security_group_id)) {
      return error(reply, 404, "NeutronError", `Security group rule ${req.params.id} could not be found.`);
    }
    sgRules.delete(rule.id);
    return reply.code(204).send();
  });

  /* ---------------- Nova / Cinder quotas (admin only) ---------------- */

  app.get<{ Params: { projectId: string } }>("/compute/v2.1/os-quota-sets/:projectId", async (req) => {
    const q = quotasFor(req.params.projectId);
    return { quota_set: { id: req.params.projectId, instances: q.instances, cores: q.cores, ram: q.ram } };
  });

  app.put<{ Params: { projectId: string } }>("/compute/v2.1/os-quota-sets/:projectId", async (req, reply) => {
    if (!isAdmin(req)) return forbidden(reply);
    const set = (req.body as { quota_set?: Partial<Quotas> }).quota_set ?? {};
    const q = { ...quotasFor(req.params.projectId) };
    for (const key of ["instances", "cores", "ram"] as const) if (typeof set[key] === "number") q[key] = set[key];
    quotas.set(req.params.projectId, q);
    return { quota_set: { instances: q.instances, cores: q.cores, ram: q.ram } };
  });

  app.put<{ Params: { tenant: string; projectId: string } }>(
    "/volume/v3/:tenant/os-quota-sets/:projectId",
    async (req, reply) => {
      if (!isAdmin(req)) return forbidden(reply);
      const set = (req.body as { quota_set?: Partial<Quotas> }).quota_set ?? {};
      const q = { ...quotasFor(req.params.projectId) };
      for (const key of ["volumes", "gigabytes"] as const) if (typeof set[key] === "number") q[key] = set[key];
      quotas.set(req.params.projectId, q);
      return { quota_set: { volumes: q.volumes, gigabytes: q.gigabytes } };
    },
  );

  /* ---------------- Nova: servers ---------------- */

  app.get("/compute/v2.1/flavors/detail", async () => ({ flavors: FLAVORS }));

  app.get("/compute/v2.1/servers/detail", async (req) => ({
    servers: liveServers(scopeOf(req).projectId).map(toNova),
  }));

  app.get<{ Params: { id: string } }>("/compute/v2.1/servers/:id", async (req, reply) => {
    const server = findServer(req, req.params.id);
    if (!server) return error(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    return { server: toNova(server) };
  });

  app.post("/compute/v2.1/servers", async (req, reply) => {
    const projectId = scopeOf(req).projectId;
    const body = (req.body as { server?: Record<string, unknown> }).server ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const flavorRef = body.flavorRef as string | undefined;
    const networks = (body.networks as { uuid?: string }[] | undefined) ?? [];
    const bdm =
      (body.block_device_mapping_v2 as { uuid?: string; boot_index?: number; volume_size?: number }[] | undefined) ?? [];
    const boot = bdm.find((b) => b.boot_index === 0);
    const imageId = (body.imageRef as string | undefined) ?? boot?.uuid;
    const bootVolumeGb = boot?.volume_size ?? 0;

    if (!name) return error(reply, 400, "badRequest", "Invalid input: 'name' is a required property");
    const flavor = FLAVORS.find((f) => f.id === flavorRef);
    if (!flavor) return error(reply, 400, "badRequest", `Flavor ${flavorRef} could not be found.`);
    if (!IMAGES.some((i) => i.id === imageId)) {
      return error(reply, 400, "badRequest", `Image ${imageId} could not be found.`);
    }
    const networkId = networks[0]?.uuid;
    const network = NETWORKS.find((n) => n.id === networkId);
    if (!network || (!network.shared && projectId !== serviceProject.id)) {
      return error(reply, 400, "badRequest", `Network ${networkId} could not be found.`);
    }

    // Quota enforcement, using the same wording as Nova.
    const q = quotasFor(projectId);
    const used = liveServers(projectId).reduce(
      (acc, s) => {
        const f = FLAVORS.find((x) => x.id === s.flavorId)!;
        return { instances: acc.instances + 1, cores: acc.cores + f.vcpus, ram: acc.ram + f.ram, gigabytes: acc.gigabytes + s.bootVolumeGb };
      },
      { instances: 0, cores: 0, ram: 0, gigabytes: 0 },
    );
    const over = (
      [
        ["instances", 1, used.instances, q.instances],
        ["cores", flavor.vcpus, used.cores, q.cores],
        ["ram", flavor.ram, used.ram, q.ram],
        ["volumes", 1, used.instances, q.volumes],
        ["gigabytes", bootVolumeGb, used.gigabytes, q.gigabytes],
      ] as const
    ).find(([, requested, inUse, limit]) => limit >= 0 && inUse + requested > limit);
    if (over) {
      const [resource, requested, inUse, limit] = over;
      return error(
        reply,
        403,
        "forbidden",
        `Quota exceeded for ${resource}: Requested ${requested}, but already used ${inUse} of ${limit} ${resource}`,
      );
    }

    const failing = name.toLowerCase().includes("fail");
    const server: MockServer = {
      id: randomUUID(),
      projectId,
      name,
      status: "BUILD",
      flavorId: flavor.id,
      imageId: imageId!,
      networkId: network.id,
      bootVolumeGb,
      metadata: (body.metadata as Record<string, string> | undefined) ?? {},
      created: new Date().toISOString(),
      ip: `10.0.0.${nextIp++}`,
      userData: typeof body.user_data === "string" ? Buffer.from(body.user_data, "base64").toString("utf8") : undefined,
      pending: failing
        ? { to: "ERROR", at: Date.now() + buildMs, fault: "No valid host was found. There are not enough hosts available." }
        : { to: "ACTIVE", at: Date.now() + buildMs },
    };
    servers.set(server.id, server);
    return reply.code(202).send({ server: { id: server.id, links: [] } });
  });

  app.post<{ Params: { id: string } }>("/compute/v2.1/servers/:id/action", async (req, reply) => {
    const server = findServer(req, req.params.id);
    if (!server) return error(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    const body = req.body as Record<string, unknown>;
    const conflict = (action: string) =>
      error(
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
      return error(reply, 400, "badRequest", "Unsupported action");
    }
    return reply.code(202).send();
  });

  app.delete<{ Params: { id: string } }>("/compute/v2.1/servers/:id", async (req, reply) => {
    const server = findServer(req, req.params.id);
    if (!server) return error(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    server.pending = { to: "GONE", at: Date.now() + actionMs };
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/compute/v2.1/servers/:id/remote-consoles", async (req, reply) => {
    const server = findServer(req, req.params.id);
    if (!server) return error(reply, 404, "itemNotFound", `Instance ${req.params.id} could not be found.`);
    if (server.status !== "ACTIVE") return error(reply, 409, "conflictingRequest", "Instance is not running");
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

  /* ---------------- Test inspection (not part of OpenStack) ---------------- */

  app.get<{ Params: { id: string } }>("/_mock/servers/:id", async (req, reply) => {
    const server = servers.get(req.params.id);
    if (!server) return reply.code(404).send({ error: "not found" });
    return { ...server, pending: undefined };
  });

  app.get("/_mock/projects", async () => ({
    projects: [...projects.values()].map((p) => ({
      ...p,
      quotas: quotasFor(p.id),
      serviceUserRoles: ROLES.filter((r) => assignments.has(`${p.id}:${SERVICE_USER_ID}:${r.id}`)).map((r) => r.name),
      servers: liveServers(p.id).length,
      inboundRules: [...sgRules.values()]
        .filter((r) => r.direction === "ingress" && !r.remote_group_id && securityGroups.get(r.security_group_id)?.project_id === p.id)
        .map((r) => `${r.protocol ?? "any"}:${r.port_range_min ?? ""}-${r.port_range_max ?? ""}:${r.remote_ip_prefix}`),
    })),
  }));

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
