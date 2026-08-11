#!/usr/bin/env bash
# Detects credential drift between infra/.env, the running containers, and the
# datastores themselves. Exit 0 = no drift.
#
# Usage: ./scripts/check-credential-drift.sh [compose-file]
#
# ── Why this exists ────────────────────────────────────────────────────────
# Three values are routinely assumed equal and silently are not:
#
#   1. what infra/.env says the password is
#   2. what is baked into a running container (env vars fix at CREATE time,
#      so any container older than the last .env edit holds a stale copy)
#   3. what the datastore will actually accept
#
# Postgres is the dangerous one: `POSTGRES_PASSWORD` is honoured ONLY when the
# image initialises an empty data directory. Redis, MinIO and ClickHouse all
# re-read their credentials on recreate, so regenerating .env against existing
# volumes rotates three of four datastores and leaves Postgres behind. Nothing
# warns. The failure surfaces later, as a P1000 crash loop on the next
# container recreate — with caddy gated on `web: service_healthy`, that takes
# the public ingest path down alongside the UI.
#
# See docs/DEPLOYMENT-PITFALLS.md issue 12.
#
# ── Why the checks look indirect ───────────────────────────────────────────
# Postgres is probed over TCP from a SEPARATE container. Probing from inside
# the postgres container connects over the Unix socket, where pg_hba grants
# trust/peer and the password is never verified — that check passes against a
# password the application cannot use.
#
# Secrets are never printed; values are compared by sha256 fingerprint.
set -euo pipefail

cd "$(dirname "$0")/.."

compose_file="${1:-infra/compose.yaml}"
C=(docker compose -f "$compose_file")
env_file="infra/.env"

[ -f "$env_file" ] || { echo "ERROR: $env_file not found"; exit 1; }

# Parse rather than source: .env holds unquoted space-separated values
# (ADMIN_ALLOWLIST) that break `source`.
getenv() { grep -E "^$1=" "$env_file" | head -1 | cut -d= -f2-; }
fp() { printf '%s' "${1:-}" | sha256sum | cut -c1-12; }

# Password field of a URL of the form scheme://user:PASSWORD@host/...
url_pw() { printf '%s' "${1:-}" | sed -nE 's#^[a-z+]+://[^:]*:([^@]+)@.*#\1#p'; }

container_env() {
  local svc="$1" key="$2" cid
  cid=$("${C[@]}" ps -q "$svc" 2>/dev/null) || return 1
  [ -n "$cid" ] || return 1
  docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -E "^${key}=" | head -1 | cut -d= -f2-
}

rc=0
fail() { echo "  DRIFT: $*"; rc=1; }

echo "== .env vs running containers =="
# Any container created before the last .env edit may hold stale values.
for pair in "web:DATABASE_URL" "worker:DATABASE_URL" \
            "web:REDIS_CONNECTION_STRING" "worker:REDIS_CONNECTION_STRING" \
            "web:CLICKHOUSE_PASSWORD" "worker:CLICKHOUSE_PASSWORD"; do
  svc="${pair%%:*}"; key="${pair##*:}"
  actual=$(container_env "$svc" "$key" 2>/dev/null) || { echo "  $svc/$key: not running — skipped"; continue; }
  expected=$(getenv "$key")
  if [ "$actual" = "$expected" ]; then
    echo "  $svc/$key: match"
  else
    fail "$svc/$key differs from $env_file (container fp $(fp "$actual") vs .env fp $(fp "$expected")) — recreate with: docker compose -f $compose_file up -d --force-recreate $svc"
  fi
done

network=$(docker inspect "$("${C[@]}" ps -q postgres)" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null || true)

echo
echo "== datastores actually accept the .env credentials =="

if [ -n "$network" ]; then
  pg_pw=$(getenv POSTGRES_PASSWORD)
  pg_user=$(getenv POSTGRES_USER)
  pg_db=$(getenv POSTGRES_DB)
  # Deliberately over TCP from a second container — see header.
  if docker run --rm --network "$network" -e PGPASSWORD="$pg_pw" postgres:17-alpine \
       psql -h postgres -U "$pg_user" -d "$pg_db" -tAc 'select 1' >/dev/null 2>&1; then
    echo "  postgres: accepts .env password over TCP"
  else
    fail "postgres REJECTS the password in $env_file. The role kept the password from volume init. Fix (non-destructive, no volume touched):
         docker compose -f $compose_file exec -T postgres \\
           psql -U $pg_user -d $pg_db -v ON_ERROR_STOP=1 \\
           -c \"ALTER USER \\\"$pg_user\\\" WITH PASSWORD '<POSTGRES_PASSWORD from $env_file>';\"
         then recreate web and worker. Never 'docker compose down -v' — it destroys
         all trace history and every project credential."
  fi

  redis_pw=$(getenv REDIS_AUTH)
  if docker run --rm --network "$network" valkey/valkey:8-alpine \
       valkey-cli -h redis -a "$redis_pw" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    echo "  redis: accepts .env password"
  else
    fail "redis REJECTS the password in $env_file"
  fi
else
  echo "  SKIP: postgres container not running, cannot resolve the compose network"
fi

ch_user=$(getenv CLICKHOUSE_USER)
ch_pw=$(getenv CLICKHOUSE_PASSWORD)
if "${C[@]}" exec -T clickhouse clickhouse-client \
     --user "$ch_user" --password "$ch_pw" --query 'select 1' >/dev/null 2>&1; then
  echo "  clickhouse: accepts .env password"
else
  fail "clickhouse REJECTS the password in $env_file"
fi

# Consistency within .env itself: DATABASE_URL and REDIS_CONNECTION_STRING embed
# passwords that must match their standalone variables. generate-secrets.sh keeps
# these in step; a hand edit routinely does not.
echo
echo "== internal consistency of $env_file =="
if [ "$(url_pw "$(getenv DATABASE_URL)")" = "$(getenv POSTGRES_PASSWORD)" ]; then
  echo "  DATABASE_URL matches POSTGRES_PASSWORD"
else
  fail "DATABASE_URL password != POSTGRES_PASSWORD"
fi
if [ "$(url_pw "$(getenv REDIS_CONNECTION_STRING)")" = "$(getenv REDIS_AUTH)" ]; then
  echo "  REDIS_CONNECTION_STRING matches REDIS_AUTH"
else
  fail "REDIS_CONNECTION_STRING password != REDIS_AUTH"
fi

echo
[ $rc -eq 0 ] && echo "PASS: no credential drift" || echo "FAIL: credential drift detected (see above)"
exit $rc
