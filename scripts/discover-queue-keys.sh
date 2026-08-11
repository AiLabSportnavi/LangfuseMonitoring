#!/usr/bin/env bash
# Discover the real BullMQ key layout in the running Valkey, and print the
# REDIS_QUEUE_KEY_PATTERNS value to put in infra/.env.
#
# Usage: ./scripts/discover-queue-keys.sh
#
# WHY THIS SCRIPT EXISTS
#
# Langfuse exposes no Prometheus endpoint, so worker queue depth — the single
# most important scaling signal in CLAUDE.md §11.2 — has to be read from
# BullMQ's own Redis keys. BullMQ's documented default prefix is "bull", but the
# prefix is a construction-time option and Langfuse does not document which one
# it passes. Langfuse's own FAQ warns against depending on its queue internals.
#
# Guessing wrong does not produce an error. redis_exporter simply matches
# nothing, redis_key_size is absent, and the queue panels render EMPTY — which
# looks exactly like a healthy, idle queue. That is the silent-failure class
# CLAUDE.md §18.11 says to guard against hardest.
#
# So: measure it, do not assume it.
set -euo pipefail

cd "$(dirname "$0")/../infra"

compose() { docker compose -f compose.yaml "$@"; }

if ! compose ps --status running --services 2>/dev/null | grep -qx redis; then
  echo "FAIL: the redis service is not running. Start the stack first."
  exit 1
fi

# Read the password from the running container's environment rather than from
# .env, so this reports on what is ACTUALLY deployed. DEPLOYMENT-PITFALLS.md #12
# and #14 are both cases where .env and the running container disagreed.
auth=$(compose exec -T redis sh -c 'printf %s "$REDIS_AUTH"')
if [ -z "$auth" ]; then
  echo "FAIL: REDIS_AUTH is empty inside the redis container."
  exit 1
fi

scan() {
  compose exec -T redis valkey-cli -a "$auth" --no-auth-warning --scan --pattern "$1" 2>/dev/null
}

echo "Scanning Valkey for BullMQ queue keys..."
echo

# BullMQ stores waiting jobs in a LIST at <prefix>:<queue>:wait. Finding that
# suffix anywhere tells us both the prefix and the queue names in one pass.
wait_keys=$(scan '*:wait' | sort || true)

if [ -z "$wait_keys" ]; then
  echo "No ':wait' keys found."
  echo
  echo "This means one of:"
  echo "  - the worker has never run, so no queue has been created yet"
  echo "  - queues exist but are empty AND BullMQ has not materialised the key"
  echo "  - the key layout differs from what this script assumes"
  echo
  echo "Broadest view of what IS in Valkey (first 40 keys):"
  scan '*' | head -40 | sed 's/^/    /'
  echo
  echo "Send some traffic through the ingestion canary and re-run:"
  echo "    ./scripts/ingestion-canary.sh <base-url>"
  exit 1
fi

echo "Found queue keys:"
echo "$wait_keys" | sed 's/^/    /'
echo

# Everything before the last two segments is the prefix.
prefixes=$(echo "$wait_keys" | sed 's/:[^:]*:wait$//' | sort -u)
prefix_count=$(echo "$prefixes" | grep -c . || true)

echo "Detected prefix(es):"
echo "$prefixes" | sed 's/^/    /'
echo

if [ "$prefix_count" -ne 1 ]; then
  echo "WARNING: more than one prefix is in use. The suggested value below covers"
  echo "         all of them, which is correct but worth understanding first."
  echo
fi

# Build the pattern list. :completed is deliberately excluded — BullMQ retains
# completed jobs and that key can hold tens of thousands of entries, making the
# per-scrape SCAN expensive for a number that answers no operational question.
patterns=""
for p in $prefixes; do
  for state in wait active delayed failed paused; do
    patterns="${patterns}${patterns:+,}${p}:*:${state}"
  done
done

echo "══════════════════════════════════════════════════════════════════════"
echo "Put this in infra/.env:"
echo
echo "REDIS_QUEUE_KEY_PATTERNS=${patterns}"
echo "══════════════════════════════════════════════════════════════════════"
echo
echo "Then recreate the exporter and confirm the metric appears:"
echo "    docker compose -f compose.yaml -f compose.monitoring.yaml up -d redis-exporter"
echo "    ./scripts/verify-metric-sources.sh"
