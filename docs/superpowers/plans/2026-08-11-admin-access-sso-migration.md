# Plan — Replace `ADMIN_ALLOWLIST` with SSO + domain lock

**Date:** 2026-08-11 · **Provider:** Microsoft Entra ID · **Review:** [SECURITY-REVIEW.md](../../SECURITY-REVIEW.md)

**Status:** Phase 2 (rate limiting) implemented in-repo, not deployed. Phase 1 wiring in
place with empty defaults — inert until the Entra credentials from Step 1 are supplied.

Goal: delete IP-based trust entirely. Admin access becomes "an authenticated
`@sportnavi.de` identity" instead of "whoever currently holds this IP address."

Justified by Langfuse's own guidance — the `langfuse/langfuse` web container "is designed
to be exposed publicly as a web service and has undergone penetration testing," and is the
same image serving Langfuse Cloud. Firewall/VPN is documented as an *option*, not a
requirement. See <https://langfuse.com/self-hosting/security/networking>.

**Nothing here is applied yet.** Phase 1 is not started until Step 0 is answered.

---

## Phase order and why

| Phase | Closes | Why this order |
|---|---|---|
| **1. SSO + domain lock** | P1, P2, P3, P5, P6 | Solves the operational pain immediately and removes three findings at once |
| **2. Rate limiting** | P4 | Precondition for a public login page being responsible; needs a custom Caddy build |
| **3. Backups + restore test** | Upstream's named Compose gap | Largest unmitigated risk on the platform; independent of the other two |

Phases 1 and 2 ship together on the server — Phase 1 is not cut over publicly until
Phase 2's rate limiting is live. They are separated here because they are built and
tested independently.

---

## Step 0 — Identity provider — RESOLVED: Microsoft Entra ID

Determined from public DNS, which is authoritative and needed no login:

```
sportnavi.de  MX   → sportnavi-de.mail.protection.outlook.com
sportnavi.de  TXT  → v=spf1 ... include:spf.protection.outlook.com ...
```

**`sportnavi.de` runs on Microsoft 365 / Entra ID, not Google Workspace.** The
`google-site-verification` TXT records present on the domain are Search Console
verification, not Workspace — a common false positive worth naming.

Google SSO is therefore out; `AUTH_GOOGLE_ALLOWED_DOMAINS` has no `hd` claim to read.
Entra ID is the better outcome anyway: it is the company's real identity provider, so
account lifecycle (joiners, leavers, MFA, conditional access) is already managed there
rather than being a second thing to maintain.

### How the domain lock works here — read before Step 1

**There is no `AUTH_AZURE_AD_ALLOWED_DOMAINS`.** The equivalent control is the app
registration's *supported account types*:

- Registered as **single-tenant** ("Accounts in this organizational directory only")
  → only identities in the `sportnavi.de` tenant can authenticate. This is the lock.
- Registered as **multi-tenant** → **any Microsoft account on the internet can sign in.**

This is a single dropdown at registration time, it is easy to get wrong, and getting it
wrong produces a working login flow that admits the entire world. Step 5's negative test
exists specifically to catch it.

> **Prerequisite:** creating an app registration requires Application Developer or
> Application Administrator rights in the Entra tenant. If you do not have them, this
> step needs whoever administers Microsoft 365 for `sportnavi.de`. Confirm this before
> starting — it is the most likely thing to stall the migration.

---

## Phase 1 — SSO + domain lock

### Step 1 — The app registration

**Decision: reuse the existing `n8n-Automation (neu)` registration**
(`appId 03f90999-0120-4dcb-8728-171d6466406d`, tenant `8238d906-9211-4059-89e2-36142daa7205`).

It is retired — n8n no longer uses it — so the usual objection to sharing one
registration between two systems (rotating a secret for one breaks the other) does not
apply. Confirmed by the operator on 2026-08-11.

Already correct in its manifest: **`signInAudience: AzureADMyOrg`** — single tenant, so
the domain lock is in place. Verify any change with:

```bash
bash scripts/test-entra-app.sh <manifest.json>
```

Four changes are required. The last two were caught by that script against the real
manifest, not assumed:

1. **Rename** to `Langfuse Observability`. The current name describes a decommissioned
   system; anyone auditing the tenant later would reasonably assume it is n8n's and
   either leave it alone or delete it.
2. **Add the redirect URI** under platform **Web** (not SPA, not Public client):
   ```
   https://sportnavi-langfuse.sportnavi.de/api/auth/callback/azure-ad
   ```
   and **remove** the stale `https://n8nserver.sportnavi.de/rest/oauth2-credential/callback`
   — an unused callback is dead attack surface on a live app.
3. **Token configuration → Add optional claim → `ID` → `email`.** The manifest has
   `optionalClaims: null`; without this, login completes and then fails to map a user.
4. **Rotate the secret.** The `langfuse-infrastructure` secret
   (keyId `8c54da85-…`, expires 2027-02-07) was pasted into a chat transcript. Nothing
   consumes it, so rotation is free — delete it and create a replacement.

> The keyId `8c54da85-…` is the **Secret ID**, not the client id and not the secret
> value. It was initially mistaken for the client id. The client id is
> `03f90999-0120-4dcb-8728-171d6466406d`, from the manifest's `appId`.

<details>
<summary>Creating a fresh registration instead (original instructions)</summary>


In the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID → App registrations
→ New registration**:

1. **Name:** `Langfuse Observability`
2. **Supported account types:** **Accounts in this organizational directory only
   (sportnavi.de — Single tenant).**
   ⚠️ **This is the domain lock.** Any other choice admits Microsoft accounts from
   outside the company. Do not proceed past this screen without confirming it.
3. **Redirect URI:** platform **Web**, value exactly — no trailing slash:
   ```
   https://sportnavi-langfuse.sportnavi.de/api/auth/callback/azure-ad
   ```
4. Register, then from **Overview** copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
5. **Certificates & secrets → New client secret.** Copy the **Value** column.
   ⚠️ The docs call this out explicitly: `AUTH_AZURE_AD_CLIENT_SECRET` "needs to be the
   Client Secret **`value`**, not the `Secret ID`." Both are GUID-ish strings shown side
   by side, the wrong one fails at login with an unhelpful error, and the Value is only
   displayed once — copy it now or regenerate.
   **Note its expiry date** (default 6 or 24 months). An expired secret locks everyone
   out of the UI with no warning; put the date in the calendar at Step 8.
6. **Token configuration → Add optional claim → `ID` token type → `email`.**
   Required: "Langfuse uses email to identify users. Thus, you need to add the `email`
   claim in the token configuration and all users must have an `Email` in their user
   profile." Without it, login completes and *then* fails to map to a user — a failure
   that reads like a Langfuse bug rather than a claims problem.

   Note the token type is **ID**, not Access. Langfuse reads the OIDC ID token.

   If the portal offers a checkbox to "turn on the Microsoft Graph `email` permission
   (required for claims to appear in token)", tick it. It grants the OIDC `email`
   scope, not mailbox access.

</details>

### API permissions — nothing to add by hand

Registration auto-adds `User.Read` (Microsoft Graph, delegated) and that is sufficient.
Sign-in uses the OIDC scopes `openid`, `profile`, `email`, which are protocol scopes
rather than Graph permissions configured in the **API permissions** blade. **Do not add
Graph permissions** — a broader grant than sign-in requires is a standing liability on
an app registration that only needs to identify people.

**Admin consent** is normally unnecessary: these scopes are user-consentable, so the
first sign-in shows a one-time consent prompt. If the tenant disables user consent, that
prompt becomes "needs admin approval" and a Cloud Application Administrator grants
consent once. This surfaces at first login, not at registration.

> **Users without an email attribute cannot log in.** Accounts carrying only a UPN and
> no `mail` value produce an empty `email` claim. Worth checking for any service or
> admin account expected to use the UI.

### Step 2 — Add the variables to `infra/.env`

```env
# ─── SSO (Microsoft Entra ID) ───────────────────────────────────────────────
AUTH_AZURE_AD_CLIENT_ID=<Application (client) ID>
AUTH_AZURE_AD_CLIENT_SECRET=<Client secret VALUE, not the Secret ID>
# The domain lock, together with the single-tenant app registration from Step 1.
# Only identities in this tenant can authenticate.
AUTH_AZURE_AD_TENANT_ID=<Directory (tenant) ID>

# Password login off: SSO becomes the only way in, so there is no password to brute
# force and no credential to leak. Do NOT set this until SSO login is proven (Step 5).
AUTH_DISABLE_USERNAME_PASSWORD=true
```

Then wire them through `infra/compose.yaml` in the `web` service `environment:` block
(they are per-service, not part of the shared `x-langfuse-env` anchor — worker does not
serve auth).

> **Deliberately NOT setting `AUTH_DISABLE_SIGNUP=true`.** Per the Langfuse docs it
> "affects all new users that try to sign up, **also those who received an invite** and
> have no account yet" — so it would block legitimate colleague onboarding. What bounds
> registration here is the single-tenant app registration: an identity outside the
> `sportnavi.de` tenant cannot complete OAuth at all, so there is no account for it to
> create. This corrects finding P5's proposed fix — the review's original wording was
> wrong about which knob does the work.

> **Not setting `AUTH_AZURE_AD_ALLOW_ACCOUNT_LINKING` either.** It merges accounts by
> matching email across providers. With exactly one provider there is nothing to link,
> and enabling it would mean a future second provider could silently take over an
> existing account.

### Step 3 — Keep the existing password admin reachable during migration

`LANGFUSE_INIT_USER_EMAIL` is `platform@example.com` with a password. Once
`AUTH_DISABLE_USERNAME_PASSWORD=true` is set, **that account can no longer log in.**

Before Step 5, sign in via SSO once and confirm your Entra identity has `OWNER` on the
org. Otherwise you get a running platform with no administrator — recoverable only via
Postgres surgery.

### Step 4 — Deploy with SSO alongside the allowlist still in force

```bash
cd /root/LangfuseMonitoring/infra
docker compose up -d --force-recreate web     # NOT `restart` — env vars bake in at create
docker compose logs -f web | head -50         # watch for auth provider registration
```

From an allowlisted IP, confirm a "Sign in with Microsoft" button appears and that
logging in with your `@sportnavi.de` account works. **The allowlist is untouched at this point** —
if SSO is broken, nothing is lost.

### Step 5 — Verify the domain lock actually blocks

Do not skip this. It is the entire security control.

- Sign in with a personal Microsoft account (outlook.com/hotmail.com, or any account
  outside the tenant) → **must be rejected.** This is the test that proves the app
  registration is single-tenant. A multi-tenant registration admits it and everything
  else still looks perfectly normal.
- Sign in with `@sportnavi.de` → must succeed and land on the org.

If an out-of-tenant account gets in, the app registration is multi-tenant and
**the cut-over must not proceed.**

### Step 6 — Cut over (only after Phase 2 rate limiting is live)

Delete the `@trusted` block from `infra/caddy/Caddyfile`:

```diff
-  @trusted remote_ip {$ADMIN_ALLOWLIST}
-  handle @trusted {
-    reverse_proxy web:3000
-  }
+  # UI/admin. Public by design — the langfuse/langfuse container is built for public
+  # exposure and is the same image serving Langfuse Cloud. Access control is identity,
+  # not network position: Entra ID SSO, single-tenant to sportnavi.de, password off.
+  handle {
+    reverse_proxy web:3000
+  }
```

Remove `ADMIN_ALLOWLIST` from `infra/.env` and from the `caddy` service in
`compose.yaml`, then:

```bash
docker compose up -d --force-recreate caddy
```

> Note the deny-by-default `handle` at the bottom of the Caddyfile is now the proxy
> handler. Re-read the file after editing and confirm there is exactly one catch-all —
> a stray leftover `respond 403` would black-hole the UI.

### Step 7 — Verify from a non-allowlisted network

Use mobile data, or any machine that was never on the allowlist:

```bash
D=sportnavi-langfuse.sportnavi.de
curl -s -o /dev/null -w '%{http_code}\n' https://$D/                       # expect 200 (login page)
curl -s -o /dev/null -w '%{http_code}\n' https://$D/api/public/health      # expect 200
bash scripts/ingestion-canary.sh https://$D                                # must still pass
```

Then open the UI in a browser and confirm you are prompted for SSO and cannot reach
anything without it.

### Step 8 — Update the tests and the docs

- `scripts/test-caddy-split.sh` asserts `remote_ip` is present — **it will now fail.**
  Replace that assertion with one that verifies SSO variables are set and that
  `AUTH_DISABLE_USERNAME_PASSWORD=true`.
- Fix the `rate_limit\|request_body` assertion so it cannot pass on `request_body` alone
  (this is what let P4 hide).
- Reconcile `CLAUDE.md` §12.1, §12.4 and both runbooks: the UI is no longer
  allowlist-restricted, and record *why* — with the upstream networking citation.

---

## Phase 2 — Rate limiting (build before Phase 1 Step 6)

Caddy has no built-in `rate_limit`. Build a pinned image:

```dockerfile
FROM caddy:2.11.4-builder AS builder
RUN xcaddy build v2.11.4 --with github.com/mholt/caddy-ratelimit
FROM caddy:2.11.4-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Two zones, deliberately asymmetric:

- **`/api/auth/*`** — tight. Credential stuffing has no legitimate high-rate use.
- **ingest** — deliberately loose. Sized to stop a runaway agent loop and accidental
  floods, not to police normal traffic. Calibrate once §19.1's volume measurement exists;
  a limit tuned on guesses will throttle legitimate deep traces (50–200 observations).

Verify a burst returns `429` and that `ingestion-canary.sh` still passes.

---

## Phase 3 — Backups + restore test

Tracked separately; scope to be planned. Upstream names backups as a thing Docker
Compose does not provide, and §16 priorities 3–4 are unstarted. Postgres is the crown
jewel — losing it costs every project credential and the platform's identity.

---

## Rollback

| Phase | Rollback | Time |
|---|---|---|
| 1, steps 1–5 | Remove the SSO vars, `up -d --force-recreate web`. Allowlist never changed. | ~1 min |
| 1, step 6 | Restore the `@trusted` block + `ADMIN_ALLOWLIST`, `up -d --force-recreate caddy`. Needs only SSH. | ~2 min |
| 2 | Re-pin `caddy:2.11.4-alpine`, recreate. | ~1 min |

**Break-glass, independent of both SSO and Caddy** — rehearse this once before Step 6:

```bash
ssh -L 3000:127.0.0.1:3000 deploy@5.9.95.174   # then http://localhost:3000
```

Requires `web` to publish `127.0.0.1:3000`. It does not today, so either add that to a
`compose.admin.yaml` first or use `docker compose exec web` for diagnostics.

No step in this plan touches the ingest route. Ingestion cannot break as a result of it,
and `ingestion-canary.sh` is run at every verification point to prove that.
