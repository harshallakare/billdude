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
  };
}
