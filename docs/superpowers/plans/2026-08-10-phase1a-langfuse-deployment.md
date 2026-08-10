# Phase 1A — Self-Hosted Langfuse Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Tier 1 self-hosted Langfuse on a single Hetzner box via Docker Compose, with TLS, a public-ingest/private-UI split, ClickHouse disk protection, headless project provisioning, and a verified end-to-end ingestion canary.

**Architecture:** All six Langfuse components (web, worker, Postgres, ClickHouse, Redis, MinIO blob storage) run as Docker Compose services on one Hetzner dedicated server in the EU. Caddy terminates TLS and enforces the security boundary: `/api/public/otel` and `/api/public/ingestion` are internet-reachable and key-authed; every other route is IP-allowlisted. Configuration is committed as code so the host is reproducible.

**Tech Stack:** Docker Compose · `langfuse/langfuse:3` · `langfuse/langfuse-worker:3` · Postgres 16 · ClickHouse · Valkey/Redis 7 · MinIO · Caddy 2 · Bash

## Global Constraints

- **All infrastructure components must run with timezone UTC.** Non-negotiable — a wrong timezone silently corrupts analytics.
- **ClickHouse `shards` must remain 1.** Langfuse does not support multi-shard clusters.
- **Never use `latest` image tags.** Pin every image to an explicit version.
- **No secrets in Git.** `.env` is gitignored; only `.env.example` with placeholder values is committed.
- **Data residency: EU only.** Hetzner Falkenstein/Nuremberg/Helsinki.
- **Trace retention: 90 days.**
- Langfuse web listens on port **3000**; worker on **3030**.
- Ingestion is **asynchronous** — `POST /api/public/ingestion` returns **207 (queued)**, not stored. Never treat a 207 as proof of durability.

---

## File Structure

| File | Responsibility |
|---|---|
| `infra/compose.yaml` | Six-service Langfuse stack definition |
| `infra/.env.example` | Documented placeholder environment (committed) |
| `infra/.env` | Real secrets (**gitignored**) |
| `infra/clickhouse/config.d/langfuse-ttl.xml` | System-table TTLs + profiler disable |
| `infra/caddy/Caddyfile` | TLS, ingest/UI split, rate limiting |
| `scripts/health-check.sh` | Liveness/readiness probe |
| `scripts/ingestion-canary.sh` | End-to-end write→read-back verification |
| `scripts/provision-project.sh` | Per-project credential provisioning helper |
| `.gitignore` | Secret exclusion |

---

## Task 1: Repository scaffolding and secret hygiene

**Files:**
- Create: `.gitignore`
- Create: `infra/.env.example`
- Create: `scripts/generate-secrets.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `infra/.env` (gitignored, generated) consumed by every later task

- [ ] **Step 1: Write the failing test**

Create `scripts/test-secret-hygiene.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

fail=0

# .env must never be tracked by git
if git ls-files --error-unmatch infra/.env >/dev/null 2>&1; then
  echo "FAIL: infra/.env is tracked by git"
  fail=1
else
  echo "PASS: infra/.env is not tracked"
fi

# .env.example must exist and contain no real-looking secrets
if [ ! -f infra/.env.example ]; then
  echo "FAIL: infra/.env.example missing"
  fail=1
else
  if grep -qE '^(NEXTAUTH_SECRET|SALT|ENCRYPTION_KEY)=.{16,}$' infra/.env.example; then
    echo "FAIL: infra/.env.example contains a real-looking secret"
    fail=1
  else
    echo "PASS: infra/.env.example has no real secrets"
  fi
fi

exit $fail
```

- [ ] **Step 2: Run test to verify it fails**

```bash
chmod +x scripts/test-secret-hygiene.sh && ./scripts/test-secret-hygiene.sh
```

Expected: FAIL with `infra/.env.example missing`

- [ ] **Step 3: Write minimal implementation**

`.gitignore`:

```gitignore
# Secrets — never commit
infra/.env
*.env.local
*.pem
*.key

# Runtime
node_modules/
.DS_Store
backups/
```

`infra/.env.example`:

```bash
# ─── Postgres ───────────────────────────────────────────────────────────────
POSTGRES_USER=langfuse
POSTGRES_PASSWORD=CHANGEME
POSTGRES_DB=langfuse
DATABASE_URL=postgresql://langfuse:CHANGEME@postgres:5432/langfuse

# ─── ClickHouse ─────────────────────────────────────────────────────────────
CLICKHOUSE_USER=clickhouse
CLICKHOUSE_PASSWORD=CHANGEME
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_MIGRATION_URL=clickhouse://clickhouse:9000
CLICKHOUSE_CLUSTER_ENABLED=false

# ─── Redis / Valkey ─────────────────────────────────────────────────────────
REDIS_AUTH=CHANGEME
REDIS_CONNECTION_STRING=redis://default:CHANGEME@redis:6379

# ─── Blob storage (MinIO at Tier 1) ─────────────────────────────────────────
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=CHANGEME
LANGFUSE_S3_EVENT_UPLOAD_BUCKET=langfuse
LANGFUSE_S3_EVENT_UPLOAD_REGION=eu-central-1
LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=minio
LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=CHANGEME
LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://minio:9000
LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true
LANGFUSE_S3_EVENT_UPLOAD_PREFIX=events/

# ─── Langfuse app ───────────────────────────────────────────────────────────
# Generate each with: openssl rand -hex 32
NEXTAUTH_SECRET=CHANGEME
SALT=CHANGEME
ENCRYPTION_KEY=CHANGEME
NEXTAUTH_URL=https://langfuse.example.com

# ─── Headless initialization (Task 6) ───────────────────────────────────────
LANGFUSE_INIT_ORG_ID=org-main
LANGFUSE_INIT_ORG_NAME=Main
LANGFUSE_INIT_USER_EMAIL=platform@example.com
LANGFUSE_INIT_USER_NAME=Platform
LANGFUSE_INIT_USER_PASSWORD=CHANGEME

# ─── Ingest tuning (raise only on observed S3 throttling) ───────────────────
LANGFUSE_S3_CONCURRENT_WRITES=50
```

`scripts/generate-secrets.sh`:

```bash
#!/usr/bin/env bash
# Generates infra/.env from .env.example with real random secrets.
# Refuses to overwrite an existing .env.
set -euo pipefail

target="infra/.env"
[ -f "$target" ] && { echo "ERROR: $target already exists. Refusing to overwrite."; exit 1; }

gen() { openssl rand -hex 32; }

pg_pw=$(gen); ch_pw=$(gen); redis_pw=$(gen); minio_pw=$(gen)
nextauth=$(gen); salt=$(gen); enc=$(gen); init_pw=$(gen)

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pg_pw}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://langfuse:${pg_pw}@postgres:5432/langfuse|" \
  -e "s|^CLICKHOUSE_PASSWORD=.*|CLICKHOUSE_PASSWORD=${ch_pw}|" \
  -e "s|^REDIS_AUTH=.*|REDIS_AUTH=${redis_pw}|" \
  -e "s|^REDIS_CONNECTION_STRING=.*|REDIS_CONNECTION_STRING=redis://default:${redis_pw}@redis:6379|" \
  -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${minio_pw}|" \
  -e "s|^LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=.*|LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=${minio_pw}|" \
  -e "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=${nextauth}|" \
  -e "s|^SALT=.*|SALT=${salt}|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${enc}|" \
  -e "s|^LANGFUSE_INIT_USER_PASSWORD=.*|LANGFUSE_INIT_USER_PASSWORD=${init_pw}|" \
  infra/.env.example > "$target"

chmod 600 "$target"
echo "Generated $target (mode 600). Set NEXTAUTH_URL to your real domain before deploying."
```

- [ ] **Step 4: Run test to verify it passes**

```bash
chmod +x scripts/generate-secrets.sh && ./scripts/test-secret-hygiene.sh
```

Expected: `PASS: infra/.env is not tracked` and `PASS: infra/.env.example has no real secrets`

- [ ] **Step 5: Commit**

```bash
git add .gitignore infra/.env.example scripts/generate-secrets.sh scripts/test-secret-hygiene.sh
git commit -m "feat(infra): scaffold env template and secret generation"
```

---

## Task 2: ClickHouse disk protection

**Files:**
- Create: `infra/clickhouse/config.d/langfuse-ttl.xml`
- Create: `scripts/test-clickhouse-ttl.sh`

**Interfaces:**
- Consumes: nothing
- Produces: config volume mount path `./clickhouse/config.d` used by Task 3

**Why this is Task 2, not Task 12:** on a single Tier 1 box, ClickHouse's own system tables will fill the NVMe at default settings. This must be in place *before* the first byte is ingested — retrofitting means an outage.

- [ ] **Step 1: Write the failing test**

`scripts/test-clickhouse-ttl.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
f="infra/clickhouse/config.d/langfuse-ttl.xml"

[ -f "$f" ] || { echo "FAIL: $f missing"; exit 1; }

fail=0
for needle in "query_profiler_real_time_period_ns" "trace_log" "opentelemetry_span_log" "query_log"; do
  grep -q "$needle" "$f" || { echo "FAIL: $needle not configured"; fail=1; }
done

grep -q "INTERVAL 7 DAY"  "$f" || { echo "FAIL: 7-day TTL missing";  fail=1; }
grep -q "INTERVAL 30 DAY" "$f" || { echo "FAIL: 30-day TTL missing"; fail=1; }

[ $fail -eq 0 ] && echo "PASS: ClickHouse TTL config complete"
exit $fail
```

- [ ] **Step 2: Run test to verify it fails**

```bash
chmod +x scripts/test-clickhouse-ttl.sh && ./scripts/test-clickhouse-ttl.sh
```

Expected: FAIL with `infra/clickhouse/config.d/langfuse-ttl.xml missing`

- [ ] **Step 3: Write minimal implementation**

`infra/clickhouse/config.d/langfuse-ttl.xml`:

```xml
<clickhouse>
    <!-- Disable the query profiler: high overhead, large system-table growth. -->
    <profiles>
        <default>
            <query_profiler_real_time_period_ns>0</query_profiler_real_time_period_ns>
            <query_profiler_cpu_time_period_ns>0</query_profiler_cpu_time_period_ns>
        </default>
    </profiles>

    <!-- Aggressive TTLs on ClickHouse's own system tables.
         Distinct from Langfuse's 90-day TRACE retention: this bounds internal logging,
         a common cause of disk exhaustion on single-node deployments. -->
    <trace_log>
        <engine>ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (event_date, event_time) TTL event_date + INTERVAL 7 DAY</engine>
    </trace_log>
    <opentelemetry_span_log>
        <engine>ENGINE = MergeTree PARTITION BY toYYYYMM(finish_date) ORDER BY (finish_date, finish_time_us) TTL finish_date + INTERVAL 7 DAY</engine>
    </opentelemetry_span_log>
    <query_log>
        <engine>ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (event_date, event_time) TTL event_date + INTERVAL 30 DAY</engine>
    </query_log>
</clickhouse>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
./scripts/test-clickhouse-ttl.sh
```

Expected: `PASS: ClickHouse TTL config complete`

- [ ] **Step 5: Commit**

```bash
git add infra/clickhouse/config.d/langfuse-ttl.xml scripts/test-clickhouse-ttl.sh
git commit -m "feat(infra): add ClickHouse system-table TTLs and disable query profiler"
```

---

## Task 3: Docker Compose stack

**Files:**
- Create: `infra/compose.yaml`
- Create: `scripts/test-compose-config.sh`

**Interfaces:**
- Consumes: `infra/.env` (Task 1), `infra/clickhouse/config.d/` (Task 2)
- Produces: services `web`, `worker`, `postgres`, `clickhouse`, `redis`, `minio` on network `langfuse`; web reachable at `web:3000`

- [ ] **Step 1: Write the failing test**

`scripts/test-compose-config.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd infra

# Compose file must parse and resolve all variables
docker compose config >/dev/null || { echo "FAIL: compose config invalid"; exit 1; }
echo "PASS: compose config parses"

fail=0
rendered=$(docker compose config)

# Every service present
for svc in web worker postgres clickhouse redis minio; do
  echo "$rendered" | grep -qE "^  ${svc}:" || { echo "FAIL: service $svc missing"; fail=1; }
done

# UTC enforced on every service (web, worker, postgres, clickhouse, redis, minio, caddy)
tz_count=$(echo "$rendered" | grep -c "TZ: UTC" || true)
if [ "$tz_count" -lt 6 ]; then
  echo "FAIL: TZ=UTC set on only ${tz_count} services (expected >= 6)"; fail=1
fi

# Postgres must additionally set PGTZ
echo "$rendered" | grep -q "PGTZ: UTC" || { echo "FAIL: PGTZ=UTC not set"; fail=1; }

# No floating tags
if echo "$rendered" | grep -qE "image: .*:latest"; then
  echo "FAIL: a service uses the :latest tag"; fail=1
fi

[ $fail -eq 0 ] && echo "PASS: compose stack valid"
exit $fail
```

- [ ] **Step 2: Run test to verify it fails**

```bash
chmod +x scripts/test-compose-config.sh && ./scripts/test-compose-config.sh
```

Expected: FAIL with `compose config invalid` (no `compose.yaml` yet)

- [ ] **Step 3a: Resolve real image tags before writing the file**

⚠️ **The version tags below are illustrative placeholders, not verified releases.** Pinning is
mandatory (no `:latest`), but pinning to a tag that does not exist fails at pull time. Resolve each
against the registry first and substitute the results:

```bash
# Langfuse web and worker — pick the same version for both
curl -s "https://hub.docker.com/v2/repositories/langfuse/langfuse/tags?page_size=20" \
  | grep -o '"name":"[0-9.]*"' | head -5
curl -s "https://hub.docker.com/v2/repositories/langfuse/langfuse-worker/tags?page_size=20" \
  | grep -o '"name":"[0-9.]*"' | head -5

# ClickHouse, Valkey, MinIO, Caddy
curl -s "https://hub.docker.com/v2/repositories/clickhouse/clickhouse-server/tags?page_size=20" \
  | grep -o '"name":"[0-9.]*-alpine"' | head -5
```

Record the chosen versions in `docs/RUNBOOK-deploy.md` (Task 6) so upgrades are deliberate.

- [ ] **Step 3b: Write minimal implementation**

`infra/compose.yaml` — substituting the tags resolved in Step 3a:

```yaml
name: langfuse

x-langfuse-env: &langfuse-env
  DATABASE_URL: ${DATABASE_URL}
  SALT: ${SALT}
  ENCRYPTION_KEY: ${ENCRYPTION_KEY}
  CLICKHOUSE_URL: ${CLICKHOUSE_URL}
  CLICKHOUSE_USER: ${CLICKHOUSE_USER}
  CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD}
  CLICKHOUSE_MIGRATION_URL: ${CLICKHOUSE_MIGRATION_URL}
  CLICKHOUSE_CLUSTER_ENABLED: ${CLICKHOUSE_CLUSTER_ENABLED}
  REDIS_CONNECTION_STRING: ${REDIS_CONNECTION_STRING}
  LANGFUSE_S3_EVENT_UPLOAD_BUCKET: ${LANGFUSE_S3_EVENT_UPLOAD_BUCKET}
  LANGFUSE_S3_EVENT_UPLOAD_REGION: ${LANGFUSE_S3_EVENT_UPLOAD_REGION}
  LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: ${LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID}
  LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: ${LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY}
  LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: ${LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT}
  LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: ${LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE}
  LANGFUSE_S3_EVENT_UPLOAD_PREFIX: ${LANGFUSE_S3_EVENT_UPLOAD_PREFIX}
  LANGFUSE_S3_CONCURRENT_WRITES: ${LANGFUSE_S3_CONCURRENT_WRITES}
  TZ: UTC

services:
  web:
    image: langfuse/langfuse:3.140.0
    depends_on:
      postgres: { condition: service_healthy }
      clickhouse: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
    environment:
      <<: *langfuse-env
      NEXTAUTH_URL: ${NEXTAUTH_URL}
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      LANGFUSE_INIT_ORG_ID: ${LANGFUSE_INIT_ORG_ID}
      LANGFUSE_INIT_ORG_NAME: ${LANGFUSE_INIT_ORG_NAME}
      LANGFUSE_INIT_USER_EMAIL: ${LANGFUSE_INIT_USER_EMAIL}
      LANGFUSE_INIT_USER_NAME: ${LANGFUSE_INIT_USER_NAME}
      LANGFUSE_INIT_USER_PASSWORD: ${LANGFUSE_INIT_USER_PASSWORD}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/public/ready"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 90s
    restart: unless-stopped
    networks: [langfuse]

  worker:
    image: langfuse/langfuse-worker:3.140.0
    depends_on:
      postgres: { condition: service_healthy }
      clickhouse: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio: { condition: service_healthy }
    environment:
      <<: *langfuse-env
    restart: unless-stopped
    networks: [langfuse]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      TZ: UTC
      PGTZ: UTC
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [langfuse]

  clickhouse:
    image: clickhouse/clickhouse-server:24.12-alpine
    user: "101:101"
    environment:
      CLICKHOUSE_DB: default
      CLICKHOUSE_USER: ${CLICKHOUSE_USER}
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD}
      TZ: UTC
    volumes:
      - ./clickhouse/config.d:/etc/clickhouse-server/config.d:ro
      - clickhouse_data:/var/lib/clickhouse
      - clickhouse_logs:/var/log/clickhouse-server
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8123/ping"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [langfuse]

  redis:
    image: valkey/valkey:8-alpine
    command: ["valkey-server", "--requirepass", "${REDIS_AUTH}", "--maxmemory-policy", "noeviction"]
    environment:
      TZ: UTC
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli -a ${REDIS_AUTH} ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [langfuse]

  minio:
    image: minio/minio:RELEASE.2024-12-18T13-15-44Z
    command: server /data --address ":9000" --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      TZ: UTC
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks: [langfuse]

volumes:
  postgres_data:
  clickhouse_data:
  clickhouse_logs:
  redis_data:
  minio_data:

networks:
  langfuse:
    driver: bridge
```

> **`maxmemory-policy noeviction` is deliberate.** Redis holds the ingestion queue; evicting keys
> would silently discard queued events. Alert on memory pressure instead of evicting.

> **No `ports:` mappings.** Nothing binds to the host directly — Caddy (Task 4) is the only ingress.
> This is what keeps Postgres, ClickHouse, and Redis off the public internet.

- [ ] **Step 4: Run test to verify it passes**

```bash
cp infra/.env.example infra/.env   # placeholder values are fine for config validation
./scripts/test-compose-config.sh
```

Expected: `PASS: compose config parses` and `PASS: compose stack valid`

- [ ] **Step 5: Commit**

```bash
git add infra/compose.yaml scripts/test-compose-config.sh
git commit -m "feat(infra): add Langfuse Docker Compose stack"
```

---

## Task 4: Caddy — TLS and the ingest/UI security split

**Files:**
- Create: `infra/caddy/Caddyfile`
- Modify: `infra/compose.yaml` (add `caddy` service)
- Create: `scripts/test-caddy-split.sh`

**Interfaces:**
- Consumes: service `web:3000` (Task 3)
- Produces: public HTTPS ingest at `/api/public/otel` and `/api/public/ingestion`; all other routes IP-restricted

**Why the split:** Vercel serverless functions have **no static egress IPs** outside Enterprise Secure Compute, so ingest cannot be IP-allowlisted — it must be public and key-authed. The admin surface has no such constraint and must not inherit that exposure.

- [ ] **Step 1: Write the failing test**

`scripts/test-caddy-split.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
f="infra/caddy/Caddyfile"
[ -f "$f" ] || { echo "FAIL: $f missing"; exit 1; }

fail=0
grep -q "/api/public/otel"      "$f" || { echo "FAIL: OTLP route missing";       fail=1; }
grep -q "/api/public/ingestion" "$f" || { echo "FAIL: ingestion route missing";  fail=1; }
grep -q "remote_ip"             "$f" || { echo "FAIL: IP allowlist missing";     fail=1; }
grep -q "rate_limit\|request_body" "$f" || { echo "FAIL: no rate/size limiting"; fail=1; }

docker run --rm -v "$(pwd)/infra/caddy:/etc/caddy:ro" caddy:2.8-alpine \
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || { echo "FAIL: Caddyfile does not validate"; fail=1; }

[ $fail -eq 0 ] && echo "PASS: Caddy ingest/UI split configured"
exit $fail
```

- [ ] **Step 2: Run test to verify it fails**

```bash
chmod +x scripts/test-caddy-split.sh && ./scripts/test-caddy-split.sh
```

Expected: FAIL with `infra/caddy/Caddyfile missing`

- [ ] **Step 3: Write minimal implementation**

`infra/caddy/Caddyfile`:

```caddyfile
{
	email {$ACME_EMAIL}
	servers {
		trusted_proxies static private_ranges
	}
}

{$LANGFUSE_DOMAIN} {
	encode gzip

	# ── PUBLIC: telemetry ingest ────────────────────────────────────────────
	# Must be internet-reachable: Vercel has no static egress IPs outside
	# Enterprise Secure Compute. Protected by TLS + per-project API keys.
	@ingest path /api/public/otel* /api/public/ingestion*
	handle @ingest {
		request_body {
			max_size 10MB
		}
		reverse_proxy web:3000
	}

	# ── PUBLIC: health, for external monitoring ─────────────────────────────
	@health path /api/public/health /api/public/ready
	handle @health {
		reverse_proxy web:3000
	}

	# ── RESTRICTED: UI, admin, and everything else ──────────────────────────
	@trusted {
		remote_ip {$ADMIN_ALLOWLIST}
	}
	handle @trusted {
		reverse_proxy web:3000
	}

	# Anything else from an untrusted source
	handle {
		respond "Not authorized" 403
	}
}
```

Add to `infra/compose.yaml` under `services:`:

```yaml
  caddy:
    image: caddy:2.8-alpine
    depends_on:
      web: { condition: service_healthy }
    environment:
      LANGFUSE_DOMAIN: ${LANGFUSE_DOMAIN}
      ACME_EMAIL: ${ACME_EMAIL}
      ADMIN_ALLOWLIST: ${ADMIN_ALLOWLIST}
      TZ: UTC
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped
    networks: [langfuse]
```

Add to the `volumes:` block: `caddy_data:` and `caddy_config:`

Append to `infra/.env.example`:

```bash
# ─── Ingress ────────────────────────────────────────────────────────────────
LANGFUSE_DOMAIN=langfuse.example.com
ACME_EMAIL=platform@example.com
# Space-separated CIDRs permitted to reach the UI/admin surface
ADMIN_ALLOWLIST=10.0.0.0/8 192.168.0.0/16
```

> **Rate limiting note:** Caddy's `rate_limit` directive requires a plugin build. Until that is
> added, `request_body max_size` bounds payloads and abuse protection relies on per-project key
> revocation. Adding the rate-limit plugin is tracked in Stage 1C.

- [ ] **Step 4: Run test to verify it passes**

```bash
./scripts/test-caddy-split.sh
```

Expected: `PASS: Caddy ingest/UI split configured`

- [ ] **Step 5: Commit**

```bash
git add infra/caddy/Caddyfile infra/compose.yaml infra/.env.example scripts/test-caddy-split.sh
git commit -m "feat(infra): add Caddy TLS with public-ingest/private-UI split"
```

---

## Task 5: Health check and ingestion canary

**Files:**
- Create: `scripts/health-check.sh`
- Create: `scripts/ingestion-canary.sh`

**Interfaces:**
- Consumes: running stack (Tasks 3–4)
- Produces: `health-check.sh` and `ingestion-canary.sh`, both exit 0 on success — consumed by Stage 1C monitoring and by post-deploy verification

**Why the canary matters more than the health check:** `POST /api/public/ingestion` returns **207 (queued)**, and `/api/public/health` can return 200 while the worker is completely backlogged. Only a write followed by a read-back proves ingest → queue → worker → ClickHouse → query actually works.

- [ ] **Step 1: Write the failing test**

The scripts *are* the tests. Write the invocation contract first — `scripts/test-canary-contract.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
fail=0
for s in scripts/health-check.sh scripts/ingestion-canary.sh; do
  [ -x "$s" ] || { echo "FAIL: $s missing or not executable"; fail=1; continue; }
  bash -n "$s" || { echo "FAIL: $s has a syntax error"; fail=1; }
done
grep -q "failIfDatabaseUnavailable" scripts/health-check.sh \
  || { echo "FAIL: health-check must use the deep DB check"; fail=1; }
grep -q "api/public/traces" scripts/ingestion-canary.sh \
  || { echo "FAIL: canary must read the trace back"; fail=1; }
[ $fail -eq 0 ] && echo "PASS: probe contract satisfied"
exit $fail
```

- [ ] **Step 2: Run test to verify it fails**

```bash
chmod +x scripts/test-canary-contract.sh && ./scripts/test-canary-contract.sh
```

Expected: FAIL with `scripts/health-check.sh missing or not executable`

- [ ] **Step 3: Write minimal implementation**

`scripts/health-check.sh`:

```bash
#!/usr/bin/env bash
# Liveness + readiness probe. Exit 0 = healthy.
# Usage: ./scripts/health-check.sh https://langfuse.example.com
set -euo pipefail

base="${1:?usage: health-check.sh <base-url>}"

health_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  "${base}/api/public/health?failIfDatabaseUnavailable=true")
ready_code=$(curl -sS -o /dev/null -w '%{http_code}' "${base}/api/public/ready")

echo "health=${health_code} ready=${ready_code}"

[ "$health_code" = "200" ] || { echo "FAIL: health check returned ${health_code}"; exit 1; }
[ "$ready_code"  = "200" ] || { echo "FAIL: readiness returned ${ready_code}"; exit 1; }

echo "PASS: platform healthy"
```

`scripts/ingestion-canary.sh`:

```bash
#!/usr/bin/env bash
# End-to-end ingestion verification: write a trace, then read it back.
# Requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in the environment.
# Usage: ./scripts/ingestion-canary.sh https://langfuse.example.com [timeout_seconds]
set -euo pipefail

base="${1:?usage: ingestion-canary.sh <base-url> [timeout]}"
timeout="${2:-60}"
: "${LANGFUSE_PUBLIC_KEY:?LANGFUSE_PUBLIC_KEY not set}"
: "${LANGFUSE_SECRET_KEY:?LANGFUSE_SECRET_KEY not set}"

auth=$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 -w0)
trace_id="canary-$(date -u +%s)-$RANDOM"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# 1. Write. Expect 207 — queued, NOT stored.
code=$(curl -sS -o /tmp/canary-write.json -w '%{http_code}' \
  -X POST "${base}/api/public/ingestion" \
  -H "Authorization: Basic ${auth}" \
  -H "Content-Type: application/json" \
  -d "{\"batch\":[{\"id\":\"${trace_id}-evt\",\"type\":\"trace-create\",\"timestamp\":\"${now}\",\"body\":{\"id\":\"${trace_id}\",\"name\":\"ingestion-canary\",\"timestamp\":\"${now}\"}}]}")

[ "$code" = "207" ] || { echo "FAIL: ingestion returned ${code} (expected 207)"; cat /tmp/canary-write.json; exit 1; }
echo "queued trace ${trace_id} (207)"

# 2. Read back. This is the part that actually proves the pipeline works.
deadline=$(( $(date -u +%s) + timeout ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  read_code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: Basic ${auth}" \
    "${base}/api/public/traces/${trace_id}")
  if [ "$read_code" = "200" ]; then
    lag=$(( timeout - (deadline - $(date -u +%s)) ))
    echo "PASS: trace readable after ~${lag}s"
    exit 0
  fi
  sleep 3
done

echo "FAIL: trace ${trace_id} not readable within ${timeout}s — ingestion pipeline is backlogged or broken"
exit 1
```

- [ ] **Step 4: Run test to verify it passes**

```bash
chmod +x scripts/health-check.sh scripts/ingestion-canary.sh
./scripts/test-canary-contract.sh
```

Expected: `PASS: probe contract satisfied`

- [ ] **Step 5: Commit**

```bash
git add scripts/health-check.sh scripts/ingestion-canary.sh scripts/test-canary-contract.sh
git commit -m "feat(ops): add health check and end-to-end ingestion canary"
```

---

## Task 6: Bring the stack up and verify end-to-end

**Files:**
- Modify: `infra/.env` (real values — not committed)
- Create: `docs/RUNBOOK-deploy.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: a running platform; org + admin user provisioned headlessly

- [ ] **Step 1: Generate real secrets and set the domain**

```bash
rm -f infra/.env
./scripts/generate-secrets.sh
# Then edit infra/.env: set NEXTAUTH_URL, LANGFUSE_DOMAIN, ACME_EMAIL, ADMIN_ALLOWLIST
```

- [ ] **Step 2: Start the stack**

```bash
cd infra && docker compose up -d
docker compose ps
```

Expected: all seven services `running`; `web` reaches `healthy` within ~90s.

- [ ] **Step 3: Verify UTC and TTLs actually applied**

```bash
docker compose exec clickhouse clickhouse-client --query "SELECT timezone()"
docker compose exec postgres psql -U langfuse -d langfuse -tAc "SHOW TIMEZONE"
docker compose exec clickhouse clickhouse-client --query \
  "SELECT name, engine_full FROM system.tables WHERE name IN ('trace_log','query_log') AND database='system'"
```

Expected: `UTC` from both databases; `TTL` present in the `engine_full` output.

> If the system tables were created before the config mount took effect, drop them and restart —
> ClickHouse recreates them with the configured engine.

- [ ] **Step 4: Verify health and the ingestion canary**

```bash
./scripts/health-check.sh https://<your-domain>
# Create a project + API keys in the UI (from an allowlisted IP), then:
export LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-...
./scripts/ingestion-canary.sh https://<your-domain>
```

Expected: `PASS: platform healthy` and `PASS: trace readable after ~Ns`

- [ ] **Step 5: Verify the security split holds**

```bash
# From a NON-allowlisted host:
curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/            # expect 403
curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/api/public/health  # expect 200

# Confirm data services are not exposed:
nmap -Pn -p 5432,8123,9000,6379 <your-server-ip>
```

Expected: `403` for the UI, `200` for health, and **all four data ports closed**.

- [ ] **Step 6: Document and commit**

Create `docs/RUNBOOK-deploy.md` recording: server spec, domain, allowlist CIDRs, the exact bring-up
sequence above, and the rebuild-from-scratch procedure.

```bash
git add docs/RUNBOOK-deploy.md
git commit -m "docs: add deployment runbook"
```

---

## Task 7: Per-project credential provisioning

**Files:**
- Create: `scripts/provision-project.sh`
- Create: `docs/RUNBOOK-onboarding.md`

**Interfaces:**
- Consumes: running platform (Task 6)
- Produces: `provision-project.sh <project-slug>` emitting a `pk-lf-…`/`sk-lf-…` pair for one project

**Constraint:** never a shared org-wide key. One key pair per agent project so a leak is revocable in isolation and ingestion is attributable per project.

- [ ] **Step 1: Write the failing test**

`scripts/test-provisioning.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
s="scripts/provision-project.sh"
[ -x "$s" ] || { echo "FAIL: $s missing or not executable"; exit 1; }
bash -n "$s" || { echo "FAIL: syntax error in $s"; exit 1; }
grep -q "LANGFUSE_INIT_PROJECT_RETENTION" "$s" \
  || { echo "FAIL: retention must be set at provisioning time"; exit 1; }
echo "PASS: provisioning script contract satisfied"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
chmod +x scripts/test-provisioning.sh && ./scripts/test-provisioning.sh
```

Expected: FAIL with `scripts/provision-project.sh missing or not executable`

- [ ] **Step 3: Write minimal implementation**

`scripts/provision-project.sh`:

```bash
#!/usr/bin/env bash
# Provision one Langfuse project with its own API key pair, via headless initialization.
#
# Headless init creates resources at web-container startup if they do not exist.
# It provisions ONE org/project per startup, so this script runs the initializer
# once per project and then restarts the web service.
#
# Usage: ./scripts/provision-project.sh <project-slug>
set -euo pipefail

slug="${1:?usage: provision-project.sh <project-slug>}"
cd "$(dirname "$0")/../infra"

pk="pk-lf-$(openssl rand -hex 16)"
sk="sk-lf-$(openssl rand -hex 16)"

cat >> .env <<EOF

# ─── project: ${slug} (provisioned $(date -u +%F)) ───
LANGFUSE_INIT_PROJECT_ID=${slug}
LANGFUSE_INIT_PROJECT_NAME=${slug}
LANGFUSE_INIT_PROJECT_RETENTION=90
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=${pk}
LANGFUSE_INIT_PROJECT_SECRET_KEY=${sk}
EOF

docker compose up -d --force-recreate web
docker compose exec -T web sh -c 'until wget -qO- http://localhost:3000/api/public/ready >/dev/null 2>&1; do sleep 2; done'

cat <<EOF

Project '${slug}' provisioned with 90-day retention.

  LANGFUSE_PUBLIC_KEY=${pk}
  LANGFUSE_SECRET_KEY=${sk}

Store these in the Vercel project's environment variables (per environment).
They are also in infra/.env — rotate by re-running with new keys.
EOF
```

- [ ] **Step 4: Run test to verify it passes**

```bash
chmod +x scripts/provision-project.sh && ./scripts/test-provisioning.sh
```

Expected: `PASS: provisioning script contract satisfied`

Then provision the pilot project for Stage 1B:

```bash
./scripts/provision-project.sh pilot-agent
```

Expected: a key pair printed, and the project visible in the Langfuse UI.

- [ ] **Step 5: Commit**

Create `docs/RUNBOOK-onboarding.md` documenting: run `provision-project.sh`, copy keys into Vercel
env vars per environment, install `@org/agent-telemetry`, add `agent/instrumentation.ts`.

```bash
git add scripts/provision-project.sh scripts/test-provisioning.sh docs/RUNBOOK-onboarding.md
git commit -m "feat(ops): add per-project credential provisioning"
```

---

## Exit criteria for Stage 1A

- [ ] `GET /api/public/health?failIfDatabaseUnavailable=true` → 200
- [ ] `GET /api/public/ready` → 200; 500 after SIGTERM
- [ ] Ingestion canary passes: write → read-back
- [ ] UI returns 403 from non-allowlisted IPs; ingest and health return 200 publicly
- [ ] Postgres, ClickHouse, Redis, MinIO ports closed from outside
- [ ] ClickHouse and Postgres both report `UTC`
- [ ] ClickHouse system-table TTLs verified in `system.tables`
- [ ] Pilot project provisioned with its own key pair and 90-day retention
- [ ] `docs/RUNBOOK-deploy.md` and `docs/RUNBOOK-onboarding.md` written
- [ ] No secrets tracked in Git

**Then proceed to** [`2026-08-10-phase1b-agent-telemetry.md`](2026-08-10-phase1b-agent-telemetry.md).

---

## Known gaps carried into Stage 1C

Recorded explicitly so they are not mistaken for oversights:

| Gap | Why deferred |
|---|---|
| Caddy rate limiting | Requires a plugin build; key revocation covers the immediate risk |
| Automated backups | Automation priority 3 — after monitoring exists |
| Restore testing | Automation priority 4 |
| External off-host monitoring | Automation priority 1 — the canary script here is its building block |
| Alert routing | Needs measured baselines from Stage 1D |
| SSO | Single admin user at Tier 1; revisit as the team grows |
