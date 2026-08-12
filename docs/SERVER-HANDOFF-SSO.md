# Server handoff — deploy Entra SSO + rate limiting

**For:** an agent operating on the Hetzner host (`5.9.95.174`, `/root/LangfuseMonitoring`)
**Prepared:** 2026-08-11 · **Background:** [archive/SECURITY-REVIEW-2026-08-11.md](archive/SECURITY-REVIEW-2026-08-11.md) (archived) ·
[migration plan](superpowers/plans/2026-08-11-admin-access-sso-migration.md)

You are deploying a change to how the Langfuse **admin UI** is protected. Read this
entire file before running anything.

---

## What problem this solves

Today the UI is gated by `ADMIN_ALLOWLIST`, a list of IP CIDRs in `infra/.env`. The
operator's entry is a **dynamic residential IP**. When it rotates they lose the UI, the
REST API and the MCP endpoint at once — and the released address is reassigned to another
ISP customer, who then holds allowlisted access to the admin surface until someone
notices.

The fix replaces network trust with identity: **Microsoft Entra ID SSO**, single-tenant
to `sportnavi.de`. Justified by Langfuse's own guidance — the `langfuse/langfuse`
container "is designed to be exposed publicly as a web service and has undergone
penetration testing," and is the same image serving Langfuse Cloud.

Rate limiting ships first, because publishing a login page without brute-force
protection is not defensible.

---

## Hard rules

1. **Never touch the ingest path.** `/api/public/otel*` and `/api/public/ingestion*`
   must stay reachable throughout. Agents on Vercel depend on them, and
   `CLAUDE.md` requirement 10 says agents must never fail because of Langfuse.
   Run `scripts/ingestion-canary.sh` after every step that recreates a container.
2. **Do not remove `ADMIN_ALLOWLIST` until Gate C below passes.** That is the only
   irreversible-feeling step, and it must not happen on your own judgement.
3. **Never commit secrets.** `infra/.env` is gitignored. Keep it that way.
4. **`docker compose restart` does NOT reload `.env`.** Environment variables bake in at
   container *creation*. Always `docker compose up -d --force-recreate <svc>`.
5. **Do not run `docker compose down -v`.** It destroys all trace history and every
   project credential.
6. **Deploy one service at a time**, verifying between. If something breaks you then know
   which change did it.

---

## Preconditions

```bash
cd /root/LangfuseMonitoring && git pull
docker compose -f infra/compose.yaml ps      # all services up; web+worker (healthy)
bash scripts/health-check.sh https://sportnavi-langfuse.sportnavi.de
```

The Entra app registration is **already configured and verified** — single tenant,
correct redirect URI, `email` claim present, and its credentials were confirmed to issue
a token. Do not modify anything in Azure.

| Value | |
|---|---|
| `AUTH_AZURE_AD_CLIENT_ID` | `03f90999-0120-4dcb-8728-171d6466406d` |
| `AUTH_AZURE_AD_TENANT_ID` | `8238d906-9211-4059-89e2-36142daa7205` |
| `AUTH_AZURE_AD_CLIENT_SECRET` | **ask the operator** — never in git, expires 2027-02-07 |

---

## Step 1 — Deploy rate limiting (Caddy)

The Caddyfile now uses `rate_limit`, which is **not** a stock Caddy directive. Compose
builds a custom image (`infra/caddy/Dockerfile`) with the module compiled in. All inputs
are pinned; the Dockerfile fails the build if the module did not link in.

```bash
cd /root/LangfuseMonitoring/infra
docker compose build caddy
docker compose up -d --force-recreate caddy
docker compose logs caddy --tail 30
```

**Verify — all four must hold:**

```bash
D=https://sportnavi-langfuse.sportnavi.de
curl -s -o /dev/null -w 'UI      %{http_code} (expect 403)\n' $D/
curl -s -o /dev/null -w 'health  %{http_code} (expect 200)\n' $D/api/public/health
bash ../scripts/ingestion-canary.sh $D          # must pass
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code} ' $D/api/auth/session; done; echo
# expect ~30x 200 then 429s. 429 here is the rate limiter working, not a fault.
```

> If Caddy fails to start, the config did not parse and there is **no ingress at all**.
> Roll back immediately: set `image: caddy:2.11.4-alpine` in `compose.yaml`, remove the
> `build:` block and both `rate_limit { ... }` blocks from `infra/caddy/Caddyfile`, then
> `docker compose up -d --force-recreate caddy`. Those changes go together.

---

## Step 2 — Deploy SSO (web), with the allowlist still enforcing

Ask the operator for the client secret. Add to `infra/.env`:

```env
AUTH_AZURE_AD_CLIENT_ID=03f90999-0120-4dcb-8728-171d6466406d
AUTH_AZURE_AD_CLIENT_SECRET=<from the operator>
AUTH_AZURE_AD_TENANT_ID=8238d906-9211-4059-89e2-36142daa7205
# Required on this deployment: every account predates SSO. Without it the very
# first SSO login fails with OAuthAccountNotLinked. See pitfall 13.
AUTH_AZURE_AD_ALLOW_ACCOUNT_LINKING=true
```

**Leave `AUTH_DISABLE_USERNAME_PASSWORD=false`.** Step 4 turns it on, and not before.

```bash
docker compose up -d --force-recreate web
docker compose logs -f web --tail 60      # watch for the azure-ad provider registering
bash ../scripts/ingestion-canary.sh https://sportnavi-langfuse.sportnavi.de
```

**Verify the variables actually reached the container** — `web` enumerates its
environment explicitly in `compose.yaml`, so anything present only in `.env` is dropped
silently and `--force-recreate` still reports success (pitfall 14):

```bash
docker inspect langfuse-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E 'AUTH_AZURE_AD_(CLIENT_ID|ALLOW_ACCOUNT_LINKING)'
```

If a variable is missing, add it to the `web` `environment:` block in `compose.yaml`
first. Editing `.env` alone will not fix it.

`ADMIN_ALLOWLIST` is untouched here. If SSO is broken, nothing is lost.

### 🚦 GATE A — human required

The operator must, from an allowlisted IP:

1. See a **"Sign in with Microsoft"** button on the login page. On Langfuse v4.6.0 this
   renders as **"Azure AD"** — the same provider, a different label.
2. Log in successfully with their `@sportnavi.de` account. Note this is **not** the
   address on the pre-existing password account, which is a personal one — the two
   identities sit in different organisations and land on different dashboards.

**You cannot verify the login itself.** Once they confirm, the link is durably checkable
in Postgres — a successful page load is not evidence, a row is:

```bash
docker compose exec -T postgres psql -U langfuse -d langfuse \
  -c 'select u.email, a.provider, a.type from "Account" a join users u on u.id=a.user_id;'
```

Expect `azure-ad | oauth` against the `@sportnavi.de` address. An empty table means no
SSO login has ever completed, whatever the operator saw. Note the table is `"Account"`
(quoted, capitalised) — `accounts` does not exist.

---

## Step 3 — Confirm an SSO identity owns the org

### 🚦 GATE B — human required, and the one that can lock everyone out

`LANGFUSE_INIT_USER_EMAIL` (`platform@example.com`) logs in with a password. Step 4
disables password login entirely. **If no Entra identity holds `OWNER` on the
organisation at that moment, the platform is left with no reachable administrator** —
recoverable only by editing Postgres directly.

The operator must confirm, while logged in via SSO, that their account holds `OWNER`.
Get an explicit "yes" naming the role. Do not infer it from a successful login.

---

## Step 4 — Make SSO the only way in

Only after Gates A and B. In `infra/.env`:

```env
AUTH_DISABLE_USERNAME_PASSWORD=true
```

```bash
docker compose up -d --force-recreate web
```

**Verify by attempting the login, not by reading `/api/auth/providers`.** That endpoint
still lists `credentials` after the flag takes effect — it reflects NextAuth's registered
providers, not enforcement. See [DEPLOYMENT-PITFALLS.md #11](DEPLOYMENT-PITFALLS.md).

```bash
CSRF=$(curl -s -c /tmp/j https://sportnavi-langfuse.sportnavi.de/api/auth/csrf \
       | grep -oE '"csrfToken":"[^"]+' | cut -d'"' -f4)
curl -s -b /tmp/j -X POST -d "csrfToken=$CSRF" \
  --data-urlencode "email=platform@example.com" \
  --data-urlencode "password=$LANGFUSE_INIT_USER_PASSWORD" \
  -d json=true -d redirect=false \
  https://sportnavi-langfuse.sportnavi.de/api/auth/callback/credentials
# expect: error=Sign in with email and password is disabled for this instance.
```

Then confirm SSO login still works. This whole sequence was rehearsed locally against a
throwaway stack before this document was written, and behaved exactly as above.

### 🚦 GATE C — human required, and NOT automatable

The operator must attempt to sign in with a Microsoft account **outside** the
`sportnavi.de` tenant (a personal outlook.com account, or any other org) and confirm it
is **rejected**.

This is the entire security control. Entra has no allowed-domains setting — the lock is
the app registration's single-tenant `signInAudience`, which is verified in config
(`bash scripts/test-entra-app.sh <manifest.json>`) but must also be proven at runtime.

> **Do not attempt to verify this by probing `login.microsoftonline.com` unauthenticated.**
> Two such checks were written during this work and both produced false passes; Azure
> defers those errors until after sign-in. See
> [DEPLOYMENT-PITFALLS.md #10](DEPLOYMENT-PITFALLS.md). A second account is the only
> reliable test.

**If an out-of-tenant account gets in: STOP. Do not proceed to Step 5.** Report it.

---

## Step 5 — Remove `ADMIN_ALLOWLIST` (the cut-over)

**Requires explicit operator approval. Gates A, B and C must all have passed.**

In `infra/caddy/Caddyfile`, replace the `@trusted` handler with an unconditional one:

```caddyfile
# UI/admin. Public by design — access control is identity (Entra SSO, single-tenant),
# not network position.
handle {
    route {
        rate_limit {
            zone auth {
                match { path /api/auth/* }
                key    {remote_host}
                events 30
                window 1m
            }
        }
        reverse_proxy web:3000
    }
}
```

Delete the `@trusted` matcher, the old `handle @trusted` block, **and** the trailing
deny-by-default `handle { respond "Not authorized" 403 }` — with the catch-all now
proxying, a leftover 403 handler would black-hole the UI. Re-read the file and confirm
exactly one catch-all `handle` exists.

Then remove `ADMIN_ALLOWLIST` from `infra/.env` and from the `caddy` service in
`compose.yaml`, and:

```bash
docker compose up -d --force-recreate caddy
```

**Verify from a network that was never allowlisted** (ask the operator to test from
mobile data):

```bash
curl -s -o /dev/null -w 'UI      %{http_code} (expect 200 login page)\n' $D/
curl -s -o /dev/null -w 'health  %{http_code} (expect 200)\n' $D/api/public/health
bash ../scripts/ingestion-canary.sh $D    # must still pass
```

**Rollback (~2 min, needs only SSH):** restore the `@trusted` block and
`ADMIN_ALLOWLIST`, then `docker compose up -d --force-recreate caddy`.

---

## Step 6 — Reconcile tests and docs

`scripts/test-caddy-split.sh` asserts a deny-by-default `respond 403` handler exists.
After Step 5 that is gone by design, so **the test will fail** and must be updated to
assert the new shape: ingest and health public, UI proxied, rate limiting present on both
`/api/auth/*` and ingest.

Also update `CLAUDE.md` §12.1 (the UI is no longer allowlist-restricted — record why,
citing <https://langfuse.com/self-hosting/security/networking>) and §12.4 (rate limiting
now genuinely exists). Update `docs/RUNBOOK-deploy.md` §13–15, which still describe
allowlist management as the way to grant UI access.

Add a calendar reminder: **the Entra client secret expires 2027-02-07.** An expired
secret locks every user out of the UI with no warning.

---

## Break-glass

If the UI is unreachable by every route, `web` is still directly accessible on the host:

```bash
docker compose exec web wget -qO- http://127.0.0.1:3000/api/public/ready
```

For browser access, publish it to loopback and tunnel in:

```bash
# on the server, temporarily:  ports: ["127.0.0.1:3000:3000"] on the web service
ssh -L 3000:127.0.0.1:3000 deploy@5.9.95.174    # then http://localhost:3000
```

Ingestion is independent of all of this and should keep working throughout. If it ever
stops, that is the priority — not the UI.

---

## Summary of gates

| Gate | Who | Blocks |
|---|---|---|
| A — SSO login works | operator, allowlisted IP | Step 3 |
| B — SSO identity holds `OWNER` | operator | Step 4 |
| C — out-of-tenant account rejected | operator, second account | Step 5 |
| Cut-over approval | operator, explicit | Step 5 |

Steps 1, 2, 4 and 6 you can execute. Gates A, B and C you cannot — they need a human with
a browser and a second Microsoft account. Do not simulate them, and do not treat a
config-level check as a substitute for one.
