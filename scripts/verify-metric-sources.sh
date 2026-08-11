#!/usr/bin/env bash
# Assert that every metric the dashboards depend on is actually being exported.
#
# Usage: ./scripts/verify-metric-sources.sh
#
# WHY THIS SCRIPT EXISTS
#
# CLAUDE.md §7.6 requires that instrumentation be audited by fetching the real
# data back, not by checking that the code compiles. This is that rule applied
# to metrics.
#
# Metric NAMES are the silent failure mode of a monitoring stack. A renamed
# ClickHouse async metric, a changed exporter label, a key pattern that matches
# nothing — none of these produce an error. They produce an EMPTY PANEL, and an
# empty panel reads as "healthy". This script turns every one of those into a
# loud failure, in one command.
#
# Run it: after standing the stack up, after any image version bump, and after
# changing prometheus.yml.
set -euo pipefail

cd "$(dirname "$0")/../infra"

compose() { docker compose -f compose.yaml -f compose.monitoring.yaml "$@"; }

fail=0
checked=0

# Curl from inside the Prometheus container: these endpoints are deliberately
# unreachable from the host (no published ports), and reaching them the same way
# Prometheus does is also what proves Prometheus CAN reach them.
# Docker Engine 29 writes `search .` with `options ndots:0` into the
# container's resolv.conf. busybox's resolver — which is what wget in the
# Prometheus image uses — mishandles that combination and fails every bare
# service name with "bad address", while Prometheus's own Go resolver
# resolves them fine. The symptom is this script reporting FAIL for every
# endpoint while `up` is 1 for all of them in Prometheus. Appending a
# trailing dot makes the name fully qualified and skips the search list.
# Hosts that already contain a dot (FQDNs, literal IPs) and localhost are
# left alone.
qualify() {
  local url="$1" scheme rest hostport host port path
  scheme="${url%%://*}"
  rest="${url#*://}"
  hostport="${rest%%/*}"
  path="${rest#"$hostport"}"
  host="${hostport%%:*}"
  port="${hostport#"$host"}"
  case "$host" in
    localhost|*.*) ;;
    *) host="${host}." ;;
  esac
  printf '%s://%s%s%s' "$scheme" "$host" "$port" "$path"
}

fetch() {
  compose exec -T prometheus wget -qO- --timeout=10 "$(qualify "$1")" 2>/dev/null || true
}

# assert_metric <label> <url> <metric-name>...
assert_metric() {
  local label="$1" url="$2"; shift 2
  local body missing=""

  body=$(fetch "$url")
  if [ -z "$body" ]; then
    echo "FAIL: ${label} — endpoint returned nothing (${url})"
    fail=1
    return
  fi

  for m in "$@"; do
    checked=$((checked + 1))
    # Anchored at line start so a metric name that is merely a SUBSTRING of
    # another does not count as present.
    # Herestring, NOT `printf ... | grep -q`. grep -q exits on its first
    # match and closes the pipe; printf then dies with SIGPIPE (141), and
    # `set -o pipefail` reports the whole pipeline as FAILED even though
    # the metric was found. Every early match in a body bigger than the
    # 64K pipe buffer therefore read as "missing": node, cadvisor,
    # clickhouse, postgres and caddy all failed, while redis (its match
    # sits near the end of the body) and blackbox (11K, fits the buffer)
    # passed. A herestring has no pipeline, so pipefail cannot fire.
    if ! grep -qE "^${m}[ {]" <<< "$body"; then
      missing="${missing} ${m}"
    fi
  done

  if [ -n "$missing" ]; then
    echo "FAIL: ${label} — missing:${missing}"
    fail=1
  else
    echo "PASS: ${label}"
  fi
}

echo "Verifying metric sources against the live stack..."
echo

# ── Host ──────────────────────────────────────────────────────────────────
assert_metric "node-exporter" "http://node-exporter:9100/metrics" \
  node_cpu_seconds_total \
  node_memory_MemAvailable_bytes \
  node_memory_MemTotal_bytes \
  node_filesystem_avail_bytes \
  node_filesystem_size_bytes \
  node_disk_io_time_seconds_total \
  node_load1

# ── Containers ────────────────────────────────────────────────────────────
# If these are missing, cAdvisor is running but the metric_relabel_configs keep
# list in prometheus.yml has drifted from what cAdvisor actually emits.
assert_metric "cadvisor" "http://cadvisor:8080/metrics" \
  container_cpu_usage_seconds_total \
  container_memory_working_set_bytes \
  container_start_time_seconds \
  machine_cpu_cores

# ── Edge ──────────────────────────────────────────────────────────────────
# Proves the `metrics` global option AND the :2020 listener are both in effect.
# The directive is silently inert without the global option.
assert_metric "caddy" "http://caddy:2020/metrics" \
  caddy_http_requests_total \
  caddy_http_request_duration_seconds_bucket

# ── ClickHouse ────────────────────────────────────────────────────────────
# The highest-risk names in the whole stack: these come from ClickHouse's
# internal tables and CAN be renamed across major versions. Verified against
# 25.12; re-run after any ClickHouse bump.
assert_metric "clickhouse" "http://clickhouse:9363/metrics" \
  ClickHouseAsyncMetrics_DiskTotal_default \
  ClickHouseAsyncMetrics_TotalBytesOfMergeTreeTables \
  ClickHouseAsyncMetrics_MaxPartCountForPartition \
  ClickHouseMetrics_MemoryTracking \
  ClickHouseMetrics_DelayedInserts \
  ClickHouseProfileEvents_InsertedRows \
  ClickHouseProfileEvents_FailedQuery

# ── Postgres ──────────────────────────────────────────────────────────────
assert_metric "postgres-exporter" "http://postgres-exporter:9187/metrics" \
  pg_up \
  pg_stat_activity_count \
  pg_settings_max_connections

# ── Redis / Valkey ────────────────────────────────────────────────────────
assert_metric "redis-exporter" "http://redis-exporter:9121/metrics" \
  redis_up \
  redis_memory_used_bytes \
  redis_evicted_keys_total

# ── Blackbox ──────────────────────────────────────────────────────────────
assert_metric "blackbox-exporter" "http://blackbox-exporter:9115/metrics" \
  blackbox_module_unknown_total

echo

# ── The two checks that are worth more than all the rest ──────────────────

# 1. QUEUE DEPTH. Absent redis_key_size means REDIS_QUEUE_KEY_PATTERNS matches
#    nothing, and every queue panel is silently blank — indistinguishable from
#    an idle, healthy queue. This is the failure this script exists for.
echo "Checking worker queue depth (the CLAUDE.md §11.2 scaling signal)..."
queue_body=$(fetch "http://redis-exporter:9121/metrics")
queue_series=$(printf '%s\n' "$queue_body" | grep -c '^redis_key_size' || true)
if [ "${queue_series:-0}" -eq 0 ]; then
  echo "FAIL: no redis_key_size series — QUEUE DEPTH IS NOT BEING MEASURED."
  echo "      The queue panels will render EMPTY, which looks like an idle queue."
  echo "      Fix: ./scripts/discover-queue-keys.sh, then set"
  echo "           REDIS_QUEUE_KEY_PATTERNS in infra/.env and recreate"
  echo "           redis-exporter."
  fail=1
else
  echo "PASS: ${queue_series} queue key series exported"
  printf '%s\n' "$queue_body" | grep '^redis_key_size' \
    | sed 's/^redis_key_size{/      /;s/} / = /' | head -12
fi
echo

# 2. PROMETHEUS' OWN VIEW. An exporter can be healthy while Prometheus fails to
#    scrape it — wrong port, wrong job, DNS. Only Prometheus can confirm this.
echo "Checking Prometheus scrape targets..."
targets=$(fetch "http://localhost:9090/api/v1/targets?state=active")
if [ -z "$targets" ]; then
  echo "FAIL: could not query the Prometheus targets API"
  fail=1
else
  down=$(printf '%s' "$targets" | tr '}' '\n' | grep -c '"health":"down"' || true)
  up=$(printf '%s' "$targets" | tr '}' '\n' | grep -c '"health":"up"' || true)
  echo "      up=${up} down=${down}"
  if [ "${down:-0}" -gt 0 ]; then
    echo "FAIL: ${down} scrape target(s) are DOWN"
    printf '%s' "$targets" | tr '}' '\n' | grep '"health":"down"' \
      | grep -oE '"scrapeUrl":"[^"]+"' | sed 's/^/      /'
    fail=1
  else
    echo "PASS: all scrape targets up"
  fi
fi

echo
if [ $fail -eq 0 ]; then
  echo "PASS: ${checked} metric names verified, all scrape targets healthy"
else
  echo "FAIL: see above. Do not trust the dashboards until this is clean."
fi
exit $fail
