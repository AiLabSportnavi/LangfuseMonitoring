#!/usr/bin/env bash
# End-to-end ingestion verification: write a trace, then read it back.
#
# This is the check that matters most. POST /api/public/ingestion returns 207
# (queued), NOT stored — so a 207, and even a healthy /api/public/health, can
# coexist with a completely backlogged pipeline. Only the read-back proves
# ingest -> queue -> worker -> ClickHouse -> query actually works.
#
# Requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in the environment.
# Usage: ./scripts/ingestion-canary.sh https://langfuse.example.com [timeout_seconds]
set -euo pipefail

base="${1:?usage: ingestion-canary.sh <base-url> [timeout]}"
base="${base%/}"
timeout="${2:-60}"
: "${LANGFUSE_PUBLIC_KEY:?LANGFUSE_PUBLIC_KEY not set}"
: "${LANGFUSE_SECRET_KEY:?LANGFUSE_SECRET_KEY not set}"

# openssl rather than `base64 -w0`: -w is GNU-only and absent on BSD/macOS.
auth=$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | openssl base64 -A)

trace_id="canary-$(date -u +%s)-${RANDOM}"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# 1. Write. Expect 207 — queued, not stored.
#    environment=canary keeps synthetic traffic out of production dashboards.
code=$(curl -sS -o /tmp/canary-write.json -w '%{http_code}' --max-time 30 \
  -X POST "${base}/api/public/ingestion" \
  -H "Authorization: Basic ${auth}" \
  -H "Content-Type: application/json" \
  -H "x-langfuse-ingestion-version: 4" \
  -d "{\"batch\":[{\"id\":\"${trace_id}-evt\",\"type\":\"trace-create\",\"timestamp\":\"${now}\",\"body\":{\"id\":\"${trace_id}\",\"name\":\"ingestion-canary\",\"environment\":\"canary\",\"timestamp\":\"${now}\"}}]}" \
  || echo "000")

if [ "$code" != "207" ]; then
  echo "FAIL: ingestion returned ${code} (expected 207)"
  [ -s /tmp/canary-write.json ] && sed 's/^/    /' /tmp/canary-write.json
  exit 1
fi
echo "queued trace ${trace_id} (207)"

# 2. Read back. This is the part that actually proves the pipeline works.
started=$(date -u +%s)
deadline=$(( started + timeout ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  read_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Authorization: Basic ${auth}" \
    "${base}/api/public/traces/${trace_id}" || echo "000")
  if [ "$read_code" = "200" ]; then
    lag=$(( $(date -u +%s) - started ))
    echo "PASS: trace readable after ~${lag}s"
    exit 0
  fi
  sleep 3
done

echo "FAIL: trace ${trace_id} not readable within ${timeout}s"
echo "      Ingestion pipeline is backlogged or broken. Check worker logs and"
echo "      Valkey queue depth before assuming this is a false alarm."
exit 1
