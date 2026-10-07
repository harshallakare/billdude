/**
 * apps/api/src/catalog.ts
 *
 * Usage: short-lived in-memory cache of VHI flavors/images/networks so the
 * portal does not hit the cloud on every page load or create request.
 * Networks are filtered to what customers may attach to: the configured
 * allow-list, or every shared network when the list is empty.
 *
 *   const catalog = createCatalog(vhi, { allowedNetworkIds: ["net-1"] });
 *   const flavors = await catalog.flavors();
 */
import type { Flavor, Image, Network, VhiConnector } from "@billdude/vhi-connector";

export interface Catalog {
  flavors(): Promise<Flavor[]>;
  images(): Promise<Image[]>;
  networks(): Promise<Network[]>;
}

export function createCatalog(
  vhi: VhiConnector,
  options: { ttlMs?: number; allowedNetworkIds?: string[] } = {},
): Catalog {
  const ttlMs = options.ttlMs ?? 60_000;
  const allowed = options.allowedNetworkIds ?? [];
  const cached = <T>(load: () => Promise<T>) => {
    let entry: { value: Promise<T>; at: number } | null = null;
    return () => {
      if (!entry || Date.now() - entry.at > ttlMs) {
        const value = load();
        entry = { value, at: Date.now() };
        // Never cache failures.
        value.catch(() => {
          entry = null;
        });
      }
      return entry.value;
    };
  };
  return {
    flavors: cached(() => vhi.listFlavors()),
    images: cached(() => vhi.listImages()),
    networks: cached(async () =>
      (await vhi.listNetworks()).filter((n) => (allowed.length > 0 ? allowed.includes(n.id) : n.shared)),
    ),
  };
}
