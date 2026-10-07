/**
 * packages/vhi-connector/src/connector.ts
 *
 * Usage: the contract every cloud backend implements. The API and worker only
 * ever talk to these interfaces, so a second backend (plain OpenStack,
 * Proxmox…) can be added later without touching business logic.
 *
 *   const vhi: VhiConnector = createVhiConnector({ authUrl, username, ... });
 *   const flavors = await vhi.listFlavors();                       // cloud-wide catalog
 *   const { id } = await vhi.ensureProject({ name: "billdude-<account>" });
 *   await vhi.setProjectQuotas(id, { instances: 10, cores: 20, ... });
 *   const servers = await vhi.project(id).listServers();          // per-customer resources
 *
 * Each customer gets their own VHI project, so isolation and quotas are
 * enforced by the cloud itself, not just by the portal.
 */
import type {
  CreateServerInput,
  Flavor,
  Image,
  Network,
  FirewallRule,
  PowerAction,
  ProjectQuotas,
  Server,
  Volume,
} from "./types.js";

export interface VhiConnector {
  listFlavors(): Promise<Flavor[]>;
  listImages(): Promise<Image[]>;
  listNetworks(): Promise<Network[]>;

  /**
   * Finds or creates a project with this name in the service account's domain
   * and makes sure the service account can act inside it. Idempotent.
   */
  ensureProject(input: { name: string; description?: string }): Promise<{ id: string }>;
  setProjectQuotas(projectId: string, quotas: ProjectQuotas): Promise<void>;

  /** Resource operations scoped to one customer project. */
  project(projectId: string): VhiProject;
}

export interface VhiProject {
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

  /**
   * Makes the inbound rules of the project's "default" security group (which
   * every server gets) exactly match `rules`. Outbound rules and the built-in
   * same-group rule are left alone. Idempotent; returns what changed.
   */
  syncFirewall(rules: FirewallRule[]): Promise<{ added: number; removed: number }>;

  /** Data volumes (Cinder). Creation is asynchronous: poll getVolume() for "available". */
  createVolume(input: { name: string; sizeGb: number; metadata?: Record<string, string> }): Promise<{ id: string }>;
  /** Volumes whose metadata matches every given key. */
  listVolumes(filter?: { metadata?: Record<string, string> }): Promise<Volume[]>;
  /** Returns null when the volume does not exist. */
  getVolume(id: string): Promise<Volume | null>;
  /** Asynchronous; poll getVolume() for "in-use". */
  attachVolume(serverId: string, volumeId: string): Promise<void>;
  /** Asynchronous; poll getVolume() for "available". Detaching an unattached volume resolves normally. */
  detachVolume(serverId: string, volumeId: string): Promise<void>;
  /** Idempotent: deleting a volume that is already gone resolves normally. */
  deleteVolume(id: string): Promise<void>;
}
