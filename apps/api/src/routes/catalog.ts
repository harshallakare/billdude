/**
 * apps/api/src/routes/catalog.ts
 *
 * Usage: what customers can choose from when creating a VM (signed-in users):
 *   GET /api/catalog  -> { flavors, images, networks }
 */
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";

export async function catalogRoutes(app: FastifyInstance, { catalog }: AppDeps) {
  app.get("/catalog", { preHandler: app.authenticate }, async () => {
    const [flavors, images, networks] = await Promise.all([catalog.flavors(), catalog.images(), catalog.networks()]);
    return { flavors, images, networks };
  });
}
