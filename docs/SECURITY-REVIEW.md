# Security review — Langfuse Tier 1 (Hetzner + Docker Compose)

**Date:** 2026-08-11 · **Host:** `sportnavi-langfuse.sportnavi.de` (5.9.95.174) · **Status:** review only, no changes applied

Scope: the whole externally reachable surface, not just the `ADMIN_ALLOWLIST` entry.
Every claim below was verified against the live host or the repo, not from memory.
Documentation claims were re-fetched from current Langfuse, Caddy and Tailscale docs.

---

## 1. Current architecture

```
Vercel (Eve agents, no static egress IP)
        │  OTLP/HTTPS + Basic auth (per-project pk/sk)
        ▼
Hetzner AX-class box, ufw: 22/80/443 only
        │
  Caddy 2.11.4  ── sole ingress, single vhost, ACME (ZeroSSL)
        ├─ /api/public/otel*, /api/public/ingestion*  → PUBLIC, 10MB body cap
        ├─ /api/public/health, /api/public/ready      → PUBLIC
        ├─ remote_ip ∈ ADMIN_ALLOWLIST                → everything else
        └─ fallthrough                                → 403 "Not authorized"
        │
  docker bridge `langfuse` (no published ports on any other service)
        web:3000 · worker:3030 · postgres · clickhouse · valkey · minio
```

### Verified facts

| Check | Result |
|---|---|
| Open TCP ports on 5.9.95.174 | **22, 80, 443 only.** 5432, 8123, 9000, 6379, 9001, 3000, 3030, 2019 all refused |
| `GET /` | `403` (allowlist working) |
| `GET /api/public/health` / `/ready` | `200` |
| `POST` surfaces `/api/public/otel`, `/api/public/ingestion` | reachable (`404`/`405` on GET — correct, they are POST-only) |
| `/api/public/v2/*`, `/api/public/mcp`, `/api/auth/signin`, `/auth/sign-up` | `403` from a non-allowlisted source |
| HTTP → HTTPS | `308` redirect |
| Certificate | ZeroSSL ECC DV, CN + SAN `sportnavi-langfuse.sportnavi.de`, valid 2026-08-10 → 2026-11-08 |
| Security headers | HSTS 1y + includeSubDomains, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `-Server` |
| Rate limiting | **none present** |

The core design is sound. Goals 1, 3, 6 and 10 are met today. The findings below
are about goals 2, 4, 5, 7 and about drift between `CLAUDE.md`'s claims and reality.

---

## 2. Current attack surface

**Publicly reachable, by design and correctly so:**

- `POST /api/public/ingestion` — key-authed, 10 MB body cap
- `POST /api/public/otel/v1/traces` — key-authed, 10 MB body cap
- `GET /api/public/health`, `GET /api/public/ready` — unauthenticated, needed by the off-host monitor
- TCP/22 (SSH) — key-only, root login disabled per the runbook
- TCP/80 — redirect + ACME HTTP-01 only

**Reachable only from `ADMIN_ALLOWLIST` sources:** the entire Langfuse UI, `/api/auth/*`,
the admin surface, the whole public REST API (`/api/public/v2/*`), and the MCP endpoint.

**Not reachable from the internet at all:** Postgres, ClickHouse, Valkey, MinIO, MinIO
console, the worker, the web container directly, and the Caddy admin API. Confirmed by
port probe, not just by reading compose.

**Trust model of the allowlist:** `remote_ip` matches the direct peer and `trusted_proxies`
is deliberately unset, so `X-Forwarded-For` cannot be spoofed past it. That part is correct
and should be preserved in any redesign.

---

## 3. Problems found

### P1 — Admin access depends on a dynamic residential IP · Risk: **HIGH (operational), MEDIUM (security)**

`2.214.240.43/32` is a dynamic ISP address. When it rotates you lose the UI, the REST API
*and* the MCP server simultaneously, and recovery requires SSH + log inspection + a Caddy
recreate. Your own runbook already warns against exactly this
([RUNBOOK-deploy.md:185](docs/RUNBOOK-deploy.md#L185)) and the deployment does it anyway.

The security half matters too: the released address is reassigned to another ISP customer.
Between rotation and cleanup, **a stranger holds allowlisted access to your admin surface.**
The only thing standing behind it is Langfuse's own password login. This is the single
strongest argument for removing IP-based trust rather than refreshing the IP.

### P2 — `5.9.95.174/32` is the server's own public IP · Risk: **MEDIUM**

This entry grants admin-surface trust to anything whose source address is the box itself —
including any compromised container, any other stack on the host, and any SSRF primitive
reachable from the machine. It is presumably there so on-host `curl` checks work through
the hairpin. That convenience is not worth a standing bypass of the security boundary;
on-host checks should target `web:3000` directly instead.

### P3 — `172.16.0.0/12` grants admin trust to every container on the host · Risk: **MEDIUM**

This is a /12 covering the whole Docker bridge range. Nothing in this stack needs it:
internal services reach `web:3000` directly and never traverse Caddy. It is most likely
present because `docker-proxy` rewrites the source address to the bridge gateway for
connections that originate on the host itself.

**This needs one command on the host to settle** — do not remove it blind:

```bash
docker compose exec caddy tail -50 /var/log/caddy/access.log | grep -o '"remote_ip":"[^"]*"' | sort -u
```

If nothing in the 172.x range appears for a legitimate request, the entry is dead weight
and should go. Under the recommended architecture it becomes unnecessary either way.

### P4 — No rate limiting anywhere · Risk: **MEDIUM-HIGH**

`CLAUDE.md` §12.4 states the public ingest endpoint is "protected at the reverse proxy"
by rate limiting. **It is not.** Caddy has no built-in `rate_limit` directive — it is a
third-party module ([mholt/caddy-ratelimit](https://github.com/mholt/caddy-ratelimit))
requiring an `xcaddy` build. `test-caddy-split.sh` passes only because its assertion is
`rate_limit\|request_body` and `request_body` is present.

Consequences: a compromised or leaked project key can ingest without bound until the disk
fills; a runaway agent loop can do the same accidentally; and the `/api/auth/*` login
endpoint has no brute-force protection beyond the allowlist. The 10 MB body cap bounds
*one* request, not the *rate* of requests. This is goal 7, unmet.

### P5 — Signup is not disabled · Risk: **MEDIUM**

`AUTH_DISABLE_SIGNUP` is absent from both `infra/.env` and `infra/compose.yaml`, so
self-registration is enabled. `CLAUDE.md` §12.1 claims "signup disabled after
provisioning." Today the only thing preventing a stranger from creating an account is
the IP allowlist — the same control P1 shows is unreliable.

> **Correction to an earlier draft of this finding.** Setting `AUTH_DISABLE_SIGNUP=true`
> is *not* the right fix. Per the Langfuse docs it "affects all new users that try to
> sign up, **also those who received an invite** and have no account yet" — it would
> block legitimate colleague onboarding. The control that should bound registration is
> the SSO domain restriction (`AUTH_GOOGLE_ALLOWED_DOMAINS`): an identity outside the
> domain cannot complete OAuth, so no account can be created for it. See
> [the migration plan](superpowers/plans/2026-08-11-admin-access-sso-migration.md) Step 2.

### P6 — Password login is the only authentication · Risk: **MEDIUM**

A single `LANGFUSE_INIT_USER_PASSWORD`, no SSO, no MFA, no lockout. Layered behind an IP
allowlist that is reliable this is tolerable; behind one that rotates to strangers it is
the last line of defence. Langfuse self-hosted supports SSO (Google, GitHub, Okta,
Keycloak, Authentik, …) and none of these are EE-gated per current docs.

### P7 — Certificate expiry is unmonitored · Risk: **LOW-MEDIUM**

Cert expires 2026-11-08. Caddy auto-renews, but a renewal failure (ACME outage, DNS
change, port 80 blocked) is silent until agents start failing TLS. `CLAUDE.md` §12.1
claims expiry is monitored; `scripts/health-check.sh` does not check it.

### P8 — Route matchers use prefix globs · Risk: **LOW**

`path /api/public/otel* /api/public/ingestion*` matches `/api/public/otelXYZ` and any
sibling path Langfuse may add under that prefix in a future version. Tighten to
`/api/public/otel/*`, `/api/public/otel`, `/api/public/ingestion` once the exact paths
in use are confirmed.

### P9 — Documentation asserts controls that do not exist · Risk: **LOW (compounding)**

Rate limiting (§12.4), signup disabled (§12.1), certificate monitoring (§12.1) are all
documented as present and are all absent. This manufactures the false confidence
`CLAUDE.md` §10.3 warns about. Whatever is decided, the doc must be reconciled.

### Non-findings, confirmed good

Data services unreachable · no `ports:` on any data service · `compose.local.yaml`
deliberately not named `compose.override.yaml` · `trusted_proxies` unset so XFF cannot
spoof the allowlist · deny-by-default fallthrough that responds rather than proxies ·
secrets gitignored and generated, not committed · TLS + HSTS + security headers ·
Valkey `noeviction` · per-project credentials via `provision-project.sh`.

---

## 4. The four access tiers

Making this explicit, because the current single-vhost design blurs tiers 1 and 4.

| Tier | What belongs in it | Today |
|---|---|---|
| **Public, key-authed** — must stay reachable for Vercel/Eve | `POST /api/public/ingestion`, `POST /api/public/otel/*` | ✅ correct |
| **Public, unauthenticated** — needed by the off-host monitor | `GET /api/public/health`, `GET /api/public/ready` | ✅ correct |
| **Private network only** — never leaves the host | Postgres, ClickHouse, Valkey, MinIO, worker, web:3000, Caddy admin API | ✅ correct |
| **Human-authenticated, private network** | UI, `/api/auth/*`, admin, `/api/public/v2/*`, `/api/public/mcp` | ⚠️ guarded by a rotating IP |

Note the third row of tier 4: the REST API and MCP endpoint are **key-authed but currently
behind the IP allowlist**. That is why `langfuse-cli` read-back (`CLAUDE.md` §7.6) and the
MCP server break every time your ISP rotates. Fixing tier 4 fixes all three at once.

---

## 5. Options evaluated

| | Security | Ops complexity | Cost | Reliability | Ingestion impact | Dev access |
|---|---|---|---|---|---|---|
| **A. Tailscale + Serve** | High — device identity, no public admin port at all | Low — one daemon, one command | €0 (≤3 users) / $6/user | High | **None** (separate path) | Any device, any network, no IP tracking |
| **B. Self-hosted WireGuard** | High | Medium-high — key mgmt, client config, you own the uptime | €0 | Medium — you operate it | None | Good once configured |
| **C. Cloudflare Access (Tunnel)** | High — SSO + policy | Medium — CF account, tunnel, DNS to CF | €0 (≤50 users) | High | **Risk** if ingest also proxied | Excellent, browser-based |
| **D. Caddy `basic_auth`** | Low-medium — one shared password, public admin surface | Very low | €0 | High | None | Good |
| **E. Caddy `forward_auth` + Authelia/OIDC** | High | High — extra stateful service to run and back up | €0 | Medium | None | Excellent |
| **F. Static egress IP / VPS jump host** | Medium — still IP trust, just stable | Medium | €4-5/mo | Medium | None | Requires proxying through it |
| **G. Langfuse SSO alone, admin public** | Medium — whole admin surface internet-facing | Low | €0 | High | None | Excellent |
| **H. Keep allowlist, refresh IP** | Low, degrading | High recurring toil | €0 | Low | None | Breaks on every rotation |

**Discarded and why.** D — a shared password in front of an admin console is a downgrade,
not a control. F — solves the symptom (stability) without removing IP trust, and adds a
host to patch. G — puts the login page and admin surface on the open internet, contradicting
`CLAUDE.md` §12.1. H — the status quo, which is the problem. B and E are correct but ask a
small team to operate authentication or VPN infrastructure, violating goal 8.

**C is the strongest runner-up** and worth choosing if you want browser-based SSO with no
client software. Its disqualifier here is the temptation to route ingest through Cloudflare
too, which inserts a third party into the Vercel→Langfuse path, adds a dependency that can
fail independently, and puts high-volume non-HTML API traffic on a free plan. It is viable
strictly for the *admin* hostname with ingest left on direct DNS — at which point it does
the same job as A with more moving parts and an external dependency.

---

## 6. Recommended architecture — Option A

**Separate the two surfaces onto two hostnames with two different trust models, and delete
IP-based trust entirely.**

```
Vercel agents ──HTTPS──► sportnavi-langfuse.sportnavi.de (5.9.95.174:443)
                         Caddy vhost 1 — PUBLIC
                           ├─ /api/public/ingestion   → web:3000   (key auth + rate limit)
                           ├─ /api/public/otel/*      → web:3000   (key auth + rate limit)
                           ├─ /api/public/health|ready→ web:3000
                           └─ everything else         → 403.  No allowlist. No exceptions.

You / team  ──Tailscale──► langfuse.<tailnet>.ts.net:443
                         tailscale serve → 127.0.0.1:3000
                           └─ full UI, admin, /api/public/v2/*, /api/public/mcp
                              reachable ONLY from tailnet devices + Langfuse login
```

**Mechanically:**

1. `tailscale up` on the Hetzner host, tagged `tag:langfuse`, with tailnet ACLs limiting
   which users reach it.
2. `web` publishes `127.0.0.1:3000` (loopback only — unchanged public exposure; ufw and
   the port probe stay identical).
3. `tailscale serve --bg 3000` — Tailscale provisions and renews a real Let's Encrypt cert
   for the `ts.net` name automatically. No DNS record, no ACME config, no cert to monitor.
4. The `@trusted` block and `ADMIN_ALLOWLIST` are **deleted** from the Caddyfile and `.env`.
   The public vhost becomes deny-by-default with no exceptions.
5. `NEXTAUTH_URL` moves to the `ts.net` URL (login cookies bind to origin, and the UI now
   only exists there).
6. `LANGFUSE_MCP_ALLOWED_HOSTS` and `.mcp.json` point at the `ts.net` host.

**Applied regardless of option, as defence in depth:**

7. `AUTH_DISABLE_SIGNUP=true` (P5).
8. Rate limiting on the public vhost: custom Caddy image via
   `xcaddy build --with github.com/mholt/caddy-ratelimit`, zoned per source IP on the
   ingest routes. Pinned tag, built in CI, never `latest`.
9. Certificate-expiry check added to `scripts/health-check.sh` (P7).
10. Tighten the path matchers (P8) and reconcile `CLAUDE.md` §12 with reality (P9).

### Why this is better

- **Eliminates the operational problem outright.** There is no IP to track. Your address
  can change hourly and nothing breaks — this is the actual ask, and no other option
  achieves it without either external dependencies or infrastructure you must operate.
- **Strictly stronger security.** Trust moves from "whoever currently holds this IP" to
  "an enrolled, authenticated device on your tailnet," plus the Langfuse login behind it.
  P1, P2 and P3 all disappear together because the mechanism they exploit is gone.
- **Zero risk to ingestion.** The Vercel path is untouched: same hostname, same IP, same
  certificate, same Caddy route. The admin path is added alongside, not in front. Goals 1
  and 10 are structurally protected — nothing in this change can affect agents.
- **Fixes `langfuse-cli` and MCP permanently.** Both become reachable from any tailnet
  device instead of breaking on every ISP rotation, which unblocks the §7.6 trace-audit
  loop that `INTEGRATION-PITFALLS.md` already records as obstructed.
- **Reduces the public surface** from "everything, filtered by IP" to "four endpoints."
- **Fits the existing architecture.** One daemon on the host and one compose line. No
  Kubernetes, no new stateful service, no external provider (goals 8, 9).
- **Cost:** €0 at ≤3 users, $6/user/month beyond that.

### Failure modes and recovery

| Failure | Impact | Recovery |
|---|---|---|
| Tailscale coordination server down | Cannot reach UI. **Ingestion unaffected** | Existing tailnet connections usually survive; else SSH (unchanged) and `docker compose exec web` |
| Host tailscaled crashes | Same as above | `systemctl restart tailscaled` over SSH |
| Auth key expires on the host | Node drops off tailnet | Tag the node with a non-expiring auth key at setup — **do this, it is the main foot-gun** |
| Your device loses tailnet access | No UI from that device | Any other enrolled device; or re-enrol |
| Total Tailscale failure | No UI, ingest and agents fine | SSH tunnel: `ssh -L 3000:127.0.0.1:3000 deploy@5.9.95.174` → `http://localhost:3000`. **This is the standing break-glass path and it exists today.** |

Note the shape of every row: **no failure in this design can affect Vercel ingestion**,
because the admin path shares no component with it beyond the `web` container itself.

---

## 7. Migration plan

Ordered so the current access path stays working until the new one is proven.

| # | Step | Verify | Reversible |
|---|---|---|---|
| 1 | Add cert-expiry + rate-limit assertions to `scripts/health-check.sh` / `test-caddy-split.sh` — **tests first, they should fail** | tests red | n/a |
| 2 | Install Tailscale on host, tag `tag:langfuse`, non-expiring key, ACLs | `tailscale status` from your laptop | `tailscale down` |
| 3 | Publish `web` on `127.0.0.1:3000` via a new `compose.admin.yaml` | port probe from outside still shows 22/80/443 only | remove the file |
| 4 | `tailscale serve --bg 3000`; confirm UI loads over `ts.net` | UI reachable; allowlist path **still works** | `tailscale serve reset` |
| 5 | Set `NEXTAUTH_URL` to the `ts.net` URL, `AUTH_DISABLE_SIGNUP=true`; `up -d --force-recreate web` | log in over `ts.net`; signup page rejects | revert `.env`, recreate |
| 6 | Point `.mcp.json` + `LANGFUSE_MCP_ALLOWED_HOSTS` at `ts.net`; run `ingestion-canary.sh` and an MCP query | canary passes, MCP returns traces | revert |
| 7 | **Only now:** delete `@trusted` + `ADMIN_ALLOWLIST`; `up -d --force-recreate caddy` | `curl https://<domain>/` → 403 **from every source**; health → 200; canary passes | restore the block, recreate |
| 8 | Build and deploy the rate-limited Caddy image; tune the zone | tests green; canary passes; a burst gets 429 | redeploy previous pinned tag |
| 9 | Reconcile `CLAUDE.md` §12 and the runbooks with what now exists | — | — |

Steps 2–6 are purely additive — the allowlist keeps working throughout. Step 7 is the only
cut-over, and it is a two-line revert.

**Do not skip step 4's verification.** Confirming the new path works *before* removing the
old one is what makes this a safe migration rather than a lockout risk.

## 8. Rollback plan

- **Steps 2–6:** revert the individual change; nothing else is affected.
- **Step 7 (the cut-over):** restore the `@trusted` block and `ADMIN_ALLOWLIST` in
  `infra/.env`, then `docker compose up -d --force-recreate caddy`. Requires only SSH,
  which is independent of both Tailscale and Caddy. Under 2 minutes.
- **Step 8:** re-pin the previous Caddy image tag and recreate.
- **Total loss of both paths:** `ssh -L 3000:127.0.0.1:3000 deploy@5.9.95.174` reaches the
  UI directly. Rehearse this once before step 7 so it is known-good, not theoretical.

At no point does rollback touch the ingest route, and at no point can it affect agents.

## 9. Operational runbook (new setup)

```bash
# Reach the UI — from any enrolled device, any network
https://langfuse.<tailnet>.ts.net

# Grant a colleague access
#   Tailscale admin console → invite user → assign to the ACL group for tag:langfuse
#   No server change, no Caddy recreate, no .env edit.

# Revoke access
#   Tailscale admin console → remove user / disable device. Effective immediately.

# Health, at three depths (unchanged)
bash scripts/health-check.sh https://sportnavi-langfuse.sportnavi.de
curl -s -o /dev/null -w '%{http_code}\n' https://sportnavi-langfuse.sportnavi.de/            # 403 from EVERYWHERE now
curl -s -o /dev/null -w '%{http_code}\n' https://sportnavi-langfuse.sportnavi.de/api/public/health  # 200
bash scripts/ingestion-canary.sh https://sportnavi-langfuse.sportnavi.de

# Verify the split is intact (run from a non-tailnet network)
#   403 on / and on /api/public/v2/* ; 200 on health. Any other result is a regression.

# Break-glass if Tailscale is unavailable
ssh -L 3000:127.0.0.1:3000 deploy@5.9.95.174     # then http://localhost:3000

# Tailscale health
tailscale status && tailscale serve status
systemctl restart tailscaled                      # if the node drops off
```

**Monthly:** confirm the host node still shows in `tailscale status` (catches an expired
auth key before it locks you out) and that the tailnet ACL still matches who should have
access. **Quarterly:** rehearse the break-glass SSH tunnel.

---

## 10. Decisions needed before implementation

1. **Tailscale vs Cloudflare Access** — A is recommended; C is defensible if you prefer
   browser-only access with no client software.
2. **Should `/api/public/v2/*` and `/api/public/mcp` stay private, or become public?**
   They are key-authed by design, so publishing them is not unreasonable and would simplify
   CI read-back. But a leaked key would then read all trace data from anywhere. Recommend
   keeping them private (tailnet-only); flagging it because it changes CI design.
3. **Rate-limit thresholds** — requires the volume measurement `CLAUDE.md` §19.1 still lists
   as outstanding. Suggest shipping a deliberately loose zone now (protects against runaway
   loops and floods) and calibrating once real numbers exist, rather than blocking on it.
