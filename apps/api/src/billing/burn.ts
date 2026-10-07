/**
 * apps/api/src/billing/burn.ts
 *
 * Usage: what a customer's current resources cost per hour (micros), used for
 * the wallet "runway" and low-balance warnings.
 *
 *   const hourly = await hourlyBurn(db, prices, userId);
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { servers, volumes } from "../db/schema.js";
import type { PriceBook } from "./pricing.js";

export async function hourlyBurn(db: Db, prices: PriceBook, userId: string): Promise<number> {
  const liveServers = await db
    .select()
    .from(servers)
    .where(and(eq(servers.ownerId, userId), ne(servers.status, "deleted"), isNotNull(servers.billingStartedAt)));
  const liveVolumes = await db
    .select({ sizeGb: volumes.sizeGb })
    .from(volumes)
    .where(and(eq(volumes.ownerId, userId), ne(volumes.status, "deleted"), isNotNull(volumes.billingStartedAt)));
  return (
    liveServers.reduce(
      (sum, s) => sum + prices.serverHourly({ id: s.flavorId, vcpus: s.flavorVcpus, ramMb: s.flavorRamMb }, s.bootVolumeGb),
      0,
    ) + liveVolumes.reduce((sum, v) => sum + v.sizeGb * prices.storageGbHourly, 0)
  );
}
