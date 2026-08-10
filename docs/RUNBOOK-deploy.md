# Runbook — Deploying Langfuse Tier 1

Bring-up and rebuild procedure for the self-hosted Langfuse platform.

Architecture and rationale live in [`../CLAUDE.md`](../CLAUDE.md). This document is
the sequence you actually run.

---

## 1. Pinned versions

Never `latest`. Every tag below was verified against the registry before pinning.

| Component | Image | Tag |
|---|---|---|
| Langfuse Web | `langfuse/langfuse` | `4.6.0` |
| Langfuse Worker | `langfuse/langfuse-worker` | `4.6.0` |
| Postgres | `postgres` | `17-alpine` |
| ClickHouse | `clickhouse/clickhouse-server` | `25.12-alpine` |
| Valkey | `valkey/valkey` | `8-alpine` |
| MinIO | `minio/minio` | `RELEASE.2025-09-07T16-13-09Z` |
| Caddy | `caddy` | `2.11.4-alpine` |

**Web and worker tags must always match.** ClickHouse 25.12 is the version upstream
Langfuse tests against — do not bump it independently of a Langfuse upgrade, because
a ClickHouse major can carry an irreversible schema migration.

Upgrades follow the flow in CLAUDE.md §14. Never edit a tag in place on the server.

---

## 2. Host prerequisites

- Hetzner dedicated server, EU (Falkenstein / Nuremberg / Helsinki) — AX102-class:
  ~16 cores, 128 GB RAM, ~3.8 TB NVMe.
- Docker Engine + Compose v2.
- DNS `A` record for `LANGFUSE_DOMAIN` pointing at the host, resolving **before**
  first start — Caddy needs it to complete the ACME challenge.
- Inbound 80 and 443 open. **Nothing else.**

> Record the actual server ID, region, and allowlist CIDRs here when the box is
> provisioned. Infrastructure is code; hand-configured hosts are not acceptable.

| Field | Value |
|---|---|
| Server | _to be filled at provisioning_ |
| Region | _to be filled at provisioning_ |
| Domain | _to be filled at provisioning_ |
| Admin allowlist | _to be filled at provisioning_ |

---

## 2.5 Preparing a fresh Hetzner host

Run once, on a new box, before anything else.

### a. Order the server

Hetzner Robot → dedicated, **EU location** (Falkenstein / Nuremberg / Helsinki) for
GDPR residency. AX102-class: ~16 cores, 128 GB RAM, ~3.8 TB NVMe, ~€105/mo. Install
Ubuntu 24.04 LTS.

> Hetzner *Cloud* (CX/CPX) is cheaper but tops out well below what ClickHouse needs at
> this trace depth. Tier 1 assumes dedicated.

### b. Point DNS at it — before first start

Create an `A` record for your domain pointing at the server IP and wait for it to
resolve. Caddy performs an ACME HTTP-01 challenge on first boot; if DNS is not live,
certificate issuance fails and you will debug TLS instead of Langfuse.

```bash
dig +short langfuse.yourdomain.com    # must return the server IP
```

### c. Harden SSH and firewall

```bash
ssh root@<server-ip>

adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Key-only SSH.
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh

# Only SSH, HTTP and HTTPS. Nothing else, ever.
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable && ufw status verbose
```

**Postgres (5432), ClickHouse (8123/9000), Valkey (6379) and MinIO (9001) must never
be reachable.** The compose stack publishes no host ports for them, and `ufw` is the
second layer. Do not add a rule "temporarily to debug".

> **Docker bypasses ufw.** Docker writes its own iptables rules and a published port
> is reachable regardless of ufw. This stack only publishes 80/443 (via Caddy), so it
> is safe — but never add a `ports:` mapping to a data service expecting ufw to cover
> you.

### d. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
systemctl enable --now docker
docker --version && docker compose version
```

### e. Set the host clock to UTC

```bash
timedatectl set-timezone UTC && timedatectl
```

Non-negotiable. A wrong timezone corrupts analytics silently, and containers inherit
the host clock even though every service also sets `TZ=UTC`.

### f. Clone the repository

The repo is **private**, so the server needs read access. Generate a deploy key:

```bash
ssh-keygen -t ed25519 -C "langfuse-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Add that public key at **Settings → Deploy keys → Add deploy key** on the GitHub repo
(read-only; do not tick write access). Then:

```bash
git clone git@github.com:AiLabSportnavi/LangfuseMonitoring.git
cd LangfuseMonitoring
```

### g. Choose the admin allowlist carefully

`ADMIN_ALLOWLIST` decides who can reach the UI. **Set it wrong and you lock yourself
out of your own dashboard** — ingest keeps working, so the platform looks healthy while
being unusable.

```bash
curl -s https://ifconfig.me      # your current public IP
```

- **Static office/VPN IP** → use it: `ADMIN_ALLOWLIST=203.0.113.7/32`
- **Dynamic residential IP** → do **not** hardcode it; it will change and lock you out.
  Put the box on a VPN (WireGuard/Tailscale) and allowlist the VPN range instead.

Recovery if you are locked out: SSH in and query the container directly —
`docker compose exec web wget -qO- http://127.0.0.1:3000/api/public/ready` — or widen
the allowlist in `infra/.env` and `docker compose up -d --force-recreate caddy`.

---

## 3. First bring-up

```bash
git clone <this-repo> && cd LangfuseMonitoring

# 1. Generate secrets. Refuses to overwrite an existing .env.
./scripts/generate-secrets.sh

# 2. Set the real values it cannot guess:
#      NEXTAUTH_URL, LANGFUSE_DOMAIN, ACME_EMAIL, ADMIN_ALLOWLIST
$EDITOR infra/.env

# 3. Pre-flight: every check must pass before the stack starts.
./scripts/test-secret-hygiene.sh
./scripts/test-clickhouse-ttl.sh     # boots a throwaway ClickHouse
./scripts/test-compose-config.sh
./scripts/test-caddy-split.sh

# 4. Start.
cd infra && docker compose up -d && docker compose ps
```

All eight services should be `running`; `web` reaches `healthy` within ~2 minutes
(first start runs Postgres and ClickHouse migrations).

`NEXTAUTH_URL` must be the full external HTTPS URL. Login cookies bind to it, so a
mismatch produces a sign-in loop with no useful error.

---

## 4. Post-deploy verification

Run all four. A deploy is not "good" until every one passes.

```bash
# UTC everywhere. A wrong timezone corrupts analytics silently.
docker compose exec clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "SELECT timezone()"
docker compose exec postgres psql -U langfuse -d langfuse -tAc "SHOW TIMEZONE"
# expect: UTC, UTC

# System-table TTLs actually applied (not merely present in the config file).
docker compose exec clickhouse clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query \
  "SELECT name, engine_full FROM system.tables
   WHERE database='system' AND name IN ('trace_log','query_log','opentelemetry_span_log')
   FORMAT Vertical"
# expect: TTL clauses present in engine_full

# Health.
./scripts/health-check.sh https://<domain>

# Ingestion, end to end. This is the one that matters.
export LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-...
./scripts/ingestion-canary.sh https://<domain>
```

> If system tables were created before the config mount took effect, they keep the
> old engine. Drop them and restart — ClickHouse recreates them with the configured
> TTL.

### Verify the security split holds

**Run this from a host that is NOT on the allowlist.** Running it from an
allowlisted machine proves nothing.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/                   # expect 403
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/public/health  # expect 200

# Data services must be unreachable.
nmap -Pn -p 5432,8123,9000,9001,6379 <server-ip>                             # all closed
```

---

## 5. Known behaviours

> 📖 **If anything fails to start, read [`DEPLOYMENT-PITFALLS.md`](DEPLOYMENT-PITFALLS.md)
> before debugging.** It documents nine failures already hit and fixed during Stage 1A,
> several of which present as a completely different problem than they are — including
> a healthy service marked unhealthy, and an app that never started looking like an app
> that was slow to start. It ends with a diagnostic checklist.

**ClickHouse system-table TTLs.** `infra/clickhouse/config.d/langfuse-ttl.xml`
uses two different forms deliberately — bare `<ttl>` for most tables, a full
element replacement for `opentelemetry_span_log`. ClickHouse rejects mixing
`<engine>` with `<partition_by>`/`<ttl>`, and which form is legal depends on what
the stock `config.xml` ships per table. Getting this wrong prevents the server
from starting at all (exit 36). The file documents the mapping; do not "tidy" it.

**Mount the ClickHouse config file, not the directory.** Mounting over
`/etc/clickhouse-server/config.d` hides the image's own `docker_related_config.xml`
and ClickHouse then binds loopback only — healthy to its own probe, unreachable to
web and worker.

**Healthchecks address `127.0.0.1`, never `localhost`.** Where IPv6 is disabled,
`localhost` resolves to `::1` first and the probe is refused against a perfectly
healthy service. Combined with `depends_on: service_healthy`, that silently stops
everything downstream from starting.

**Editing a bind-mounted config does not restart the service.** Compose sees no
change to the container spec. Use `docker compose up -d --force-recreate <svc>`.

**Valkey and BullMQ.** `LANGFUSE_BULLMQ_SKIP_REDIS_VERSION_CHECK=true` is set
because Valkey reports its own version string, which BullMQ's Redis version check
can reject despite Valkey 8 being wire-compatible with Redis 7.2.

**Valkey uses `noeviction`.** It holds the ingestion queue; evicting keys would
silently discard queued events. Alert on memory pressure rather than evicting.

**Rate limiting is not yet enforced.** Caddy's `rate_limit` needs a plugin build.
`request_body max_size 10MB` bounds payloads today; abuse response is per-project
key revocation. Tracked in Stage 1C.

---

## 6. Rebuild from scratch

```bash
cd infra
docker compose down                 # keeps volumes
docker compose up -d
```

**Destructive** — deletes all trace history and platform identity:

```bash
docker compose down -v
```

Never run that against production without a verified restore. Note the priority
ordering from CLAUDE.md §13: losing ClickHouse costs trace history; losing
**Postgres** costs the platform's identity and every project credential.

---

## 7. Local validation

To exercise the stack without a domain:

```bash
cd infra
docker compose -f compose.yaml -f compose.local.yaml up -d
```

Publishes web on `127.0.0.1:3000` and disables Caddy (ACME cannot issue for
localhost). This is explicitly **not** named `compose.override.yaml`, because that
name auto-loads and would publish the web port on the server.

The ingest/UI split therefore **cannot** be verified locally — it must be checked
against the real host, from a non-allowlisted source, per §4.
