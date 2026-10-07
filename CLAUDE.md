<!--
  CLAUDE.md
  Usage: project instructions loaded automatically by Claude Code (and a good
  onboarding read for humans). Keep it current when architecture or conventions change.
-->
# billdude — Claude Code guide

billdude is a self-service cloud portal + billing platform (StackConsole-style) for
**Virtuozzo Hybrid Infrastructure (VHI)**. Customers sign up, create and manage VMs;
admins manage customers. Billing (Razorpay first) lands in phase 3.

## Layout

| Path | What |
|---|---|
| `packages/vhi-connector` | `VhiConnector` (cloud-wide: catalog, projects, quotas) + `VhiProject` (per-customer servers) interfaces and the OpenStack (Keystone v3 / Nova / Cinder / Glance / Neutron) implementation. The only code that knows OpenStack payloads. |
| `apps/mock-vhi` | In-memory fake of the VHI APIs used for dev and tests (projects/roles, project-scoped tokens, quota enforcement, BUILD→ACTIVE delays, `fail` in a name → ERROR, 409s on bad transitions). `/_mock/*` exposes internal state to tests. |
| `apps/api` | Fastify API (`src/main.ts`) and BullMQ worker (`src/worker-main.ts`) sharing one codebase. Postgres via Drizzle. |
| `apps/web` | React + Vite + Tailwind v4 + React Query customer portal. Proxies `/api` to :4000. |

## Architecture rules

- **API never waits on the cloud.** Routes validate, move the DB row to a transitional
  status with a *guarded* `UPDATE … WHERE status IN (…)`, write an audit row, and enqueue a
  job. The worker (`src/jobs/processor.ts`) talks to VHI and settles the row.
- **Jobs must be idempotent.** `create` first looks for a Nova VM tagged
  `billdude_server_id=<row id>` before creating one; power actions check current state.
  Throw `UnrecoverableError` for permanent failures; let retryable `VhiError`s propagate.
- **One VHI project per customer.** `accounts.ensureProject()` (worker only) creates
  `<VHI_PROJECT_PREFIX><user id>`, grants the service user `VHI_MEMBER_ROLE`, applies quotas
  and stores `users.vhi_project_id`. Servers record `vhi_project_id` too; always go through
  `vhi.project(id)` for server calls. Registration enqueues an `account-ops` provision job.
- **Firewall = desired state.** `firewall_rules` rows are the truth; `VhiProject.syncFirewall`
  makes the default security group's inbound CIDR rules match exactly (never touching egress
  or the same-group rule). Any rule change enqueues an `account-ops` `sync-firewall` job.
- **Quotas are enforced twice**: a friendly portal check (`exceededQuota` in `accounts.ts`)
  and VHI's own Nova/Cinder quotas (`VhiQuotaError` → job fails with a clear message).
- **Money is integer micro-units** (`balance_micros`, 1 INR = 1_000_000) — see
  `billing/money.ts`. Convert to paise only for Razorpay, to strings only in responses.
- **Only `billing/ledger.ts#postTransaction` changes a balance**; it writes the ledger row
  in the same transaction and maintains `users.overdue_since`. Use a `reference` for
  anything that must not be applied twice (payment ids, signup credit).
- **Metering** (`billing/metering.ts`, hourly `billing-ops` job): servers are billed per
  second from `billing_started_at` (first ACTIVE) to `deleted_at`, advancing
  `billed_until` with a guarded UPDATE. Overdue customers past `BILLING_GRACE_HOURS` get
  running servers stopped, never deleted. Creating/starting servers needs funds (402).
- **Payments**: `billing/gateway.ts` (Razorpay, or the fake gateway when keys are unset —
  refused in production). `billing/payments.ts#settlePayment` verifies amount/currency
  against our order, captures if needed and credits exactly once. Webhook verifies the
  raw-body HMAC.
- **Only `packages/vhi-connector` imports OpenStack shapes.** Everything else uses the
  domain types in `src/types.ts`. A new cloud backend = a new `VhiConnector` implementation.
- **VHI boots VMs from volumes**: `createServer` always sends `block_device_mapping_v2`
  (image → volume, `delete_on_termination`), with `VHI_VOLUME_TYPE` as storage policy.
- Ownership checks live in `loadOwned()` in `routes/servers.ts`; customers get 404 (not 403)
  for other people's resources.
- Sessions: JWT in httpOnly `bd_session` cookie (SameSite=Lax); the user row is re-read on
  every request so suspensions apply immediately. Passwords: Argon2id.
- Security-relevant and billable actions call `audit()`.

## Conventions

- **Every file starts with a comment block describing its usage** (path + how to use/run
  it). JSON files that cannot hold comments (`package.json`, drizzle `meta/*.json`) are the
  only exception. Generated SQL migrations get a `--` header added after generation.
- TypeScript strict, ESM, `.js` suffixes in relative imports (NodeNext) for Node packages.
- Validate request bodies with zod `.parse()`; the global error handler turns `ZodError`
  into 400 and `VhiError` into 502.
- Schema changes: edit `apps/api/src/db/schema.ts` → `pnpm db:generate` → add the usage
  header to the new SQL file → `pnpm db:migrate`. Never edit an applied migration.
- Tests are integration-first: real Postgres + Redis + mock VHI (`apps/api/test/helpers.ts`).

## Commands

```bash
pnpm install
docker compose up -d                       # Postgres + Redis (or use local services)
cp .env.example apps/api/.env
pnpm db:migrate && pnpm seed:admin
pnpm dev                                   # mock VHI :5050, API :4000, worker, web :5173
pnpm build && pnpm lint && pnpm typecheck && pnpm test   # what CI runs
```

Tests need `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/billdude_test`)
and `REDIS_URL`. `pnpm build` must run before tests (packages are consumed from `dist/`).

## Roadmap

- [x] Phase 0 — monorepo, auth/roles, DB, queue/worker, CI, mock VHI
- [x] Phase 1 (core) — VHI connector: catalog, VM create/start/stop/reboot/delete, noVNC console
- [x] Phase 1 — SSH keys via cloud-init; per-customer VHI projects + quotas; network allow-list
- [x] Phase 1 — firewall: per-customer inbound rules reconciled onto the project's default
      security group (new projects block inbound traffic by default; SSH + ping seeded)
- [ ] Phase 1 (rest) — extra volumes, snapshots/backups, floating IPs; test against a real VHI cluster
- [ ] Phase 2 — portal polish: dashboard, SSH key manager, embedded noVNC
- [x] Phase 3 (core) — pricing (formula + per-flavor overrides), per-second metering, prepaid
      wallet + ledger, Razorpay top-ups + webhook, monthly statements, non-payment stop
- [ ] Phase 3 (rest) — GST tax invoices, low-balance emails, auto-recharge, coupons
- [x] Phase 4 — admin area (overview, customers: suspend/quotas/wallet, pricing, audit log),
      support tickets for customers and staff
- [ ] Phase 5 — hardening: CSRF tokens, 2FA, email verification, load tests, Docker images, deploy

## Known gaps (deliberate for now)

- No CSRF token yet (SameSite=Lax + JSON bodies only); add before public launch.
