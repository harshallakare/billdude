/**
 * packages/vhi-connector/src/index.ts
 *
 * Usage: public entry point of @billdude/vhi-connector.
 *
 *   import { createVhiConnector, type VhiConnector } from "@billdude/vhi-connector";
 *   const vhi = createVhiConnector(options);
 */
import type { VhiConnector } from "./connector.js";
import { OpenStackVhiConnector, type VhiConnectorOptions } from "./openstack/connector.js";

export type { VhiConnector } from "./connector.js";
export type { VhiConnectorOptions } from "./openstack/connector.js";
export * from "./errors.js";
export * from "./types.js";

export function createVhiConnector(options: VhiConnectorOptions): VhiConnector {
  return new OpenStackVhiConnector(options);
}
