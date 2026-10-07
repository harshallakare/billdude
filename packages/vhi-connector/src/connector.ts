/**
 * packages/vhi-connector/src/connector.ts
 *
 * Usage: the contract every cloud backend implements. The API and worker only
 * ever talk to this interface, so a second backend (plain OpenStack, Proxmox…)
 * can be added later without touching business logic.
 *
 *   const vhi: VhiConnector = createVhiConnector({ authUrl, username, ... });
 *   const flavors = await vhi.listFlavors();
 */
import type {
  CreateServerInput,
  Flavor,
  Image,
  Network,
  PowerAction,
  Server,
} from "./types.js";

export interface VhiConnector {
  listFlavors(): Promise<Flavor[]>;
  listImages(): Promise<Image[]>;
  listNetworks(): Promise<Network[]>;

  /** All servers in the project; optionally only those whose metadata matches every given key. */
  listServers(filter?: { metadata?: Record<string, string> }): Promise<Server[]>;
  /** Returns null when the server does not exist (or is already gone). */
  getServer(id: string): Promise<Server | null>;
  /** Starts provisioning and returns immediately; poll getServer() for BUILD -> ACTIVE/ERROR. */
  createServer(input: CreateServerInput): Promise<{ id: string }>;
  powerAction(id: string, action: PowerAction): Promise<void>;
  /** Idempotent: deleting a server that is already gone resolves normally. */
  deleteServer(id: string): Promise<void>;
  /** Short-lived noVNC URL for the server's console. */
  getConsoleUrl(id: string): Promise<string>;
}
