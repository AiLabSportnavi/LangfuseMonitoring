#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
fail=0

for s in scripts/health-check.sh scripts/ingestion-canary.sh; do
  [ -x "$s" ] || { echo "FAIL: $s missing or not executable"; fail=1; continue; }
  bash -n "$s" || { echo "FAIL: $s has a syntax error"; fail=1; }
done

grep -q "failIfDatabaseUnavailable" scripts/health-check.sh \
  || { echo "FAIL: health-check must use the deep DB check"; fail=1; }

# The read-back is the whole point. POST /api/public/ingestion returns 207
# (queued, not stored), so a 207 alone proves nothing about the pipeline.
grep -q "api/public/traces" scripts/ingestion-canary.sh \
  || { echo "FAIL: canary must read the trace back"; fail=1; }

grep -q "207" scripts/ingestion-canary.sh \
  || { echo "FAIL: canary must assert the 207 queued response"; fail=1; }

[ $fail -eq 0 ] && echo "PASS: probe contract satisfied"
exit $fail
