/**
 * apps/api/src/main.ts
 *
 * Usage: starts the HTTP API.
 *   pnpm --filter @billdude/api dev      # watch mode, reads apps/api/.env
 *   pnpm --filter @billdude/api start    # production (after build)
 * Run the worker separately (src/worker-main.ts) or VM jobs will queue forever.
 */
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const runtime = createRuntime(loadConfig());
const app = await buildApp(runtime);

const shutdown = async () => {
  await app.close();
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: runtime.config.API_PORT, host: "0.0.0.0" });
