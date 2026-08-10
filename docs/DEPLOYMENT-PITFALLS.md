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
