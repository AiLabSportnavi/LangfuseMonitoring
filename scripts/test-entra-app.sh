#!/usr/bin/env bash
# Assert an Entra app registration is correctly configured for Langfuse SSO.
#
#   Usage: bash scripts/test-entra-app.sh <manifest.json>
#
# Get the manifest from: Portal -> App registrations -> <app> -> Manifest (copy all).
#
# WHY A MANIFEST AND NOT A LIVE PROBE — read before "improving" this
# ------------------------------------------------------------------
# Two earlier versions of this check probed login.microsoftonline.com's authorize
# endpoint unauthenticated. Both were worthless, and both LOOKED like they worked:
#
#   1. Treating AADSTS50194 as a single-tenant signal. Azure performs home realm
#      discovery only after the user enters an identity, so that error is raised
#      post-authentication. The probe reported multi-tenant for every app,
#      including one the portal showed as single tenant.
#   2. Treating "reached a sign-in page" as proof the client id and redirect URI
#      were valid. Azure defers AADSTS700016 (no such app) and AADSTS50011
#      (unregistered redirect URI) past the sign-in page too. The probe passed for
#      a GUID that was not an application at all, and for a redirect URI the
#      manifest proved was absent.
#
# The authorize endpoint tells an unauthenticated caller nothing. The manifest is
# the authoritative record. Do not reintroduce a network probe.
#
# This asserts CONFIGURATION. The runtime proof — sign in with an out-of-tenant
# account and confirm rejection — is separate and still required.

set -uo pipefail

MANIFEST="${1:-}"
EXPECTED_REDIRECT="${EXPECTED_REDIRECT:-https://sportnavi-langfuse.sportnavi.de/api/auth/callback/azure-ad}"

if [ -z "$MANIFEST" ] || [ ! -f "$MANIFEST" ]; then
  echo "SKIP: no manifest supplied."
  echo "      Usage: bash scripts/test-entra-app.sh <manifest.json>"
  echo "      Portal -> App registrations -> <app> -> Manifest -> copy to a file."
  exit 0
fi

command -v python >/dev/null 2>&1 || { echo "FAIL: python required to parse JSON"; exit 1; }

python - "$MANIFEST" "$EXPECTED_REDIRECT" <<'PY'
import json, sys

m = json.load(open(sys.argv[1], encoding="utf-8-sig"))
want_redirect = sys.argv[2]
fail = []
ok = []

name  = m.get("displayName", "?")
appid = m.get("appId", "?")
print(f"App: {name}  (appId {appid})\n")

# 1. Single tenant. This is THE domain lock — Entra has no allowed-domains variable.
aud = m.get("signInAudience")
if aud == "AzureADMyOrg":
    ok.append(f"signInAudience={aud} — single tenant, domain lock in place")
else:
    fail.append(
        f"signInAudience={aud} — NOT single tenant. Accounts outside the tenant "
        "can sign in.\n      Fix: Authentication -> Supported account types -> "
        "'Accounts in this organizational directory only'.")

# 2. Redirect URI must be registered under the WEB platform (not spa/publicClient).
web_uris = (m.get("web") or {}).get("redirectUris") or []
if want_redirect in web_uris:
    ok.append(f"redirect URI registered (web): {want_redirect}")
else:
    fail.append(
        f"redirect URI NOT registered: {want_redirect}\n"
        f"      web.redirectUris currently = {web_uris or '[]'}\n"
        "      Login fails with AADSTS50011 until this is added under platform 'Web'.")
for other in ("spa", "publicClient"):
    if want_redirect in ((m.get(other) or {}).get("redirectUris") or []):
        fail.append(f"redirect URI is under '{other}', but Langfuse needs platform 'Web'.")

# 3. The email optional claim. Langfuse identifies users by email; without this the
#    login completes and THEN fails to map to a user, which reads as a Langfuse bug.
oc = m.get("optionalClaims") or {}
id_claims = {c.get("name") for c in (oc.get("idToken") or [])}
if "email" in id_claims:
    ok.append("optionalClaims.idToken includes 'email'")
else:
    fail.append(
        "'email' optional claim missing from the ID token.\n"
        "      Langfuse identifies users by email; login will complete and then fail.\n"
        "      Fix: Token configuration -> Add optional claim -> ID -> email.")

# 4. Advisory: secret expiry, and how many exist.
creds = m.get("passwordCredentials") or []
if not creds:
    print("NOTE: no client secrets on this app — one is required.\n")
for c in creds:
    print(f"NOTE: secret '{c.get('displayName')}' (keyId {c.get('keyId')}) "
          f"expires {c.get('endDateTime')}")
if creds:
    print("      An expired secret locks every user out of the UI with no warning.")
    print("      The keyId above is the 'Secret ID' — it is NOT the client id and")
    print("      NOT the secret value.")
if len(creds) == 1:
    print("      Only ONE secret exists: rotating it takes effect immediately for")
    print("      every consumer of this app registration.")
print()

for line in ok:
    print(f"PASS: {line}")
for line in fail:
    print(f"FAIL: {line}")

print()
if fail:
    print("DO NOT remove ADMIN_ALLOWLIST while this fails.")
    sys.exit(1)
print("PASS: app registration configured correctly for Langfuse SSO")
print("NOTE: configuration only. Still required: sign in with an out-of-tenant")
print("      account and confirm it is rejected.")
PY
