/**
 * apps/api/src/jobs/processor.ts
 *
 * Usage: the business logic for every background job, independent of BullMQ
 * so it can be tested directly:
 *
 *   const { processVmJob, processAccountJob, processVolumeJob } = createProcessors({ db, vhi, accounts, pollMs: 3000 });
 *   await processVmJob({ serverId, op: "create", actorId });
 *   await processAccountJob({ userId, op: "provision" });
 *
 * Every operation is written to be safe to retry: a crashed or retried
 * create first looks for a VM already tagged with this server id before
 * creating another one, so customers are never double-provisioned.
 */
import {
  isRetryable,
  VhiQuotaError,
  type Server,
  type ServerStatus,
  type VhiConnector,
  type VhiProject,
  type Volume,
  type VolumeStatus,
} from "@billdude/vhi-connector";
import { UnrecoverableError } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import type { AccountService } from "../accounts.js";
import { audit } from "../audit.js";
import type { Db } from "../db/client.js";
import { servers, volumes, type ServerRow, type ServerStatusValue, type VolumeRow } from "../db/schema.js";
import { buildCloudInit } from "../ssh.js";
import type { AccountJobData, VmJobData, VolumeJobData } from "./queue.js";

export interface ProcessorDeps {
  db: Db;
  vhi: VhiConnector;
  accounts: AccountService;
  /** Delay between status polls (default 3s). */
  pollMs?: number;
  /** Give up waiting for a status after this long (default 15 min). */
  timeoutMs?: number;
}

/** Metadata key linking a Nova server back to the portal row. */
export const SERVER_TAG = "billdude_server_id";
export const ACCOUNT_TAG = "billdude_account_id";
export const VOLUME_TAG = "billdude_volume_id";

class TimeoutError extends Error {}

export function createProcessors(deps: ProcessorDeps) {
  const { db, vhi, accounts } = deps;
  const pollMs = deps.pollMs ?? 3_000;
  const timeoutMs = deps.timeoutMs ?? 15 * 60_000;

  const update = (id: string, values: Partial<ServerRow>) => db.update(servers).set(values).where(eq(servers.id, id));

  /** Poll until the VM reaches one of `targets` (or vanishes when "GONE" is a target). */
  async function waitFor(project: VhiProject, vhiId: string, targets: (ServerStatus | "GONE")[]): Promise<Server | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const server = await project.getServer(vhiId);
      if (!server || server.status === "DELETED") {
        if (targets.includes("GONE")) return null;
        throw new UnrecoverableError(`VM ${vhiId} disappeared from VHI`);
      }
      if (targets.includes(server.status)) return server;
      if (server.status === "ERROR") return server;
      if (Date.now() > deadline) throw new TimeoutError(`Timed out waiting for VM ${vhiId} to reach ${targets.join("/")}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function settleFrom(row: ServerRow, vm: Server | null, ok: ServerStatusValue): Promise<void> {
    if (vm?.status === "ERROR") {
      await update(row.id, { status: "error", statusMessage: vm.fault ?? "The VM entered an error state" });
      return;
    }
    const ipv4 = vm?.addresses.find((a) => a.version === 4)?.ip ?? row.ipv4;
    // Billing starts the first time the VM is up.
    const billingStartedAt = row.billingStartedAt ?? (ok === "active" ? new Date() : null);
    await update(row.id, { status: ok, statusMessage: null, ipv4, billingStartedAt });
  }

  async function create(row: ServerRow): Promise<void> {
    let projectId = row.vhiProjectId;
    if (!projectId) {
      projectId = await accounts.ensureProject(row.ownerId);
      await update(row.id, { vhiProjectId: projectId });
    }
    const project = vhi.project(projectId);

    let vhiId = row.vhiServerId;
    if (!vhiId) {
      // Adopt a VM left behind by a previous attempt that crashed after createServer().
      const [existing] = await project.listServers({ metadata: { [SERVER_TAG]: row.id } });
      vhiId =
        existing?.id ??
        (
          await project.createServer({
            name: row.name,
            flavorId: row.flavorId,
            imageId: row.imageId,
            networkId: row.networkId,
            bootVolumeGb: row.bootVolumeGb,
            userData: buildCloudInit(row.sshPublicKeys),
            metadata: { [SERVER_TAG]: row.id, [ACCOUNT_TAG]: row.ownerId },
          })
        ).id;
      await update(row.id, { vhiServerId: vhiId, status: "building" });
    }
    const vm = await waitFor(project, vhiId, ["ACTIVE"]);
    await settleFrom(row, vm, "active");
  }

  async function power(row: ServerRow, op: "start" | "stop" | "reboot"): Promise<void> {
    if (!row.vhiServerId || !row.vhiProjectId) throw new UnrecoverableError("Server was never provisioned");
    const project = vhi.project(row.vhiProjectId);
    const current = await project.getServer(row.vhiServerId);
    const target: ServerStatus = op === "stop" ? "SHUTOFF" : "ACTIVE";
    // On retry the action may already have been applied; only issue it if needed.
    if (op === "reboot" || current?.status !== target) {
      await project.powerAction(row.vhiServerId, op);
    }
    const vm = await waitFor(project, row.vhiServerId, [target]);
    await settleFrom(row, vm, op === "stop" ? "stopped" : "active");
  }

  async function remove(row: ServerRow): Promise<void> {
    if (row.vhiServerId && row.vhiProjectId) {
      const project = vhi.project(row.vhiProjectId);
      await project.deleteServer(row.vhiServerId);
      await waitFor(project, row.vhiServerId, ["GONE"]);
    }
    await update(row.id, { status: "deleted", deletedAt: new Date(), statusMessage: null });
    // VHI detaches data volumes from deleted servers; mirror that.
    await db
      .update(volumes)
      .set({ serverId: null, status: "available", statusMessage: null })
      .where(and(eq(volumes.serverId, row.id), inArray(volumes.status, ["attached", "attaching", "detaching"])));
  }

  /* ---------------- volumes ---------------- */

  const updateVolume = (id: string, values: Partial<VolumeRow>) => db.update(volumes).set(values).where(eq(volumes.id, id));

  async function waitForVolume(project: VhiProject, vhiId: string, targets: (VolumeStatus | "GONE")[]): Promise<Volume | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const volume = await project.getVolume(vhiId);
      if (!volume) {
        if (targets.includes("GONE")) return null;
        throw new UnrecoverableError(`Volume ${vhiId} disappeared from VHI`);
      }
      if (targets.includes(volume.status)) return volume;
      if (volume.status === "error") return volume;
      if (Date.now() > deadline) throw new TimeoutError(`Timed out waiting for volume ${vhiId} to reach ${targets.join("/")}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async function createVolume(row: VolumeRow): Promise<void> {
    let projectId = row.vhiProjectId;
    if (!projectId) {
      projectId = await accounts.ensureProject(row.ownerId);
      await updateVolume(row.id, { vhiProjectId: projectId });
    }
    const project = vhi.project(projectId);
    let vhiId = row.vhiVolumeId;
    if (!vhiId) {
      const [existing] = await project.listVolumes({ metadata: { [VOLUME_TAG]: row.id } });
      vhiId =
        existing?.id ??
        (await project.createVolume({ name: row.name, sizeGb: row.sizeGb, metadata: { [VOLUME_TAG]: row.id, [ACCOUNT_TAG]: row.ownerId } }))
          .id;
      await updateVolume(row.id, { vhiVolumeId: vhiId });
    }
    const volume = await waitForVolume(project, vhiId, ["available"]);
    if (volume?.status === "error") {
      await updateVolume(row.id, { status: "error", statusMessage: "VHI could not create the volume" });
      return;
    }
    await updateVolume(row.id, { status: "available", statusMessage: null, billingStartedAt: row.billingStartedAt ?? new Date() });
  }

  async function attachVolume(row: VolumeRow): Promise<void> {
    if (!row.vhiVolumeId || !row.vhiProjectId || !row.serverId) throw new UnrecoverableError("Volume or target server missing");
    const [server] = await db.select().from(servers).where(eq(servers.id, row.serverId));
    if (!server?.vhiServerId) throw new UnrecoverableError("The server is not provisioned");
    const project = vhi.project(row.vhiProjectId);
    const current = await project.getVolume(row.vhiVolumeId);
    if (current?.status !== "in-use") await project.attachVolume(server.vhiServerId, row.vhiVolumeId);
    const volume = await waitForVolume(project, row.vhiVolumeId, ["in-use"]);
    if (volume?.status === "error") {
      await updateVolume(row.id, { status: "error", statusMessage: "VHI could not attach the volume" });
      return;
    }
    await updateVolume(row.id, { status: "attached", statusMessage: null });
  }

  async function detachVolume(row: VolumeRow): Promise<void> {
    if (!row.vhiVolumeId || !row.vhiProjectId) throw new UnrecoverableError("Volume was never provisioned");
    const project = vhi.project(row.vhiProjectId);
    const current = await project.getVolume(row.vhiVolumeId);
    if (current?.attachedTo) await project.detachVolume(current.attachedTo, row.vhiVolumeId);
    await waitForVolume(project, row.vhiVolumeId, ["available"]);
    await updateVolume(row.id, { status: "available", serverId: null, statusMessage: null });
  }

  async function deleteVolume(row: VolumeRow): Promise<void> {
    if (row.vhiVolumeId && row.vhiProjectId) {
      const project = vhi.project(row.vhiProjectId);
      await project.deleteVolume(row.vhiVolumeId);
      await waitForVolume(project, row.vhiVolumeId, ["GONE"]);
    }
    await updateVolume(row.id, { status: "deleted", deletedAt: new Date(), serverId: null, statusMessage: null });
  }

  async function processVolumeJob(job: VolumeJobData): Promise<void> {
    const [row] = await db.select().from(volumes).where(eq(volumes.id, job.volumeId));
    if (!row || row.status === "deleted") return;
    try {
      if (job.op === "create") await createVolume(row);
      else if (job.op === "attach") await attachVolume(row);
      else if (job.op === "detach") await detachVolume(row);
      else await deleteVolume(row);
    } catch (error) {
      classify(error);
    }
    await audit(db, { actorId: null, action: `volume.${job.op}.completed`, targetType: "volume", targetId: row.id });
  }

  /** Transient cloud errors are retried by BullMQ; everything else fails fast. */
  function classify(error: unknown): never {
    if (error instanceof VhiQuotaError) {
      throw new UnrecoverableError("Your resource quota does not allow this. Delete unused servers or ask support to raise it.");
    }
    if (isRetryable(error) || error instanceof UnrecoverableError || error instanceof TimeoutError) throw error;
    throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
  }

  async function processVmJob(job: VmJobData): Promise<void> {
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
    } catch (error) {
      classify(error);
    }
    await audit(db, { actorId: null, action: `server.${job.op}.completed`, targetType: "server", targetId: row.id });
  }

  async function processAccountJob(job: AccountJobData): Promise<void> {
    try {
      if (job.op === "provision") await accounts.ensureProject(job.userId);
      else if (job.op === "sync-quotas") await accounts.syncQuotas(job.userId);
      else await accounts.syncFirewall(job.userId);
    } catch (error) {
      classify(error);
    }
  }

  return { processVmJob, processAccountJob, processVolumeJob };
}

/** Called when a volume job has exhausted its retries. */
export async function markVolumeJobFailed(db: Db, job: VolumeJobData, reason: string): Promise<void> {
  await db
    .update(volumes)
    .set({ status: "error", statusMessage: `${job.op} failed: ${reason}` })
    .where(eq(volumes.id, job.volumeId));
  await audit(db, { actorId: null, action: `volume.${job.op}.failed`, targetType: "volume", targetId: job.volumeId, data: { reason } });
}

/** Called when a VM job has exhausted its retries: surface the failure on the server row. */
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
