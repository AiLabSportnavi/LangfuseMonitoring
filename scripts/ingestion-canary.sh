#!/usr/bin/env bash
# End-to-end ingestion verification: write a trace, then read it back.
#
# This is the check that matters most. A write being ACCEPTED proves nothing —
# the event is queued, not stored. Only the read-back proves
# OTLP -> blob storage -> Redis -> worker -> ClickHouse -> query actually works.
#
# ── Why OTLP and not /api/public/ingestion ─────────────────────────────────
# Langfuse v4 defaults to LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only. Under
# that mode the legacy ingestion endpoint REJECTS trace events:
#
#   POST /api/public/ingestion  ->  HTTP 207 with a per-event error:
#     "Event type \"trace-create\" is not accepted by /api/public/ingestion
#      when LANGFUSE_MIGRATION_V4_WRITE_MODE is events_only.
#      This endpoint only accepts score and log events."
#
# Note the trap: the HTTP status is still 207. A canary that asserts only on
# the status code passes against a pipeline that stored nothing. Assert on the
# response BODY.
#
# Likewise the v3 read endpoints (/api/public/traces, /api/public/traces/{id},
# /api/public/observations) all return 404 in events_only mode. The documented
# replacement is GET /api/public/v2/observations.
#
# OTLP is also the path the agents actually use (CLAUDE.md 6.1), so this canary
# now exercises production's real code path rather than a retired one.
#
# Requires LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in the environment.
# Usage: ./scripts/ingestion-canary.sh https://langfuse.example.com [timeout_seconds]
set -euo pipefail

base="${1:?usage: ingestion-canary.sh <base-url> [timeout]}"
base="${base%/}"
timeout="${2:-90}"
: "${LANGFUSE_PUBLIC_KEY:?LANGFUSE_PUBLIC_KEY not set}"
: "${LANGFUSE_SECRET_KEY:?LANGFUSE_SECRET_KEY not set}"

# openssl rather than `base64 -w0`: -w is GNU-only and absent on BSD/macOS.
auth=$(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | openssl base64 -A)

# OTLP identifiers are raw hex: 16 bytes for a trace, 8 for a span.
trace_id=$(openssl rand -hex 16)
span_id=$(openssl rand -hex 8)
end_ns=$(date -u +%s%N)
start_ns=$(( end_ns - 1500000000 ))

# 1. Write over OTLP. environment=canary keeps synthetic traffic out of
#    production dashboards.
code=$(curl -sS -o /tmp/canary-write.json -w '%{http_code}' --max-time 30 \
  -X POST "${base}/api/public/otel/v1/traces" \
  -H "Authorization: Basic ${auth}" \
  -H "Content-Type: application/json" \
  -d "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"ingestion-canary\"}}]},\"scopeSpans\":[{\"scope\":{\"name\":\"ingestion-canary\"},\"spans\":[{\"traceId\":\"${trace_id}\",\"spanId\":\"${span_id}\",\"name\":\"ingestion-canary\",\"kind\":1,\"startTimeUnixNano\":\"${start_ns}\",\"endTimeUnixNano\":\"${end_ns}\",\"attributes\":[{\"key\":\"langfuse.environment\",\"value\":{\"stringValue\":\"canary\"}}]}]}]}]}" \
  || echo "000")

if [ "$code" != "200" ]; then
  echo "FAIL: OTLP ingestion returned ${code} (expected 200)"
  [ -s /tmp/canary-write.json ] && sed 's/^/    /' /tmp/canary-write.json
  exit 1
fi

# A 2xx can still carry a per-event rejection. Fail on any error payload.
if grep -q '"errors":\[[^]]' /tmp/canary-write.json 2>/dev/null; then
  echo "FAIL: ingestion accepted the request but rejected the event:"
  sed 's/^/    /' /tmp/canary-write.json
  exit 1
fi
echo "queued trace ${trace_id} (200)"

# 2. Read back. This is the part that actually proves the pipeline works.
#    The window is generous: a parked or slow worker must not look like a
#    missing trace.
from=$(date -u -d '-15 min' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
       || date -u -v-15M +%Y-%m-%dT%H:%M:%SZ)
started=$(date -u +%s)
deadline=$(( started + timeout ))
while [ "$(date -u +%s)" -lt "$deadline" ]; do
  to=$(date -u -d '+5 min' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
       || date -u -v+5M +%Y-%m-%dT%H:%M:%SZ)
  read_code=$(curl -sS -o /tmp/canary-read.json -w '%{http_code}' --max-time 15 \
    -H "Authorization: Basic ${auth}" \
    "${base}/api/public/v2/observations?fromStartTime=${from}&toStartTime=${to}&limit=100" \
    || echo "000")
  if [ "$read_code" = "200" ] && grep -q "$trace_id" /tmp/canary-read.json; then
    lag=$(( $(date -u +%s) - started ))
    echo "PASS: trace readable after ~${lag}s"
    exit 0
  fi
  sleep 3
done

echo "FAIL: trace ${trace_id} not readable within ${timeout}s"
echo "      Ingestion pipeline is backlogged or broken. Check worker logs and"
echo "      Valkey queue depth before assuming this is a false alarm:"
echo "        docker compose logs worker --tail 50"
echo "        docker compose exec redis valkey-cli -a \"\$REDIS_AUTH\" llen bull:otel-ingestion-queue:wait"
exit 1
