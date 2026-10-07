/**
 * packages/vhi-connector/src/openstack/connector.ts
 *
 * Usage: VhiConnector implementation for Virtuozzo Hybrid Infrastructure,
 * which exposes OpenStack-compatible Nova (compute), Glance (image) and
 * Neutron (network) APIs. Construct it through createVhiConnector():
 *
 *   const vhi = createVhiConnector({
 *     authUrl: "https://vhi.example.com:5000/v3",
 *     username: "billdude", password: "…", userDomain: "Default",
 *     projectName: "billdude", projectDomain: "Default",
 *     volumeType: "default",          // optional VHI storage policy
 *   });
 *   const { id } = await vhi.createServer({ name, flavorId, imageId, networkId, bootVolumeGb: 20 });
 *
 * VMs always boot from a Cinder volume created from the image, because that
 * is how VHI compute provisions disks.
 */
import type { VhiConnector } from "../connector.js";
import { VhiNotFoundError } from "../errors.js";
import type {
  CreateServerInput,
  Flavor,
  Image,
  Network,
  PowerAction,
  Server,
  ServerAddress,
  ServerStatus,
} from "../types.js";
import { OpenStackClient, type OpenStackCredentials } from "./client.js";

export interface VhiConnectorOptions extends OpenStackCredentials {
  /** VHI storage policy (Cinder volume type) for boot volumes. */
  volumeType?: string;
}

/* ---- Raw OpenStack payload shapes (only the fields we read) ---- */

interface NovaFlavor {
  id: string;
  name: string;
  vcpus: number;
  ram: number;
  disk: number;
}

interface NovaServer {
  id: string;
  name: string;
  status: string;
  flavor: { id?: string; original_name?: string };
  addresses?: Record<string, { addr: string; version: number; "OS-EXT-IPS:type"?: string }[]>;
  metadata?: Record<string, string>;
  created: string;
  fault?: { message?: string };
}

interface GlanceImage {
  id: string;
  name: string | null;
  status: string;
  min_disk?: number;
  min_ram?: number;
}

interface NeutronNetwork {
  id: string;
  name: string;
  "router:external"?: boolean;
  shared?: boolean;
}

const KNOWN_STATUSES = new Set<ServerStatus>(["BUILD", "ACTIVE", "SHUTOFF", "REBOOT", "ERROR", "DELETED"]);

export class OpenStackVhiConnector implements VhiConnector {
  private readonly client: OpenStackClient;

  constructor(private readonly options: VhiConnectorOptions) {
    this.client = new OpenStackClient(options);
  }

  async listFlavors(): Promise<Flavor[]> {
    const body = await this.client.request<{ flavors: NovaFlavor[] }>("compute", "GET", "/flavors/detail");
    return body.flavors.map((f) => ({ id: f.id, name: f.name, vcpus: f.vcpus, ramMb: f.ram, diskGb: f.disk }));
  }

  async listImages(): Promise<Image[]> {
    const body = await this.client.request<{ images: GlanceImage[] }>(
      "image",
      "GET",
      "/v2/images?status=active&limit=1000",
    );
    return body.images.map((i) => ({
      id: i.id,
      name: i.name ?? i.id,
      status: i.status,
      minDiskGb: i.min_disk ?? 0,
      minRamMb: i.min_ram ?? 0,
    }));
  }

  async listNetworks(): Promise<Network[]> {
    const body = await this.client.request<{ networks: NeutronNetwork[] }>("network", "GET", "/v2.0/networks");
    return body.networks.map((n) => ({
      id: n.id,
      name: n.name,
      external: n["router:external"] ?? false,
      shared: n.shared ?? false,
    }));
  }

  async listServers(filter: { metadata?: Record<string, string> } = {}): Promise<Server[]> {
    const body = await this.client.request<{ servers: NovaServer[] }>("compute", "GET", "/servers/detail");
    const servers = body.servers.map(toServer);
    const wanted = Object.entries(filter.metadata ?? {});
    // Nova cannot filter by metadata server-side, so filter here.
    return wanted.length === 0
      ? servers
      : servers.filter((s) => wanted.every(([k, v]) => s.metadata[k] === v));
  }

  async getServer(id: string): Promise<Server | null> {
    try {
      const body = await this.client.request<{ server: NovaServer }>(
        "compute",
        "GET",
        `/servers/${encodeURIComponent(id)}`,
      );
      return toServer(body.server);
    } catch (error) {
      if (error instanceof VhiNotFoundError) return null;
      throw error;
    }
  }

  async createServer(input: CreateServerInput): Promise<{ id: string }> {
    const blockDevice: Record<string, unknown> = {
      boot_index: 0,
      uuid: input.imageId,
      source_type: "image",
      destination_type: "volume",
      volume_size: input.bootVolumeGb,
      delete_on_termination: true,
    };
    if (this.options.volumeType) blockDevice.volume_type = this.options.volumeType;

    const body = await this.client.request<{ server: { id: string } }>("compute", "POST", "/servers", {
      // volume_type inside block_device_mapping_v2 needs compute microversion 2.67.
      headers: this.options.volumeType ? { "OpenStack-API-Version": "compute 2.67" } : undefined,
      body: {
        server: {
          name: input.name,
          flavorRef: input.flavorId,
          networks: [{ uuid: input.networkId }],
          block_device_mapping_v2: [blockDevice],
          ...(input.keyName ? { key_name: input.keyName } : {}),
          ...(input.userData ? { user_data: Buffer.from(input.userData, "utf8").toString("base64") } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      },
    });
    return { id: body.server.id };
  }

  async powerAction(id: string, action: PowerAction): Promise<void> {
    const actionBody =
      action === "start"
        ? { "os-start": null }
        : action === "stop"
          ? { "os-stop": null }
          : { reboot: { type: action === "hard-reboot" ? "HARD" : "SOFT" } };
    await this.client.request("compute", "POST", `/servers/${encodeURIComponent(id)}/action`, {
      body: actionBody,
    });
  }

  async deleteServer(id: string): Promise<void> {
    try {
      await this.client.request("compute", "DELETE", `/servers/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof VhiNotFoundError) return;
      throw error;
    }
  }

  async getConsoleUrl(id: string): Promise<string> {
    const body = await this.client.request<{ remote_console: { url: string } }>(
      "compute",
      "POST",
      `/servers/${encodeURIComponent(id)}/remote-consoles`,
      {
        headers: { "OpenStack-API-Version": "compute 2.6" },
        body: { remote_console: { protocol: "vnc", type: "novnc" } },
      },
    );
    return body.remote_console.url;
  }
}

function toServer(s: NovaServer): Server {
  const addresses: ServerAddress[] = [];
  for (const [network, entries] of Object.entries(s.addresses ?? {})) {
    for (const entry of entries) {
      const type = entry["OS-EXT-IPS:type"];
      addresses.push({
        network,
        ip: entry.addr,
        version: entry.version === 6 ? 6 : 4,
        type: type === "fixed" || type === "floating" ? type : "unknown",
      });
    }
  }
  const status = KNOWN_STATUSES.has(s.status as ServerStatus) ? (s.status as ServerStatus) : "UNKNOWN";
  return {
    id: s.id,
    name: s.name,
    status,
    rawStatus: s.status,
    flavorId: s.flavor.id ?? s.flavor.original_name ?? "",
    addresses,
    metadata: s.metadata ?? {},
    createdAt: s.created,
    ...(s.fault?.message ? { fault: s.fault.message } : {}),
  };
}
