# Deployment Pitfalls — Langfuse Self-Hosting

Every failure below was hit while standing up Stage 1A, diagnosed to root cause, and
fixed. They are recorded because **none of them were obvious from the documentation**,
several produced misleading symptoms, and two were masked by tests that passed anyway.

Read this before changing `infra/compose.yaml` or the ClickHouse config.

**The recurring theme:** every one of these presented as a *different* problem than it
was. A config that crashes the server looked like a valid config. A service listening
correctly looked unhealthy. An app that never started looked like an app that was
slow to start. Diagnose to root cause; do not treat symptoms.

---

## Severity index

| # | Issue | Symptom | Blast radius |
|---|---|---|---|
| 1 | ClickHouse `<engine>` vs `<partition_by>`/`<ttl>` | Server exits 36 at startup | Platform never starts |
| 2 | `config.d` mounted as a directory | ClickHouse migrations fail | Platform never starts |
| 3 | Healthcheck via `localhost` on IPv6-disabled hosts | Healthy service marked unhealthy | Web/worker never start |
| 4 | `LANGFUSE_S3_MEDIA_UPLOAD_BUCKET` missing | Startup failure | Platform never starts |
| 5 | MinIO buckets not auto-created | Startup failure | Platform never starts |
| 6 | Valkey rejected by BullMQ version check | Worker refuses to start | No ingestion |
| 7 | CRLF line endings from Windows | `bad interpreter: ...^M` | All scripts broken |
| 8 | Stale image tag from the plan | `manifest unknown` on pull | Deploy fails |
| 9 | Bind-mount edit does not restart service | Fix appears not to work | Wasted debugging time |

> **Issues 10–15 were found during the first real server deploy** and live in
> [`RUNBOOK-deploy.md` §5A](RUNBOOK-deploy.md#5a-failures-hit-during-the-first-real-server-deploy-2026-08-10):
> ports 80/443 already bound · Next.js binding `$HOSTNAME` · v4 `events_only`
> retiring the ingestion/read APIs · invalid hostname · the allowlist 403 read as
> an outage · `.env` needing `--force-recreate`.
>
> They are kept beside the deploy sequence because that is where they bite. None of
> them reproduce locally.

| # | Issue | Symptom | Blast radius |
|---|---|---|---|
| 10 | `AADSTS50194` as a multi-tenant signal | Wrong conclusion about the app | Misdiagnosis |
| 11 | `/api/auth/providers` lists `credentials` | Looks like password login is live | Misdiagnosis |
| 12 | Rotating `.env` does not rotate the Postgres password | Web crash-loops on `P1000` | **Platform down, ingest included** |
| 13 | Pre-SSO accounts cannot be signed into via Entra | `OAuthAccountNotLinked` | No admin can use SSO |
| 14 | A variable in `.env` never reaches the container | Setting silently has no effect | Any config change, silently |

---

## 1. ClickHouse rejects `<engine>` mixed with `<partition_by>` / `<ttl>`

**Symptom.** ClickHouse exits with code 36 immediately at startup. Container logs stop
after `Logging errors to /var/log/clickhouse-server/clickhouse-server.err.log` — the
actual error is only in that file, not on stdout.

```
Code: 36. DB::Exception: If 'engine' is specified for system table, PARTITION BY
parameters should be specified directly inside 'engine' and 'partition_by' setting
doesn't make sense. (BAD_ARGUMENTS)
```

**Root cause.** ClickHouse's stock `config.xml` already defines system-log tables. An
overlay in `config.d` **merges** with those definitions rather than replacing them, so
adding `<engine>` collides with the inherited `<partition_by>`. Fixing that by
switching to a bare `<ttl>` then produces the *mirror-image* error on
`opentelemetry_span_log`, because that one table ships with an `<engine>` upstream.

**Which form is legal depends entirely on what the stock config ships per table:**

| Stock definition | Tables | Correct override |
|---|---|---|
| `<partition_by>` | `query_log`, `trace_log`, `part_log` | bare `<ttl>` |
| neither | `metric_log`, `asynchronous_metric_log` | bare `<ttl>` |
| `<engine>` | `opentelemetry_span_log` | `replace="replace"`, TTL **inside** the engine |

**Fix.** See [`infra/clickhouse/config.d/langfuse-ttl.xml`](../infra/clickhouse/config.d/langfuse-ttl.xml),
which documents the mapping inline. Verified against ClickHouse 25.12.

**Do not normalise the file to one consistent form.** It is inconsistent because the
upstream defaults are inconsistent. Check what ships before adding a table:

```bash
docker run --rm --entrypoint sh clickhouse/clickhouse-server:25.12-alpine -c \
  'sed -n "/<query_log>/,/<\/query_log>/p" /etc/clickhouse-server/config.xml'
```

**Why it wasn't caught.** The original test grepped the XML for expected strings. It
passed against a config that prevented the server from starting at all. `scripts/test-clickhouse-ttl.sh`
now boots a throwaway ClickHouse and requires it to serve.

> **Lesson: a config test that does not start the software tests nothing.**

---

## 2. Mounting `config.d` as a directory hides the image's own config

**Symptom.** ClickHouse reports healthy, but web fails every startup with:

```
error: failed to open database: dial tcp 172.19.0.5:9000: connect: connection refused
  in line 0: SHOW TABLES FROM "default" LIKE 'schema_migrations'
Applying clickhouse migrations failed.
```

The suggested causes in that error — database unreachable, unescaped password — are
both **red herrings** here.

**Root cause.** This mount replaces the whole directory:

```yaml
- ./clickhouse/config.d:/etc/clickhouse-server/config.d:ro     # WRONG
```

which hides the image's own `docker_related_config.xml`, the file that sets
`<listen_host>` so ClickHouse binds all interfaces. Without it ClickHouse binds
loopback only. It runs perfectly — just unreachable from other containers.

**Fix.** Mount the file, never the directory:

```yaml
- ./clickhouse/config.d/langfuse-ttl.xml:/etc/clickhouse-server/config.d/langfuse-ttl.xml:ro
```

**How to detect.** Confirm the image's own config still merges at startup:

```bash
docker compose logs clickhouse | grep "Merging configuration file"
# must list docker_related_config.xml AND langfuse-ttl.xml
```

> **Lesson: bind-mounting a directory into a container erases what the image put there.
> Mount individual files into directories the image also populates.**

---

## 3. Healthchecks using `localhost` fail where IPv6 is disabled

**Symptom.** ClickHouse is `(unhealthy)` while demonstrably serving. `netstat` inside
the container shows `0.0.0.0:8123` and `0.0.0.0:9000` LISTEN, restart count is 0, and
memory is fine — yet the probe reports `wget: can't connect to remote host: Connection refused`.

Because web and worker declare `depends_on: {clickhouse: {condition: service_healthy}}`,
they stay in `Created` and **never start**. The browser shows `ERR_EMPTY_RESPONSE`,
which looks exactly like an app still booting.

**Root cause.** `localhost` resolves to `::1` before `127.0.0.1`. Where IPv6 is
disabled — common in Docker Desktop VMs and on hardened hosts — the service never bound
`::1`, so the probe is refused. The service is healthy; the probe is wrong.

Corroborating warning in the ClickHouse error log:

```
Listen [::]:8123 failed: ... DNS error: EAI: Address family for hostname not supported
```

**Fix.** Address the loopback interface explicitly in every healthcheck:

```yaml
test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8123/ping"]     # not localhost
```

**This is not local-only.** Any host with IPv6 disabled hits it, including the Hetzner
box. Check before blaming the application:

```bash
docker inspect <container> --format '{{json .State.Health.Log}}'
docker compose exec <svc> netstat -ltn      # is it actually listening?
```

> **Lesson: `depends_on: service_healthy` converts a broken healthcheck into a
> silent, total outage of everything downstream. A wrong probe is as damaging as a
> broken service — and much harder to recognise.**

---

## 4. Langfuse v4 requires a media upload bucket

**Symptom.** Web exits at startup complaining about missing configuration.

**Root cause.** v4 requires **both** `LANGFUSE_S3_EVENT_UPLOAD_BUCKET` and
`LANGFUSE_S3_MEDIA_UPLOAD_BUCKET`. Guides written against v3 only mention the first.

**Fix.** Both blocks are in [`infra/.env.example`](../infra/.env.example). One MinIO
bucket serves both, separated by `events/` and `media/` prefixes.

---

## 5. MinIO does not create buckets on its own

**Symptom.** Web and worker fail at startup against a healthy MinIO.

**Root cause.** MinIO starts empty. Langfuse expects its buckets to exist.

**Fix.** The `minio-init` service in `compose.yaml` creates both with
`mc mb --ignore-existing` and gates web/worker behind
`condition: service_completed_successfully`. It is idempotent and safe to re-run.

---

## 6. Valkey and the BullMQ version check

**Symptom.** Worker refuses to start, citing an unsupported Redis version.

**Root cause.** Valkey reports its own version string. BullMQ's Redis version check can
reject it even though Valkey 8 is wire-compatible with Redis 7.2.

**Fix.** `LANGFUSE_BULLMQ_SKIP_REDIS_VERSION_CHECK: "true"` is set in `compose.yaml`.
Re-evaluate on any Valkey major upgrade — the skip suppresses a real compatibility
check, so the wire-compatibility assumption must be re-validated, not assumed.

---

## 7. CRLF line endings break every script

**Symptom.** On the Linux host, scripts fail with `bad interpreter: /usr/bin/env bash^M`.
Docker healthchecks and entrypoints fail in similarly opaque ways.

**Root cause.** The repo is authored on Windows; Git converts LF to CRLF on checkout by
default. Every artifact here runs on Linux.

**Fix.** [`.gitattributes`](../.gitattributes) forces `eol=lf` for `*.sh`, `*.yaml`,
`*.xml`, and `Caddyfile`. Never remove it. If scripts start failing mysteriously after
a clone, check line endings first: `file scripts/*.sh`.

---

## 8. Pin versions — but verify the tag exists

**Symptom.** `docker compose pull` fails with `manifest unknown`.

**Root cause.** The implementation plan specified `langfuse/langfuse:3.140.0`. That tag
never existed, and Langfuse had moved to v4 (current: **4.6.0**).

**Fix.** Verify every tag against the registry before pinning:

```bash
docker manifest inspect langfuse/langfuse:4.6.0 >/dev/null && echo OK
```

Pinning remains mandatory — but an unverified pin fails at pull time, on the server,
during a deploy window. **Web and worker tags must always match.**

---

## 9. Editing a bind-mounted file does not restart the service

**Symptom.** You fix a config, run `docker compose up -d`, and the old behaviour
persists — making a correct fix look wrong.

**Root cause.** Compose diffs the *container spec*. A changed file behind a bind mount
is not a spec change, so nothing is recreated.

**Fix.**

```bash
docker compose up -d --force-recreate <service>
```

Confirm you are testing the fix and not the old container:

```bash
docker inspect <container> --format '{{.State.StartedAt}}'
```

---

## 10. `AADSTS50194` cannot be used to detect a multi-tenant Entra app

**Symptom.** A script probes `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
for an app registration and treats the response as a tenancy test:
`AADSTS50194` returned → single tenant; sign-in page served → multi-tenant.
It reports **multi-tenant for an app the portal plainly shows as
`Nur meine Organisation` (single tenant)**.

**Root cause.** For the `/common` and `/organizations` authorities, Azure does not know
which tenant the user belongs to until they enter an identity — home realm discovery
happens *after* the sign-in page is served. `AADSTS50194` is therefore raised
**post-authentication**, and an unauthenticated probe sees the sign-in page in both the
single- and multi-tenant cases. The probe cannot distinguish them at all; it returns the
same answer for every app and is indistinguishable from a real finding.

**Fix.** The authoritative value is `signInAudience` in the app manifest, which is not
publicly readable and must be supplied by the operator or read via Graph:

| `signInAudience` | Who can sign in |
|---|---|
| `AzureADMyOrg` | this tenant only — **the only correct value here** |
| `AzureADMultipleOrgs` | any work/school account, any tenant |
| `AzureADandPersonalMicrosoftAccount` | the above, plus personal accounts |
| `PersonalMicrosoftAccount` | personal accounts only |

`scripts/test-entra-single-tenant.sh` now asserts the supplied value and separately
checks what *is* reliably probeable unauthenticated — that the client id resolves and
the redirect URI is registered (`AADSTS50011` fires pre-authentication, so that one is
a valid test). The runtime proof — signing in with an out-of-tenant account and
confirming rejection — remains required and is not replaceable by any config check.

> **Lesson: run a known-good control before trusting a new test.** The bad method was
> caught only because it was pointed at an app whose correct state was visible in a
> screenshot. A test that returns the same verdict for every input is worthless, and
> without a control it is indistinguishable from one that works. This nearly produced
> the worst possible outcome — replacing an IP allowlist with an authentication check
> believed to be verified and in fact never tested.

---

## 11. `/api/auth/providers` still lists `credentials` after disabling password login

**Symptom.** `AUTH_DISABLE_USERNAME_PASSWORD=true` is set and confirmed present inside
the container (`docker exec langfuse-web-1 printenv | grep AUTH_`), yet
`GET /api/auth/providers` still returns a `credentials` entry alongside `azure-ad`.
Reads as "the flag did not work."

**It did work.** The providers endpoint reflects NextAuth's registered provider list,
not the enforcement decision. Attempting the login proves it:

```bash
CSRF=$(curl -s -c /tmp/j http://127.0.0.1:3000/api/auth/csrf | grep -oE '"csrfToken":"[^"]+' | cut -d'"' -f4)
curl -s -b /tmp/j -X POST -d "csrfToken=$CSRF" \
  --data-urlencode "email=$EMAIL" --data-urlencode "password=$PASSWORD" \
  -d json=true -d redirect=false \
  http://127.0.0.1:3000/api/auth/callback/credentials
# -> {"url":".../api/auth/error?error=Sign%20in%20with%20email%20and%20password%20is%20disabled..."}
curl -s -b /tmp/j http://127.0.0.1:3000/api/auth/session    # -> {}  (no session)
```

**Why it matters in both directions.** Someone verifying the cut-over by reading
`/api/auth/providers` would conclude the control failed and roll back a change that was
working. Worse, the same reasoning inverted — "the endpoint no longer lists it, so we are
safe" — would be an equally unfounded conclusion from the same untrustworthy signal.

> **Lesson: verify an auth control by attempting the authentication, not by reading a
> config or capability endpoint.** The same class as issue 10 and as the
> `rate_limit\|request_body` assertion: a proxy signal that correlates with the thing you
> care about, right up until it doesn't.

---

## 12. Rotating secrets in `.env` does not rotate the Postgres password

**Symptom.** `langfuse-web` crash-loops. Postgres, ClickHouse, Redis and MinIO all report
`(healthy)`. The web log repeats:

```
Error: P1000: Authentication failed against database server,
the provided database credentials for `langfuse` are not valid.
```

`caddy` sits in `Created` and never starts, so the UI *and* the public ingest path are both
down — while `docker compose ps` shows five of six services healthy.

**Root cause.** The `postgres` image applies `POSTGRES_PASSWORD` **only when it initialises
an empty data directory**. On every subsequent start the value is ignored and the role keeps
whatever password it was created with. So when `infra/.env` is regenerated against an
existing `postgres_data` volume:

| Service | Password source | Rotates on recreate? |
|---|---|---|
| Redis/Valkey | `--requirepass` on the command line | **Yes** |
| MinIO | root creds re-read at start | **Yes** |
| ClickHouse | init script + `users.d` | **Yes** |
| **Postgres** | **only at volume init** | **No** |

Postgres silently diverges from every other service. Nothing warns; the drift only surfaces
the next time a container is recreated and picks up the new `.env`.

**The misleading part.** Checking the password from inside the container *appears to confirm
it is correct*:

```bash
docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U langfuse -d langfuse -c 'select 1'      # succeeds — proves nothing
```

That connects over the **Unix socket**, which `pg_hba.conf` grants under `trust`/`peer` —
the password is never checked. The app connects over **TCP**, where `scram-sha-256` applies.
Always test the way the application connects, from a second container:

```bash
docker run --rm --network langfuse_langfuse -e PGPASSWORD="$POSTGRES_PASSWORD" \
  postgres:17-alpine psql -h postgres -U langfuse -d langfuse -tAc 'select 1'
```

**A second false signal:** a still-running container that was created *before* the rotation
keeps working, because its old credentials are still the valid ones. Here `worker` held a
different `DATABASE_URL` password than `.env` and was connecting to Postgres fine — which
inverts the usual intuition. Comparing the password baked into each container against `.env`
is what localises the drift:

```bash
docker inspect <container> --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^DATABASE_URL='
```

Fingerprint the values (`sha256sum | cut -c1-12`) rather than printing secrets.

**Fix.** Bring the role in line with `.env` — non-destructive, no volume is touched:

```bash
docker compose -f infra/compose.yaml exec -T postgres \
  psql -U langfuse -d langfuse -v ON_ERROR_STOP=1 \
  -c "ALTER USER \"langfuse\" WITH PASSWORD '<POSTGRES_PASSWORD from .env>';"
docker compose -f infra/compose.yaml up -d --force-recreate web worker
```

Recreate **every** container created before the rotation, not just the failing one — `worker`
also held a stale `REDIS_AUTH`, which surfaced as a flood of
`Stream isn't writeable and enableOfflineQueue options is false` and an `(unhealthy)` worker.
That looked like a Redis fault; Redis was fine and had rotated correctly.

> **Never `docker compose down -v` to "reset" this.** It destroys all trace history and every
> project credential. The `ALTER USER` above is the correct fix and is reversible — the old
> password stays valid until it runs.

**Prevention.** `scripts/generate-secrets.sh` already refuses to overwrite an existing
`infra/.env`, so it is not the route in — this drift arrives through a **hand edit** of a
live `.env`, which nothing guards. Rotating a credential on a running deployment is a
deliberate procedure per datastore, not a file rewrite: change `.env`, apply the change
*inside* the datastore, then recreate every consumer.

`scripts/check-credential-drift.sh` detects the condition before it becomes an outage. It
compares `.env` against what each container has baked in and against what the datastores
actually accept, probing Postgres over TCP from a separate container so the socket-`trust`
false pass above cannot occur. Run it after any `.env` edit and as part of post-deploy
verification.

Note also that `caddy` gating on `web: service_healthy` means any web failure silently takes
the public ingest path down with it — the ingest canary, not `docker compose ps`, is what
catches this.

---

## 13. Accounts that predate SSO cannot sign in with Entra

**Symptom.** Entra authentication itself succeeds, then Langfuse bounces back to the login
page with a `callbackUrl` that nests into itself and:

```
error=OAuthAccountNotLinked
```

Password login for the same deployment still works, which makes it look like an Entra
misconfiguration. It is not — the provider is fine.

**Root cause.** Auth.js refuses to attach an OAuth identity to an existing account with the
same email address unless explicitly told to. Silently merging them is an account-takeover
vector: anyone who could get an IdP to assert an address would inherit that account.

So **every account created before SSO was switched on hits this** — which on a migrated
deployment means all of them, including the org `OWNER`. The condition is visible in
Postgres before anyone tries to log in:

```bash
docker compose exec -T postgres psql -U langfuse -d langfuse \
  -c 'select u.email, a.provider from "Account" a right join users u on u.id=a.user_id;'
```

A `provider` column that is entirely null means no user has ever completed an SSO login,
and the first one to try will fail. (The table is `"Account"`, quoted and capitalised;
`accounts` does not exist.)

**Fix.**

```env
AUTH_AZURE_AD_ALLOW_ACCOUNT_LINKING=true
```

then recreate `web` — **and confirm the variable actually arrived, per issue 14.**

**Security condition — do not skip.** Linking is only safe when the IdP is authoritative for
the addresses it returns. Here the app registration is `signInAudience=AzureADMyOrg`
(single-tenant, verified by `scripts/test-entra-app.sh`), so only tenant identities can
authenticate at all. On a **multi-tenant** app the same setting would let anyone who can
prove control of a matching address take over the corresponding Langfuse account. The
upstream docs carry the same warning.

**Verifying it worked.** A dashboard that loads is not proof — password login produces the
same result. The durable evidence is a row:

```
                email                | provider | type
-------------------------------------+----------+-------
 mohamed-naceur.mahmoud@sportnavi.de | azure-ad | oauth
```

**Expect a different dashboard.** The Entra identity and the old password account are
usually *different* users in different organisations, with different projects. That is
correct behaviour, not a second fault — but it surprises everyone once.

---

## 14. A variable added to `.env` never reaches the container

**Symptom.** A setting is added to `infra/.env`, `web` is recreated with
`--force-recreate`, compose reports success, the container comes up healthy — and the
setting has no effect whatsoever. No error, no warning, nothing in the logs.

**Root cause.** The `web` and `worker` services **enumerate their environment explicitly**
in `compose.yaml`:

```yaml
    environment:
      AUTH_AZURE_AD_CLIENT_ID: ${AUTH_AZURE_AD_CLIENT_ID:-}
```

Only listed keys are passed through. `.env` is the *source* of values for that
substitution, not the environment itself — so a key present in `.env` but absent from the
`environment:` block is silently discarded. `env_file:` would behave differently; this
project does not use it for the app tier, deliberately, because the explicit list is what
keeps datastore credentials out of the app containers.

This bit during the SSO migration: `AUTH_AZURE_AD_ALLOW_ACCOUNT_LINKING` was set correctly
in `.env`, `web` was recreated twice, and the login kept failing with the exact error the
setting exists to fix.

**Fix.** Add the key to the service's `environment:` block in `compose.yaml`, then
recreate. Because `compose.yaml` is tracked in git and `.env` is not, this also means the
*shape* of the config is reviewable while the secrets stay out of the repo.

**Detection.** `scripts/check-env-mapping.sh` lists every key in `.env` that no service
consumes. It is static — two files, nothing running — so it belongs in CI and pre-deploy
validation, where it catches the mistake before a deploy rather than after a failed login.

**And always verify against the container, never against the file:**

```bash
docker inspect langfuse-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '<VARIABLE>'
```

> Combined with issue 9 (bind-mount edits need a restart) and issue 12 (env vars fix at
> container *create* time), the rule is: **after any config change, confirm the running
> container holds the value you think it does.** Three separate outages in this project
> have come from a config that was correct on disk and absent at runtime.

---

## Diagnostic checklist

When a service will not start, in this order:

1. **What is actually running?** `docker compose ps -a` — `Created` means never
   started, almost always a `depends_on` gate. Not a slow boot.
2. **Why is the dependency ungated?** `docker inspect <c> --format '{{json .State.Health.Log}}'`
   — read the probe's real output before assuming the service is broken.
3. **Is the service genuinely listening?** `docker compose exec <svc> netstat -ltn`.
   Listening + unhealthy = the probe is wrong, not the service.
4. **Read the real log.** ClickHouse writes fatal errors only to
   `/var/log/clickhouse-server/clickhouse-server.err.log`, not stdout. Copy it out of
   an exited container with `docker cp` — `--rm` destroys the evidence.
5. **Confirm the image's own config still loads** — see issue 2.
6. **Confirm you restarted it** — see issue 9.
7. **On any auth error, compare the credential in `.env` against the one baked into the
   container and the one the datastore actually holds** — three values that are assumed
   equal and silently are not. Test over TCP from a second container, never over the
   in-container socket. See issue 12.
8. **When a config change appears to have no effect, check the container before checking
   your logic** — `docker inspect <c> --format '{{range .Config.Env}}{{println .}}{{end}}'`.
   A value can be correct in `.env` and absent at runtime. See issue 14.

---

## Lessons for the test suite

Two tests passed against genuinely broken configurations. Both blind spots are worth
carrying into any future infrastructure work:

- **Asserting on text is not asserting on behaviour.** `test-clickhouse-ttl.sh` grepped
  for the right strings in a config that stopped the server from booting. It now starts
  a real ClickHouse.
- **Probing a service from inside its own container hides binding faults.** Both the
  test and the container healthcheck used in-container loopback, so a service reachable
  by nobody else looked fine. A probe from a *second* container would have caught
  issues 2 and 3 immediately.

Still open: neither the healthchecks nor `test-clickhouse-ttl.sh` verify cross-container
reachability. Worth adding before Stage 1C builds alerting on top of these signals.
