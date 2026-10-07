<!--
  README.md
  Usage: project overview and quick start for developers.
-->
# billdude

Self-service cloud portal and billing for **Virtuozzo Hybrid Infrastructure (VHI)** —
let customers sign up, launch and manage VMs on your VHI cluster, and (soon) pay for them.

## Status

Phase 0 + core of phase 1: customer sign-up/login, admin role, VM create / start / stop /
reboot / delete / console against VHI's OpenStack-compatible APIs, background provisioning
worker, and a mock VHI so everything runs without a cluster. Billing is next.
See [CLAUDE.md](CLAUDE.md) for architecture and the roadmap.

## Quick start

Requirements: Node 22+, pnpm 10, and Postgres 16 + Redis 7 (via Docker or installed locally).

```bash
pnpm install
docker compose up -d
cp .env.example apps/api/.env          # defaults point at the mock VHI
pnpm build
pnpm db:migrate
pnpm seed:admin                        # admin@example.com / value of SEED_ADMIN_PASSWORD
pnpm dev
```

Open http://localhost:5173 and register, or sign in as the admin.

| Service | URL |
|---|---|
| Web portal | http://localhost:5173 |
| API | http://localhost:4000/api/health |
| Mock VHI (Keystone) | http://localhost:5050/identity/v3 |

In the mock, any server whose name contains `fail` ends in ERROR — handy for testing the UI.

## Connecting a real VHI cluster

Set these in `apps/api/.env` (or your secret manager), then restart API and worker:

```
VHI_AUTH_URL=https://<vhi-panel-host>:5000/v3
VHI_USERNAME=<service user>
VHI_PASSWORD=<password>
VHI_USER_DOMAIN=<domain>
VHI_PROJECT_NAME=<project for customer VMs>
VHI_PROJECT_DOMAIN=<domain>
VHI_VOLUME_TYPE=<storage policy, optional>
```

The service user needs the member role in that project. Never commit credentials.

## Repo layout

```
apps/api            Fastify API + BullMQ worker, Drizzle/Postgres
apps/web            React customer portal
apps/mock-vhi       Fake VHI (Keystone/Nova/Glance/Neutron) for dev & tests
packages/vhi-connector   VhiConnector interface + OpenStack implementation
```

## Checks

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```
