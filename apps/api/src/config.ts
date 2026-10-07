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

/** A non-negative decimal amount such as "12" or "0.75" (validated, kept as a string for exact parsing). */
const decimalString = z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a decimal amount like 0.75");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  /** Public URL of the portal used in email links; defaults to the first WEB_ORIGIN. */
  PUBLIC_URL: z.string().url().optional(),
  /** Customers must confirm their email address before creating servers. */
  REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** smtp(s)://user:pass@host:port — leave empty in development to log emails instead of sending. */
  SMTP_URL: z.string().optional().transform((v) => v || undefined),
  MAIL_FROM: z.string().default("billdude <no-reply@localhost>"),
  /** Comma-separated addresses notified about new support tickets. */
  SUPPORT_NOTIFY_EMAILS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  /** Max register/login attempts per IP per minute. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
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

  /* ---- Billing ---- */
  BILLING_CURRENCY: z.string().length(3).default("INR"),
  /** Default compute prices (decimal, in BILLING_CURRENCY) used for flavors without an admin price. */
  BILLING_VCPU_HOURLY: decimalString.default("0.60"),
  BILLING_RAM_GB_HOURLY: decimalString.default("0.30"),
  /** Boot-volume storage price per GB per month (charged per second, 730 h = 1 month). */
  BILLING_STORAGE_GB_MONTHLY: decimalString.default("6.00"),
  /** Free credit given to every new customer (decimal). */
  BILLING_SIGNUP_CREDIT: decimalString.default("0"),
  /** Hours a customer may stay below zero before their running servers are stopped. */
  BILLING_GRACE_HOURS: z.coerce.number().min(0).default(24),
  /** Allowed top-up range (whole currency units). */
  BILLING_MIN_TOPUP: z.coerce.number().int().positive().default(100),
  BILLING_MAX_TOPUP: z.coerce.number().int().positive().default(100000),
  /** Time zone used to cut monthly statements. */
  BILLING_TIMEZONE: z.string().default("Asia/Kolkata"),

  /* ---- Razorpay (leave empty in development to use the built-in fake gateway) ---- */
  RAZORPAY_KEY_ID: z.string().optional().transform((v) => v || undefined),
  RAZORPAY_KEY_SECRET: z.string().optional().transform((v) => v || undefined),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().transform((v) => v || undefined),
  /** Business name shown in the Razorpay checkout. */
  BILLING_COMPANY_NAME: z.string().default("billdude"),
});

export type Config = z.infer<typeof schema> & { PUBLIC_URL: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const config = { ...result.data, PUBLIC_URL: result.data.PUBLIC_URL ?? result.data.WEB_ORIGIN.split(",")[0]!.trim() };
  if (config.NODE_ENV === "production" && !(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET)) {
    throw new Error("Invalid configuration:\n  - RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required in production");
  }
  if (config.NODE_ENV === "production" && !config.SMTP_URL) {
    throw new Error("Invalid configuration:\n  - SMTP_URL is required in production (password resets and notifications)");
  }
  return config;
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
