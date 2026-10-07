/**
 * apps/api/src/routes/servers.ts
 *
 * Usage: customer VM endpoints (mounted under /api, signed-in users):
 *   GET    /servers                 -> own servers (admins: ?all=true for everyone's)
 *   POST   /servers                 -> { name, flavorId, imageId, networkId, bootVolumeGb, sshKeyIds? } queue a create
 *   GET    /servers/:id             -> one server
 *   POST   /servers/:id/actions     -> { action: "start" | "stop" | "reboot" }
 *   DELETE /servers/:id             -> queue deletion
 *   GET    /servers/:id/console     -> { url } short-lived noVNC link
 *
 * The API never waits on the cloud: it records the intent, moves the row to a
 * transitional status with a guarded UPDATE (so two clicks cannot race), and
 * enqueues a job for the worker.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { computeUsage, effectiveQuotas, exceededQuota } from "../accounts.js";
import { servers, sshKeys, users, type ServerRow, type ServerStatusValue } from "../db/schema.js";
import { enqueueVmOp } from "../jobs/queue.js";

const createBody = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/, "Use letters, digits and hyphens (max 63 characters)"),
  flavorId: z.string().min(1),
  imageId: z.string().min(1),
  networkId: z.string().min(1),
  bootVolumeGb: z.number().int().min(10).max(2000),
  sshKeyIds: z.array(z.string().uuid()).max(10).default([]),
});

const idParams = z.object({ id: z.string().uuid() });

export const QUOTA_LABELS = {
  instances: "server",
  cores: "vCPU",
  ramMb: "RAM (MB)",
  volumes: "volume",
  gigabytes: "disk (GB)",
} as const;
const actionBody = z.object({ action: z.enum(["start", "stop", "reboot"]) });

/** Which statuses each action may start from, and the transitional status it moves to. */
const TRANSITIONS: Record<"start" | "stop" | "reboot" | "delete", { from: ServerStatusValue[]; to: ServerStatusValue }> = {
  start: { from: ["stopped"], to: "starting" },
  stop: { from: ["active"], to: "stopping" },
  reboot: { from: ["active"], to: "rebooting" },
  delete: { from: ["active", "stopped", "error"], to: "deleting" },
};

export async function serverRoutes(app: FastifyInstance, { db, queues, catalog, vhi, config }: AppDeps) {
  /** Loads a server the caller may act on (owner, or any admin). */
  async function loadOwned(req: FastifyRequest): Promise<ServerRow | null> {
    const { id } = idParams.parse(req.params);
    const [row] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, id), ne(servers.status, "deleted")));
    if (!row) return null;
    return row.ownerId === req.user.id || req.user.role === "admin" ? row : null;
  }

  app.get("/servers", { preHandler: app.authenticate }, async (req) => {
    const all = (req.query as { all?: string }).all === "true" && req.user.role === "admin";
    const rows = await db
      .select()
      .from(servers)
      .where(all ? ne(servers.status, "deleted") : and(eq(servers.ownerId, req.user.id), ne(servers.status, "deleted")))
      .orderBy(desc(servers.createdAt));
    return { servers: rows.map(toDto) };
  });

  app.post("/servers", { preHandler: app.authenticate }, async (req, reply) => {
    const body = createBody.parse(req.body);

    const [flavors, images, networks] = await Promise.all([catalog.flavors(), catalog.images(), catalog.networks()]);
    const image = images.find((i) => i.id === body.imageId);
    if (!flavors.some((f) => f.id === body.flavorId)) return reply.code(400).send({ error: "Unknown flavor" });
    if (!image) return reply.code(400).send({ error: "Unknown image" });
    if (!networks.some((n) => n.id === body.networkId)) return reply.code(400).send({ error: "Unknown network" });
    if (body.bootVolumeGb < image.minDiskGb) {
      return reply.code(400).send({ error: `This image needs a disk of at least ${image.minDiskGb} GB` });
    }

    // Fast, friendly quota check; VHI enforces the same limits authoritatively.
    const flavor = flavors.find((f) => f.id === body.flavorId)!;
    const [owner] = await db.select().from(users).where(eq(users.id, req.user.id));
    const over = exceededQuota(effectiveQuotas(owner!, config), await computeUsage(db, flavors, req.user.id), {
      instances: 1,
      cores: flavor.vcpus,
      ramMb: flavor.ramMb,
      volumes: 1,
      gigabytes: body.bootVolumeGb,
    });
    if (over) {
      return reply.code(403).send({
        error: `This would exceed your ${QUOTA_LABELS[over.resource]} quota (${over.used} of ${over.limit} used)`,
      });
    }

    const { sshKeyIds, ...serverFields } = body;
    const keys = sshKeyIds.length
      ? await db
          .select()
          .from(sshKeys)
          .where(and(eq(sshKeys.ownerId, req.user.id), inArray(sshKeys.id, sshKeyIds)))
      : [];
    if (keys.length !== new Set(sshKeyIds).size) return reply.code(400).send({ error: "Unknown SSH key" });

    const [row] = await db
      .insert(servers)
      .values({ ...serverFields, ownerId: req.user.id, sshPublicKeys: keys.map((k) => k.publicKey) })
      .returning();
    await audit(db, { actorId: req.user.id, action: "server.create", targetType: "server", targetId: row!.id, data: body });
    await enqueueVmOp(queues.vm, { serverId: row!.id, op: "create", actorId: req.user.id });
    return reply.code(202).send({ server: toDto(row!) });
  });

  app.get("/servers/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const row = await loadOwned(req);
    if (!row) return reply.code(404).send({ error: "Server not found" });
    return { server: toDto(row) };
  });

  async function transition(req: FastifyRequest, op: keyof typeof TRANSITIONS) {
    const row = await loadOwned(req);
    if (!row) return { code: 404, body: { error: "Server not found" } };
    const { from, to } = TRANSITIONS[op];
    const [updated] = await db
      .update(servers)
      .set({ status: to, statusMessage: null })
      .where(and(eq(servers.id, row.id), inArray(servers.status, from)))
      .returning();
    if (!updated) {
      return { code: 409, body: { error: `Cannot ${op} a server that is ${row.status}` } };
    }
    await audit(db, { actorId: req.user.id, action: `server.${op}`, targetType: "server", targetId: row.id });
    await enqueueVmOp(queues.vm, { serverId: row.id, op, actorId: req.user.id });
    return { code: 202, body: { server: toDto(updated) } };
  }

  app.post("/servers/:id/actions", { preHandler: app.authenticate }, async (req, reply) => {
    const { action } = actionBody.parse(req.body);
    const result = await transition(req, action);
    return reply.code(result.code).send(result.body);
  });

  app.delete("/servers/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const result = await transition(req, "delete");
    return reply.code(result.code).send(result.body);
  });

  app.get("/servers/:id/console", { preHandler: app.authenticate }, async (req, reply) => {
    const row = await loadOwned(req);
    if (!row) return reply.code(404).send({ error: "Server not found" });
    if (row.status !== "active" || !row.vhiServerId || !row.vhiProjectId) {
      return reply.code(409).send({ error: "The console is only available while the server is running" });
    }
    await audit(db, { actorId: req.user.id, action: "server.console", targetType: "server", targetId: row.id });
    return { url: await vhi.project(row.vhiProjectId).getConsoleUrl(row.vhiServerId) };
  });
}

function toDto(row: ServerRow) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    status: row.status,
    statusMessage: row.statusMessage,
    flavorId: row.flavorId,
    imageId: row.imageId,
    networkId: row.networkId,
    bootVolumeGb: row.bootVolumeGb,
    ipv4: row.ipv4,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
