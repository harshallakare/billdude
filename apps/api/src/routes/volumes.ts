/**
 * apps/api/src/routes/volumes.ts
 *
 * Usage: customer data volumes (mounted under /api, signed-in users):
 *   GET    /volumes                       -> own volumes
 *   POST   /volumes { name, sizeGb }      -> create (quota + funds checked)
 *   POST   /volumes/:id/attach { serverId } -> attach to one of your servers (same project)
 *   POST   /volumes/:id/detach            -> detach
 *   DELETE /volumes/:id                   -> delete (must be detached)
 * Like servers, every change moves the row to a transitional status with a
 * guarded UPDATE and enqueues a volume-ops job for the worker.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { computeUsage, effectiveQuotas, exceededQuota } from "../accounts.js";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { loadPriceBook } from "../billing/pricing.js";
import { servers, users, volumes, type VolumeRow, type VolumeStatusValue } from "../db/schema.js";
import { enqueueVolumeOp } from "../jobs/queue.js";
import { QUOTA_LABELS } from "./servers.js";

const createBody = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/, "Use letters, digits and hyphens (max 63 characters)"),
  sizeGb: z.number().int().min(1).max(4000),
});
const idParams = z.object({ id: z.string().uuid() });
const attachBody = z.object({ serverId: z.string().uuid() });

export async function volumeRoutes(app: FastifyInstance, { db, queues, catalog, config }: AppDeps) {
  async function loadOwned(req: FastifyRequest): Promise<VolumeRow | null> {
    const { id } = idParams.parse(req.params);
    const [row] = await db
      .select()
      .from(volumes)
      .where(and(eq(volumes.id, id), ne(volumes.status, "deleted")));
    if (!row) return null;
    return row.ownerId === req.user.id || req.user.role === "admin" ? row : null;
  }

  /** Guarded transition; returns the updated row or null if the volume was not in an allowed state. */
  async function transition(row: VolumeRow, from: VolumeStatusValue[], values: Partial<VolumeRow>) {
    const [updated] = await db
      .update(volumes)
      .set({ statusMessage: null, ...values })
      .where(and(eq(volumes.id, row.id), inArray(volumes.status, from)))
      .returning();
    return updated ?? null;
  }

  app.get("/volumes", { preHandler: app.authenticate }, async (req) => {
    const rows = await db
      .select({ volume: volumes, serverName: servers.name })
      .from(volumes)
      .leftJoin(servers, eq(servers.id, volumes.serverId))
      .where(and(eq(volumes.ownerId, req.user.id), ne(volumes.status, "deleted")))
      .orderBy(desc(volumes.createdAt));
    return { volumes: rows.map((r) => ({ ...toDto(r.volume), serverName: r.serverName })) };
  });

  app.post("/volumes", { preHandler: app.authenticate }, async (req, reply) => {
    const body = createBody.parse(req.body);
    if (config.REQUIRE_EMAIL_VERIFICATION && !req.user.emailVerified && req.user.role !== "admin") {
      return reply.code(403).send({ error: "Please confirm your email address before creating volumes." });
    }
    const [owner] = await db.select().from(users).where(eq(users.id, req.user.id));
    const usage = await computeUsage(db, await catalog.flavors(), req.user.id);
    const over = exceededQuota(effectiveQuotas(owner!, config), usage, {
      instances: 0,
      cores: 0,
      ramMb: 0,
      volumes: 1,
      gigabytes: body.sizeGb,
    });
    if (over) {
      return reply
        .code(403)
        .send({ error: `This would exceed your ${QUOTA_LABELS[over.resource]} quota (${over.used} of ${over.limit} used)` });
    }
    const prices = await loadPriceBook(db, config);
    if (owner!.role !== "admin" && (owner!.overdueSince || owner!.balanceMicros < body.sizeGb * prices.storageGbHourly)) {
      return reply.code(402).send({ error: "Add funds to your wallet to create volumes." });
    }

    const [row] = await db
      .insert(volumes)
      .values({ ownerId: req.user.id, name: body.name, sizeGb: body.sizeGb, vhiProjectId: owner!.vhiProjectId })
      .returning();
    await audit(db, { actorId: req.user.id, action: "volume.create", targetType: "volume", targetId: row!.id, data: body });
    await enqueueVolumeOp(queues.volume, { volumeId: row!.id, op: "create", actorId: req.user.id });
    return reply.code(202).send({ volume: toDto(row!) });
  });

  app.post("/volumes/:id/attach", { preHandler: app.authenticate }, async (req, reply) => {
    const row = await loadOwned(req);
    if (!row) return reply.code(404).send({ error: "Volume not found" });
    const { serverId } = attachBody.parse(req.body);
    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.ownerId, row.ownerId), inArray(servers.status, ["active", "stopped"])));
    if (!server) return reply.code(400).send({ error: "Pick one of your running or stopped servers" });
    if (server.vhiProjectId !== row.vhiProjectId) return reply.code(400).send({ error: "The volume and server are in different projects" });

    const updated = await transition(row, ["available"], { status: "attaching", serverId });
    if (!updated) return reply.code(409).send({ error: `Cannot attach a volume that is ${row.status}` });
    await audit(db, { actorId: req.user.id, action: "volume.attach", targetType: "volume", targetId: row.id, data: { serverId } });
    await enqueueVolumeOp(queues.volume, { volumeId: row.id, op: "attach", actorId: req.user.id });
    return reply.code(202).send({ volume: toDto(updated) });
  });

  app.post("/volumes/:id/detach", { preHandler: app.authenticate }, async (req, reply) => {
    const row = await loadOwned(req);
    if (!row) return reply.code(404).send({ error: "Volume not found" });
    const updated = await transition(row, ["attached"], { status: "detaching" });
    if (!updated) return reply.code(409).send({ error: `Cannot detach a volume that is ${row.status}` });
    await audit(db, { actorId: req.user.id, action: "volume.detach", targetType: "volume", targetId: row.id });
    await enqueueVolumeOp(queues.volume, { volumeId: row.id, op: "detach", actorId: req.user.id });
    return reply.code(202).send({ volume: toDto(updated) });
  });

  app.delete("/volumes/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const row = await loadOwned(req);
    if (!row) return reply.code(404).send({ error: "Volume not found" });
    const updated = await transition(row, ["available", "error"], { status: "deleting" });
    if (!updated) {
      return reply.code(409).send({ error: row.status === "attached" ? "Detach the volume before deleting it" : `Cannot delete a volume that is ${row.status}` });
    }
    await audit(db, { actorId: req.user.id, action: "volume.delete", targetType: "volume", targetId: row.id });
    await enqueueVolumeOp(queues.volume, { volumeId: row.id, op: "delete", actorId: req.user.id });
    return reply.code(202).send({ volume: toDto(updated) });
  });
}

function toDto(row: VolumeRow) {
  return {
    id: row.id,
    name: row.name,
    sizeGb: row.sizeGb,
    status: row.status,
    statusMessage: row.statusMessage,
    serverId: row.serverId,
    createdAt: row.createdAt,
  };
}
