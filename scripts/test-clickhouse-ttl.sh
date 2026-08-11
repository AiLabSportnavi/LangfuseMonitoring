#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
f="infra/clickhouse/config.d/langfuse-ttl.xml"

[ -f "$f" ] || { echo "FAIL: $f missing"; exit 1; }

fail=0
for needle in "query_profiler_real_time_period_ns" "trace_log" "opentelemetry_span_log" "query_log"; do
  grep -q "$needle" "$f" || { echo "FAIL: $needle not configured"; fail=1; }
done

grep -q "INTERVAL 7 DAY"  "$f" || { echo "FAIL: 7-day TTL missing";  fail=1; }
grep -q "INTERVAL 30 DAY" "$f" || { echo "FAIL: 30-day TTL missing"; fail=1; }

# The XML must actually parse. A malformed config file is silently ignored by
# ClickHouse on some paths, which would leave the disk unprotected.
PY="$(command -v python3 || command -v python || true)"
if [ -n "$PY" ]; then
  "$PY" -c "import xml.etree.ElementTree as e,sys; e.parse('$f')" \
    || { echo "FAIL: $f is not well-formed XML"; fail=1; }
fi

# Well-formed XML is not the same as a config ClickHouse accepts. An <engine>
# element here collides with the stock config's <partition_by> and the server
# refuses to start — which text inspection alone will not catch. Boot a
# throwaway server with the config mounted and require it to serve.
if [ "${SKIP_CLICKHOUSE_BOOT:-0}" != "1" ]; then
  export MSYS_NO_PATHCONV=1
  image="clickhouse/clickhouse-server:25.12-alpine"
  cid=$(docker run -d --rm \
    -v "$(pwd -W 2>/dev/null || pwd)/infra/clickhouse/config.d:/etc/clickhouse-server/config.d:ro" \
    "$image" 2>/dev/null) || { echo "WARN: could not start ClickHouse, skipped boot check"; cid=""; }

  if [ -n "$cid" ]; then
    ok=0
    for _ in $(seq 1 30); do
      if docker exec "$cid" wget -qO- http://localhost:8123/ping >/dev/null 2>&1; then ok=1; break; fi
      sleep 2
    done
    if [ "$ok" -eq 1 ]; then
      echo "PASS: ClickHouse starts and serves with this config"
    else
      echo "FAIL: ClickHouse did not become ready with this config"
      docker exec "$cid" tail -20 /var/log/clickhouse-server/clickhouse-server.err.log 2>/dev/null \
        | grep -E 'Error|Exception' | head -5 | sed 's/^/    /'
      fail=1
    fi
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
fi

[ $fail -eq 0 ] && echo "PASS: ClickHouse TTL config complete"
exit $fail
