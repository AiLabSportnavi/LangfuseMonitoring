#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
f="infra/caddy/Caddyfile"
[ -f "$f" ] || { echo "FAIL: $f missing"; exit 1; }

fail=0
grep -q "/api/public/otel"      "$f" || { echo "FAIL: OTLP route missing";       fail=1; }
grep -q "/api/public/ingestion" "$f" || { echo "FAIL: ingestion route missing";  fail=1; }
grep -q "remote_ip"             "$f" || { echo "FAIL: IP allowlist missing";     fail=1; }
grep -q "rate_limit\|request_body" "$f" || { echo "FAIL: no rate/size limiting"; fail=1; }

# The default route must deny, not proxy. If the fallthrough handler forwarded to
# web:3000, the entire admin surface would be public — the exact failure this
# split exists to prevent.
if ! grep -qE 'respond .*(403|401)' "$f"; then
  echo "FAIL: no deny-by-default handler for untrusted sources"; fail=1
fi

# Caddy must accept the config. A Caddyfile that does not parse means no ingress
# at all on deploy.
# MSYS_NO_PATHCONV stops Git Bash on Windows rewriting the in-container paths
# (/etc/caddy would become C:/Program Files/Git/etc/caddy). No effect on Linux.
export MSYS_NO_PATHCONV=1

if docker image inspect caddy:2.11.4-alpine >/dev/null 2>&1 || docker pull -q caddy:2.11.4-alpine >/dev/null 2>&1; then
  if ! docker run --rm \
      -e LANGFUSE_DOMAIN=langfuse.example.com \
      -e ACME_EMAIL=platform@example.com \
      -e ADMIN_ALLOWLIST="10.0.0.0/8 192.168.0.0/16" \
      -v "$(pwd -W 2>/dev/null || pwd)/infra/caddy:/etc/caddy:ro" \
      caddy:2.11.4-alpine \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
    echo "FAIL: Caddyfile does not validate"; sed 's/^/    /' /tmp/caddy-validate.log; fail=1
  fi
else
  echo "WARN: caddy image unavailable, skipped config validation"
fi

[ $fail -eq 0 ] && echo "PASS: Caddy ingest/UI split configured"
exit $fail
