/**
 * apps/web/src/lib/api.ts
 *
 * Usage: typed client for the billdude API. All calls send the session cookie.
 *
 *   const { servers } = await api.listServers();
 *   await api.serverAction(id, "stop");
 *
 * Failed requests throw ApiError with the server's message and HTTP status.
 */

export type ServerStatus =
  | "pending"
  | "building"
  | "active"
  | "stopping"
  | "stopped"
  | "starting"
  | "rebooting"
  | "error"
  | "deleting"
  | "deleted";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "customer";
  emailVerified: boolean;
}

export interface Server {
  id: string;
  ownerId: string;
  name: string;
  status: ServerStatus;
  statusMessage: string | null;
  flavorId: string;
  imageId: string;
  networkId: string;
  bootVolumeGb: number;
  ipv4: string | null;
  createdAt: string;
}

export interface Flavor {
  id: string;
  name: string;
  vcpus: number;
  ramMb: number;
  diskGb: number;
}
export interface Image {
  id: string;
  name: string;
  minDiskGb: number;
}
export interface Network {
  id: string;
  name: string;
  external: boolean;
}

export interface CreateServerInput {
  name: string;
  flavorId: string;
  imageId: string;
  networkId: string;
  bootVolumeGb: number;
  sshKeyIds: string[];
}

export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface Quotas {
  instances: number;
  cores: number;
  ramMb: number;
  volumes: number;
  gigabytes: number;
}

export interface Wallet {
  currency: string;
  balance: string;
  hourlyBurn: string;
  runwayHours: number | null;
  overdueSince: string | null;
  graceHours: number;
  minTopup: number;
  maxTopup: number;
  gateway: "razorpay" | "fake";
}

export interface WalletTransaction {
  id: string;
  type: "topup" | "usage" | "credit" | "adjustment" | "refund";
  amount: string;
  balanceAfter: string;
  description: string;
  createdAt: string;
}

export interface TopupOrder {
  gateway: "razorpay" | "fake";
  keyId: string | null;
  orderId: string;
  amountMinor: number;
  currency: string;
  companyName: string;
  prefill: { name: string; email: string };
}

export interface Pricing {
  currency: string;
  storageGbMonthly: string;
  flavors: { flavorId: string; hourly: string; monthly: string }[];
}

export interface Statement {
  month: string;
  currency: string;
  openingBalance: string;
  closingBalance: string;
  usageTotal: string;
  lines: { serverId: string; name: string; flavorId: string; diskGb: number; hours: number; compute: string; storage: string; total: string }[];
  payments: { type: string; amount: string; description: string; createdAt: string }[];
}

export type TicketStatus = "open" | "answered" | "closed";

export interface Ticket {
  id: string;
  userId: string;
  subject: string;
  status: TicketStatus;
  serverId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketMessage {
  id: string;
  body: string;
  fromStaff: boolean;
  authorName: string;
  createdAt: string;
}

export interface AdminOverview {
  currency: string;
  customers: number;
  suspended: number;
  overdue: number;
  walletTotal: string;
  servers: { total: number; active: number; error: number };
  thisMonth: { topups: string; usage: string };
  openTickets: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "customer";
  status: "active" | "suspended";
  vhiProjectId: string | null;
  quotas: Quotas | null;
  effectiveQuotas: Quotas;
  balance: string;
  overdueSince: string | null;
  createdAt: string;
}

export interface AdminUserDetail {
  user: AdminUser;
  servers: { id: string; name: string; status: ServerStatus; ipv4: string | null; flavorId: string; createdAt: string }[];
  transactions: WalletTransaction[];
}

export interface AdminPricing {
  currency: string;
  defaults: { vcpuHourly: string; ramGbHourly: string; storageGbMonthly: string };
  flavors: { flavorId: string; name: string; vcpus: number; ramMb: number; hourly: string; hourlyExact: string; monthly: string; override: boolean }[];
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  data: Record<string, unknown> | null;
  actorEmail: string;
  createdAt: string;
}

export interface FirewallRule {
  id: string;
  protocol: "tcp" | "udp" | "icmp" | "any";
  portMin: number | null;
  portMax: number | null;
  cidr: string;
  description: string;
  createdAt: string;
}

export type VolumeStatus = "creating" | "available" | "attaching" | "attached" | "detaching" | "deleting" | "deleted" | "error";

export interface Volume {
  id: string;
  name: string;
  sizeGb: number;
  status: VolumeStatus;
  statusMessage: string | null;
  serverId: string | null;
  serverName: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const issues = (data as { issues?: { message: string }[] } | undefined)?.issues;
    const message = issues?.[0]?.message ?? (data as { error?: string } | undefined)?.error ?? res.statusText;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>("GET", "/auth/me"),
  login: (email: string, password: string) => request<{ user: User }>("POST", "/auth/login", { email, password }),
  register: (name: string, email: string, password: string) =>
    request<{ user: User }>("POST", "/auth/register", { name, email, password }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout", {}),
  verifyEmail: (token: string) => request<{ ok: true }>("POST", "/auth/verify-email", { token }),
  resendVerification: () => request<{ ok: true }>("POST", "/auth/resend-verification", {}),
  forgotPassword: (email: string) => request<{ ok: true }>("POST", "/auth/forgot-password", { email }),
  resetPassword: (token: string, password: string) => request<{ ok: true }>("POST", "/auth/reset-password", { token, password }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("POST", "/auth/change-password", { currentPassword, newPassword }),

  catalog: () => request<{ flavors: Flavor[]; images: Image[]; networks: Network[] }>("GET", "/catalog"),
  listServers: (all = false) => request<{ servers: Server[] }>("GET", `/servers${all ? "?all=true" : ""}`),
  getServer: (id: string) => request<{ server: Server }>("GET", `/servers/${id}`),
  createServer: (input: CreateServerInput) => request<{ server: Server }>("POST", "/servers", input),
  serverAction: (id: string, action: "start" | "stop" | "reboot") =>
    request<{ server: Server }>("POST", `/servers/${id}/actions`, { action }),
  deleteServer: (id: string) => request<{ server: Server }>("DELETE", `/servers/${id}`),
  consoleUrl: (id: string) => request<{ url: string }>("GET", `/servers/${id}/console`),

  quotas: () => request<{ limits: Quotas; usage: Quotas }>("GET", "/account/quotas"),

  wallet: () => request<Wallet>("GET", "/billing/wallet"),
  transactions: () => request<{ currency: string; transactions: WalletTransaction[] }>("GET", "/billing/transactions"),
  pricing: () => request<Pricing>("GET", "/billing/pricing"),
  createTopup: (amount: number) => request<TopupOrder>("POST", "/billing/topups", { amount }),
  verifyTopup: (orderId: string, paymentId: string, signature: string) =>
    request<{ status: string; balance: string; currency: string }>("POST", "/billing/topups/verify", { orderId, paymentId, signature }),
  statements: () => request<{ currency: string; statements: { month: string; usage: string }[] }>("GET", "/billing/statements"),
  statement: (month: string) => request<Statement>("GET", `/billing/statements/${month}`),

  tickets: () => request<{ tickets: Ticket[] }>("GET", "/tickets"),
  createTicket: (subject: string, body: string) => request<{ ticket: Ticket }>("POST", "/tickets", { subject, body }),
  ticket: (id: string) => request<{ ticket: Ticket; messages: TicketMessage[] }>("GET", `/tickets/${id}`),
  replyTicket: (id: string, body: string) => request<{ status: TicketStatus }>("POST", `/tickets/${id}/messages`, { body }),
  closeTicket: (id: string) => request<{ status: TicketStatus }>("POST", `/tickets/${id}/close`, {}),

  admin: {
    overview: () => request<AdminOverview>("GET", "/admin/overview"),
    users: () => request<{ users: AdminUser[] }>("GET", "/admin/users"),
    user: (id: string) => request<AdminUserDetail>("GET", `/admin/users/${id}`),
    setStatus: (id: string, status: "active" | "suspended") => request<{ ok: true }>("PATCH", `/admin/users/${id}`, { status }),
    setQuotas: (id: string, quotas: Quotas | null) => request<{ quotas: Quotas }>("PUT", `/admin/users/${id}/quotas`, quotas),
    adjustWallet: (id: string, amount: string, description: string) =>
      request<{ balance: string }>("POST", `/admin/users/${id}/wallet`, { amount, description }),
    pricing: () => request<AdminPricing>("GET", "/admin/pricing"),
    setFlavorPrice: (flavorId: string, hourly: string) =>
      request<{ ok: true }>("PUT", `/admin/pricing/flavors/${encodeURIComponent(flavorId)}`, { hourly }),
    resetFlavorPrice: (flavorId: string) => request<{ ok: true }>("DELETE", `/admin/pricing/flavors/${encodeURIComponent(flavorId)}`),
    runBilling: () => request<{ charged: number; total: string; stopped: number }>("POST", "/admin/billing/run", {}),
    tickets: (status?: TicketStatus) =>
      request<{ tickets: (Ticket & { customerEmail: string; customerName: string })[] }>(
        "GET",
        `/admin/tickets${status ? `?status=${status}` : ""}`,
      ),
    audit: () => request<{ entries: AuditEntry[] }>("GET", "/admin/audit?limit=200"),
  },

  volumes: () => request<{ volumes: Volume[] }>("GET", "/volumes"),
  createVolume: (name: string, sizeGb: number) => request<{ volume: Volume }>("POST", "/volumes", { name, sizeGb }),
  attachVolume: (id: string, serverId: string) => request<{ volume: Volume }>("POST", `/volumes/${id}/attach`, { serverId }),
  detachVolume: (id: string) => request<{ volume: Volume }>("POST", `/volumes/${id}/detach`, {}),
  deleteVolume: (id: string) => request<{ volume: Volume }>("DELETE", `/volumes/${id}`),

  firewall: () => request<{ rules: FirewallRule[] }>("GET", "/firewall"),
  addFirewallRule: (rule: Omit<FirewallRule, "id" | "createdAt">) => request<{ rule: FirewallRule }>("POST", "/firewall", rule),
  deleteFirewallRule: (id: string) => request<{ ok: true }>("DELETE", `/firewall/${id}`),

  listSshKeys: () => request<{ sshKeys: SshKey[] }>("GET", "/ssh-keys"),
  addSshKey: (name: string, publicKey: string) => request<{ sshKey: SshKey }>("POST", "/ssh-keys", { name, publicKey }),
  deleteSshKey: (id: string) => request<{ ok: true }>("DELETE", `/ssh-keys/${id}`),
};

export const VOLUME_TRANSITIONAL: VolumeStatus[] = ["creating", "attaching", "detaching", "deleting"];

/** Statuses during which the UI should keep polling. */
export const TRANSITIONAL: ServerStatus[] = ["pending", "building", "stopping", "starting", "rebooting", "deleting"];
