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
- **Ports 80 and 443 must be free.** On a shared box they usually are not — see §2.1.

> Record the actual server ID, region, and allowlist CIDRs here when the box is
> provisioned. Infrastructure is code; hand-configured hosts are not acceptable.

| Field | Value |
|---|---|
| Server | Hetzner dedicated, `Ubuntu-2404-noble-amd64-base` — 20 cores, 62 GB RAM, 1.7 TB NVMe |
| Public IP | `5.9.95.174` |
| Region | Hetzner EU |
| Domain | `sportnavi-langfuse.sportnavi.de` |
| Admin allowlist | `127.0.0.1/32 ::1/128 5.9.95.174/32 172.16.0.0/12 2.214.226.222/32` |
| Deployed | 2026-08-10 — Langfuse 4.6.0 |

> ⚠️ The box is **smaller than the AX102 target** (62 GB RAM, not 128 GB) and is
> **shared with other workloads**. Both matter for capacity planning under §8.7.

### 2.1 Pre-flight on a shared host — check this FIRST

The compose stack binds 80 and 443 through Caddy. On a box that already serves
other sites, that is a hard conflict, and you will not discover it until the very
last step of the deploy unless you check up front:

```bash
ss -tlnp | grep -E ':(80|443)\s'         # anything here blocks Caddy
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '(:80|:443)->'
```

Resolve the conflict **before** running `generate-secrets.sh`, because freeing
the ports means taking someone else's ingress down and that is a decision, not a
deployment step. Options, in order of preference:

1. **This stack owns the edge.** Stop and remove the other proxy. Only correct if
   the vhosts it serves are genuinely decommissioned — confirm each one.
2. **The existing proxy stays the edge.** Do not run this stack's Caddy; add the
   split rules from `infra/caddy/Caddyfile` to that proxy's config and point it
   at `web:3000`. Preserves the other sites, but the ingest/UI split now lives in
   a file this repo does not own — record where.

Also confirm no *other* Langfuse is already on the box (`docker ps | grep langfuse`).
A pre-existing v3 install will hold the same hostname and quietly answer your
verification probes with the wrong version — check `/api/public/health` reports the
version you just deployed, not merely `"status":"OK"`.

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

> Run every script with `bash scripts/<name>.sh`. A fresh clone does not
> necessarily carry the executable bit, and `./scripts/...` then fails with
> `Permission denied` (exit 126) — which looks like the script is broken rather
> than merely not `+x`. Fix once with `chmod +x scripts/*.sh`.

```bash
git clone <this-repo> && cd LangfuseMonitoring
chmod +x scripts/*.sh

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
# Needs a project first — headless init creates the org and admin user, but NOT
# a project, so there are no API keys until you provision one:
./scripts/provision-project.sh <slug> 90
export LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-...
./scripts/ingestion-canary.sh https://<domain>
```

> **The canary writes over OTLP, not `/api/public/ingestion`.** Langfuse v4
> defaults to `LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`, under which the
> legacy ingestion endpoint rejects trace events and the v3 read endpoints are
> gone. See §5 issue 12 before "fixing" a canary failure.

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

## 5A. Failures hit during the first real server deploy (2026-08-10)

Stage 1A's nine pitfalls were found bringing the stack up **locally**. The six below
were found bringing it up **on the Hetzner box**, and none of them can reproduce
locally: four are properties of a shared, internet-facing host, and two only appear
against a real domain. They continue the numbering in
[`DEPLOYMENT-PITFALLS.md`](DEPLOYMENT-PITFALLS.md).

The recurring theme is unchanged, and worth restating because it caught us again:
**every one of these presented as a different problem than it was.** A correct
deployment looked broken; a broken probe looked like a broken app; an accepted
write looked like a working pipeline.

| # | Issue | Symptom | Real cause |
|---|---|---|---|
| 10 | Ports 80/443 already bound | `bind: address already in use`, or Caddy silently absent | Another project's proxy owns the edge |
| 11 | Next.js binds `$HOSTNAME` | web + worker `(unhealthy)`, Caddy never starts | Probe hits `127.0.0.1`; app bound only to the container IP |
| 12 | v4 `events_only` write mode | Canary: `207` then read-back fails forever | Legacy ingest/read endpoints retired; OTLP is the path |
| 13 | Invalid / misdirected hostname | ACME never issues | Underscore in hostname, or DNS points elsewhere |
| 14 | `Not authorized` in the browser | Looks like a failed deploy | The allowlist working as designed |
| 15 | `.env` edits appear to do nothing | Old value still in effect after `restart` | Env vars are fixed at container **creation** |

### 10. Ports 80/443 were already taken

The box already ran an unrelated Caddy serving four production vhosts **plus an
older Langfuse v3**, which held the very hostname we were deploying to and answered
`/api/public/health` with `{"status":"OK","version":"3.158.0"}`.

That last detail is the dangerous one: a health probe against the target domain
**passed before we deployed anything**. Always assert on the version, not just
on `status: OK`.

Detection and resolution are in §2.1. Freeing the ports is a decision about someone
else's service — get it confirmed, never assume.

### 11. Web and worker are unhealthy while serving perfectly

**Symptom.** `web` and `worker` sit at `(unhealthy)` forever. Because Caddy declares
`depends_on: {web: {condition: service_healthy}}`, Caddy stays in `Created` and
**there is no ingress at all** — the site is simply down. Migrations, meanwhile,
completed cleanly and the logs show `✓ Ready`.

```
wget: can't connect to remote host (127.0.0.1): Connection refused
```

**Root cause.** Next.js standalone binds to whatever `$HOSTNAME` says, and Docker
sets `HOSTNAME` to the container ID. The server therefore binds **only** the
container's eth0 address:

```
$ docker exec langfuse-web-1 netstat -ltn
tcp  0  0 172.21.0.6:3000   0.0.0.0:*  LISTEN     # <- not 127.0.0.1, not 0.0.0.0
$ docker exec langfuse-web-1 sh -c 'wget -qO- http://$(hostname -i):3000/api/public/ready'
{"status":"OK","version":"4.6.0"}                 # <- the app is fine
```

This is pitfall #3's twin. #3 was the probe naming the wrong address; this is the
**app binding the wrong address**. Same signature, opposite fix — and note the fix
for #3 (`127.0.0.1` instead of `localhost`) is what *exposes* this one.

**Fix.** `HOSTNAME: "0.0.0.0"` on `web` and `worker` in `compose.yaml`. Upstream
Langfuse's own compose sets this. Do not "fix" it by pointing the healthcheck at
the container IP — that address changes on every recreate.

### 12. `events_only` mode retires the v3 ingestion and read APIs

**Symptom.** The canary reports `queued trace ... (207)` and then never reads it
back. Worker logs are clean, no queue backlog, no errors anywhere — and MinIO is
empty. The pipeline looks healthy and stores nothing.

**Root cause.** Langfuse v4.6 defaults to
`LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`. Under it,
`POST /api/public/ingestion` **returns HTTP 207 while rejecting the event in the
body**:

```json
{"successes":[],"errors":[{"id":"...","status":400,
 "message":"Event type not accepted",
 "error":"Event type \"trace-create\" is not accepted by /api/public/ingestion
          when LANGFUSE_MIGRATION_V4_WRITE_MODE is events_only.
          This endpoint only accepts score and log events."}]}
```

The v3 read endpoints are gone too — `/api/public/traces`,
`/api/public/traces/{id}` and `/api/public/observations` all return **404** with a
deprecation payload naming the replacement.

**Fix.** Write traces over **OTLP** (`POST /api/public/otel/v1/traces`) and read
them back via **`GET /api/public/v2/observations?fromStartTime=&toStartTime=`**.
`scripts/ingestion-canary.sh` now does exactly this, which has the side benefit of
exercising the same path the agents use (CLAUDE.md §6.1) instead of a retired one.

Under this mode the `traces` and `observations` ClickHouse tables stay empty by
design; rows land in `events_core` / `events_full`. An empty `traces` table is
**not** evidence of broken ingestion:

```sql
SELECT count() FROM events_core;   -- this is where the data is
```

> **Lesson: a 2xx is not a success. Assert on the response body.** The old canary
> checked only `http_code == 207` and would have passed against a pipeline that
> persisted nothing — the same blind spot §"Lessons for the test suite" already
> recorded once.

### 13. The hostname must be a legal hostname that points at this box

The domain first supplied for this deploy was `sportnavi_langfuse.sportnavi.de`,
which cannot work for two independent reasons:

- **Underscores are illegal in hostnames** (RFC 1123). Let's Encrypt and ZeroSSL
  both refuse to issue, so HTTPS is impossible no matter what DNS says.
- Its `A` record pointed at `85.13.152.135` — unrelated shared hosting, not this
  server.

Verify both before touching `.env`; ACME failures at the end of a deploy are
expensive to diagnose:

```bash
dig +short A "$LANGFUSE_DOMAIN"      # must equal this host's public IP
curl -s -4 https://ifconfig.me       # this host's public IP
```

Hyphens only. The working name here is `sportnavi-langfuse.sportnavi.de`.

### 14. `Not authorized` is success, not failure

A browser hitting the domain gets a black page reading **`Not authorized`**. That
is `infra/caddy/Caddyfile`'s deny-by-default handler doing its job: the UI is
restricted to `ADMIN_ALLOWLIST`, and every address outside it — including your own
laptop — gets a 403.

Distinguish "denied" from "broken" with one command, not by guessing:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/                  # 403 = allowlist
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/public/health # 200 = platform is up
```

Confirm from the edge's own view — this is the authoritative record of what Caddy
decided, and it shows the real client IP:

```bash
docker compose exec caddy tail -20 /var/log/caddy/access.log
```

To grant access, add the CIDR to `ADMIN_ALLOWLIST` and recreate Caddy (see #15).
Note that residential IPs are usually dynamic — expect to redo this.

### 15. Editing `.env` needs `--force-recreate`, not `restart`

Pitfall #9 covers bind-mounted *files*. Environment variables have the same trap
for a different reason: they are baked into the container at **creation**.
`docker compose restart caddy` reuses the existing container and silently keeps the
old `ADMIN_ALLOWLIST`.

```bash
docker compose up -d --force-recreate caddy
docker exec langfuse-caddy-1 sh -c 'echo $ADMIN_ALLOWLIST'   # verify it actually changed
```

**Related trap:** do not `source infra/.env` in a shell. `ADMIN_ALLOWLIST` is a
space-separated list and `::1/128` parses as a command, giving
`./.env: line 82: ::1/128: No such file or directory`. Compose parses the file
correctly; bash does not. Use `docker compose exec` for values, or quote carefully.

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

**Local validation will not catch issues 10–15.** Four of them are properties of a
shared, internet-facing host and two require a real domain. Treat a clean local run
as necessary, never sufficient.

---

## 8. Operating this deployment

Everything below assumes `cd /root/LangfuseMonitoring/infra` on the Hetzner box.
The compose project is named `langfuse`, so containers are `langfuse-<service>-1`
and will not collide with other stacks on the host.

### Daily commands

```bash
docker compose ps                       # 7 services; web+worker must read (healthy)
docker compose logs -f web worker       # follow the app tiers
docker compose logs caddy --tail 50     # TLS + routing decisions
docker compose restart <svc>            # code/state bounce (does NOT reload .env)
docker compose up -d --force-recreate <svc>   # required after any .env change
```

`minio-init` showing `Exited (0)` is correct — it is a one-shot bucket creator, not
a long-running service.

### Health, at three increasing depths

```bash
cd /root/LangfuseMonitoring

# 1. Is the platform up?  (public, works from anywhere)
bash scripts/health-check.sh https://sportnavi-langfuse.sportnavi.de

# 2. Is the security split intact?  403 on UI + 200 on health = correct
curl -s -o /dev/null -w '%{http_code}\n' https://sportnavi-langfuse.sportnavi.de/
curl -s -o /dev/null -w '%{http_code}\n' https://sportnavi-langfuse.sportnavi.de/api/public/health

# 3. Does ingestion actually store and return data?  THE check that matters.
export LANGFUSE_PUBLIC_KEY=pk-lf-...  LANGFUSE_SECRET_KEY=sk-lf-...
bash scripts/ingestion-canary.sh https://sportnavi-langfuse.sportnavi.de
```

Expect the canary to pass in **~3 s** on an idle stack. A climbing figure is the
earliest warning of worker backlog — track it before it becomes an outage.

### Granting someone UI access

```bash
cd infra
sed -i 's|^ADMIN_ALLOWLIST=.*|ADMIN_ALLOWLIST=<existing list> <new-cidr>|' .env
docker compose up -d --force-recreate caddy
docker exec langfuse-caddy-1 sh -c 'echo $ADMIN_ALLOWLIST'   # confirm
```

Ingest and health endpoints are deliberately **not** gated by this list — adding a
CIDR affects the UI/admin surface only.

### Onboarding a new agent project

```bash
bash scripts/provision-project.sh <project-slug> 90
```

One key pair per project, never a shared credential. The script refuses to
re-provision an existing slug, so rotation stays a deliberate act. Only one
`LANGFUSE_INIT_PROJECT_*` block is active at a time — the script strips the
previous one and recreates `web`, which is a brief restart of the UI.

### Where the data actually is

| Question | Command |
|---|---|
| Trace rows? | `SELECT count() FROM events_core` — **not** `traces`, see issue 12 |
| Queue backed up? | `valkey-cli -a "$REDIS_AUTH" llen bull:otel-ingestion-queue:wait` |
| Raw events landed? | `mc ls --recursive l/langfuse` inside the `minio` container |
| Disk headroom? | `df -h /` and ClickHouse `system.parts` |

### Reboot behaviour

Every long-running service is `restart: unless-stopped` and Docker is
`systemctl enable`d, so the stack returns on its own after a reboot. Compose's
`depends_on` ordering is **not** replayed on daemon restart — Caddy may briefly
start before web is ready, which is harmless because it resolves upstreams per
request. Verified 2026-08-10: full `docker compose restart` → all services healthy
in ~15 s, canary passing at 3 s.
