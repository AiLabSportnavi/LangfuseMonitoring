#!/usr/bin/env bash
# Verify Grafana's Entra ID SSO against the running container.
#
#   Usage: bash scripts/test-grafana-sso.sh [<app-manifest.json>]
#
# Companion to test-entra-app.sh, which validates the app registration itself.
# Point that one at Grafana's redirect URI:
#
#   EXPECTED_REDIRECT=https://<domain>/login/azuread \
#     bash scripts/test-entra-app.sh <manifest.json>
#
# WHAT THIS CAN AND CANNOT PROVE — read before trusting a PASS
# ------------------------------------------------------------
# It cannot prove a human can sign in. Entra will not complete an authorization
# code flow for an unauthenticated script, by design. Only a real sign-in proves
# that, and it stays a required step (docs/GRAFANA-SSO.md §5).
#
# What it CAN do is inspect the authorize redirect Grafana actually emits. That
# is the authoritative record of the client_id, redirect_uri, scope and PKCE
# Grafana will send — as opposed to what the config file claims. The redirect_uri
# in particular is derived from GF_SERVER_ROOT_URL, and getting it wrong produces
# a login that fails at Entra with AADSTS50011 while every local check passes.
#
# Deliberately NOT a check of "is the provider listed somewhere". DEPLOYMENT-
# PITFALLS.md #11: Langfuse's /api/auth/providers kept advertising `credentials`
# after password login was disabled, and the control had worked. A capability
# endpoint is not evidence in either direction.

set -uo pipefail

cd "$(dirname "$0")/../infra"

MANIFEST="${1:-}"
compose() { docker compose -f compose.yaml -f compose.monitoring.yaml "$@"; }
PY="$(command -v python3 || command -v python || true)"

fail=0
CONTAINER=langfuse-grafana-1

echo "Verifying Grafana Entra ID SSO against the running container..."
echo

# ── Is Grafana even up ────────────────────────────────────────────────────
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "SKIP: $CONTAINER is not running. Start the monitoring stack first."
  exit 0
fi

envof() { docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep "^$1=" | cut -d= -f2- || true; }

SSO_ENABLED=$(envof GF_AUTH_AZUREAD_ENABLED)
CLIENT_ID=$(envof GF_AUTH_AZUREAD_CLIENT_ID)
ROOT_URL=$(envof GF_SERVER_ROOT_URL)
DISABLE_FORM=$(envof GF_AUTH_DISABLE_LOGIN_FORM)
ROLE_STRICT=$(envof GF_AUTH_AZUREAD_ROLE_ATTRIBUTE_STRICT)
ALLOWED_ORGS=$(envof GF_AUTH_AZUREAD_ALLOWED_ORGANIZATIONS)

# The variable reaching the container is not the same question as the variable
# being in .env — DEPLOYMENT-PITFALLS.md #14. Read it from the container.
if [ "$SSO_ENABLED" != "true" ]; then
  echo "SKIP: SSO is not enabled (GF_AUTH_AZUREAD_ENABLED=${SSO_ENABLED:-<unset>} in the container)."
  echo "      This is the shipped default. To enable, see docs/GRAFANA-SSO.md §4."
  if [ -n "$CLIENT_ID" ]; then
    echo "      NOTE: a client id IS set, so this looks like a half-applied change."
    echo "            Set GRAFANA_SSO_ENABLED=true in infra/.env and recreate grafana."
  fi
  exit 0
fi

# ── Config that must be present once enabled ──────────────────────────────
[ -n "$CLIENT_ID" ] \
  && echo "PASS: client id configured (${CLIENT_ID})" \
  || { echo "FAIL: GF_AUTH_AZUREAD_CLIENT_ID is empty while SSO is enabled"; fail=1; }

if [ -n "$ALLOWED_ORGS" ]; then
  echo "PASS: tenant lock set (allowed_organizations=${ALLOWED_ORGS})"
else
  echo "FAIL: allowed_organizations is empty — any Entra directory could sign in."
  echo "      Entra has no allowed-domains concept; this is half the tenant lock."
  echo "      The other half is signInAudience=AzureADMyOrg on the registration."
  fail=1
fi

# ── The authorize redirect: what Grafana ACTUALLY sends ───────────────────
# -s so curl does not follow; we want the Location header itself.
LOCATION=$(compose exec -T grafana \
  curl -s -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:3000/login/azuread" 2>/dev/null || true)

if [ -z "$LOCATION" ]; then
  echo "FAIL: GET /login/azuread did not redirect. The provider is not active."
  echo "      Grafana parsed the config but is not offering the flow — check its"
  echo "      logs: docker compose logs grafana | grep -i azuread"
  fail=1
else
  case "$LOCATION" in
    https://login.microsoftonline.com/*)
      echo "PASS: /login/azuread redirects to Entra" ;;
    *)
      echo "FAIL: /login/azuread redirects somewhere unexpected: $LOCATION"
      fail=1 ;;
  esac

  if [ -n "$PY" ]; then
    # Parse the real query string rather than pattern-matching it.
    # parse_qs already percent-decodes; shlex.quote makes each value safe to
    # eval, so no second decoding pass is needed on the shell side.
    eval "$("$PY" - "$LOCATION" <<'PYEOF'
import shlex, sys, urllib.parse as u
q = u.parse_qs(u.urlparse(sys.argv[1]).query)
for name, key in (("A_CLIENT", "client_id"), ("A_REDIRECT", "redirect_uri"),
                  ("A_SCOPE", "scope"), ("A_CCM", "code_challenge_method")):
    print("%s=%s" % (name, shlex.quote((q.get(key) or [""])[0])))
PYEOF
)"

    WANT_REDIRECT="${ROOT_URL%/}/login/azuread"

    [ "$A_CLIENT" = "$CLIENT_ID" ] \
      && echo "PASS: authorize request carries the configured client id" \
      || { echo "FAIL: authorize client_id=$A_CLIENT but config says $CLIENT_ID"; fail=1; }

    if [ "$A_REDIRECT" = "$WANT_REDIRECT" ]; then
      echo "PASS: redirect_uri is $A_REDIRECT"
      echo "      Register EXACTLY this under platform 'Web' in the app registration."
    else
      echo "FAIL: redirect_uri mismatch."
      echo "      Grafana will send: $A_REDIRECT"
      echo "      Derived from GF_SERVER_ROOT_URL=$ROOT_URL"
      echo "      Expected:         $WANT_REDIRECT"
      echo "      Entra rejects an unregistered redirect URI with AADSTS50011,"
      echo "      after the sign-in page — so this looks like a Grafana bug."
      fail=1
    fi

    case "$A_SCOPE" in
      *openid*email*|*email*openid*) echo "PASS: scope requests openid and email ($A_SCOPE)" ;;
      *) echo "FAIL: scope is '$A_SCOPE' — Grafana identifies users by email."; fail=1 ;;
    esac

    [ "$A_CCM" = "S256" ] \
      && echo "PASS: PKCE enabled (code_challenge_method=S256)" \
      || echo "WARN: PKCE not in use (code_challenge_method='${A_CCM:-none}')"
  else
    echo "WARN: no python3 — skipped parsing the authorize redirect"
  fi
fi

# ── Break-glass: can the local admin still get in ─────────────────────────
# Attempted, not inferred. This is the account that gets you back when the
# app registration's client secret expires.
ADMIN_USER=$(envof GF_SECURITY_ADMIN_USER)
ADMIN_PASS=$(envof GF_SECURITY_ADMIN_PASSWORD)

if [ "$DISABLE_FORM" = "true" ]; then
  echo "WARN: GF_AUTH_DISABLE_LOGIN_FORM=true — no local fallback."
  echo "      Deliberate as the final cut-over step, but an expired client secret"
  echo "      now locks every human out of the UI. docs/GRAFANA-SSO.md §7."
elif [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ]; then
  CODE=$(compose exec -T grafana curl -s -o /dev/null -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -d "{\"user\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" \
    "http://127.0.0.1:3000/login" 2>/dev/null || true)
  [ "$CODE" = "200" ] \
    && echo "PASS: local admin still authenticates (break-glass intact)" \
    || { echo "FAIL: local admin login returned HTTP ${CODE:-<none>} — break-glass is GONE"; fail=1; }
fi

# ── App roles, if a manifest was supplied ─────────────────────────────────
if [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ] && [ -n "$PY" ]; then
  echo
  "$PY" - "$MANIFEST" <<'PYEOF' || fail=1
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8-sig"))
have = {r.get("value") for r in (m.get("appRoles") or []) if r.get("isEnabled", True)}
want = {"Viewer", "Editor", "Admin", "GrafanaAdmin"}
missing = want - have
if missing:
    print("FAIL: app roles missing from the registration: %s" % ", ".join(sorted(missing)))
    print("      Grafana matches the role's `value` field, case-sensitively.")
    print("      Without them every user falls back to auto_assign_org_role,")
    print("      and with role_attribute_strict=true nobody can sign in at all.")
    sys.exit(1)
print("PASS: all four app roles present (%s)" % ", ".join(sorted(have & want)))
PYEOF
elif [ -n "$MANIFEST" ] && [ ! -f "$MANIFEST" ]; then
  echo "WARN: manifest '$MANIFEST' not found — skipped the app-role check"
fi

echo
if [ "$ROLE_STRICT" != "true" ]; then
  echo "NOTE: role_attribute_strict=false — an identity with no app role is"
  echo "      admitted as a Viewer. Tighten once roles are assigned (§5 step 4)."
fi

if [ $fail -ne 0 ]; then
  echo
  echo "FAIL: see above. Do NOT set GRAFANA_DISABLE_LOGIN_FORM=true while this fails."
  exit 1
fi

echo "PASS: Grafana SSO configuration is coherent"
echo "NOTE: configuration only. Still required, and not substitutable: sign in"
echo "      through the Entra button as a real user, then confirm the account and"
echo "      its role in Administration -> Users."
