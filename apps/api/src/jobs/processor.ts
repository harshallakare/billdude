/**
 * apps/api/src/jobs/processor.ts
 *
 * Usage: the business logic for each VM operation, independent of BullMQ so
 * it can be unit-tested directly:
 *
 *   const process = createVmProcessor({ db, vhi, pollMs: 3000 });
 *   await process({ serverId, op: "create", actorId });
 *
 * Every operation is written to be safe to retry: a crashed or retried
 * create first looks for a VM already tagged with this server id before
 * creating another one, so customers are never double-provisioned.
 */
import { isRetryable, type Server, type ServerStatus, type VhiConnector } from "@billdude/vhi-connector";
import { UnrecoverableError } from "bullmq";
import { eq } from "drizzle-orm";
import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { servers, type ServerRow, type ServerStatusValue } from "../db/schema.js";
import type { VmJobData } from "./queue.js";

export interface ProcessorDeps {
  db: Db;
  vhi: VhiConnector;
  /** Delay between status polls (default 3s). */
  pollMs?: number;
  /** Give up waiting for a status after this long (default 15 min). */
  timeoutMs?: number;
}

/** Metadata key linking a Nova server back to the portal row. */
export const SERVER_TAG = "billdude_server_id";
export const ACCOUNT_TAG = "billdude_account_id";

export function createVmProcessor(deps: ProcessorDeps) {
  const { db, vhi } = deps;
  const pollMs = deps.pollMs ?? 3_000;
  const timeoutMs = deps.timeoutMs ?? 15 * 60_000;

  const update = (id: string, values: Partial<ServerRow>) => db.update(servers).set(values).where(eq(servers.id, id));

  /** Poll until the VM reaches one of `targets` (or vanishes when "GONE" is a target). */
  async function waitFor(vhiId: string, targets: (ServerStatus | "GONE")[]): Promise<Server | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const server = await vhi.getServer(vhiId);
      if (!server || server.status === "DELETED") {
        if (targets.includes("GONE")) return null;
        throw new UnrecoverableError(`VM ${vhiId} disappeared from VHI`);
      }
      if (targets.includes(server.status)) return server;
      if (server.status === "ERROR") return server;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for VM ${vhiId} to reach ${targets.join("/")}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function settleFrom(row: ServerRow, vm: Server | null, ok: ServerStatusValue): Promise<void> {
    if (vm?.status === "ERROR") {
      await update(row.id, { status: "error", statusMessage: vm.fault ?? "The VM entered an error state" });
      return;
    }
    const ipv4 = vm?.addresses.find((a) => a.version === 4)?.ip ?? row.ipv4;
    await update(row.id, { status: ok, statusMessage: null, ipv4 });
  }

  async function create(row: ServerRow): Promise<void> {
    let vhiId = row.vhiServerId;
    if (!vhiId) {
      // Adopt a VM left behind by a previous attempt that crashed after createServer().
      const [existing] = await vhi.listServers({ metadata: { [SERVER_TAG]: row.id } });
      vhiId =
        existing?.id ??
        (
          await vhi.createServer({
            name: row.name,
            flavorId: row.flavorId,
            imageId: row.imageId,
            networkId: row.networkId,
            bootVolumeGb: row.bootVolumeGb,
            metadata: { [SERVER_TAG]: row.id, [ACCOUNT_TAG]: row.ownerId },
          })
        ).id;
      await update(row.id, { vhiServerId: vhiId, status: "building" });
    }
    const vm = await waitFor(vhiId, ["ACTIVE"]);
    await settleFrom(row, vm, "active");
  }

  async function power(row: ServerRow, op: "start" | "stop" | "reboot"): Promise<void> {
    if (!row.vhiServerId) throw new UnrecoverableError("Server was never provisioned");
    const current = await vhi.getServer(row.vhiServerId);
    const target: ServerStatus = op === "stop" ? "SHUTOFF" : "ACTIVE";
    // On retry the action may already have been applied; only issue it if needed.
    if (op === "reboot" || current?.status !== target) {
      await vhi.powerAction(row.vhiServerId, op);
    }
    const vm = await waitFor(row.vhiServerId, [target]);
    await settleFrom(row, vm, op === "stop" ? "stopped" : "active");
  }

  async function remove(row: ServerRow): Promise<void> {
    if (row.vhiServerId) {
      await vhi.deleteServer(row.vhiServerId);
      await waitFor(row.vhiServerId, ["GONE"]);
    }
    await update(row.id, { status: "deleted", deletedAt: new Date(), statusMessage: null });
  }

  return async function processVmJob(job: VmJobData): Promise<void> {
    const [row] = await db.select().from(servers).where(eq(servers.id, job.serverId));
    if (!row || row.status === "deleted") return;

    try {
      switch (job.op) {
        case "create":
          await create(row);
          break;
        case "start":
        case "stop":
        case "reboot":
          await power(row, job.op);
          break;
        case "delete":
          await remove(row);
          break;
      }
      await audit(db, { actorId: null, action: `server.${job.op}.completed`, targetType: "server", targetId: row.id });
    } catch (error) {
      // Transient cloud errors are retried by BullMQ; everything else fails fast.
      if (isRetryable(error) || error instanceof UnrecoverableError) throw error;
      if (error instanceof Error && error.message.startsWith("Timed out")) throw error;
      throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
    }
  };
}

/** Called when a job has exhausted its retries: surface the failure on the server row. */
export async function markJobFailed(db: Db, job: VmJobData, reason: string): Promise<void> {
  await db
    .update(servers)
    .set({ status: "error", statusMessage: `${job.op} failed: ${reason}` })
    .where(eq(servers.id, job.serverId));
  await audit(db, {
    actorId: null,
    action: `server.${job.op}.failed`,
    targetType: "server",
    targetId: job.serverId,
    data: { reason },
  });
}
