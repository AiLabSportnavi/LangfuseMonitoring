# Design — Prometheus + Grafana monitoring for Tier 1

**Date:** 2026-08-11
**Status:** Approved
**Scope:** Automation priorities 1–2 of `CLAUDE.md` §16 — *health monitoring* and *resource, queue,
disk, DB and ingestion metrics*. Explicitly **not** alerting (§16 priority 1's alerting half is
deferred by the user until a baseline exists).

---

## 1. Objective

Answer one question with data instead of intuition:

> **Is the current Tier 1 box sufficient, or do we need to move to Tier 2?**

`CLAUDE.md` §9 states the governing constraint — *"We do not scale because we think we might need
to. We measure the workload, define thresholds, and scale when real metrics demonstrate that
capacity is required."* This monitoring stack is the measurement half of that sentence. Without it,
every threshold in `docs/OPERATIONS.md` is a placeholder, and §8.7's tier-upgrade triggers cannot
fire.

A secondary objective follows from §8.1: **actual trace volume is unmeasured.** The ingestion-rate
and queue panels are what finally produce that number.

---

## 2. The constraint that shapes the design

**Langfuse exposes no Prometheus endpoint.** Verified, not assumed:

- [Self-hosting observability docs](https://langfuse.com/self-hosting/configuration/observability)
  document exactly three OTel variables — `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`,
  `OTEL_TRACE_SAMPLING_RATIO`. All three concern **trace** export. There is no metrics exporter.
- [langfuse/langfuse discussion #1816](https://github.com/orgs/langfuse/discussions/1816),
  "Add a metrics endpoint for Prometheus", is still open.
- The one built-in queue-metrics publisher, `ENABLE_AWS_CLOUDWATCH_METRIC_PUBLISHING`, emits to
  **CloudWatch only**. Useless off AWS.

Consequence: Langfuse-specific signals must be **derived from the components around it**. This is
the central design decision and the reason the stack looks the way it does.

| Langfuse signal | Derived from | Why this source is trustworthy |
|---|---|---|
| Request rate, latency, HTTP status classes | Caddy's own `/metrics` | Caddy terminates every request. Labels are host / handler / method / code — **no path label**, so this cannot split ingest from UI within one host. It does make allowlist rejections visible via `handler="static_response"`. |
| **Ingestion throughput** (observations actually persisted) | ClickHouse `ClickHouseProfileEvents_InsertedRows` | The honest source. `/api/public/ingestion` returns **207 on enqueue**, so an edge request rate can look perfectly healthy while a backlogged pipeline persists nothing (`OPERATIONS.md` §1). Rows landing in ClickHouse is what actually happened. |
| **Worker queue depth and growth rate** | `redis_exporter --check-keys` on BullMQ keys | BullMQ stores waiting jobs in a Redis list; the list length *is* the depth. No API, no auth, no polling contract that can change. |
| Web / worker liveness and readiness | `blackbox_exporter` | Probes the same endpoints `scripts/health-check.sh` already treats as the contract. |
| Web / worker CPU, memory, restarts, OOM kills | cAdvisor | Container-level truth, independent of the app. |

Everything else has a first-class source and needs no cleverness.

---

## 3. Architecture

```
┌──────────────────────── Hetzner box, one Docker network ────────────────────────┐
│                                                                                  │
│  EXISTING                              NEW (compose.monitoring.yaml)             │
│  ────────                              ─────────────────────────────             │
│  caddy      ──── :2020/metrics ──────►                                           │
│  clickhouse ──── :9363/metrics ──────►                                           │
│  minio      ──── /minio/v2/... ──────►  prometheus  ──────►  grafana             │
│  postgres   ◄─── postgres-exporter ──►     :9090                :3000            │
│  redis      ◄─── redis-exporter ─────►       │                    │              │
│  web/worker ◄─── blackbox-exporter ──►       │                    │              │
│                                        node-exporter (host)       │              │
│                                        cadvisor (containers)      │              │
│                                                                   │              │
│  caddy ──────────────────────────────────────────────────────────►┘              │
│    grafana.<domain>, ADMIN_ALLOWLIST-gated, TLS                                  │
│                                                                                  │
│  No monitoring service publishes a host port. Caddy remains the only ingress.    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Delivered as a **separate compose file** merged with `-f`, not as edits to `compose.yaml`:

```bash
docker compose -f compose.yaml -f compose.monitoring.yaml up -d
```

Same project name, so it joins the existing `langfuse` network and can reach every service by
DNS name. Separating the file means monitoring can be omitted, upgraded, or removed without
touching the file that defines the platform itself.

### 3.1 Component inventory

| Service | Image | Purpose |
|---|---|---|
| `prometheus` | `prom/prometheus:v3.13.2` | Scrape + TSDB, 90d / 10GB |
| `grafana` | `grafana/grafana:13.0.6` | Dashboards, provisioned as code |
| `node-exporter` | `prom/node-exporter:v1.12.1` | Host CPU, RAM, NVMe, network |
| `cadvisor` | `gcr.io/cadvisor/cadvisor:v0.55.1` | Per-container CPU, memory, restarts, OOM |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter:v0.20.1` | Connection saturation, DB size |
| `redis-exporter` | `oliver006/redis_exporter:v1.89.0-alpine` | Memory, evictions, **BullMQ queue depth** |
| `blackbox-exporter` | `prom/blackbox-exporter:v0.28.0` | Health / ready probes |

All tags were confirmed against the registry before being written down. `CLAUDE.md` §14 forbids
`latest`; `docs/DEPLOYMENT-PITFALLS.md` #8 records a deploy that failed on a tag guessed from a
plan. `scripts/test-monitoring-config.sh --pull-check` re-verifies every tag against the registry
so this cannot rot silently.

### 3.2 Changes to existing files

Three small, additive changes — each one enables a metrics endpoint that already exists in the
software but ships disabled:

1. **`infra/clickhouse/config.d/prometheus.xml`** (new file) — ClickHouse ships a native Prometheus
   endpoint, commented out in stock `config.xml`. Enabling it on `:9363` is a five-line overlay.
   Mounted as a **file**, never a directory: `DEPLOYMENT-PITFALLS.md` #2 records that mounting
   `config.d` as a directory hides the image's own `docker_related_config.xml` and silently binds
   ClickHouse to localhost.
2. **`infra/caddy/Caddyfile`** — add the `metrics` global option, an internal-only `:2020` listener
   serving `/metrics`, and the `grafana.<domain>` site block.
3. **`infra/.env.example`** — new variables, all defaulted so an existing `.env` keeps working.

MinIO's endpoint is enabled by `MINIO_PROMETHEUS_AUTH_TYPE=public`, set as a service override
inside `compose.monitoring.yaml` so `compose.yaml` is untouched.

### 3.3 Caddy metrics without exposing Caddy's admin API

Caddy serves `/metrics` from its **admin API on `localhost:2019`** by default. Publishing that on
the container network so Prometheus could scrape it would also publish the admin API — which can
**reconfigure the running server**. That is an unacceptable trade for a metrics endpoint.

Instead: the `metrics` *handler directive* is mounted in a dedicated site block on `:2020`. Caddy's
admin API stays bound to `localhost` inside the container, unreachable from any other container.
`:2020` is never published to the host, so it is reachable only from the Docker network.

```caddyfile
{
	metrics                        # global option — required before the directive works
}

:2020 {
	metrics /metrics               # internal only; never published to the host
}
```

### 3.4 Grafana exposure

`grafana.<domain>`, a new Caddy site block, reusing `ADMIN_ALLOWLIST` verbatim — the same network
boundary that already protects the Langfuse UI — **plus** Grafana's own login. Two independent
controls, matching §12.1's treatment of the admin surface.

Grafana is deliberately given its own subdomain rather than a subpath. A subpath would have to be
matched ahead of the Langfuse site's deny-by-default handler, and `handle` blocks are evaluated in
order and mutually exclusive; one ordering mistake there exposes the admin surface. The Caddyfile
already carries a long comment explaining exactly this hazard for the `/api/auth/*` rate limiter.
A separate site block cannot make that mistake.

Anonymous access is off, sign-up is off, and the admin password comes from `.env`. Entra SSO for
Grafana is a natural follow-up (Grafana speaks generic OAuth against the same app registration) but
is **not** in this scope.

---

## 4. Metrics: what we collect and what we deliberately do not

The user's requirement — *"follow monitoring best practices and avoid collecting unnecessary
metrics"* — mirrors `CLAUDE.md` §7.5's tracing philosophy: **high signal, not maximum logging.**
Applied to metrics, that means every series must plausibly change a decision.

### 4.1 Collected, mapped to `OPERATIONS.md` §2

| Area | Metrics | Decision it informs |
|---|---|---|
| **Host** | CPU by mode, memory, NVMe used/free, disk I/O, network | Is the box saturated? (§8.7 trigger) |
| **Containers** | CPU, memory, restarts, **OOM kills** | Which service is the pressure? |
| **Ingest / load** | request rate, p50/p95/p99 latency, status classes — **labelled by handler** | Real trace volume (§8.1's open question) |
| **Queue** | depth per queue, **derivative**, active/delayed/failed | Worker scaling (§11.2) — the highest-value signal here |
| **ClickHouse** | disk used/total, **projected days-until-full**, query rate, failed queries, concurrent queries, memory | Tier 2 trigger (§8.7) |
| **Postgres** | connections vs `max_connections`, DB size, transaction/rollback rate | Saturation; Postgres is the crown jewel (§13) |
| **Redis** | memory vs the 1GB/100k-events-per-min rule, **evictions**, connected clients | Evictions > 0 on `noeviction` means queue data loss |
| **Availability** | blackbox probe success + duration for health, ready, worker health | Is it up? |

**Days-until-full and evictions deserve special note.** §11 of `OPERATIONS.md` calls
days-until-full one of the two highest-value tiles precisely because it is a *leading* indicator —
a disk at 45% tells you nothing; a disk at 45% filling at 3GB/day tells you the date. And Valkey
runs `--maxmemory-policy noeviction` deliberately, so a non-zero eviction counter is not a
performance note, it is silent queue-data loss.

### 4.2 Deliberately not collected

- **cAdvisor's per-CPU-core series, `container_tasks_state`, `container_memory_failures_total`,
  filesystem-per-device series.** Dropped in `metric_relabel_configs`. cAdvisor is by far the
  highest-cardinality source in this stack and most of that cardinality answers no question.
- **node-exporter's default collector set.** Trimmed with explicit `--no-collector.*` flags
  (`mdadm`, `nfs`, `zfs`, `infiniband`, `bcache`, …) — none of it applies to this box.
- **Per-Langfuse-project ingestion labels.** `OPERATIONS.md` §12 wants these, and they are the
  right thing eventually, but the only per-project identifier available at the Caddy layer is the
  `Authorization` header — which **is the API secret**. Putting it in a metric label would write
  project secrets into the TSDB and onto every dashboard. Deferred to the same work that fixes
  per-project rate limiting, and tracked in `docs/SECURITY-REVIEW.md`.
- **Langfuse's internal OTel traces.** `OTEL_EXPORTER_OTLP_ENDPOINT` could point at a collector,
  but that is application tracing, not infrastructure monitoring, and it would need a collector
  plus a trace backend. Out of scope; §17's "do not block, do not implement" rule applies.
- **Alerting rules of any kind.** Explicit user instruction. `prometheus.yml` carries an empty,
  commented `rule_files` block so the extension point is obvious and unused.

---

## 5. Verification strategy

The project's rule (§18.11, §7.6) is that a thing is not done because it compiles — it is done
because it was observed working. Two scripts enforce that:

**`scripts/verify-metric-sources.sh`** — run against the live stack. For each exporter it curls the
endpoint and asserts that the specific metric names the dashboards depend on are actually present.
This is the metrics analogue of §7.6's "fetch the real trace back and audit it". Metric names are
the silent failure mode here: a renamed ClickHouse async metric produces an empty panel, not an
error, and an empty panel reads as "healthy".

**`scripts/discover-queue-keys.sh`** — scans the live Valkey for BullMQ keys and prints the real
prefix and queue names. BullMQ's documented default prefix is `bull`, but Langfuse constructs its
queues itself and the prefix is not documented. Rather than trust the default, the pattern is an
environment variable and this script tells you what to set it to. If it finds nothing, the queue
panels would have been silently empty — that is a failure the script surfaces in one command.

**`scripts/test-monitoring-config.sh`** — static checks, runnable without a server: compose parses,
no monitoring service publishes a host port, no `:latest` tag, every dashboard JSON parses, every
Prometheus job has a target, and (with `--pull-check`) every image tag exists in its registry.

### 5.1 What this stack cannot tell you

Prometheus runs **on the box it monitors**. If the box dies, so does the monitor, and the
dashboards go blank rather than red. This does not replace `OPERATIONS.md` §5's **off-host**
external monitor or the ingestion canary — it complements them. §10.2 of `CLAUDE.md` is
unambiguous: *"Langfuse must not be the only system that knows Langfuse is down."* Neither may
Prometheus. This is recorded prominently in `docs/MONITORING.md` so the stack's presence does not
create false confidence that priority 8 of §19 is done.

Similarly, blackbox probes target `web:3000` on the container network, bypassing Caddy and TLS.
That is intentional — it separates "the app is broken" from "the edge is broken" — but it means a
TLS or DNS failure is invisible here and visible only to the external monitor.

---

## 6. Dashboards

Three, provisioned from JSON on disk. No click-ops: `CLAUDE.md` §13 requires infrastructure as
code, and a dashboard edited in the UI is lost on container replacement.

1. **Langfuse — Platform Overview.** Deliberately mirrors the ASCII layout in `OPERATIONS.md` §11,
   section for section: PLATFORM, INGESTION, WORKERS, DATA LAYER. One screen, "is it healthy" in
   under a minute.
2. **Langfuse — Ingestion & Queues.** The scaling-decision dashboard. Depth *and* derivative side
   by side, because §3 of the runbook is explicit that depth alone misleads: a large draining queue
   needs no action, a small growing one needs immediate action.
3. **Langfuse — Infrastructure & Capacity.** The tier-decision dashboard: host resources,
   per-container usage, disk growth rate, and projected days-until-full.

Panels are annotated with the corresponding `OPERATIONS.md` threshold as a description so the
runbook and the dashboard cannot drift apart.

---

## 7. Resource cost

Seven additional containers on a 16-core / 128GB box. Prometheus at a 15s interval over roughly
this target count is the only meaningful consumer: expect low-hundreds of MB RSS and 1–3GB of disk
at 90-day retention. The `--storage.tsdb.retention.size=10GB` cap is a hard backstop — the single
biggest risk on this box is NVMe exhaustion stopping ingestion (§10.1), and the monitoring stack
must never be the cause of the thing it exists to warn about.

cAdvisor is the CPU cost, which is why it scrapes at 30s rather than 15s and drops most of its
series.

---

## 8. Out of scope

Alerting rules and routing · Alertmanager · Loki/log aggregation · per-project ingestion labels ·
Grafana SSO · long-term storage (Thanos/Mimir) · Kubernetes ServiceMonitors · infra cost tracking
(`OPERATIONS.md` §13) · restore-test and backup tiles (nothing produces those metrics yet).

Alerting is the intended next step once a baseline exists. The thresholds already written in
`OPERATIONS.md` §2 become the rules, and `rule_files` in `prometheus.yml` is where they go.
