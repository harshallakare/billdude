<!--
  docs/DEPLOYMENT.md
  Usage: step-by-step guide for running billdude in production on one Linux server
  with Docker. Linked from README.md.
-->
# Deploying billdude

This runs the whole platform — Postgres, Redis, API, worker and the web portal behind
Caddy with automatic HTTPS — on a single Linux host using Docker Compose.

## 1. Prerequisites

| Need | Notes |
|---|---|
| Linux server | 2 vCPU / 4 GB RAM is plenty to start. Ubuntu 22.04+ or Debian 12. |
| Docker Engine + Compose plugin | `curl -fsSL https://get.docker.com \| sh` |
| A domain name | An A (and optionally AAAA) record for e.g. `cloud.example.com` pointing at the server. Ports 80 and 443 open. |
| VHI service account | See section 2. |
| Razorpay account | Key id + secret (Dashboard → Account & Settings → API Keys). Use test keys first. |
| SMTP account | Any provider (Amazon SES, Zoho, SendGrid, Postmark…) for password resets, verification and billing notices → `SMTP_URL`, `MAIL_FROM`. Set up SPF/DKIM for your sending domain. |

The server must be able to reach your VHI Keystone endpoint (usually port 5000) and the
compute/network/volume endpoints listed in its service catalog, plus `api.razorpay.com`.

## 2. Prepare Virtuozzo Hybrid Infrastructure

billdude creates **one VHI project per customer**, so its service account needs rights
to create projects and assign roles.

1. In the VHI admin panel create a domain for customers (or use `Default`).
2. Create a user, e.g. `billdude`, in that domain and give it the **domain administrator**
   role (or cloud admin). It must be able to create projects, assign roles and set quotas.
3. Create a project for the service account itself, e.g. `billdude`, and add the user to it.
4. Note the Keystone URL (e.g. `https://vhi.example.com:5000/v3`), and optionally:
   - the storage policy (volume type) to use for boot disks → `VHI_VOLUME_TYPE`
   - the ids of networks customers may attach to (e.g. your public provider network)
     → `VHI_ALLOWED_NETWORK_IDS` (comma separated). If empty, all *shared* networks are offered.
5. Make sure images (Ubuntu, Debian, …) are public and flavors exist.

Check the credentials from the server before going further:

```bash
curl -si https://vhi.example.com:5000/v3/auth/tokens -H 'Content-Type: application/json' -d '{
  "auth": {"identity": {"methods": ["password"], "password": {"user": {"name": "billdude",
  "domain": {"name": "Default"}, "password": "…"}}},
  "scope": {"project": {"name": "billdude", "domain": {"name": "Default"}}}}}' | head -1
# Expect: HTTP/1.1 201 Created
```

## 3. Configure

```bash
git clone https://github.com/harshallakare/billdude.git && cd billdude
cp deploy/.env.production.example deploy/.env && chmod 600 deploy/.env
openssl rand -hex 32   # use for POSTGRES_PASSWORD
openssl rand -hex 32   # use for JWT_SECRET
nano deploy/.env       # DOMAIN, VHI_*, RAZORPAY_*, SMTP_URL, MAIL_FROM, SEED_ADMIN_*
```

Any setting from the root `.env.example` (quotas, prices, grace period, sign-up credit…)
can be added to `deploy/.env`.

## 4. Start

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
```

The `migrate` service applies database migrations and exits; `api` and `worker` start
after it succeeds. Caddy obtains a TLS certificate for `DOMAIN` on first request.

Create the first admin (uses `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`):

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env run --rm api node dist/scripts/seed-admin.js
```

Open `https://<DOMAIN>`, sign in as the admin and check **Admin → Pricing**.

## 5. Razorpay webhook

Top-ups are confirmed in the browser, but configure the webhook too so payments are
credited even if the customer closes the tab:

1. Razorpay Dashboard → Settings → Webhooks → *Add New Webhook*
2. URL: `https://<DOMAIN>/api/billing/razorpay/webhook`
3. Secret: a random string → put the same value in `RAZORPAY_WEBHOOK_SECRET`
4. Events: `payment.captured`, `order.paid`
5. Restart: `docker compose … up -d`

## 6. Operating it

| Task | Command |
|---|---|
| Logs | `docker compose -f deploy/docker-compose.prod.yml logs -f api worker` |
| Update to a new version | `git pull && docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d --build` (migrations run automatically) |
| Database backup | `docker compose -f deploy/docker-compose.prod.yml exec postgres pg_dump -U billdude billdude \| gzip > billdude-$(date +%F).sql.gz` |
| Restore | `gunzip -c backup.sql.gz \| docker compose … exec -T postgres psql -U billdude billdude` |
| Run billing immediately | Admin → Overview → *Run billing now* |

Back up the database daily and copy the dumps off the server: it holds wallet balances
and the ledger. Redis only holds queued jobs (persisted with AOF).

## 7. Troubleshooting

- **Servers stay in "building"** — check `worker` logs. Most often the VHI service
  account lacks a role, the volume type does not exist, or the network is not allowed.
- **"The cloud platform is unavailable"** — the API cannot reach VHI; check `VHI_AUTH_URL`,
  firewalls and the TLS certificate of the VHI endpoint (it must be publicly trusted, or
  mount your CA and set `NODE_EXTRA_CA_CERTS` on `api` and `worker`).
- **"The payment provider is unavailable"** — outbound HTTPS to `api.razorpay.com` is blocked
  or the keys are wrong.
- **Customers cannot SSH in** — check *Firewall* in the portal (SSH is allowed by default)
  and that the image uses cloud-init.
