/**
 * packages/vhi-connector/src/openstack/client.ts
 *
 * Usage: low-level authenticated HTTP client for VHI's OpenStack-compatible
 * APIs. It logs in to Keystone v3 with a project-scoped password token,
 * caches the token until shortly before expiry, resolves service endpoints
 * from the catalog and maps HTTP failures to typed VhiError subclasses.
 *
 *   const client = new OpenStackClient(creds);                         // scoped to creds.projectName
 *   const scoped = new OpenStackClient(creds, { projectId: "abc" });   // scoped to a customer project
 *   const body = await client.request<{ flavors: unknown[] }>("compute", "GET", "/flavors/detail");
 *   const { userId, projectId, projectDomainId } = await client.identity();
 *
 * Higher-level code should use OpenStackVhiConnector instead of this class.
 */
import {
  VhiAuthError,
  VhiConflictError,
  VhiError,
  VhiNotFoundError,
  VhiQuotaError,
} from "../errors.js";

export interface OpenStackCredentials {
  /** Keystone v3 base URL, e.g. https://vhi.example.com:5000/v3 */
  authUrl: string;
  username: string;
  password: string;
  userDomain: string;
  projectName: string;
  projectDomain: string;
  /** Restrict catalog endpoints to this region when set. */
  region?: string;
  /** Per-request timeout in milliseconds (default 30s). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Catalog service types used by the connector. "identity" always resolves to authUrl. */
export type ServiceType = "identity" | "compute" | "image" | "network" | "volumev3";

/** Scope a client to a project by id instead of the configured service project. */
export interface ProjectScope {
  projectId: string;
}

interface CatalogEntry {
  type: string;
  endpoints: { interface: string; region?: string | null; region_id?: string | null; url: string }[];
}

interface Session {
  token: string;
  expiresAt: number;
  endpoints: Map<string, string>;
  userId: string;
  projectId: string;
  projectDomainId: string;
}

/** Refresh the token this long before Keystone says it expires. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export class OpenStackClient {
  private session: Session | null = null;
  private loggingIn: Promise<Session> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly creds: OpenStackCredentials,
    private readonly scope?: ProjectScope,
  ) {
    this.fetchImpl = creds.fetch ?? fetch;
    this.timeoutMs = creds.timeoutMs ?? 30_000;
  }

  /** Ids of the authenticated user and the project/domain the token is scoped to. */
  async identity(): Promise<{ userId: string; projectId: string; projectDomainId: string }> {
    const { userId, projectId, projectDomainId } = await this.getSession();
    return { userId, projectId, projectDomainId };
  }

  /**
   * Performs a JSON request against a catalog service. Retries once with a
   * fresh token when the cached one is rejected (401).
   */
  async request<T>(
    service: ServiceType,
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let session = await this.getSession();
    let res = await this.send(session, service, method, path, options);
    if (res.status === 401) {
      this.session = null;
      session = await this.getSession();
      res = await this.send(session, service, method, path, options);
    }
    if (!res.ok) throw await toVhiError(res, `${method} ${service}${path}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async send(
    session: Session,
    service: ServiceType,
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> },
  ): Promise<Response> {
    const base = service === "identity" ? this.creds.authUrl : session.endpoints.get(service);
    if (!base) {
      throw new VhiError(`Service "${service}" is not in the VHI service catalog`, 0, false);
    }
    return this.fetchWithTimeout(joinUrl(base, path), {
      method,
      headers: {
        "X-Auth-Token": session.token,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  }

  private async getSession(): Promise<Session> {
    if (this.session && this.session.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return this.session;
    }
    // Collapse concurrent logins into one Keystone call.
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = null;
    });
    this.session = await this.loggingIn;
    return this.session;
  }

  private async login(): Promise<Session> {
    const res = await this.fetchWithTimeout(joinUrl(this.creds.authUrl, "/auth/tokens"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        auth: {
          identity: {
            methods: ["password"],
            password: {
              user: {
                name: this.creds.username,
                domain: { name: this.creds.userDomain },
                password: this.creds.password,
              },
            },
          },
          scope: {
            project: this.scope
              ? { id: this.scope.projectId }
              : { name: this.creds.projectName, domain: { name: this.creds.projectDomain } },
          },
        },
      }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new VhiAuthError("VHI rejected the configured credentials", res.status);
    }
    if (!res.ok) throw await toVhiError(res, "Keystone login");

    const token = res.headers.get("x-subject-token");
    if (!token) throw new VhiAuthError("Keystone response had no X-Subject-Token header");
    const body = (await res.json()) as {
      token: {
        expires_at: string;
        catalog?: CatalogEntry[];
        user: { id: string };
        project: { id: string; domain: { id: string } };
      };
    };

    const endpoints = new Map<string, string>();
    for (const entry of body.token.catalog ?? []) {
      const endpoint = entry.endpoints.find(
        (e) =>
          e.interface === "public" &&
          (!this.creds.region || (e.region_id ?? e.region) === this.creds.region),
      );
      if (endpoint) endpoints.set(entry.type, endpoint.url);
    }
    // Newer catalogs name Cinder "block-storage" instead of "volumev3".
    if (!endpoints.has("volumev3") && endpoints.has("block-storage")) {
      endpoints.set("volumev3", endpoints.get("block-storage")!);
    }

    return {
      token,
      expiresAt: Date.parse(body.token.expires_at),
      endpoints,
      userId: body.token.user.id,
      projectId: body.token.project.id,
      projectDomainId: body.token.project.domain.id,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new VhiError(`Network error calling VHI (${url}): ${reason}`, 0, true);
    }
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function toVhiError(res: Response, what: string): Promise<VhiError> {
  const detail = extractMessage(await res.text().catch(() => ""));
  const message = `${what} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
  if (res.status === 413 || (res.status === 403 && /quota/i.test(detail))) {
    return new VhiQuotaError(message, res.status);
  }
  switch (res.status) {
    case 401:
    case 403:
      return new VhiAuthError(message, res.status);
    case 404:
      return new VhiNotFoundError(message);
    case 409:
      return new VhiConflictError(message);
    default:
      return new VhiError(message, res.status, res.status === 429 || res.status >= 500);
  }
}

/** OpenStack services wrap errors differently ({badRequest:{message}}, {NeutronError:{message}}, {error:{message}}). */
function extractMessage(text: string): string {
  if (!text) return "";
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const value of Object.values(body)) {
      if (value && typeof value === "object" && "message" in value) {
        return String((value as { message: unknown }).message);
      }
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 300);
}
