/**
 * apps/api/src/config.ts
 *
 * Usage: loads and validates environment variables once at startup.
 *
 *   import { loadConfig } from "./config.js";
 *   const config = loadConfig();            // throws with a readable list of problems
 *
 * See .env.example at the repo root for every variable and its meaning.
 */
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  VHI_AUTH_URL: z.string().url(),
  VHI_USERNAME: z.string().min(1),
  VHI_PASSWORD: z.string().min(1),
  VHI_USER_DOMAIN: z.string().default("Default"),
  VHI_PROJECT_NAME: z.string().min(1),
  VHI_PROJECT_DOMAIN: z.string().default("Default"),
  VHI_REGION: z.string().optional().transform((v) => v || undefined),
  VHI_VOLUME_TYPE: z.string().optional().transform((v) => v || undefined),
  /** Keystone role the service account grants itself on customer projects. */
  VHI_MEMBER_ROLE: z.string().default("member"),
  /** Customer projects are named <prefix><account id>. */
  VHI_PROJECT_PREFIX: z.string().default("billdude-"),
  /** Comma-separated network ids customers may attach to. Empty = every shared network. */
  VHI_ALLOWED_NETWORK_IDS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  /** Default per-customer quotas (admins can override per customer). -1 = unlimited. */
  QUOTA_INSTANCES: z.coerce.number().int().min(-1).default(5),
  QUOTA_CORES: z.coerce.number().int().min(-1).default(10),
  QUOTA_RAM_MB: z.coerce.number().int().min(-1).default(20480),
  QUOTA_VOLUMES: z.coerce.number().int().min(-1).default(10),
  QUOTA_GIGABYTES: z.coerce.number().int().min(-1).default(500),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}

/** Connector options derived from config. */
export function vhiOptions(config: Config) {
  return {
    authUrl: config.VHI_AUTH_URL,
    username: config.VHI_USERNAME,
    password: config.VHI_PASSWORD,
    userDomain: config.VHI_USER_DOMAIN,
    projectName: config.VHI_PROJECT_NAME,
    projectDomain: config.VHI_PROJECT_DOMAIN,
    region: config.VHI_REGION,
    volumeType: config.VHI_VOLUME_TYPE,
    memberRole: config.VHI_MEMBER_ROLE,
  };
}

/** Quotas applied to customers without an admin override. */
export function defaultQuotas(config: Config) {
  return {
    instances: config.QUOTA_INSTANCES,
    cores: config.QUOTA_CORES,
    ramMb: config.QUOTA_RAM_MB,
    volumes: config.QUOTA_VOLUMES,
    gigabytes: config.QUOTA_GIGABYTES,
  };
}
