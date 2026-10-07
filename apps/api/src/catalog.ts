/**
 * apps/api/src/catalog.ts
 *
 * Usage: short-lived in-memory cache of VHI flavors/images/networks so the
 * portal does not hit the cloud on every page load or create request.
 *
 *   const catalog = createCatalog(vhi, 60_000);
 *   const flavors = await catalog.flavors();
 */
import type { Flavor, Image, Network, VhiConnector } from "@billdude/vhi-connector";

export interface Catalog {
  flavors(): Promise<Flavor[]>;
  images(): Promise<Image[]>;
  networks(): Promise<Network[]>;
}

export function createCatalog(vhi: VhiConnector, ttlMs = 60_000): Catalog {
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
    networks: cached(() => vhi.listNetworks()),
  };
}
