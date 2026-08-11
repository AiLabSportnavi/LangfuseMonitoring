#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
f="infra/caddy/Caddyfile"
[ -f "$f" ] || { echo "FAIL: $f missing"; exit 1; }

fail=0
grep -q "/api/public/otel"      "$f" || { echo "FAIL: OTLP route missing";       fail=1; }
grep -q "/api/public/ingestion" "$f" || { echo "FAIL: ingestion route missing";  fail=1; }

# Size limiting and RATE limiting are separate controls and must be asserted
# separately. The previous assertion was `rate_limit\|request_body`, which passed
# on request_body alone — so the deployment ran with no rate limiting at all while
# this test reported green, and CLAUDE.md §12.4 claimed the control existed.
# See docs/SECURITY-REVIEW.md P4. Never re-combine these two greps.
grep -q "request_body" "$f" || { echo "FAIL: no request size limit";            fail=1; }
grep -q "rate_limit"   "$f" || { echo "FAIL: no rate limiting";                 fail=1; }

# Brute-force protection on the auth surface. Once the UI is publicly reachable
# (SSO replaces the IP allowlist), an unprotected /api/auth/* is the exposed
# surface that matters most.
grep -q "/api/auth" "$f" || { echo "FAIL: no rate limit zone for /api/auth/*";  fail=1; }

# Health must NOT be rate limited: the off-host monitor polls it continuously and
# throttling it would make the platform look down when it is up.
if grep -A4 'zone health' "$f" | grep -q 'rate_limit'; then
  echo "FAIL: health endpoints must not be rate limited"; fail=1
fi

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

# Validation MUST use the custom image, not caddy:2.11.4-alpine. `rate_limit` is a
# third-party directive, so stock Caddy rejects the config outright — validating
# against stock would report a failure that is not real, and validating a
# rate-limit-free config against stock would report a pass that is not real either.
img="langfuse-caddy:2.11.4-ratelimit-0.1.0"

if docker image inspect "$img" >/dev/null 2>&1 \
   || docker build -q -t "$img" infra/caddy >/dev/null 2>&1; then
  if ! docker run --rm \
      -e LANGFUSE_DOMAIN=langfuse.example.com \
      -e ACME_EMAIL=platform@example.com \
      -e ADMIN_ALLOWLIST="10.0.0.0/8 192.168.0.0/16" \
      -v "$(pwd -W 2>/dev/null || pwd)/infra/caddy:/etc/caddy:ro" \
      "$img" \
      caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
    echo "FAIL: Caddyfile does not validate"; sed 's/^/    /' /tmp/caddy-validate.log; fail=1
  fi
else
  echo "WARN: caddy image unavailable/unbuildable, skipped config validation"
fi

[ $fail -eq 0 ] && echo "PASS: Caddy ingest/UI split configured"
exit $fail
