# Grafana SSO — Microsoft Entra ID

Puts the monitoring UI behind the same directory as Langfuse, so access is granted and
revoked in one place instead of by sharing a password.

**Status: prepared, not enabled.** Every variable ships defaulted to off. Until
`GRAFANA_SSO_ENABLED=true` is set in `infra/.env`, Grafana behaves exactly as it did
before this document existed. Enabling is an `.env` change plus a container recreate — no
code change, no image change.

---

## 1. What is and is not available

Entra ID OAuth is a **Grafana OSS feature**. No licence is required for anything below.

| Capability | Available | Notes |
|---|---|---|
| Entra ID sign-in | ✅ OSS | `[auth.azuread]` |
| Role mapping via app roles | ✅ OSS | `Viewer` / `Editor` / `Admin` / `GrafanaAdmin` |
| Tenant restriction | ✅ OSS | `allowed_organizations` |
| Group restriction | ✅ OSS | `allowed_groups` — not used here, see §7 |
| Server-admin via directory | ✅ OSS | `allow_assign_grafana_admin` |
| Team Sync | ❌ Enterprise | Not needed |
| `org_mapping` / `org_attribute_path` | ❌ Enterprise | Multi-org only; this is a single-org install |

Verified against Grafana 13.0.6, the pinned image.

---

## 2. Why a separate app registration

Grafana gets its **own** app registration in the **same tenant** as Langfuse. Sharing
Langfuse's (`03f90999-…`) would be a mistake in three separate ways:

- **Redirect URIs are per-application.** Grafana's callback is `/login/azuread`,
  Langfuse's is `/api/auth/callback/azure-ad`. One registration would have to carry both,
  so a misconfiguration in one app becomes reachable from the other.
- **App roles collide.** Grafana reads `Viewer`/`Editor`/`Admin`/`GrafanaAdmin` from the
  roles claim. Langfuse does not use app roles at all. Adding them to the shared
  registration changes the token every Langfuse user receives.
- **Blast radius.** One client secret, expiring or leaked, would take down the platform
  and the monitoring that tells you the platform is down — at the same moment.

Same tenant is what delivers centralised access management. Same *registration* delivers
nothing except coupling.

---

## 3. Create the app registration

Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.

1. **Name:** `Langfuse Monitoring (Grafana)`
2. **Supported account types:** *Accounts in this organizational directory only*
   (`AzureADMyOrg`). This is the tenant lock — see §7.
3. **Redirect URI:** platform **Web**, value:

   ```
   https://deploy-ui.sportnavi.de/login/azuread
   ```

   Must be platform *Web*, not *SPA* and not *Public client*. A URI registered under the
   wrong platform fails at login with `AADSTS50011` and reads like a Grafana bug.

4. **Certificates & secrets** → new client secret. Record the **Value** (not the Secret
   ID). Note the expiry date somewhere you will actually see it — an expired secret locks
   out every SSO user with no warning.

5. **Token configuration** → **Add optional claim** → **ID** → `email`.
   Grafana identifies users by email address. Without this claim the OAuth handshake
   completes and *then* fails to map to a user.

6. **App roles** → create four, each with **Allowed member types: Users/Groups**. The
   `value` field is what Grafana matches, and it is case-sensitive:

   | Display name | Value | Grants |
   |---|---|---|
   | Viewer | `Viewer` | Read dashboards |
   | Editor | `Editor` | Edit dashboards and data sources |
   | Admin | `Admin` | Organisation admin |
   | Grafana Admin | `GrafanaAdmin` | Grafana **server** admin |

7. **Enterprise applications** → the new app → **Users and groups** → assign people (or a
   group) to a role. **Do this before enabling SSO.** An identity with no role assigned is
   admitted as a Viewer while `GRAFANA_SSO_ROLE_STRICT=false`, and refused outright once
   it is `true`.

### Verify the registration before enabling anything

`scripts/test-entra-app.sh` already does this — point it at Grafana's redirect URI:

```bash
# Portal -> App registrations -> <app> -> Manifest -> copy to a file
EXPECTED_REDIRECT=https://deploy-ui.sportnavi.de/login/azuread \
  bash scripts/test-entra-app.sh grafana-app-manifest.json
```

It checks single-tenant audience, the redirect URI under the right platform, the `email`
claim, and secret expiry. It does **not** check app roles — `scripts/test-grafana-sso.sh`
does that, along with the runtime checks.

---

## 4. Enable it

In `infra/.env`:

```env
GRAFANA_SSO_ENABLED=true
GRAFANA_AZURE_AD_CLIENT_ID=<Application (client) ID>
GRAFANA_AZURE_AD_CLIENT_SECRET=<the secret Value>
```

`AUTH_AZURE_AD_TENANT_ID` is reused from the Langfuse block — same directory, so there is
no second tenant id to keep in sync.

Then, from `infra/`:

```bash
docker compose -f compose.yaml -f compose.monitoring.yaml up -d grafana
```

Only Grafana is recreated. Dashboards are provisioned from disk and survive; nothing in
the ingestion path is touched.

---

## 5. Cut-over, in the order that cannot lock you out

The local admin stays enabled throughout. It is switched off only in step 5, and only
after a real Entra login has worked.

1. `GRAFANA_SSO_ENABLED=true`, recreate Grafana. The login page now offers **both** the
   local form and a *Microsoft Entra ID* button.
2. Run `bash scripts/test-grafana-sso.sh`. It proves what Grafana will actually send to
   Entra, which is where `root_url` mistakes surface.
3. **Sign in as a real user through the Entra button.** This is the only step that proves
   anything. Confirm in Grafana → Administration → Users that the account exists and
   carries the role you assigned in step 3.7.
4. Tighten: `GRAFANA_SSO_ROLE_STRICT=true`, recreate, sign in again to confirm your own
   role still resolves.
5. Only now: `GRAFANA_DISABLE_LOGIN_FORM=true`, recreate. Keep one browser session already
   signed in while you do this, so a mistake is recoverable without touching the server.

> Steps 3 and 5 are separated on purpose. Every SSO lockout this project has had came from
> disabling the fallback in the same change that introduced the provider.

---

## 6. Verification, and what it is worth

```bash
bash scripts/test-grafana-sso.sh
```

| Check | Proves |
|---|---|
| Provider registered | Grafana parsed the config and offers the button |
| Authorize redirect | The real `client_id`, `redirect_uri`, `scope` and PKCE Grafana emits |
| `redirect_uri` matches `root_url` | Catches the silent `GF_SERVER_ROOT_URL` mistake |
| Local admin still authenticates | Break-glass intact |
| App roles present in manifest | The four values Grafana matches on exist |

What it cannot prove: that a human can sign in. Entra will not complete an authorization
code flow for an unauthenticated script, by design.

> **Read a capability endpoint, learn nothing.** `DEPLOYMENT-PITFALLS.md` #11 is the
> Langfuse version of this: `/api/auth/providers` kept listing `credentials` after password
> login was disabled, and the flag had in fact worked. The same trap exists here in both
> directions. A provider listed in Grafana's config is not a provider that works, and a
> provider missing from it is not proof you are safe. Attempt the sign-in.

---

## 7. Traps

**The tenant lock is two settings, not one.** `signInAudience=AzureADMyOrg` on the
registration and `allowed_organizations=<tenant id>` in Grafana. Entra has no
allowed-domains concept, so these are what stop an identity from another directory. Set
both; either alone is a single point of failure.

**`allowed_groups` is deliberately unused.** Group object IDs would restrict access
further, but Entra omits the `groups` claim entirely once a user is in more than ~200
groups, substituting an overage claim — at which point access silently breaks for exactly
the most group-heavy users. Working around it means `force_use_graph_api=true` and extra
Graph permissions. App-role assignment (§3.7) achieves the same control without the cliff.

**Role changes apply at next login, not immediately.** Grafana resyncs org roles on each
sign-in. Revoking a role in Entra does not end an existing session — remove the user's
assignment *and* expect a session to persist until it expires.

**Grafana matches users by email.** An Entra identity whose email matches no existing
Grafana user creates a new one. The only pre-existing account here is the local `admin`,
which has no email address, so no collision is expected — but Langfuse's
`OAuthAccountNotLinked` failure (`DEPLOYMENT-PITFALLS.md` #13) was this same class of
problem, so check Administration → Users after the first login rather than assuming.

**An expired client secret is a silent, total outage of the UI.** Not of ingestion, not of
the dashboards' data — just of everyone's ability to look at them. This is the entire
reason the local admin account stays.

---

## 8. What SSO does not replace

`ADMIN_ALLOWLIST` in the Caddyfile stays. SSO is identity; the allowlist is network reach,
and `CLAUDE.md` §12.1 puts the UI behind VPN/allowlist regardless of who is authenticating.
The two answer different questions and the second one still limits what an attacker with a
stolen session cookie can even connect to.

Relaxing the allowlist because SSO is now in place is a deliberate policy decision, not a
consequence of this change. If it is taken, take it separately and record the reasoning.

---

## 9. Rollback

```env
GRAFANA_SSO_ENABLED=false
GRAFANA_DISABLE_LOGIN_FORM=false
```

then recreate Grafana. The local admin account works again immediately; it was never
removed. No data, dashboard or datasource is affected — Grafana's SSO state lives entirely
in these environment variables and the users table.
