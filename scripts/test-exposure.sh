#!/usr/bin/env bash
# BEHAVIOURAL exposure probe. Audit findings F-01 and F-06.
#
#   ./scripts/test-exposure.sh https://langfuse.example.com https://grafana.example.com
#   ./scripts/test-exposure.sh            # reads LANGFUSE_DOMAIN / GRAFANA_DOMAIN from infra/.env
#
# ── Why this file exists ──────────────────────────────────────────────────────
#
# Every other test-*.sh in this directory reads a config file. On 2026-08-12 all
# six of them passed — including one that printed "grafana site block is
# allowlist-gated with a default deny" — while an arbitrary internet client was
# receiving Grafana's /api/health JSON from the deployed server.
#
# Text in a config file is not a control. This script asserts on what the
# running system DOES.
#
# ── ⚠️ RUN IT FROM OFF-NETWORK ────────────────────────────────────────────────
#
# Run from the operator's own machine, or from the box, this script can report
# PASS on a surface that is wide open — because your address may be trusted and
# theirs is not. That is exactly how F-01 stayed invisible.
#
# Use a mobile hotspot, a cheap VPS, or a CI runner. The script prints the
# vantage it is probing from so the result is interpretable later; it cannot
# verify the vantage for you.
set -euo pipefail

cd "$(dirname "$0")/.."

lf="${1:-}"
gf="${2:-}"
if [ -z "$lf" ] && [ -f infra/.env ]; then
  lf="https://$(awk -F= '/^LANGFUSE_DOMAIN=/{print $2}' infra/.env | tr -d '\r')"
  gf="https://$(awk -F= '/^GRAFANA_DOMAIN=/{print $2}' infra/.env | tr -d '\r')"
fi
[ -n "$lf" ] || { echo "usage: test-exposure.sh <langfuse-url> [grafana-url]"; exit 2; }
lf="${lf%/}"; gf="${gf%/}"

fail=0
pass() { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
info() { printf '  ..    %s\n' "$1"; }

echo "── vantage ─────────────────────────────────────────────────────────────"
vantage="$(curl -s --max-time 10 https://api.ipify.org || echo 'unknown')"
echo "  probing from: ${vantage}"
echo "  ⚠️  If this address is trusted anywhere, every PASS below is unproven."
echo

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo "000"; }
body() { curl -s --max-time 15 "$1" 2>/dev/null || true; }

echo "── Langfuse: ${lf} ─────────────────────────────────────────────────────"

# Health must stay public and unauthenticated — the off-host monitor depends on
# it, and CLAUDE.md §10.2 requires that Langfuse not be the only system that
# knows Langfuse is down. A 403 here is a REGRESSION, not an improvement.
h="$(body "${lf}/api/public/health")"
case "$h" in
  *'"status"'*) pass "health endpoint public (required by the off-host monitor)" ;;
  *)            bad  "health endpoint did not return status JSON: ${h:0:120}" ;;
esac

# The REST API must reject an unauthenticated request. 401 = missing/bad key.
# A 200 here would mean the API is open to the internet.
c="$(code "${lf}/api/public/v2/prompts")"
[ "$c" = "401" ] && pass "REST API rejects unauthenticated requests (401)" \
                 || bad  "REST API returned ${c} without a key — expected 401"

# HTTP must redirect. A plaintext 200 would mean agent keys can travel in clear.
c="$(code "http://${lf#https://}/")"
[ "$c" = "308" ] || [ "$c" = "301" ] || [ "$c" = "302" ] \
  && pass "HTTP redirects to HTTPS (${c})" \
  || bad  "HTTP returned ${c} — expected a redirect"

# ── Password login must be refused ────────────────────────────────────────────
# THE check the audit got wrong in both directions, so it is worth being precise.
#
# /api/auth/providers listing `credentials` proves NOTHING: it reflects
# NextAuth's REGISTERED providers, not enforcement (DEPLOYMENT-PITFALLS.md #11).
# And a bare POST returning `signin?csrf=true` proves nothing either — that is
# the missing-CSRF-token response, returned whether or not the provider is on.
#
# The only valid test is a real CSRF-token POST with a DELIBERATELY WRONG
# password, so that a session can never be created even if the provider is live.
csrf_jar="$(mktemp)"; trap 'rm -f "$csrf_jar"' EXIT
csrf="$(curl -s -c "$csrf_jar" --max-time 15 "${lf}/api/auth/csrf" 2>/dev/null \
        | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"
if [ -z "$csrf" ]; then
  info "could not obtain a CSRF token — password-login check SKIPPED (not passed)"
else
  # The answer is in the 302's Location header, URL-encoded — NOT in the body,
  # which is empty. Reading the body alone reports "not refused" against a
  # server that is refusing correctly, which is a false alarm in the same family
  # as the false comfort this script exists to prevent.
  #
  # Refused:  .../api/auth/error?error=Sign%20in%20with%20email%20and%20password%20is%20disabled...
  # Enabled:  .../api/auth/error?error=CredentialsSignin   ← provider LIVE, just a wrong password
  loc="$(curl -s -b "$csrf_jar" --max-time 15 -o /dev/null -D - -X POST \
    -d "csrfToken=${csrf}" \
    -d "email=exposure-probe@invalid.test" \
    -d "password=deliberately-wrong-$(date +%s)" \
    "${lf}/api/auth/callback/credentials" 2>/dev/null \
    | sed -n 's/^[Ll]ocation: *//p' | tr -d '\r' | head -1)"
  # %20 → space so the match reads plainly.
  loc_decoded="$(printf '%s' "$loc" | sed 's/%20/ /g; s/%2E/./g')"
  case "$loc_decoded" in
    *"disabled for this instance"*|*"Please use SSO"*)
      pass "password login refused — SSO is enforcing, not merely configured" ;;
    *CredentialsSignin*)
      bad "password login is LIVE — the credentials provider accepted the attempt and rejected the password" ;;
    "")
      info "no redirect from the credentials callback — check manually, do not assume either way" ;;
    *)
      bad "unexpected credentials response: ${loc_decoded}" ;;
  esac
fi

# Self-registration (F-02). The page rendering is expected — the UI is public.
# What matters is whether the org-creation privilege is restricted behind it.
# That cannot be settled from outside without creating an account, so this
# reports rather than asserts, and says so.
c="$(code "${lf}/auth/sign-up")"
info "sign-up page returns ${c} (the UI is public by design; the control is"
info "   AUTH_DISABLE_USERNAME_PASSWORD + LANGFUSE_ALLOWED_ORGANIZATION_CREATORS,"
info "   neither of which is observable from here — check the container env)"

echo
if [ -n "$gf" ] && [ "$gf" != "https://" ]; then
  echo "── Grafana: ${gf} ──────────────────────────────────────────────────────"

  # ── REWRITTEN 2026-08-12, when the allowlist was replaced by identity ──────
  # The two checks that used to live here asserted the ALLOWLIST model: that an
  # untrusted client could not reach Grafana at all. Under identity-based access
  # control that expectation is simply wrong, and leaving it in place produced
  # two false FAILs against a correctly secured server.
  #
  # Reaching Grafana is no longer the finding. AUTHENTICATING without an Entra
  # identity is. So these now assert behaviour instead of reachability.

  # /api/health is deliberately public — same posture as Langfuse's health
  # endpoint above, and for the same reason: the off-host monitor must be able
  # to see that the service is up without holding a credential. It exposes a
  # version string and nothing else. What must NOT be readable is application
  # data, so assert on a PROTECTED endpoint rather than on the health one.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${gf}/api/user" 2>/dev/null || echo 000)"
  case "$code" in
    401|403) pass "Grafana API requires authentication (${code} on /api/user)" ;;
    200)     bad  "Grafana /api/user returned 200 to ${vantage} — unauthenticated read of application data" ;;
    *)       info "Grafana /api/user returned ${code} — unexpected, inspect manually" ;;
  esac

  # THE decisive password check. Do NOT string-match the /login HTML: Grafana is
  # a single-page app, so /login returns a 200 shell whose JS bundle contains
  # the word "password" whether or not the credentials provider is enabled. The
  # old check did exactly that and would have reported a password form on a
  # server where password auth was completely disabled.
  #
  # Instead, attempt the credentials grant. With GF_AUTH_DISABLE_LOGIN_FORM and
  # GF_AUTH_BASIC_ENABLED both false, Grafana answers 400 auth.client.notConfigured.
  # A 401 is also a pass — wrong credentials, but the mechanism is still live and
  # that is worth distinguishing, so it is reported separately.
  lr="$(curl -s --max-time 15 -H 'Content-Type: application/json' \
        -d '{"user":"admin","password":"exposure-probe-not-a-real-password"}' \
        "${gf}/login" 2>/dev/null || true)"
  case "$lr" in
    *notConfigured*)
      pass "password login is not configured — SSO is the only authenticator" ;;
    *"Invalid username"*|*"Unauthorized"*|*invalidCredentials*)
      bad "Grafana still accepts credential logins (rejected these creds, but the mechanism is live)" ;;
    *)
      info "Grafana /login credential probe returned an unrecognised body — inspect manually" ;;
  esac

  # HTTP Basic is a SEPARATE authenticator from the login form and survives
  # GF_AUTH_DISABLE_LOGIN_FORM. Verified live on 2026-08-12: before
  # GF_AUTH_BASIC_ENABLED=false, `curl -u admin:<pw> /api/user` returned the
  # admin user with isGrafanaAdmin:true while the form was already disabled.
  # Disabling the form alone is NOT "SSO only", so this is checked on its own.
  bcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
           -u 'admin:exposure-probe-not-a-real-password' "${gf}/api/user" 2>/dev/null || echo 000)"
  case "$bcode" in
    401|403) pass "HTTP Basic auth rejected (${bcode}) — the second password door is shut" ;;
    200)     bad  "HTTP Basic auth returned 200 — password authentication is still live" ;;
    *)       info "HTTP Basic probe returned ${bcode} — inspect manually" ;;
  esac

  # F-15: duplicate conflicting X-Frame-Options. Browsers treat duplicates as
  # invalid and several ignore the header entirely, dropping the protection.
  n="$(curl -sI --max-time 15 "${gf}/" 2>/dev/null | grep -ci '^x-frame-options' || true)"
  [ "${n:-0}" = "1" ] && pass "exactly one X-Frame-Options header" \
                      || bad "found ${n:-0} X-Frame-Options headers — expected exactly 1 (F-15)"
else
  info "no Grafana URL given — skipping the checks that would catch F-01"
fi

echo
if [ $fail -eq 0 ]; then
  echo "PASS: exposure probe clean from ${vantage}"
  echo "      This is evidence ONLY IF ${vantage} is not trusted by the deployment."
else
  echo "FAIL: exposure probe found a live problem from ${vantage}"
fi
exit $fail
