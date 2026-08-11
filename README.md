# Langfuse Observability Platform

Self-hosted [Langfuse](https://langfuse.com) providing centralized LLM observability for
Eve/Vercel agent projects. This repository holds the complete infrastructure definition:
the container stack, the reverse proxy and its security policy, the operational scripts,
and the runbooks.

The architectural reasoning behind these choices lives in [`CLAUDE.md`](CLAUDE.md). This
file covers **how to run and operate the deployment**.

---

## Contents

- [What this deploys](#what-this-deploys)
- [Repository layout](#repository-layout)
- [How the hosting works](#how-the-hosting-works)
- [Configuration reference](#configuration-reference)
- [Running the stack](#running-the-stack)
- [Managing the stack](#managing-the-stack)
- [Security model](#security-model)
- [Verification and monitoring](#verification-and-monitoring)
- [Troubleshooting](#troubleshooting)
- [Maintenance](#maintenance)

---

## What this deploys

Langfuse is **not a single application**. It requires six long-running stateful
components, which is why it cannot run on Vercel and is hosted on a dedicated server
instead. All of them run as containers on one host ("Tier 1").

| Component | Image (pinned) | Role |
|---|---|---|
| `web` | `langfuse/langfuse:4.6.0` | UI, REST API, OTLP ingest endpoint |
| `worker` | `langfuse/langfuse-worker:4.6.0` | Asynchronous event processing into ClickHouse |
| `postgres` | `postgres:17-alpine` | Transactional store: users, orgs, projects, API keys |
| `clickhouse` | `clickhouse/clickhouse-server:25.12-alpine` | OLAP store: traces, observations, scores |
| `redis` | `valkey/valkey:8-alpine` | Ingestion queue and cache |
| `minio` | `minio/minio:RELEASE.2025-09-07T16-13-09Z` | S3-compatible blob storage for raw events and media |
| `caddy` | `langfuse-caddy:2.11.4-ratelimit-0.1.0` (built locally) | TLS termination, routing, rate limiting |
| `minio-init` | `minio/minio:…` | One-shot job that creates the required buckets, then exits |

**Versions are pinned deliberately and never set to `latest`.** `web` and `worker` must
always be the same version. A ClickHouse major bump can carry an irreversible schema
migration, so upgrades follow the controlled flow in [`CLAUDE.md` §14](CLAUDE.md).

### Data flow

```
Eve agent (Vercel)
      │  OTLP/HTTP + Basic auth (per-project API keys)
      ▼
   Caddy :443  ──TLS, rate limit, route──►  web
                                             │ enqueue
                                             ▼
                            MinIO (raw event) + Valkey (queue)
                                             │
                                             ▼
                                          worker
                                             │
                                             ▼
                                        ClickHouse  ◄── read path ── web ── UI
```

Ingestion is **asynchronous**: `POST /api/public/ingestion` returns `207` immediately,
meaning *queued*, not *stored*. A `207` — and even a healthy `/api/public/health` — can
coexist with a completely backlogged pipeline. Only reading a trace back proves the path
works, which is what the ingestion canary does.

---

## Repository layout

```
infra/
  compose.yaml                 The stack. Single source of truth for services.
  compose.local.yaml           Local-validation overlay (never used on the server).
  .env.example                 Template for every variable. Committed.
  .env                         Real secrets. NEVER committed (gitignored).
  caddy/
    Caddyfile                  Ingress routing + the public/restricted split.
    Dockerfile                 Caddy build with the rate-limit module compiled in.
  clickhouse/config.d/
    langfuse-ttl.xml           System-table TTLs. Disk-exhaustion protection.

scripts/                       Operational and test scripts (see below).
docs/                          Runbooks, pitfalls, operations, security review.
```

---

## How the hosting works

### One compose project, one network

Everything runs under the compose project name `langfuse` on a single bridge network,
also named `langfuse`. Containers reach each other by service name — `postgres:5432`,
`clickhouse:8123`, `redis:6379`, `minio:9000` — which is why the connection strings in
`.env` use hostnames rather than IPs.

### Only the reverse proxy is published

**Caddy is the only container that publishes host ports** (`80` and `443`). Every other
service is reachable only from inside the compose network. This is what keeps Postgres,
ClickHouse, Valkey and MinIO off the public internet — it is a property of the compose
file, not of a firewall, so it cannot be undone by a firewall rule change.

| Port | Bound by | Exposure |
|---|---|---|
| `80` | caddy | Public — redirects to HTTPS |
| `443` | caddy | Public — the only real entry point |
| `3000` | web | Internal only (published to loopback in local validation only) |
| `3030` | worker | Internal only |
| `5432` / `8123` / `9000` / `6379` | datastores | Internal only, never published |

### Startup ordering

`web` and `worker` do not start until `postgres`, `clickhouse` and `redis` report
**healthy** and `minio-init` has completed successfully. `caddy` in turn waits for `web`
to be healthy.

That last dependency has an operational consequence worth knowing: **if `web` is
unhealthy, `caddy` never starts, which takes the public ingest path down along with the
UI.** A `docker compose ps` showing five of six services healthy can still mean the
platform is entirely unreachable.

### Everything runs in UTC

`TZ=UTC` is set on every service, plus `PGTZ=UTC` on Postgres. Langfuse requires
ClickHouse and Postgres to be in UTC; a wrong timezone corrupts analytics silently rather
than failing loudly. This is not configurable.

### Disk protection

`infra/clickhouse/config.d/langfuse-ttl.xml` applies aggressive TTLs to ClickHouse's own
system tables and disables the query profiler. At default settings those tables will
consume the disk on a single-node deployment. The file is mounted **as a single file**,
never as a directory — mounting the directory would hide the image's own
`docker_related_config.xml` and cause ClickHouse to bind loopback only.

This is separate from Langfuse's trace retention, which is a per-project setting governing
customer data.

---

## Configuration reference

All configuration is environment variables in `infra/.env`, generated from
`infra/.env.example`. The file is gitignored and must never be committed.

`compose.yaml` **enumerates explicitly** which variables reach each service. A variable
present in `.env` but not listed in the service's `environment:` block is silently
discarded — see [Troubleshooting](#a-config-change-appears-to-have-no-effect).

### Required — the app will not start without these

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Full Postgres URL. Password must match `POSTGRES_PASSWORD`. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Applied **only at first volume init** — see [rotation](#rotating-secrets). |
| `CLICKHOUSE_URL` / `CLICKHOUSE_MIGRATION_URL` | HTTP (`8123`) and native (`9000`) endpoints. |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | |
| `CLICKHOUSE_CLUSTER_ENABLED` | **Must be `false`.** Langfuse does not support multi-shard clusters. |
| `REDIS_AUTH` / `REDIS_CONNECTION_STRING` | Password must match between the two. |
| `LANGFUSE_S3_EVENT_UPLOAD_*` | Raw ingestion events. Bucket must exist (`minio-init` creates it). |
| `LANGFUSE_S3_MEDIA_UPLOAD_*` | **Required in v4** — omitting the media bucket prevents startup. |
| `NEXTAUTH_SECRET` / `SALT` / `ENCRYPTION_KEY` | 256-bit random each. `ENCRYPTION_KEY` must be exactly 64 hex chars. |
| `NEXTAUTH_URL` | Must match the public origin exactly, or login cookies break. |

### Ingress

| Variable | Purpose |
|---|---|
| `LANGFUSE_DOMAIN` | Hostname Caddy serves and requests a certificate for. |
| `ACME_EMAIL` | Let's Encrypt registration address. |
| `ADMIN_ALLOWLIST` | Space-separated CIDRs permitted to reach the UI/admin surface. Does **not** apply to ingest or health. |

### Authentication (Microsoft Entra ID)

| Variable | Purpose |
|---|---|
| `AUTH_AZURE_AD_CLIENT_ID` | App registration client ID. |
| `AUTH_AZURE_AD_CLIENT_SECRET` | The secret **value**, not the Secret ID. Has an expiry date — an expired secret locks every user out with no warning. |
| `AUTH_AZURE_AD_TENANT_ID` | Directory tenant ID. |
| `AUTH_AZURE_AD_ALLOW_ACCOUNT_LINKING` | Lets an Entra identity claim a pre-existing account with the same email. Required when migrating an existing deployment to SSO. |
| `AUTH_DISABLE_USERNAME_PASSWORD` | `true` makes SSO the only way in. |

> **The domain restriction is not an environment variable.** It is the app
> registration's *supported account types* = **single tenant**. If that is set to
> multi-tenant, every Microsoft account on the internet can sign in while all the
> variables above still look correct. Verify with `scripts/test-entra-app.sh`.

### Headless initialization

`LANGFUSE_INIT_ORG_ID`, `LANGFUSE_INIT_ORG_NAME`, `LANGFUSE_INIT_USER_EMAIL`,
`LANGFUSE_INIT_USER_NAME`, `LANGFUSE_INIT_USER_PASSWORD` bootstrap an organisation and an
admin user so no resource is created by hand.

**These re-create the org and user on every `web` start if they are absent.** Deleting
the seed user in the UI is undone by the next restart. Once a real (SSO) owner exists,
blank these values — otherwise a password-only account keeps reappearing as an owner after
password login has been disabled.

Per-project credentials are provisioned separately by `scripts/provision-project.sh`.
Each agent project gets **its own key pair** so a leaked key is revocable in isolation.

### Tuning

| Variable | Default | Raise when |
|---|---|---|
| `LANGFUSE_S3_CONCURRENT_WRITES` | `50` | Observed S3 socket exhaustion or throttling. |
| `TELEMETRY_ENABLED` | `false` | Never — this is a private EU platform. |

---

## Running the stack

### Prerequisites

- Docker Engine with the Compose plugin
- A DNS record pointing at the host (for TLS issuance)
- Ports `80` and `443` free on the host — Caddy cannot obtain a certificate otherwise

### First-time setup

```bash
# 1. Generate real secrets. Refuses to overwrite an existing .env.
./scripts/generate-secrets.sh

# 2. Fill in the values the generator cannot know.
#    NEXTAUTH_URL, LANGFUSE_DOMAIN, ACME_EMAIL, ADMIN_ALLOWLIST
$EDITOR infra/.env

# 3. Validate before starting anything.
./scripts/check-env-mapping.sh
./scripts/test-compose-config.sh

# 4. Start. Caddy is built from source on first run (rate-limit module).
docker compose -f infra/compose.yaml up -d

# 5. Verify.
./scripts/health-check.sh https://<your-domain>
```

### Local validation

`compose.local.yaml` proves the stack boots, migrations run and the canary passes without
needing a domain or public IP. It publishes `web` on `127.0.0.1:3000` and excludes Caddy,
since ACME cannot issue a certificate for `localhost`.

```bash
docker compose -f infra/compose.yaml -f infra/compose.local.yaml up -d
./scripts/health-check.sh http://localhost:3000
```

It must be passed **explicitly**. It is deliberately not named `compose.override.yaml`,
because that filename is auto-loaded and would silently publish the web port on the
server.

---

## Managing the stack

All commands run from the repository root.

```bash
# Status — note that "Created" means never started, usually a depends_on gate
docker compose -f infra/compose.yaml ps

# Logs
docker compose -f infra/compose.yaml logs -f web
docker compose -f infra/compose.yaml logs --tail=100 worker

# Stop (containers removed, data preserved)
docker compose -f infra/compose.yaml down

# Start
docker compose -f infra/compose.yaml up -d

# Apply a changed .env or compose.yaml to one service
docker compose -f infra/compose.yaml up -d --force-recreate web
```

### Two rules that cause real outages when ignored

**1. `restart` does not reload configuration.** Environment variables are fixed when a
container is *created*. `docker compose restart` reuses the existing container and keeps
the old values. Always use `up -d --force-recreate <service>`.

**2. Never run `docker compose down -v`.** The `-v` flag deletes the volumes, destroying
all trace history, every project credential, and the platform's identity. There is no
undo. `down` without `-v` is safe.

### Deploy changes one service at a time

Verify between each step. If something breaks, it is then unambiguous which change caused
it. Run the ingestion canary after any step that recreates a container, because agents
depend on the ingest path staying reachable throughout.

---

## Security model

### Ingress split — the core boundary

Telemetry ingest **must** be public: Vercel serverless functions have no static egress
IPs outside Enterprise Secure Compute, so they cannot be IP-allowlisted. The admin surface
has no such constraint and does not inherit that exposure.

| Surface | Paths | Exposure | Controls |
|---|---|---|---|
| **Ingest** | `/api/public/otel*`, `/api/public/ingestion*` | Public | TLS, per-project API keys, 10 MB body limit, rate limit |
| **Health** | `/api/public/health`, `/api/public/ready` | Public | None — deliberately not rate limited, so off-host monitoring is never throttled into a false alarm |
| **UI / admin / everything else** | all other paths | Restricted | `ADMIN_ALLOWLIST` (IP CIDR) **and** Entra SSO |

The final Caddy handler is `respond "Not authorized" 403` — a deny-by-default. It must
never proxy; if it did, the entire admin surface would become public.

### Transport security

TLS is terminated by Caddy with automatic Let's Encrypt certificates and renewal. Security
headers applied to every response:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Server` header removed

### Rate limiting

Stock Caddy has no rate limiting; `rate_limit` is a third-party module compiled in via the
`caddy/Dockerfile`. Two zones:

| Zone | Scope | Limit | Rationale |
|---|---|---|---|
| `ingest` | ingest paths | 1000 / min per IP | Stops a runaway agent loop, not normal traffic. Trace volume is still unmeasured, so a tighter limit would throttle legitimate deep traces. |
| `auth` | `/api/auth/*` | 30 / min per IP | Brute-force protection. A browser SSO round trip makes several calls, so a tighter limit would break normal logins. |

**Known limitation:** rate limiting is keyed per source IP, which does *not* give
per-project throttling. Vercel functions egress from many rotating IPs, so one project's
flood spreads across keys. Per-project keying would require using the `Authorization`
header as the key — that value is the API secret, so it must never be logged. Tracked in
[`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md).

`remote_ip` matches the direct peer, not `X-Forwarded-For`. `trusted_proxies` is
deliberately not configured: Caddy is the edge, and trusting a forwarded header would let
a spoofed value bypass the allowlist.

### Authentication

Access to the UI is by **Microsoft Entra ID SSO**, single-tenant. This replaces network
trust with identity: the previous model granted access to whoever currently held an
allowlisted IP address, which is unsound when that address is a dynamic residential one
that gets reassigned to another customer.

Current state:

- SSO is configured and verified against the tenant
- Account linking is enabled, so identities can claim accounts that predate SSO
- `AUTH_DISABLE_USERNAME_PASSWORD=true` — **password login is disabled; SSO is the only way in**
- `ADMIN_ALLOWLIST` remains enforced, so the UI is protected by network *and* identity

> Because password login is disabled, the platform is reachable only through Entra. If
> the Entra client secret expires or the app registration is changed, **everyone loses UI
> access at once.** The secret's expiry date is recorded next to it in `infra/.env` and
> must be calendared. Recovery is host access: restore an `infra/.env` backup with
> `AUTH_DISABLE_USERNAME_PASSWORD=false` and recreate `web`.

### Secrets

Secrets live only in `infra/.env` (mode `600`, gitignored) and in CI/CD secret storage.
Never in source, never in committed config. `scripts/test-secret-hygiene.sh` guards this.

Because the application reads all credentials from the environment, rotation is a redeploy
rather than a code change.

### Data protection

- **EU data residency**, ~90 day retention policy, retention set per project
- Anonymous telemetry to Langfuse is disabled
- Full input/output capture is currently permitted because no real PII is expected in
  prompts. **Re-validate that assumption whenever a new project onboards** — if it stops
  holding, note that server-side masking does not protect blob storage, since the event is
  written to S3 before masking is applied. Only client-side masking keeps raw data off the
  platform.

---

## Verification and monitoring

### The check that matters most

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
./scripts/ingestion-canary.sh https://<your-domain>
```

It writes a trace over OTLP and then **reads it back**. A write being accepted proves
nothing, because ingestion is queued. Only the read-back proves the whole path — OTLP →
blob storage → queue → worker → ClickHouse → query — actually works.

Note the trap it exists to avoid: in v4's `events_only` mode the legacy ingestion endpoint
rejects trace events while still returning HTTP `207`. A canary asserting only on the
status code passes against a pipeline that stored nothing, so this one asserts on the
response body.

### Script reference

| Script | Purpose |
|---|---|
| `health-check.sh` | Liveness + readiness. Proves web is up and can reach Postgres. |
| `ingestion-canary.sh` | End-to-end write-then-read verification. |
| `check-credential-drift.sh` | Compares `.env` against running containers and against what the datastores actually accept. |
| `check-env-mapping.sh` | Finds `.env` keys that no service consumes (static; safe in CI). |
| `generate-secrets.sh` | First-install secret generation. Refuses to overwrite. |
| `provision-project.sh` | Creates a project with its own API key pair. |
| `discover-queue-keys.sh` | Finds the real BullMQ key layout in Valkey and prints the `REDIS_QUEUE_KEY_PATTERNS` value. Queue depth is silently unmeasured without it. |
| `verify-metric-sources.sh` | Asserts every metric the dashboards depend on is actually exported. Run after any image bump. |
| `test-*.sh` | Config, TTL, proxy-split, provisioning, monitoring and secret-hygiene assertions. |

### Monitoring

Prometheus and Grafana, in a separate compose file that is merged explicitly:

```bash
docker compose -f compose.yaml -f compose.monitoring.yaml up -d
```

Grafana is served at `$GRAFANA_DOMAIN` behind the same `ADMIN_ALLOWLIST` as the Langfuse UI, plus
its own login. Nothing else in the monitoring stack publishes a host port — Caddy stays the only
ingress.

**Langfuse exposes no Prometheus endpoint** ([discussion #1816](https://github.com/orgs/langfuse/discussions/1816)
is still open), so its signals are derived: queue depth from BullMQ's Redis keys, ingestion
throughput from ClickHouse inserted rows, availability from blackbox probes, request load from
Caddy. Throughput is deliberately measured at ClickHouse rather than at the edge, because
`/api/public/ingestion` returns `207` on *enqueue* — a healthy request rate is compatible with a
backlogged pipeline storing nothing.

Three provisioned dashboards: platform overview, ingestion & queues, infrastructure & capacity.
**Alerting is not implemented yet** — the thresholds in `docs/OPERATIONS.md` §2 were written before
anything was measured, so a baseline comes first.

Details, blind spots and maintenance: [`docs/MONITORING.md`](docs/MONITORING.md).

### External monitoring

Langfuse must not be the only system that knows Langfuse is down. An independent, off-host
monitor should poll `/api/public/health` and run the ingestion canary on a schedule.
`/api/public/ready` returns `500` after `SIGTERM`, which is what lets traffic drain
cleanly on shutdown.

The two dominant risks are both slow-moving and catchable well in advance:

1. **ClickHouse disk exhaustion** → ingestion stops. Track GB/day and *projected days
   until full*, and alert on the projection rather than the current percentage.
2. **Worker queue backlog** → traces silently delayed or lost.

---

## Troubleshooting

Full catalogue with root causes: [`docs/DEPLOYMENT-PITFALLS.md`](docs/DEPLOYMENT-PITFALLS.md)
(infrastructure) and [`docs/INTEGRATION-PITFALLS.md`](docs/INTEGRATION-PITFALLS.md)
(agent/tracing).

**The recurring theme: these failures present as a different problem than they are.**
Diagnose to root cause; do not treat symptoms.

### Diagnostic order when a service will not start

1. **What is actually running?** `docker compose ps -a`. `Created` means never started —
   almost always a `depends_on` gate, not a slow boot.
2. **Why is the dependency ungated?** `docker inspect <c> --format '{{json .State.Health.Log}}'`
   — read the probe's real output before assuming the service is broken.
3. **Is it genuinely listening?** `docker compose exec <svc> netstat -ltn`. Listening but
   unhealthy means the probe is wrong, not the service.
4. **Read the real log.** ClickHouse writes fatal errors only to
   `/var/log/clickhouse-server/clickhouse-server.err.log`, not stdout.
5. **Confirm you actually restarted it** — a bind-mount edit does not restart a service.

### A config change appears to have no effect

Check the **container**, not the file:

```bash
docker inspect langfuse-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '<VAR>'
```

A value can be correct in `.env` and absent at runtime, because services enumerate their
environment explicitly in `compose.yaml`. If the variable is missing, add it to that
service's `environment:` block — editing `.env` alone will never fix it.
`./scripts/check-env-mapping.sh` catches this statically.

### Authentication failures against a datastore

Run `./scripts/check-credential-drift.sh`. Three values are routinely assumed equal and
silently are not: what `.env` says, what a running container has baked in, and what the
datastore will accept.

Postgres is the dangerous one — `POSTGRES_PASSWORD` is applied **only when the data
volume is first initialised**, so regenerating `.env` against existing volumes rotates
Valkey, MinIO and ClickHouse while leaving Postgres on its original password.

When testing a Postgres password by hand, connect **over TCP from a separate container**.
Running `psql` inside the postgres container uses the Unix socket, where `pg_hba` grants
trust and the password is never checked — that test passes against a password the
application cannot use.

### SSO login fails with `OAuthAccountNotLinked`

The email the identity provider returned already belongs to an account not created through
SSO. Auth.js refuses to merge them silently, because that is an account-takeover vector.
Set `AUTH_AZURE_AD_ALLOW_ACCOUNT_LINKING=true` and recreate `web`. Safe only with a
single-tenant app registration.

Verify a login truly succeeded by checking for the linked row, not by observing that a page
loaded:

```sql
select u.email, a.provider, a.type from "Account" a join users u on u.id = a.user_id;
```

The table is `"Account"` — quoted and capitalised. `accounts` does not exist.

### Ingest is down but the UI seems fine (or vice versa)

`caddy` gates on `web: service_healthy`, so a `web` failure stops caddy and takes ingest
down too. `docker compose ps` can show five of six services healthy while nothing is
reachable. The ingestion canary is what catches this; a service listing is not.

---

## Maintenance

### Upgrades

Never edit an image tag in place on the server. The flow is:

```
release detected → PR → CI → staging → smoke tests
→ [human approval for majors] → production → post-deploy verification → rollback on failure
```

- `web` and `worker` must be upgraded **together** and must match exactly.
- Major upgrades require explicit review against the current Langfuse upgrade guide, with
  attention to **ClickHouse schema migrations**.
- **Rollback is not safe across a schema migration.** That path needs its own tested
  procedure.
- Security updates are prioritised above feature updates.

### Backups

Backups are automated, encrypted, stored off the primary host in EU storage, and monitored
for both success *and* failure.

**Priority ordering matters: Postgres is the crown jewel.** Losing ClickHouse costs trace
history; losing Postgres costs the platform's identity and every project credential. Redis
loss forfeits only in-flight queued events, which is acceptable under the best-effort
policy.

**Restore testing is mandatory.** A backup is not valid because the job reported success —
it is valid because a restore worked. If the last successful restore test goes stale,
disaster recovery is theory.

### Rotating secrets

`generate-secrets.sh` is a **first-install tool** and refuses to overwrite an existing
`.env`. Rotating a credential on a running deployment is a deliberate per-datastore
procedure, not a file rewrite:

1. Back up `infra/.env` first.
2. Change the value in `.env`.
3. Apply the change **inside the datastore** — for Postgres that means
   `ALTER USER … WITH PASSWORD …`, because the container will not re-read it.
4. Recreate **every** consumer with `--force-recreate`, not just the obvious one.
5. Confirm with `./scripts/check-credential-drift.sh`.

### Certificate and secret expiry

- TLS certificates renew automatically via Caddy; expiry should still be monitored.
- The **Entra client secret does not auto-renew.** Its expiry is recorded beside it in
  `infra/.env`. With password login disabled, letting it lapse locks everyone out of the
  UI with no prior warning.

### Scaling

Scale on measured metrics, never on intuition or agent count. A large number of onboarded
agents is not a scaling signal; sustained queue growth is.

ClickHouse **cannot be scaled by sharding** — Langfuse does not support multi-shard
clusters, so shard count stays `1`. Capacity comes from a bigger box, replicas, retention,
sampling, and blob storage as external disks. Replica count cannot be raised at runtime
without downtime, so plan topology before it is urgent.

Documented upgrade triggers and thresholds: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Actions that always require human judgement

Deleting production data · changing retention · high-risk database migrations · major
Langfuse upgrades · destructive infrastructure changes · modifying ClickHouse topology ·
changing authentication · rotating all credentials simultaneously · changing backup
retention.

---

## Further documentation

| Document | Contents |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Architecture, requirements, design decisions, roadmap |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Thresholds, alert matrix, dashboard spec |
| [`docs/MONITORING.md`](docs/MONITORING.md) | The Prometheus/Grafana stack — metric sources, dashboards, and what it cannot see |
| [`docs/RUNBOOK-deploy.md`](docs/RUNBOOK-deploy.md) | Step-by-step deployment procedure |
| [`docs/RUNBOOK-onboarding.md`](docs/RUNBOOK-onboarding.md) | Adding a new agent project |
| [`docs/DEPLOYMENT-PITFALLS.md`](docs/DEPLOYMENT-PITFALLS.md) | Infrastructure failures, diagnosed to root cause |
| [`docs/INTEGRATION-PITFALLS.md`](docs/INTEGRATION-PITFALLS.md) | Agent and tracing integration failures |
| [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md) | Security findings and open items |
| [`docs/SERVER-HANDOFF-SSO.md`](docs/SERVER-HANDOFF-SSO.md) | SSO migration procedure and gates |
