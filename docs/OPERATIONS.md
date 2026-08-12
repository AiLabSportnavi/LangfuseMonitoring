# Operations Runbook — Langfuse Platform

Detailed operational reference. Architectural decisions and their rationale live in
[`../CLAUDE.md`](../CLAUDE.md); this document holds thresholds, procedures, and checklists.

> **Every threshold in this document is a starting point, not a measured truth.** Calibrate against
> real production behaviour and revise. Do not hard-code a threshold you have not observed.

---

## 1. Verified platform facts

Confirmed against current Langfuse documentation. Re-verify before relying on any of it — see
§10 of `CLAUDE.md`.

### Endpoints

| Endpoint | Behaviour |
|---|---|
| `GET /api/public/health` | 200 healthy / 503 unhealthy. Checks API only by default. |
| `GET /api/public/health?failIfDatabaseUnavailable=true` | Also fails on DB unreachable. **Use this for deep checks.** |
| `GET /api/public/ready` | 200 ready / **500 after SIGTERM/SIGINT**. Use as the readiness probe so traffic drains on graceful shutdown. |
| `POST /api/public/otel/v1/traces` | **The trace ingest path.** Basic auth + `x-langfuse-ingestion-version: 4`. Note the full path — a bare `POST /api/public/otel` returns **404**. |
| `POST /api/public/ingestion` | **`events_only` mode on this server:** accepts **score and log** events, **rejects `trace-create`**. Asynchronous — acceptance means *queued*, not *stored*. |
| `GET /api/public/v2/observations` | Read-back path for the canary. The v3 endpoints (`/api/public/traces`, `/api/public/observations`) return **404** in `events_only` mode. |
| `GET /api/public/v2/metrics` | Aggregate query API. Replaces `/api/public/metrics`, which is gone in v4. |

**Consequence for monitoring:** an accepted ingest proves nothing about durability. An end-to-end
ingestion check must **write a trace and then read it back**, allowing for queue lag.
[`scripts/ingestion-canary.sh`](../scripts/ingestion-canary.sh) already writes via OTLP and reads back
via v2 observations — do not "fix" it back to the legacy endpoint.

### Tuning environment variables

| Variable | Purpose |
|---|---|
| `LANGFUSE_S3_CONCURRENT_WRITES` | Blob-storage write concurrency (e.g. `100`). Raise on S3 socket exhaustion/throttling. |
| `LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY` | Ingestion concurrency — **counted per Redis queue shard**. |
| `LANGFUSE_TRACE_UPSERT_WORKER_CONCURRENCY` | Trace upsert concurrency — **counted per shard**. |

> **Footgun:** with 10 queue shards and a target of 20 concurrent per worker, set these to **2**, not 20.

### Sizing rules

- **Redis:** ~**1 GB memory per 100,000 events/minute**.
- **ClickHouse:** `shards: 1` (fixed — no multi-shard support), `replicaCount: 3` minimum in
  production, `resourcesPreset: large` or higher, `persistence.size: 100Gi` starting point, storage
  class with `allowVolumeExpansion: true`.
- **All components must run in UTC.**

### Enterprise-licensed features

These are **EE**, not open source. Confirm licensing before designing a dependency on them:

- Server-side ingestion masking
- Instance Management API
- Organization Creators
- UI customization

---

## 2. Monitoring matrix

> **Implemented.** Prometheus and Grafana collect everything below —
> see [`MONITORING.md`](MONITORING.md) for the stack, the metric sources, and its blind spots.
> **Alerting is not implemented yet**, deliberately: the thresholds in this section were written
> before anything was measured, and alerting on unobserved numbers manufactures noise. Collect a
> baseline, calibrate these numbers against it, then add rules.
>
> Two caveats worth carrying into every threshold below:
> - Langfuse exposes **no Prometheus endpoint**, so its signals are derived — queue depth from
>   BullMQ's Redis keys, throughput from ClickHouse inserted rows, availability from blackbox probes.
> - Prometheus runs **on the box it monitors**. It cannot report that the box is down; it goes blank.
>   The off-host monitor in §5 remains required.

### Langfuse Web

| Metric | Warning | Critical |
|---|---|---|
| CPU | > 70% sustained 10m | > 85% sustained 5m |
| Memory | > 75% | > 90% or OOM kill |
| p95 latency | > 2× baseline | > 5× baseline |
| HTTP 5xx rate | > 1% | > 5% |
| Container restarts | any unplanned | > 3 in 15m (crashloop) |
| `/api/public/health` | — | fail 2 consecutive checks → **EMERGENCY** |

### Langfuse Worker

The worker is the ingestion bottleneck; watch it hardest.

| Metric | Warning | Critical |
|---|---|---|
| CPU | 50–70% | > 70% sustained → scaling candidate |
| Memory | > 75% | > 90% or OOM kill |
| **Queue depth** | above normal band | growing continuously (§3) |
| **Queue growth rate** | > 0 for 10m | > 0 for 30m after scaling |
| Ingestion latency (write→readable) | > 1m | > 5m |
| Processing errors | > 0.1% | > 1% |

### ClickHouse

| Metric | Threshold |
|---|---|
| Disk | < 60% normal · 60–70% warning · 70–80% investigate · 80–90% **critical** · > 90% **emergency** |
| Disk growth | track GB/day; alert on > 2× 7-day trailing average |
| Projected days-to-full | **< 30 days → warning · < 14 days → critical** |
| CPU | > 80% sustained |
| Memory | > 85% |
| Query latency | p95 > 2× baseline |
| Failed queries / ingestion errors | > 0 sustained |

### PostgreSQL

Disk, disk growth, CPU, memory, **connection saturation (> 80% of `max_connections`)**, query
latency, error rate, replication/health, **backup success**, **last successful restore test**.

### Redis / Valkey

Memory vs. the 1 GB-per-100k-events/min rule, CPU, queue depth, connection count, **evictions
(> 0 on a queue workload means data loss — treat as critical)**, latency, health.

### Host / Kubernetes

CPU, RAM, disk, network, node health, pod/container restarts, **OOM kills**, filesystem capacity.

---

## 3. Queue-driven scaling logic

Queue depth alone is a poor signal. **Depth and derivative together** are the decision input.

```
Incoming events → Queue → Workers
```

| Depth | Growth rate | Action |
|---|---|---|
| Low | ~0 | Normal |
| **High** | **negative** (draining) | **No action** — recovering from a spike |
| Low | **positive** and sustained | **Scale workers** — throughput deficit forming |
| High | positive | **Critical** — scale now |
| High | positive *after* scaling | **Escalate.** Workers are not the bottleneck — check ClickHouse write latency, S3 throttling, Redis CPU |

Policy sketch (thresholds configurable, must be validated against real load):

```text
Worker CPU < 50%                        → normal
Worker CPU 50–70%                       → monitor
Worker CPU > 70% sustained              → scaling candidate
Queue growing continuously              → scale worker capacity
Queue still growing after scaling       → CRITICAL, investigate downstream
```

**Scale-down** must be gentler than scale-up: use a stabilization window (≥ 5–10 minutes of sustained
low load) and a cooldown, so a traffic trough does not cause thrash. Never scale workers to zero.

---

## 4. Alert severity

| Level | Meaning | Examples | Routing |
|---|---|---|---|
| **INFO** | Normal event, no action | Deploy completed, planned restart, scaling event, backup succeeded | Log/dashboard |
| **WARNING** | Trending wrong, act in days | CPU elevated, disk > warning, queue beginning to grow, latency rising | Team channel |
| **CRITICAL** | Acting now, degradation likely | Queue growing continuously, disk > 80%, crashloop, 5xx > 5%, DB errors, ingestion failures, **backup failure** | Team channel + on-call |
| **EMERGENCY** | Platform down or data at risk | Langfuse/ClickHouse/Postgres unavailable, disk > 90%, data-loss risk, suspected security incident | Page immediately |

Alerts must route to a channel the team actually reads. An alert nobody sees is worse than none —
it manufactures false confidence.

---

## 5. External health monitoring

> **Langfuse must not be the only thing that knows Langfuse is down.**

An **independent, off-host** monitor (e.g. Uptime Kuma on a separate machine, or a hosted checker)
probes from outside the platform:

| Check | Frequency | Alerts at |
|---|---|---|
| `GET /api/public/health?failIfDatabaseUnavailable=true` | 60s | 2 consecutive failures |
| `GET /api/public/ready` | 60s | 2 consecutive failures |
| **End-to-end ingestion canary**: write a trace, read it back | 5–15m | read-back failure or lag > threshold |
| TLS certificate expiry | daily | < 21 days remaining |
| UI reachable (from allowlisted network) | 5m | 2 consecutive failures |

The **ingestion canary is the most valuable check** — it is the only one that proves the full path
(ingest → queue → worker → ClickHouse → query) actually works. Health endpoints can return 200 while
ingestion is silently backlogged.

---

## 6. Backups

> **Status: tooling implemented, NOT YET RUNNING on the server.** Audit F-04 found no backups at
> all — not misconfigured, absent. [`scripts/backup.sh`](../scripts/backup.sh) and
> [`scripts/restore-test.sh`](../scripts/restore-test.sh) close the tooling half. Until the cron
> entry below exists on the box and one restore has passed, **this platform still has no verified
> data protection** and F-04 stays open.

| Component | Method | Frequency | Implemented by |
|---|---|---|---|
| **Postgres** | `pg_dump -Fc`, encrypted | Daily | `scripts/backup.sh` |
| **ClickHouse** | Native `BACKUP DATABASE`, tarred + encrypted | Daily | `scripts/backup.sh` |
| **Blob storage** | `mc mirror` of the event bucket, encrypted | Daily | `scripts/backup.sh` |
| **Valkey** | **Deliberately not backed up** — in-flight queue only; its loss is accepted under CLAUDE.md requirement 10 | — | — |
| **Config & IaC** | Git | Every change | — |

Requirements, and how each is met:

| Requirement | How |
|---|---|
| Automated | cron, below |
| **Encrypted** | AES-256, PBKDF2 600k iterations, `BACKUP_ENCRYPTION_KEY` |
| **Off the primary host** | `BACKUP_REMOTE` (rsync/SSH → Hetzner Storage Box). **`backup.sh` refuses to run without it** unless `--local-only` is passed |
| EU-resident | Hetzner Storage Box, same jurisdiction as the box |
| Retention | `BACKUP_RETENTION_DAYS` locally; remote retention is the storage target's job **on purpose** — pruning the remote from the machine being backed up means a compromise of that machine can erase its own backups |
| **Success *and failure* monitored** | Both scripts write Prometheus textfile metrics; [`infra/prometheus/rules/backups.yml`](../infra/prometheus/rules/backups.yml) alerts on failure, staleness, **and total absence of the metric** |

### Enabling it on the host

```bash
# 1. Generate the key (or let scripts/generate-secrets.sh do it on a fresh deploy)
openssl rand -hex 32          # → BACKUP_ENCRYPTION_KEY in infra/.env

# 2. Set BACKUP_REMOTE in infra/.env, then rehearse before trusting it
./scripts/backup.sh --dry-run
./scripts/backup.sh
./scripts/restore-test.sh

# 3. Only then, schedule it
sudo crontab -e
#   17 3 * * *  cd /opt/langfuse && ./scripts/backup.sh      >> /var/log/langfuse-backup.log 2>&1
#   40 4 * * 0  cd /opt/langfuse && ./scripts/restore-test.sh >> /var/log/langfuse-restore.log 2>&1
```

> ### ⚠️ `BACKUP_ENCRYPTION_KEY` is not like the other secrets
>
> Every other credential in `infra/.env` can be rotated by regenerating and redeploying. This one
> cannot: rotate it without keeping the old value and **every existing backup becomes permanently
> undecryptable**.
>
> Worse, it lives in `infra/.env` — **on the machine it protects**. Lose the box and you lose the
> key, and the off-host copies you were careful to make are unreadable. A backup you cannot decrypt
> is not a backup.
>
> **Put it in the team password manager, and record here where it went:**
>
> ```
> BACKUP_ENCRYPTION_KEY stored at: ______________________  on: __________
> ```

---

## 7. Restore testing

> A backup is not valid because the job reported success. It is valid because a restore worked.

[`scripts/restore-test.sh`](../scripts/restore-test.sh) implements this. It runs under a **separate
compose project on a separate network with throwaway volumes and no published ports**, which is why
it is safe to run on the production host — the only place the backups are.

```text
Backup artifact
  → sha256 verify against the manifest        ← catches a truncated transfer
  → Restore Postgres into an isolated instance
  → Assert projects and api_keys have ROWS    ← not that pg_restore exited 0
  → Restore ClickHouse into an isolated instance
  → Assert observations has ROWS              ← not that RESTORE exited 0
  → Verify the MinIO archive unpacks
  → Record result + write Prometheus metrics
  → Tear everything down
```

**Why it asserts on row counts rather than exit codes:** `pg_restore` exits non-zero for entirely
benign reasons, and exits **zero** having restored an empty schema. A ClickHouse `RESTORE` that
recreates every table and no data likewise succeeds. Only the row count answers the question that
matters.

Run it **at least monthly**, and prefer `--from-remote` at least quarterly — the off-host copy is
the one a real incident would reach for, and it is the copy whose transfer can silently truncate.

`RestoreTestStale` fires after 90 days without a pass, which is the retention window: beyond it, no
artifact still in existence has ever been proven restorable. Record each result:

```
Last successful restore test: ______________  by: __________  from: local / remote
```

---

## 8. Disaster recovery

Document and keep current — **targets below are placeholders to be agreed, not commitments**:

| Scenario | Response | RTO | RPO |
|---|---|---|---|
| Host dies | Rebuild from IaC, restore backups | *TBD* | *TBD* |
| ClickHouse corrupted | Restore from backup; trace data loss window accepted | *TBD* | *TBD* |
| Postgres lost | Restore + PITR — **highest priority**, holds orgs/projects/API keys/users | *TBD* | *TBD* |
| Redis lost | Rebuild empty; **in-flight queued events are lost** — acceptable per best-effort policy | minutes | queue depth at failure |
| Blob storage lost | Restore from versioning/replication | *TBD* | *TBD* |

**Postgres is the crown jewel** — losing ClickHouse costs trace history; losing Postgres costs the
platform's identity and every project credential.

Tier 1 is single-node: accept a rebuild-from-backup RTO measured in hours. All infrastructure
defined as code so the host is reproducible. **Write the rebuild runbook before it is needed.**

---

## 9. Update workflow

Never `latest` in production. Pin versions.

```text
New Langfuse release
  → Detected (Renovate/Dependabot)
  → PR opened automatically
  → CI: config validation, tests, Helm/compose lint
  → Deploy to staging
  → Smoke tests: health, ready, UI, ingestion canary, DB migration check
  → Human approval  ← required for major versions
  → Production deployment
  → Post-deploy verification (§10); rollback on failure
```

- **Patch/minor:** may auto-merge to staging after green CI; production still gated.
- **Major:** always explicit human review against the current Langfuse upgrade guide. Check for
  ClickHouse schema migrations — these are the risky ones and may not be reversible.

### Security updates

Tracked separately and prioritized above feature updates: Dependabot/Renovate, GitHub security
alerts, and container image vulnerability scanning across Langfuse images, Node dependencies,
Docker base images, and (at Tier 3) Kubernetes components.

---

## 10. Deployment safety checks

**Pre-deploy:** validate configuration · confirm all required secrets exist · run tests ·
lint Helm/compose · check for pending DB migrations · confirm a current backup exists.

**Post-deploy:** `/api/public/health?failIfDatabaseUnavailable=true` · `/api/public/ready` ·
**ingestion canary write + read-back** · UI/API smoke test · worker processing confirmed ·
error rate within baseline for 10 minutes.

Failing post-deploy checks stop the rollout and roll back where safely supported. **Rollback is not
safe across a schema migration** — that path needs an explicit, tested procedure.

---

## 11. Operational dashboard

One page answering "is the platform healthy?" within a minute:

```text
┌─ PLATFORM ────────────────────────────────────────────────┐
│ Langfuse Status      Web Health         Worker Health     │
│ Current Version      Available Update                     │
├─ INGESTION ───────────────────────────────────────────────┤
│ Ingestion Rate       Ingestion Latency   HTTP Error Rate  │
│ Queue Depth          Queue Growth Rate                    │
├─ WORKERS ─────────────────────────────────────────────────┤
│ Worker CPU           Worker Memory       Active Workers   │
├─ DATA LAYER ──────────────────────────────────────────────┤
│ ClickHouse Disk %    CH Growth GB/day    Days Until Full  │
│ ClickHouse CPU       ClickHouse Memory                    │
│ Postgres Health      Postgres Connections                 │
│ Redis Health         Redis Memory        Evictions        │
├─ RESILIENCE ──────────────────────────────────────────────┤
│ Backup Status        Last Successful Restore Test         │
├─ COST ────────────────────────────────────────────────────┤
│ Infra Cost MTD       Storage Growth      Δ vs Last Month  │
└───────────────────────────────────────────────────────────┘
```

**Days Until Full** and **Last Successful Restore Test** are the two highest-value tiles — both are
leading indicators, and both are routinely missing from observability dashboards.

> **Built as `Langfuse — Platform Overview`** in Grafana, section for section. *Days Until Full* is
> live. The **RESILIENCE** and **COST** rows are still empty: nothing yet produces backup,
> restore-test or infrastructure-cost metrics. See [`MONITORING.md`](MONITORING.md) §11.

---

## 12. Per-project ingestion attribution

When ingestion volume spikes, the first question is *which project*. Ensure ingestion metrics are
labelled by Langfuse project so a runaway or misconfigured agent is identifiable within minutes, and
its key can be rate-limited or revoked without affecting other projects.

---

## 13. Infrastructure cost tracking

Tracked from Phase 1 — distinct from Phase 2 *LLM* cost monitoring:

server/compute · block storage · object storage · backup storage · bandwidth/egress ·
(Tier 3) Kubernetes control plane.

Must answer: *"Why did infrastructure cost increase this month?"* Correlate cost deltas against
trace volume and storage growth so an unexplained rise is investigated rather than absorbed.
