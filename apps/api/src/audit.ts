/**
 * apps/api/src/audit.ts
 *
 * Usage: append-only audit trail for security- and billing-relevant actions.
 *
 *   await audit(db, { actorId: user.id, action: "server.create", targetType: "server", targetId: id });
 */
import type { Db } from "./db/client.js";
import { auditLogs } from "./db/schema.js";

export async function audit(
  db: Db,
  entry: {
    actorId: string | null;
    action: string;
    targetType: string;
    targetId?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLogs).values(entry);
}
