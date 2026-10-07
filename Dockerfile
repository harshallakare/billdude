# Dockerfile
# Usage: one multi-stage build for every billdude service. Pick the image with --target:
#   docker build --target api    -t billdude-api .      # HTTP API          (node dist/main.js)
#   docker build --target worker -t billdude-worker .   # background worker (node dist/worker-main.js)
#   docker build --target web    -t billdude-web .      # Caddy: portal + /api proxy + automatic HTTPS
# The API image also runs migrations and the admin seed:
#   docker run --rm --env-file .env billdude-api node dist/db/migrate.js
#   docker run --rm --env-file .env billdude-api node dist/scripts/seed-admin.js
# deploy/docker-compose.prod.yml wires all of this together.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- build: install everything, build every workspace ----------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mock-vhi/package.json apps/mock-vhi/
COPY packages/vhi-connector/package.json packages/vhi-connector/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
# Self-contained production bundle of the API (with the connector package inlined).
RUN pnpm --filter @billdude/api deploy --prod --legacy /out/api

# ---------- api ----------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------- worker ----------
FROM api AS worker
HEALTHCHECK NONE
CMD ["node", "dist/worker-main.js"]

# ---------- web ----------
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
