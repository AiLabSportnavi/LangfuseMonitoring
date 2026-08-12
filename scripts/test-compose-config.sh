#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../infra"

# Compose file must parse and resolve every variable reference.
docker compose config >/dev/null || { echo "FAIL: compose config invalid"; exit 1; }
echo "PASS: compose config parses"

fail=0
rendered=$(docker compose config)

# Every service present.
for svc in web worker postgres clickhouse redis minio; do
  echo "$rendered" | grep -qE "^  ${svc}:" || { echo "FAIL: service $svc missing"; fail=1; }
done

# UTC on every service. A wrong timezone corrupts analytics silently.
tz_count=$(echo "$rendered" | grep -c "TZ: UTC" || true)
if [ "$tz_count" -lt 6 ]; then
  echo "FAIL: TZ=UTC set on only ${tz_count} services (expected >= 6)"; fail=1
fi

# Postgres must additionally set PGTZ.
echo "$rendered" | grep -q "PGTZ: UTC" || { echo "FAIL: PGTZ=UTC not set"; fail=1; }

# No floating tags — an unpinned image makes deployments irreproducible.
if echo "$rendered" | grep -qE "image: .*:latest"; then
  echo "FAIL: a service uses the :latest tag"; fail=1
fi
if echo "$rendered" | grep -qE "image: [^:]+$"; then
  echo "FAIL: a service has an untagged image"; fail=1
fi

# Langfuse v4 requires both buckets.
for v in LANGFUSE_S3_EVENT_UPLOAD_BUCKET LANGFUSE_S3_MEDIA_UPLOAD_BUCKET; do
  echo "$rendered" | grep -q "$v" || { echo "FAIL: $v not passed to services"; fail=1; }
done

# ClickHouse must stay single-shard: Langfuse does not support multi-shard clusters.
echo "$rendered" | grep -q "CLICKHOUSE_CLUSTER_ENABLED: \"false\"" \
  || echo "$rendered" | grep -q "CLICKHOUSE_CLUSTER_ENABLED: false" \
  || { echo "FAIL: CLICKHOUSE_CLUSTER_ENABLED must be false on a single node"; fail=1; }

# Only Caddy may publish host ports. This is what keeps Postgres, ClickHouse,
# Redis and MinIO off the public internet.
published=$(echo "$rendered" | awk '
  /^  [a-z]/ { svc=$1; sub(":","",svc) }
  /published:/ { print svc }
' | sort -u | grep -v '^caddy$' || true)
if [ -n "$published" ]; then
  echo "FAIL: these services publish host ports and must not: $published"; fail=1
fi

# ── Audit F-02: the org-creation boundary must be wired through ─────────────
# Presence in the rendered config only. The VALUE lives in infra/.env and is
# deployment-specific, and an empty value is the dangerous case — Langfuse reads
# unset as "any authenticated user may create an organisation", which is not the
# same as nobody.
#
# ⚠️ This asserts the variable is PLUMBED, not that it is populated on the
# server. Whether the running container actually holds a non-empty value is
# scripts/check-config-drift.sh's job, and only that one can answer it.
echo "$rendered" | grep -q "LANGFUSE_ALLOWED_ORGANIZATION_CREATORS" \
  || { echo "FAIL: LANGFUSE_ALLOWED_ORGANIZATION_CREATORS is not passed to web (F-02)"; fail=1; }

# ── Audit E8/F-09: container hardening must not silently regress ────────────
echo "$rendered" | grep -q "no-new-privileges:true" \
  || { echo "FAIL: no service sets no-new-privileges"; fail=1; }
echo "$rendered" | grep -q "memory:" \
  || { echo "FAIL: no resource limits — a runaway container can starve ClickHouse"; fail=1; }

# Valkey holds the ingestion queue under noeviction. A container memory limit
# WITHOUT a lower --maxmemory means the kernel OOM-kills it and the entire queue
# is lost silently, instead of Valkey refusing writes loudly. The two must
# always ship together.
if echo "$rendered" | grep -q "maxmemory-policy"; then
  echo "$rendered" | grep -q -- "--maxmemory$" || echo "$rendered" | grep -q -- "- --maxmemory" \
    || { echo "FAIL: Valkey has a memory policy but no --maxmemory ceiling"; fail=1; }
fi

[ $fail -eq 0 ] && echo "PASS: compose stack valid"
exit $fail
