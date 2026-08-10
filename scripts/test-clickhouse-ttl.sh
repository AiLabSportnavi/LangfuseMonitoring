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
if command -v python >/dev/null 2>&1; then
  python -c "import xml.etree.ElementTree as e,sys; e.parse('$f')" \
    || { echo "FAIL: $f is not well-formed XML"; fail=1; }
fi

[ $fail -eq 0 ] && echo "PASS: ClickHouse TTL config complete"
exit $fail
