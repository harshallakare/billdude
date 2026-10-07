/**
 * apps/api/src/billing/pricing.ts
 *
 * Usage: what things cost, in micros per hour.
 *
 *   const prices = await loadPriceBook(db, config);
 *   prices.flavorHourly(flavor)            // admin override, else vCPU + RAM formula
 *   prices.storageGbHourly                 // per GB of boot volume
 *   prices.serverHourly(flavor, diskGb)    // everything for one server
 *   charge(seconds, hourlyMicros)          // integer micros for a usage period
 */
import type { Flavor } from "@billdude/vhi-connector";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { flavorPrices } from "../db/schema.js";
import { HOURS_PER_MONTH, parseAmount } from "./money.js";

export interface PriceBook {
  flavorHourly(flavor: Pick<Flavor, "id" | "vcpus" | "ramMb">): number;
  storageGbHourly: number;
  serverHourly(flavor: Pick<Flavor, "id" | "vcpus" | "ramMb">, diskGb: number): number;
  /** true when the admin set an explicit price for this flavor. */
  hasOverride(flavorId: string): boolean;
}

export async function loadPriceBook(db: Db, config: Config): Promise<PriceBook> {
  const overrides = new Map((await db.select().from(flavorPrices)).map((p) => [p.flavorId, p.hourlyMicros]));
  const vcpuHourly = parseAmount(config.BILLING_VCPU_HOURLY);
  const ramGbHourly = parseAmount(config.BILLING_RAM_GB_HOURLY);
  const storageGbHourly = parseAmount(config.BILLING_STORAGE_GB_MONTHLY) / HOURS_PER_MONTH;

  const flavorHourly = (flavor: Pick<Flavor, "id" | "vcpus" | "ramMb">) =>
    overrides.get(flavor.id) ?? Math.round(flavor.vcpus * vcpuHourly + (flavor.ramMb / 1024) * ramGbHourly);

  return {
    flavorHourly,
    storageGbHourly,
    serverHourly: (flavor, diskGb) => flavorHourly(flavor) + diskGb * storageGbHourly,
    hasOverride: (flavorId) => overrides.has(flavorId),
  };
}

/** Integer micros owed for `seconds` of something that costs `hourlyMicros` per hour. */
export function charge(seconds: number, hourlyMicros: number): number {
  return Math.round((seconds * hourlyMicros) / 3600);
}
