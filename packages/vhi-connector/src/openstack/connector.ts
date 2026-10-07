/**
 * packages/vhi-connector/src/openstack/connector.ts
 *
 * Usage: VhiConnector implementation for Virtuozzo Hybrid Infrastructure,
 * which exposes OpenStack-compatible Keystone (identity), Nova (compute),
 * Cinder (volume), Glance (image) and Neutron (network) APIs. Construct it
 * through createVhiConnector():
 *
 *   const vhi = createVhiConnector({
 *     authUrl: "https://vhi.example.com:5000/v3",
 *     username: "billdude", password: "…", userDomain: "Default",
 *     projectName: "billdude", projectDomain: "Default",
 *     volumeType: "default",          // optional VHI storage policy
 *   });
 *   const project = await vhi.ensureProject({ name: "billdude-acct-1" });
 *   const { id } = await vhi.project(project.id).createServer({ name, flavorId, imageId, networkId, bootVolumeGb: 20 });
 *
 * The service account needs permission to create projects and assign roles
 * in its domain (domain admin or cloud admin). It grants itself `memberRole`
 * on every customer project and then works inside it with a project-scoped token.
 *
 * VMs always boot from a Cinder volume created from the image, because that
 * is how VHI compute provisions disks.
 */
import type { VhiConnector, VhiProject } from "../connector.js";
import { VhiConflictError, VhiError, VhiNotFoundError } from "../errors.js";
import type {
  CreateServerInput,
  FirewallRule,
  Flavor,
  Image,
  Network,
  PowerAction,
  ProjectQuotas,
  Server,
  ServerAddress,
  ServerStatus,
  Volume,
  VolumeStatus,
} from "../types.js";
import { OpenStackClient, type OpenStackCredentials } from "./client.js";

export interface VhiConnectorOptions extends OpenStackCredentials {
  /** VHI storage policy (Cinder volume type) for boot volumes. */
  volumeType?: string;
  /** Role the service account grants itself on customer projects (default "member"). */
  memberRole?: string;
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

interface CinderVolume {
  id: string;
  name: string | null;
  size: number;
  status: string;
  attachments?: { server_id: string }[];
  metadata?: Record<string, string>;
}

interface NeutronRule {
  id: string;
  direction: "ingress" | "egress";
  ethertype: "IPv4" | "IPv6";
  protocol: string | null;
  port_range_min: number | null;
  port_range_max: number | null;
  remote_ip_prefix: string | null;
  remote_group_id: string | null;
}

interface NeutronNetwork {
  id: string;
  name: string;
  "router:external"?: boolean;
  shared?: boolean;
}

const KNOWN_STATUSES = new Set<ServerStatus>(["BUILD", "ACTIVE", "SHUTOFF", "REBOOT", "ERROR", "DELETED"]);

export class OpenStackVhiConnector implements VhiConnector {
  /** Client scoped to the configured service project; used for catalog and admin calls. */
  private readonly admin: OpenStackClient;
  private readonly projects = new Map<string, OpenStackVhiProject>();
  private memberRoleId: Promise<string> | null = null;

  constructor(private readonly options: VhiConnectorOptions) {
    this.admin = new OpenStackClient(options);
  }

  async listFlavors(): Promise<Flavor[]> {
    const body = await this.admin.request<{ flavors: NovaFlavor[] }>("compute", "GET", "/flavors/detail");
    return body.flavors.map((f) => ({ id: f.id, name: f.name, vcpus: f.vcpus, ramMb: f.ram, diskGb: f.disk }));
  }

  async listImages(): Promise<Image[]> {
    const body = await this.admin.request<{ images: GlanceImage[] }>(
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
    const body = await this.admin.request<{ networks: NeutronNetwork[] }>("network", "GET", "/v2.0/networks");
    return body.networks.map((n) => ({
      id: n.id,
      name: n.name,
      external: n["router:external"] ?? false,
      shared: n.shared ?? false,
    }));
  }

  async ensureProject(input: { name: string; description?: string }): Promise<{ id: string }> {
    const { userId, projectDomainId } = await this.admin.identity();
    const projectId = (await this.findProject(input.name, projectDomainId)) ?? (await this.createProject(input, projectDomainId));
    const roleId = await this.getMemberRoleId();
    // PUT is idempotent: re-granting an existing assignment is a no-op.
    await this.admin.request(
      "identity",
      "PUT",
      `/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    );
    return { id: projectId };
  }

  async setProjectQuotas(projectId: string, quotas: ProjectQuotas): Promise<void> {
    const id = encodeURIComponent(projectId);
    await this.admin.request("compute", "PUT", `/os-quota-sets/${id}`, {
      body: { quota_set: { instances: quotas.instances, cores: quotas.cores, ram: quotas.ramMb } },
    });
    await this.admin.request("volumev3", "PUT", `/os-quota-sets/${id}`, {
      body: { quota_set: { volumes: quotas.volumes, gigabytes: quotas.gigabytes } },
    });
  }

  project(projectId: string): VhiProject {
    let project = this.projects.get(projectId);
    if (!project) {
      project = new OpenStackVhiProject(projectId, new OpenStackClient(this.options, { projectId }), this.options);
      this.projects.set(projectId, project);
    }
    return project;
  }

  private async findProject(name: string, domainId: string): Promise<string | null> {
    const body = await this.admin.request<{ projects: { id: string }[] }>(
      "identity",
      "GET",
      `/projects?name=${encodeURIComponent(name)}&domain_id=${encodeURIComponent(domainId)}`,
    );
    return body.projects[0]?.id ?? null;
  }

  private async createProject(input: { name: string; description?: string }, domainId: string): Promise<string> {
    try {
      const body = await this.admin.request<{ project: { id: string } }>("identity", "POST", "/projects", {
        body: { project: { name: input.name, domain_id: domainId, description: input.description ?? "", enabled: true } },
      });
      return body.project.id;
    } catch (error) {
      // Another worker created it concurrently.
      if (error instanceof VhiConflictError) {
        const id = await this.findProject(input.name, domainId);
        if (id) return id;
      }
      throw error;
    }
  }

  private getMemberRoleId(): Promise<string> {
    const name = this.options.memberRole ?? "member";
    this.memberRoleId ??= this.admin
      .request<{ roles: { id: string; name: string }[] }>("identity", "GET", `/roles?name=${encodeURIComponent(name)}`)
      .then((body) => {
        const role = body.roles.find((r) => r.name === name);
        if (!role) throw new VhiError(`Keystone role "${name}" does not exist`, 404, false);
        return role.id;
      })
      .catch((error: unknown) => {
        this.memberRoleId = null;
        throw error;
      });
    return this.memberRoleId;
  }
}

/** Server operations inside one customer project. */
class OpenStackVhiProject implements VhiProject {
  constructor(
    private readonly projectId: string,
    private readonly client: OpenStackClient,
    private readonly options: VhiConnectorOptions,
  ) {}

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

  async syncFirewall(rules: FirewallRule[]): Promise<{ added: number; removed: number }> {
    const groupId = await this.defaultSecurityGroupId();
    const body = await this.client.request<{ security_group_rules: NeutronRule[] }>(
      "network",
      "GET",
      `/v2.0/security-group-rules?security_group_id=${encodeURIComponent(groupId)}`,
    );
    // Only plain inbound CIDR rules are ours; egress and the same-group rule stay untouched.
    const existing = new Map(
      body.security_group_rules
        .filter((r) => r.direction === "ingress" && !r.remote_group_id)
        .map((r) => [ruleKey(fromNeutronRule(r)), r]),
    );
    const desired = new Map(rules.map((r) => normalizeRule(r)).map((r) => [ruleKey(r), r]));

    let removed = 0;
    for (const [key, rule] of existing) {
      if (desired.has(key)) continue;
      try {
        await this.client.request("network", "DELETE", `/v2.0/security-group-rules/${encodeURIComponent(rule.id)}`);
      } catch (error) {
        if (!(error instanceof VhiNotFoundError)) throw error;
      }
      removed++;
    }

    let added = 0;
    for (const [key, rule] of desired) {
      if (existing.has(key)) continue;
      try {
        await this.client.request("network", "POST", "/v2.0/security-group-rules", {
          body: {
            security_group_rule: {
              security_group_id: groupId,
              direction: "ingress",
              ethertype: rule.cidr.includes(":") ? "IPv6" : "IPv4",
              protocol: rule.protocol === "any" ? null : rule.protocol,
              port_range_min: rule.portMin,
              port_range_max: rule.portMax,
              remote_ip_prefix: rule.cidr,
            },
          },
        });
      } catch (error) {
        // Already present (e.g. created by a concurrent sync).
        if (!(error instanceof VhiConflictError)) throw error;
      }
      added++;
    }
    return { added, removed };
  }

  async createVolume(input: { name: string; sizeGb: number; metadata?: Record<string, string> }): Promise<{ id: string }> {
    const body = await this.client.request<{ volume: { id: string } }>("volumev3", "POST", "/volumes", {
      body: {
        volume: {
          name: input.name,
          size: input.sizeGb,
          ...(this.options.volumeType ? { volume_type: this.options.volumeType } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      },
    });
    return { id: body.volume.id };
  }

  async listVolumes(filter: { metadata?: Record<string, string> } = {}): Promise<Volume[]> {
    const body = await this.client.request<{ volumes: CinderVolume[] }>("volumev3", "GET", "/volumes/detail");
    const wanted = Object.entries(filter.metadata ?? {});
    return body.volumes.map(toVolume).filter((v) => wanted.every(([k, val]) => v.metadata[k] === val));
  }

  async getVolume(id: string): Promise<Volume | null> {
    try {
      const body = await this.client.request<{ volume: CinderVolume }>("volumev3", "GET", `/volumes/${encodeURIComponent(id)}`);
      return toVolume(body.volume);
    } catch (error) {
      if (error instanceof VhiNotFoundError) return null;
      throw error;
    }
  }

  async attachVolume(serverId: string, volumeId: string): Promise<void> {
    await this.client.request("compute", "POST", `/servers/${encodeURIComponent(serverId)}/os-volume_attachments`, {
      body: { volumeAttachment: { volumeId } },
    });
  }

  async detachVolume(serverId: string, volumeId: string): Promise<void> {
    try {
      await this.client.request(
        "compute",
        "DELETE",
        `/servers/${encodeURIComponent(serverId)}/os-volume_attachments/${encodeURIComponent(volumeId)}`,
      );
    } catch (error) {
      if (error instanceof VhiNotFoundError) return;
      throw error;
    }
  }

  async deleteVolume(id: string): Promise<void> {
    try {
      await this.client.request("volumev3", "DELETE", `/volumes/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof VhiNotFoundError) return;
      throw error;
    }
  }

  private async defaultSecurityGroupId(): Promise<string> {
    const body = await this.client.request<{ security_groups: { id: string; project_id?: string; tenant_id?: string }[] }>(
      "network",
      "GET",
      `/v2.0/security-groups?name=default&project_id=${encodeURIComponent(this.projectId)}`,
    );
    const group = body.security_groups.find((g) => (g.project_id ?? g.tenant_id) === this.projectId);
    if (!group) throw new VhiError(`Project ${this.projectId} has no default security group`, 404, true);
    return group.id;
  }
}

/** Canonical form: ports only for tcp/udp, single ports expanded to a range, CIDR lower-cased. */
function normalizeRule(rule: FirewallRule): FirewallRule {
  const ported = rule.protocol === "tcp" || rule.protocol === "udp";
  return {
    protocol: rule.protocol,
    portMin: ported ? rule.portMin : null,
    portMax: ported ? (rule.portMax ?? rule.portMin) : null,
    cidr: rule.cidr.trim().toLowerCase(),
  };
}

function fromNeutronRule(r: NeutronRule): FirewallRule {
  const protocol = r.protocol === "tcp" || r.protocol === "udp" || r.protocol === "icmp" ? r.protocol : "any";
  return normalizeRule({
    protocol,
    portMin: r.port_range_min,
    portMax: r.port_range_max,
    cidr: r.remote_ip_prefix ?? (r.ethertype === "IPv6" ? "::/0" : "0.0.0.0/0"),
  });
}

function ruleKey(r: FirewallRule): string {
  return `${r.protocol}|${r.portMin ?? ""}|${r.portMax ?? ""}|${r.cidr}`;
}

const VOLUME_STATUSES = new Set<VolumeStatus>(["creating", "available", "attaching", "in-use", "detaching", "deleting", "error"]);

function toVolume(v: CinderVolume): Volume {
  const status = v.status.startsWith("error")
    ? "error"
    : VOLUME_STATUSES.has(v.status as VolumeStatus)
      ? (v.status as VolumeStatus)
      : "unknown";
  return {
    id: v.id,
    name: v.name ?? v.id,
    sizeGb: v.size,
    status,
    attachedTo: v.attachments?.[0]?.server_id ?? null,
    metadata: v.metadata ?? {},
  };
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
