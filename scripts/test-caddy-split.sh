#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
f="infra/caddy/Caddyfile"
[ -f "$f" ] || { echo "FAIL: $f missing"; exit 1; }

fail=0
grep -q "/api/public/otel"      "$f" || { echo "FAIL: OTLP route missing";       fail=1; }
grep -q "/api/public/ingestion" "$f" || { echo "FAIL: ingestion route missing";  fail=1; }

# The REAL OTLP path, not the bare prefix. A bare POST to /api/public/otel
# returns 404 on the live 4.6.0 instance (CLAUDE.md §6.1); a Caddyfile that only
# mentions the prefix has never been checked against that fact.
grep -q "/api/public/otel/v1/traces" "$f" \
  || { echo "FAIL: the real OTLP path /api/public/otel/v1/traces is not routed"; fail=1; }

# Audit F-17: no prefix glob on the ingest matcher. `/api/public/otel*` also
# matched /api/public/otelXYZ and every future sibling under that prefix, which
# would inherit public key-only treatment with nobody reviewing it.
if grep -qE '^[[:space:]]*@ingest .*(/api/public/otel\*|/api/public/ingestion\*)' "$f"; then
  echo "FAIL: @ingest still uses a prefix glob — enumerate the signal paths (F-17)"; fail=1
fi

# Size limiting and RATE limiting are separate controls and must be asserted
# separately. The previous assertion was `rate_limit\|request_body`, which passed
# on request_body alone — so the deployment ran with no rate limiting at all while
# this test reported green, and CLAUDE.md §12.4 claimed the control existed.
# See docs/archive/SECURITY-REVIEW-2026-08-11.md P4 (archived, but that
# finding is still in force). Never re-combine these two greps.
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

# ── Post-SSO shape (2026-08-11) ─────────────────────────────────────────────
# This block previously asserted a deny-by-default `respond 403` handler existed
# anywhere in the file. That assertion is now WRONG for the Langfuse site block,
# whose catch-all deliberately proxies: access control moved to Entra ID SSO for
# the UI and per-project API keys for /api/public/*.
#
# It was also passing for the wrong reason — a whole-file grep matched the
# GRAFANA block's 403 and would have kept reporting green even if the Langfuse
# block's deny handler had been deleted by accident. Same class of bug as the
# request_body/rate_limit conflation documented above. Assert PER BLOCK.

# Comments are stripped first. Without that, these assertions match the prose
# EXPLAINING the configuration rather than the configuration itself — a comment
# saying "ADMIN_ALLOWLIST was removed from this block" would fail the check that
# ADMIN_ALLOWLIST is absent. Assert on directives, never on documentation.
strip_comments() { sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d'; }
langfuse_block() { awk '/^\{\$LANGFUSE_DOMAIN\}/,/^\}/' "$f" | strip_comments; }
grafana_block()  { awk '/^\{\$GRAFANA_DOMAIN/,/^\}/'    "$f" | strip_comments; }

# The Langfuse block must have exactly one catch-all `handle {`, and it must
# proxy. Two would mean unreachable routes (handle blocks are mutually exclusive
# and evaluated in order); zero would mean the UI is unroutable.
n_catchall=$(langfuse_block | grep -cE '^[[:space:]]*handle \{[[:space:]]*$')
if [ "$n_catchall" -ne 1 ]; then
  echo "FAIL: Langfuse block has $n_catchall catch-all 'handle {' blocks, expected exactly 1"; fail=1
fi

# A leftover 403 handler alongside a proxying catch-all would black-hole the UI.
if langfuse_block | grep -qE 'respond .*(403|401)'; then
  echo "FAIL: Langfuse block still denies by default — post-SSO its catch-all must proxy"; fail=1
fi

# ADMIN_ALLOWLIST must NOT gate the Langfuse block. Vercel functions and
# GitHub-hosted CI runners have no static egress IPs, so an allowlist here
# breaks runtime prompt fetching and every evaluation run.
if langfuse_block | grep -q 'ADMIN_ALLOWLIST'; then
  echo "FAIL: ADMIN_ALLOWLIST reintroduced on the Langfuse block"; fail=1
fi

# Grafana carries Entra ID SSO of its own now, so ADMIN_ALLOWLIST is gone from
# THIS block too — it was the last consumer, and IP-based trust has been removed
# from the deployment entirely.
#
# This assertion is INVERTED from what it used to be, and the reason is audit
# F-01: the old test asserted the Grafana block WAS allowlist-gated, reported
# green, and the surface was reachable from the open internet the whole time.
# Text in a config file was never the control. The allowlist is now asserted
# ABSENT so it cannot be quietly reintroduced and re-create that false comfort.
if grafana_block | grep -q 'ADMIN_ALLOWLIST'; then
  echo "FAIL: ADMIN_ALLOWLIST reintroduced on the Grafana block — identity is the control now"; fail=1
fi

# Exactly one catch-all, and it must proxy. Same trap as the Langfuse block: a
# leftover deny handler beside a proxying catch-all black-holes Grafana, and two
# catch-alls make the second unreachable.
n_graf_catchall=$(grafana_block | grep -cE '^[[:space:]]*handle \{[[:space:]]*$')
if [ "$n_graf_catchall" -ne 1 ]; then
  echo "FAIL: Grafana block has $n_graf_catchall catch-all 'handle {' blocks, expected exactly 1"; fail=1
fi
if grafana_block | grep -qE 'respond .*(403|401)'; then
  echo "FAIL: Grafana block still has a deny handler — it would black-hole the UI"; fail=1
fi

# The X-Frame-Options REPLACEMENT operator (audit F-15). Without the `>`, Caddy
# APPENDS, and the response carries the header twice with conflicting values —
# which browsers treat as invalid, several ignoring it entirely and silently
# dropping the clickjacking protection the line exists to provide.
if ! grafana_block | grep -q 'header >X-Frame-Options'; then
  echo "FAIL: Grafana X-Frame-Options is not using the '>' replacement operator (F-15)"; fail=1
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
      -e GRAFANA_DOMAIN=grafana.example.com \
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
