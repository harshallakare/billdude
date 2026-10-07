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

  listSshKeys: () => request<{ sshKeys: SshKey[] }>("GET", "/ssh-keys"),
  addSshKey: (name: string, publicKey: string) => request<{ sshKey: SshKey }>("POST", "/ssh-keys", { name, publicKey }),
  deleteSshKey: (id: string) => request<{ ok: true }>("DELETE", `/ssh-keys/${id}`),
};

/** Statuses during which the UI should keep polling. */
export const TRANSITIONAL: ServerStatus[] = ["pending", "building", "stopping", "starting", "rebooting", "deleting"];
