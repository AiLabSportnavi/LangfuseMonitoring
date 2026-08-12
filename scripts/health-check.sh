#!/usr/bin/env bash
# Liveness + readiness + TLS expiry probe. Exit 0 = healthy.
#
# Usage: ./scripts/health-check.sh https://langfuse.example.com
#        CERT_WARN_DAYS=30 ./scripts/health-check.sh https://langfuse.example.com
#
# This proves the web tier is up and can reach Postgres. It does NOT prove the
# ingestion pipeline works — /api/public/health can return 200 while the worker
# is completely backlogged. Use ingestion-canary.sh for that.
set -euo pipefail

base="${1:?usage: health-check.sh <base-url>}"
base="${base%/}"

# 21 days: long enough that several failed ACME renewals can be noticed and
# fixed before anything user-visible happens. Caddy renews at 30 days remaining,
# so anything under this means renewal is already failing, not merely pending.
CERT_WARN_DAYS="${CERT_WARN_DAYS:-21}"

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

# ── TLS certificate expiry (audit F-14) ──────────────────────────────────────
#
# Caddy renews automatically, so this is NOT a reminder to renew — it is a
# detector for renewal being broken. An ACME challenge that cannot complete
# (DNS record changed, port 80 blocked by a new firewall rule, rate limit hit)
# retries silently and succeeds at nothing until the certificate expires. At
# that moment every agent's OTLP export starts failing TLS verification
# simultaneously, and the platform's own health endpoint becomes unreachable to
# the off-host monitor — so the system that should report the outage cannot.
#
# Checked here as well as in Prometheus (rules/platform.yml) on purpose. That
# rule depends on the edge-tls job having targets in a file that is absent on a
# fresh deploy, and this script runs from anywhere, including from the off-host
# monitor itself. Neither covers the other.
host="${base#https://}"; host="${host#http://}"; host="${host%%/*}"
port="443"
case "$host" in *:*) port="${host##*:}"; host="${host%%:*}" ;; esac

if [ "${base#https://}" = "$base" ]; then
  echo "cert=skipped (not an https URL)"
elif ! command -v openssl >/dev/null 2>&1; then
  # Loudly, not silently. A skipped check that prints nothing is how an
  # unmonitored certificate stays unmonitored.
  echo "WARN: openssl not found — certificate expiry NOT checked"
else
  not_after=$(echo | openssl s_client -servername "$host" -connect "${host}:${port}" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)

  if [ -z "$not_after" ]; then
    echo "FAIL: could not read the TLS certificate for ${host}:${port}"
    rc=1
  else
    # GNU date and BSD date disagree on parsing flags; try both rather than
    # assuming the platform. This script runs on the Hetzner box and on the
    # off-host monitor, which need not be the same OS.
    exp_epoch=$(date -d "$not_after" +%s 2>/dev/null \
      || date -j -f "%b %d %T %Y %Z" "$not_after" +%s 2>/dev/null \
      || echo "")

    if [ -z "$exp_epoch" ]; then
      echo "WARN: could not parse certificate date '${not_after}' — expiry NOT checked"
    else
      days_left=$(( (exp_epoch - $(date -u +%s)) / 86400 ))
      echo "cert=${host} expires in ${days_left}d (${not_after})"
      if [ "$days_left" -lt 0 ]; then
        echo "FAIL: certificate for ${host} has EXPIRED"
        rc=1
      elif [ "$days_left" -lt "$CERT_WARN_DAYS" ]; then
        echo "FAIL: certificate for ${host} expires in ${days_left}d (< ${CERT_WARN_DAYS}d)"
        echo "      Caddy renews at 30d remaining, so this means renewal is FAILING."
        echo "      Check Caddy's logs for ACME errors before assuming it is fine."
        rc=1
      fi
    fi
  fi
fi

[ $rc -eq 0 ] && echo "PASS: platform healthy"
exit $rc
