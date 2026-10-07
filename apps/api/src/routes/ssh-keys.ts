/**
 * apps/api/src/routes/ssh-keys.ts
 *
 * Usage: customer SSH key management (mounted under /api, signed-in users):
 *   GET    /ssh-keys                    -> own keys
 *   POST   /ssh-keys { name, publicKey } -> add a key (validated, de-duplicated by fingerprint)
 *   DELETE /ssh-keys/:id                -> remove a key (existing servers keep their copy)
 * Keys are injected into new servers via cloud-init (see POST /servers sshKeyIds).
 */
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { audit } from "../audit.js";
import { sshKeys } from "../db/schema.js";
import { InvalidSshKeyError, parsePublicKey } from "../ssh.js";

export const MAX_SSH_KEYS_PER_CUSTOMER = 25;

const createBody = z.object({
  name: z.string().trim().min(1).max(64),
  publicKey: z.string().trim().min(1).max(16_384),
});
const idParams = z.object({ id: z.string().uuid() });

export async function sshKeyRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/ssh-keys", { preHandler: app.authenticate }, async (req) => {
    const rows = await db.select().from(sshKeys).where(eq(sshKeys.ownerId, req.user.id)).orderBy(desc(sshKeys.createdAt));
    return { sshKeys: rows.map(toDto) };
  });

  app.post("/ssh-keys", { preHandler: app.authenticate }, async (req, reply) => {
    const body = createBody.parse(req.body);
    let parsed;
    try {
      parsed = parsePublicKey(body.publicKey);
    } catch (error) {
      if (error instanceof InvalidSshKeyError) return reply.code(400).send({ error: error.message });
      throw error;
    }

    const existing = await db.select().from(sshKeys).where(eq(sshKeys.ownerId, req.user.id));
    if (existing.some((k) => k.fingerprint === parsed.fingerprint)) {
      return reply.code(409).send({ error: "You have already added this key" });
    }
    if (existing.length >= MAX_SSH_KEYS_PER_CUSTOMER) {
      return reply.code(403).send({ error: `You can store at most ${MAX_SSH_KEYS_PER_CUSTOMER} SSH keys` });
    }

    const [row] = await db
      .insert(sshKeys)
      .values({ ownerId: req.user.id, name: body.name, publicKey: parsed.publicKey, fingerprint: parsed.fingerprint })
      .returning();
    await audit(db, { actorId: req.user.id, action: "ssh_key.create", targetType: "ssh_key", targetId: row!.id });
    return reply.code(201).send({ sshKey: toDto(row!) });
  });

  app.delete("/ssh-keys/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [row] = await db
      .delete(sshKeys)
      .where(and(eq(sshKeys.id, id), eq(sshKeys.ownerId, req.user.id)))
      .returning({ id: sshKeys.id });
    if (!row) return reply.code(404).send({ error: "SSH key not found" });
    await audit(db, { actorId: req.user.id, action: "ssh_key.delete", targetType: "ssh_key", targetId: id });
    return { ok: true };
  });
}

function toDto(row: typeof sshKeys.$inferSelect) {
  return { id: row.id, name: row.name, publicKey: row.publicKey, fingerprint: row.fingerprint, createdAt: row.createdAt };
}
