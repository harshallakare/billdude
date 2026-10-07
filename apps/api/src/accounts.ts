/**
 * apps/api/src/accounts.ts
 *
 * Usage: links portal customers to their own VHI project and keeps the
 * project's quotas in sync. Used by the worker (never from request handlers,
 * because it calls the cloud).
 *
 *   const accounts = createAccountService({ db, vhi, config });
 *   const projectId = await accounts.ensureProject(userId);   // idempotent; applies quotas + firewall on creation
 *   await accounts.syncQuotas(userId);                         // push quotas to VHI
 *   await accounts.syncFirewall(userId);                       // push firewall rules to VHI
 *
 * Usage accounting for the portal-side quota check lives in computeUsage().
 */
import type { Flavor, ProjectQuotas, VhiConnector } from "@billdude/vhi-connector";
import { and, eq, isNull, ne } from "drizzle-orm";
import { defaultQuotas, type Config } from "./config.js";
import type { Db } from "./db/client.js";
import { firewallRules, servers, users, volumes, type User } from "./db/schema.js";
import { toConnectorRules } from "./firewall.js";

export interface AccountDeps {
  db: Db;
  vhi: VhiConnector;
  config: Config;
}

export function effectiveQuotas(user: Pick<User, "quotas">, config: Config): ProjectQuotas {
  return { ...defaultQuotas(config), ...(user.quotas ?? {}) };
}

export function createAccountService({ db, vhi, config }: AccountDeps) {
  async function loadFirewall(userId: string) {
    return toConnectorRules(await db.select().from(firewallRules).where(eq(firewallRules.userId, userId)));
  }

  async function load(userId: string): Promise<User> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error(`User ${userId} not found`);
    return user;
  }

  return {
    async ensureProject(userId: string): Promise<string> {
      const user = await load(userId);
      if (user.vhiProjectId) return user.vhiProjectId;

      const { id } = await vhi.ensureProject({
        name: `${config.VHI_PROJECT_PREFIX}${user.id}`,
        description: `billdude customer ${user.email}`,
      });
      await vhi.setProjectQuotas(id, effectiveQuotas(user, config));
      await vhi.project(id).syncFirewall(await loadFirewall(user.id));
      // Only the first writer wins; ensureProject() is idempotent so a racing job got the same id.
      await db.update(users).set({ vhiProjectId: id }).where(and(eq(users.id, userId), isNull(users.vhiProjectId)));
      return id;
    },

    /** Pushes the customer's quotas to VHI. A no-op until their project exists. */
    async syncQuotas(userId: string): Promise<void> {
      const user = await load(userId);
      if (!user.vhiProjectId) return;
      await vhi.setProjectQuotas(user.vhiProjectId, effectiveQuotas(user, config));
    },

    /** Pushes the customer's firewall rules to VHI. A no-op until their project exists. */
    async syncFirewall(userId: string): Promise<void> {
      const user = await load(userId);
      if (!user.vhiProjectId) return;
      await vhi.project(user.vhiProjectId).syncFirewall(await loadFirewall(user.id));
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;

/** Resources currently held by a customer (servers, boot disks and data volumes), from portal records. */
export async function computeUsage(db: Db, flavors: Flavor[], userId: string): Promise<ProjectQuotas> {
  const rows = await db
    .select({ flavorId: servers.flavorId, bootVolumeGb: servers.bootVolumeGb })
    .from(servers)
    .where(and(eq(servers.ownerId, userId), ne(servers.status, "deleted")));
  const dataVolumes = await db
    .select({ sizeGb: volumes.sizeGb })
    .from(volumes)
    .where(and(eq(volumes.ownerId, userId), ne(volumes.status, "deleted")));
  const byId = new Map(flavors.map((f) => [f.id, f]));
  const fromServers = rows.reduce<ProjectQuotas>(
    (acc, row) => {
      const flavor = byId.get(row.flavorId);
      return {
        instances: acc.instances + 1,
        cores: acc.cores + (flavor?.vcpus ?? 0),
        ramMb: acc.ramMb + (flavor?.ramMb ?? 0),
        volumes: acc.volumes + 1,
        gigabytes: acc.gigabytes + row.bootVolumeGb,
      };
    },
    { instances: 0, cores: 0, ramMb: 0, volumes: 0, gigabytes: 0 },
  );
  return {
    ...fromServers,
    volumes: fromServers.volumes + dataVolumes.length,
    gigabytes: fromServers.gigabytes + dataVolumes.reduce((sum, v) => sum + v.sizeGb, 0),
  };
}

/** Returns the first quota the request would exceed, or null. */
export function exceededQuota(
  limits: ProjectQuotas,
  usage: ProjectQuotas,
  request: ProjectQuotas,
): { resource: keyof ProjectQuotas; limit: number; used: number } | null {
  for (const resource of Object.keys(limits) as (keyof ProjectQuotas)[]) {
    const limit = limits[resource];
    if (limit >= 0 && usage[resource] + request[resource] > limit) {
      return { resource, limit, used: usage[resource] };
    }
  }
  return null;
}
