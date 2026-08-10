#!/usr/bin/env bash
# Liveness + readiness probe. Exit 0 = healthy.
#
# Usage: ./scripts/health-check.sh https://langfuse.example.com
#
# This proves the web tier is up and can reach Postgres. It does NOT prove the
# ingestion pipeline works — /api/public/health can return 200 while the worker
# is completely backlogged. Use ingestion-canary.sh for that.
set -euo pipefail

base="${1:?usage: health-check.sh <base-url>}"
base="${base%/}"

health_code=$(curl -sS -o /tmp/lf-health.json -w '%{http_code}' --max-time 15 \
  "${base}/api/public/health?failIfDatabaseUnavailable=true" || echo "000")

# Returns 500 after SIGTERM so the proxy drains traffic on shutdown.
ready_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  "${base}/api/public/ready" || echo "000")

echo "health=${health_code} ready=${ready_code}"

rc=0
if [ "$health_code" != "200" ]; then
  echo "FAIL: health check returned ${health_code}"
  [ -s /tmp/lf-health.json ] && sed 's/^/    /' /tmp/lf-health.json
  rc=1
fi
if [ "$ready_code" != "200" ]; then
  echo "FAIL: readiness returned ${ready_code}"
  rc=1
fi

[ $rc -eq 0 ] && echo "PASS: platform healthy"
exit $rc
