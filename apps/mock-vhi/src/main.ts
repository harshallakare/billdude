/**
 * apps/mock-vhi/src/main.ts
 *
 * Usage: runs the mock VHI cloud as a standalone process for local development.
 *
 *   pnpm --filter @billdude/mock-vhi dev       # http://localhost:5050
 *   MOCK_VHI_PORT=6000 MOCK_VHI_BUILD_MS=10000 pnpm --filter @billdude/mock-vhi dev
 *
 * Point the API at it with VHI_AUTH_URL=http://localhost:5050/identity/v3
 * (username/password admin/admin, project "billdude").
 */
import { buildMockVhi } from "./server.js";

const port = Number(process.env.MOCK_VHI_PORT ?? 5050);
const app = buildMockVhi({
  buildMs: Number(process.env.MOCK_VHI_BUILD_MS ?? 4000),
  actionMs: Number(process.env.MOCK_VHI_ACTION_MS ?? 1500),
  logger: true,
});

await app.listen({ port, host: "0.0.0.0" });
