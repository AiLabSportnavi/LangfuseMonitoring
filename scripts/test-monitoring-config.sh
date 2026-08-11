#!/usr/bin/env bash
# Static validation of the monitoring stack. Runs without a server.
#
# Usage:
#   ./scripts/test-monitoring-config.sh              # config checks only
#   ./scripts/test-monitoring-config.sh --pull-check # also verify image tags exist
#
# Companion to test-compose-config.sh, which validates the platform itself.
# Everything here is checkable offline; the things that need a running stack
# live in verify-metric-sources.sh.
set -euo pipefail

cd "$(dirname "$0")/../infra"

pull_check=0
[ "${1:-}" = "--pull-check" ] && pull_check=1

fail=0

# Git Bash on Windows rewrites POSIX-looking paths inside `docker run -v`
# arguments, turning /c.yml into C:/Program Files/Git/c.yml. `pwd -W` emits the
# native path and MSYS_NO_PATHCONV=1 stops the rewrite at the call site.
# DEPLOYMENT-PITFALLS.md #7 is the same family of Windows-toolchain surprise.
host_path() { printf '%s/%s' "$(pwd -W 2>/dev/null || pwd)" "$1"; }

# ── Compose parses and resolves every variable ────────────────────────────
if ! docker compose -f compose.yaml -f compose.monitoring.yaml config >/dev/null 2>&1; then
  echo "FAIL: merged monitoring compose config is invalid"
  docker compose -f compose.yaml -f compose.monitoring.yaml config 2>&1 | sed 's/^/    /' | head -20
  exit 1
fi
echo "PASS: monitoring compose config parses"

rendered=$(docker compose -f compose.yaml -f compose.monitoring.yaml config)

# ── Every monitoring service is present ───────────────────────────────────
for svc in prometheus grafana node-exporter cadvisor postgres-exporter redis-exporter blackbox-exporter; do
  echo "$rendered" | grep -qE "^  ${svc}:" || { echo "FAIL: service $svc missing"; fail=1; }
done

# ── THE SECURITY INVARIANT ────────────────────────────────────────────────
# Caddy is the only ingress (CLAUDE.md §12.1). A published port on Prometheus
# would expose an unauthenticated query API over every metric on the box; on
# cAdvisor it would expose the container topology. This is the check that
# matters most in this file.
published=$(echo "$rendered" | awk '
  /^  [a-z]/ { svc=$1; sub(":","",svc) }
  /published:/ { print svc }
' | sort -u | grep -v '^caddy$' || true)
if [ -n "$published" ]; then
  echo "FAIL: these services publish host ports and must not: $published"; fail=1
else
  echo "PASS: only caddy publishes host ports"
fi

# ── Pinned images only ────────────────────────────────────────────────────
if echo "$rendered" | grep -qE "image: .*:latest"; then
  echo "FAIL: a service uses the :latest tag"; fail=1
fi
if echo "$rendered" | grep -qE "image: [^:]+$"; then
  echo "FAIL: a service has an untagged image"; fail=1
fi

# ── UTC everywhere ────────────────────────────────────────────────────────
# A wrong timezone corrupts analytics silently — the same reason compose.yaml
# sets it on every service. Grafana rendering in local time while Prometheus
# stores UTC makes every dashboard quietly wrong by an hour.
for svc in prometheus grafana node-exporter cadvisor postgres-exporter redis-exporter blackbox-exporter; do
  block=$(echo "$rendered" | awk -v s="  ${svc}:" '$0==s{f=1;next} /^  [a-z]/{f=0} f')
  echo "$block" | grep -q "TZ: UTC" || { echo "FAIL: $svc does not set TZ=UTC"; fail=1; }
done

# ── ClickHouse Prometheus config is mounted as a FILE ─────────────────────
# DEPLOYMENT-PITFALLS.md #2: mounting config.d as a DIRECTORY hides the image's
# own docker_related_config.xml, ClickHouse binds localhost only, and every
# migration fails while the healthcheck still passes.
# Path separator is [\\/] because `docker compose config` renders absolute host
# paths, and on Windows those come back with backslashes.
if echo "$rendered" | grep -qE "config\.d[\\/]prometheus\.xml"; then
  echo "PASS: clickhouse prometheus config mounted as a file"
else
  echo "FAIL: clickhouse/config.d/prometheus.xml is not mounted"; fail=1
fi
if echo "$rendered" | grep -qE "source: .*config\.d[\"']?$"; then
  echo "FAIL: clickhouse config.d is mounted as a DIRECTORY — see pitfall #2"; fail=1
fi

# ── Caddy metrics wiring ──────────────────────────────────────────────────
# The `metrics` directive is silently inert without the global option, and the
# scrape would return 404 with no other symptom.
grep -qE '^\s*metrics\s*\{' caddy/Caddyfile \
  || { echo "FAIL: Caddyfile has no 'metrics' global option — the directive is inert without it"; fail=1; }
grep -q '^:2020 {' caddy/Caddyfile \
  || { echo "FAIL: Caddyfile has no :2020 metrics listener"; fail=1; }
# Caddy's admin API can reconfigure the running server. It must stay on
# localhost; scraping it instead of :2020 would mean exposing it.
if grep -qE '^\s*admin\s+0\.0\.0\.0' caddy/Caddyfile; then
  echo "FAIL: Caddy admin API is bound to 0.0.0.0 — it can reconfigure the proxy"; fail=1
fi

# ── Grafana is behind the allowlist ───────────────────────────────────────
# The whole point of the separate site block. If this regressed, an admin
# surface with a query API over every metric would be public.
if grep -q 'GRAFANA_DOMAIN' caddy/Caddyfile; then
  grafana_block=$(awk '/GRAFANA_DOMAIN/{f=1} f' caddy/Caddyfile)
  echo "$grafana_block" | grep -q 'remote_ip {\$ADMIN_ALLOWLIST}' \
    || { echo "FAIL: the Grafana site block does not gate on ADMIN_ALLOWLIST"; fail=1; }
  echo "$grafana_block" | grep -q 'respond "Not authorized" 403' \
    || { echo "FAIL: the Grafana site block has no deny-by-default handler"; fail=1; }
  echo "PASS: grafana site block is allowlist-gated with a default deny"
else
  echo "FAIL: no Grafana site block in the Caddyfile"; fail=1
fi

# ── Prometheus config ─────────────────────────────────────────────────────
# promtool if available (it ships in the image), otherwise a python parse.
if docker image inspect prom/prometheus:v3.13.2 >/dev/null 2>&1; then
  if MSYS_NO_PATHCONV=1 docker run --rm -v "$(host_path prometheus/prometheus.yml):/c.yml:ro" \
      --entrypoint promtool prom/prometheus:v3.13.2 check config /c.yml >/dev/null 2>&1; then
    echo "PASS: prometheus.yml validates (promtool)"
  else
    echo "FAIL: promtool rejected prometheus.yml"
    MSYS_NO_PATHCONV=1 docker run --rm -v "$(host_path prometheus/prometheus.yml):/c.yml:ro" \
      --entrypoint promtool prom/prometheus:v3.13.2 check config /c.yml 2>&1 | sed 's/^/    /'
    fail=1
  fi
else
  echo "SKIP: promtool (image not pulled) — run --pull-check or pull it first"
fi

# ── No folded-scalar regexes ──────────────────────────────────────────────
# A YAML folded scalar (`>-`) joins lines with SPACES. Prometheus fully anchors
# relabel regexes, so a folded one matches nothing, drops every series, and
# leaves blank panels rather than an error. Cheap to check, expensive to debug.
if grep -qE '^\s+regex: >' prometheus/prometheus.yml; then
  echo "FAIL: prometheus.yml uses a folded scalar for a regex — it will match nothing"; fail=1
else
  echo "PASS: no folded-scalar regexes"
fi

# ── Alerting really is absent ─────────────────────────────────────────────
# Deferred by explicit decision until a baseline exists. If rules appear here
# without that conversation, this catches it.
if grep -qE '^\s*rule_files:\s*\[\]' prometheus/prometheus.yml; then
  echo "PASS: alerting rules deferred, as intended"
else
  echo "WARN: rule_files is no longer empty — alerting was deferred until a baseline exists"
fi

# ── Dashboards ────────────────────────────────────────────────────────────
dash_count=0
for f in grafana/dashboards/*.json; do
  [ -e "$f" ] || continue
  dash_count=$((dash_count + 1))
  python -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null \
    || { echo "FAIL: $f is not valid JSON"; fail=1; continue; }
  # A dashboard whose datasource uid does not match the provisioned datasource
  # loads fine and shows "datasource not found" on every panel.
  grep -q 'langfuse-prometheus' "$f" \
    || { echo "FAIL: $f does not reference the provisioned datasource uid"; fail=1; }
done
if [ "$dash_count" -eq 0 ]; then
  echo "FAIL: no dashboards found"; fail=1
else
  echo "PASS: ${dash_count} dashboards parse and reference the right datasource"
fi

# Provisioned uid must match what the dashboards ask for.
grep -q 'uid: langfuse-prometheus' grafana/provisioning/datasources/prometheus.yml \
  || { echo "FAIL: datasource uid mismatch with dashboards"; fail=1; }

# ── Image tags exist in their registries ──────────────────────────────────
# DEPLOYMENT-PITFALLS.md #8: a tag copied out of a plan did not exist, and the
# deploy failed on `manifest unknown`. Opt-in because it needs network.
if [ $pull_check -eq 1 ]; then
  echo
  echo "Verifying image tags against registries..."
  images=$(echo "$rendered" | grep -oE 'image: [^ ]+' | awk '{print $2}' | sort -u)
  for img in $images; do
    # The locally-built Caddy image has no registry to check against.
    case "$img" in langfuse-caddy:*) echo "SKIP: $img (built locally)"; continue;; esac
    if docker manifest inspect "$img" >/dev/null 2>&1; then
      echo "PASS: $img"
    else
      echo "FAIL: $img not found in its registry"; fail=1
    fi
  done
fi

echo
[ $fail -eq 0 ] && echo "PASS: monitoring configuration valid"
exit $fail
