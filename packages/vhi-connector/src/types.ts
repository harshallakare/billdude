/**
 * packages/vhi-connector/src/types.ts
 *
 * Usage: provider-neutral domain types shared by the connector, the API and
 * the worker. Import them from the package root:
 *
 *   import type { Server, CreateServerInput } from "@billdude/vhi-connector";
 *
 * These shapes are deliberately smaller than the raw OpenStack payloads so the
 * rest of the codebase never depends on Nova/Glance/Neutron field names.
 */

/** Normalised lifecycle state of a VM on the cloud side. */
export type ServerStatus =
  | "BUILD"
  | "ACTIVE"
  | "SHUTOFF"
  | "REBOOT"
  | "ERROR"
  | "DELETED"
  | "UNKNOWN";

export interface Flavor {
  id: string;
  name: string;
  vcpus: number;
  ramMb: number;
  /** Root disk size from the flavor. 0 means "boot from volume, size chosen at create time". */
  diskGb: number;
}

export interface Image {
  id: string;
  name: string;
  status: string;
  minDiskGb: number;
  minRamMb: number;
}

export interface Network {
  id: string;
  name: string;
  /** true for provider/external networks that hand out public addresses. */
  external: boolean;
  shared: boolean;
}

export interface ServerAddress {
  network: string;
  ip: string;
  version: 4 | 6;
  type: "fixed" | "floating" | "unknown";
}

export interface Server {
  id: string;
  name: string;
  status: ServerStatus;
  /** Raw provider status string, kept for diagnostics. */
  rawStatus: string;
  flavorId: string;
  addresses: ServerAddress[];
  metadata: Record<string, string>;
  createdAt: string;
  /** Provider fault message when status is ERROR. */
  fault?: string;
}

export interface CreateServerInput {
  name: string;
  flavorId: string;
  imageId: string;
  networkId: string;
  /** Size of the boot volume created from the image (VHI boots VMs from volumes). */
  bootVolumeGb: number;
  keyName?: string;
  /** Plain-text cloud-init user data; the connector base64-encodes it. */
  userData?: string;
  metadata?: Record<string, string>;
}

export type PowerAction = "start" | "stop" | "reboot" | "hard-reboot";
