# Monitoring — Prometheus & Grafana

How the Langfuse platform is observed, what each metric is for, and how to operate the stack.

Architectural decisions live in [`../CLAUDE.md`](../CLAUDE.md); thresholds and runbooks live in
[`OPERATIONS.md`](OPERATIONS.md). This document is the monitoring stack itself — what was built, why
it looks the way it does, and what it cannot tell you.

> **Alerting is deliberately not implemented yet.** Thresholds in `OPERATIONS.md` §2 are placeholders
> written before anything was measured. Alerting on unobserved numbers produces noise, and a channel
> that has learned to ignore alerts is worse than no alerting at all (`CLAUDE.md` §10.3). Collect a
> baseline first, calibrate, then add rules. The extension point is `rule_files` in
> [`../infra/prometheus/prometheus.yml`](../infra/prometheus/prometheus.yml), left empty on purpose.

---

## 1. What this exists to answer

One question, from `CLAUDE.md` §9:

> **Is the current Tier 1 box sufficient, or do we need Tier 2?**

Not "are there dashboards". The governing constraint is *"We do not scale because we think we might
need to. We measure the workload, define thresholds, and scale when real metrics demonstrate that
capacity is required."* This stack is the measurement half of that sentence.

It also closes §8.1's open item: **actual trace volume has never been measured.** Every sizing figure
in §8 is provisional until the *Rows persisted to ClickHouse* panel has a week of data behind it.

---

## 2. The constraint everything follows from

**Langfuse exposes no Prometheus endpoint.** This was verified, not assumed:

| Evidence | Finding |
|---|---|
| [Self-hosting observability docs](https://langfuse.com/self-hosting/configuration/observability) | Only `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_TRACE_SAMPLING_RATIO` — all **trace** export, no metrics |
| [Discussion #1816](https://github.com/orgs/langfuse/discussions/1816) | "Add a metrics endpoint for Prometheus" — still open |
| `ENABLE_AWS_CLOUDWATCH_METRIC_PUBLISHING` | The one built-in queue-metrics publisher. **CloudWatch only.** Useless off AWS |

So Langfuse-specific signals are **derived from the components around it**:

| Signal | Source | Why this one |
|---|---|---|
| Availability | `blackbox_exporter` probes | Same endpoint contract `scripts/health-check.sh` treats as authoritative |
| Request rate / latency / status | Caddy's own `/metrics` | Caddy terminates every request |
| **Queue depth & growth** | `redis_exporter --check-keys` | BullMQ stores waiting jobs in a Redis list — the list length *is* the depth |
| **Ingestion throughput** | `ClickHouseProfileEvents_InsertedRows` | Rows that actually landed. See §2.1 |
| CPU / memory / restarts / OOM | cAdvisor | Container truth, independent of the app |

### 2.1 Why throughput is measured at ClickHouse, not at the edge

Ingest accepts on **enqueue, not on store** (`OPERATIONS.md` §1). A perfectly healthy acceptance rate
at the edge is therefore entirely compatible with a completely backlogged pipeline persisting nothing.
Counting requests would measure optimism; counting rows inserted into ClickHouse measures what
happened. Same reasoning as the ingestion canary.

---

## 3. Architecture

```
┌──────────────────────── Hetzner box, one Docker network ────────────────────────┐
│                                                                                  │
│  EXISTING                              MONITORING                                │
│  ────────                              ──────────                                │
│  caddy      ──── :2020/metrics ──────►                                           │
│  clickhouse ──── :9363/metrics ──────►                                           │
│  minio      ──── /minio/v2/... ──────►  prometheus  ──────►  grafana             │
│  postgres   ◄─── postgres-exporter ──►     :9090                :3000            │
│  redis      ◄─── redis-exporter ─────►       ▲                    │              │
│  web/worker ◄─── blackbox-exporter ──►       │                    │              │
│                                        node-exporter (host)       │              │
│                                        cadvisor (containers)      │              │
│                                                                   │              │
│  caddy ◄──────────────────────────────────────────────────────────┘              │
│    grafana.<domain> · ADMIN_ALLOWLIST · TLS · Grafana login                      │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**No monitoring service publishes a host port.** Caddy remains the only ingress (`CLAUDE.md` §12.1).
Prometheus has no web ingress at all — it is an unauthenticated query API over every metric on the
box, and only Grafana needs it. `scripts/test-monitoring-config.sh` enforces this invariant.

### 3.1 Files

| File | Purpose |
|---|---|
| [`infra/compose.monitoring.yaml`](../infra/compose.monitoring.yaml) | The seven monitoring services. Merged with `-f`, never auto-loaded |
| [`infra/prometheus/prometheus.yml`](../infra/prometheus/prometheus.yml) | Scrape jobs and cardinality control |
| [`infra/blackbox/blackbox.yml`](../infra/blackbox/blackbox.yml) | The single `http_2xx` probe module |
| [`infra/clickhouse/config.d/prometheus.xml`](../infra/clickhouse/config.d/prometheus.xml) | Enables ClickHouse's built-in endpoint on `:9363` |
| [`infra/grafana/provisioning/`](../infra/grafana/provisioning/) | Datasource and dashboard provider, as code |
| [`infra/grafana/dashboards/`](../infra/grafana/dashboards/) | The three dashboards, as JSON |

---

## 4. Running it

```bash
# 1. Set the monitoring variables in infra/.env
#      GRAFANA_DOMAIN            — needs its own DNS A record
#      GRAFANA_ADMIN_PASSWORD    — openssl rand -hex 32
#      REDIS_QUEUE_KEY_PATTERNS  — leave the default for now, fixed in step 4

# 2. Validate before touching the server
./scripts/test-monitoring-config.sh --pull-check

# 3. Start
cd infra
docker compose -f compose.yaml -f compose.monitoring.yaml up -d

# 4. Discover the real BullMQ key layout and put it in .env — see §6
./scripts/discover-queue-keys.sh

# 5. Prove every dashboard panel has a source. Do not skip this.
./scripts/verify-metric-sources.sh
```

**Note on step 3:** adding `-f compose.monitoring.yaml` recreates `minio` (it gains
`MINIO_PROMETHEUS_AUTH_TYPE`) and `clickhouse` (it gains the config file mount). Both are brief
restarts, but they are restarts — do them in a maintenance window on a busy platform, and remember
that a Valkey restart forfeits in-flight queued events, which is acceptable under the best-effort
policy (`CLAUDE.md` requirement 10) but is not nothing.

Once running, **always pass both `-f` flags.** Running `docker compose -f compose.yaml up -d` alone
will not stop the monitoring containers, but it will not manage them either, and a subsequent
`down` will leave orphans.

---

## 5. What this stack CANNOT tell you

> **Prometheus runs on the box it monitors.** If the box dies, so does the monitor. The dashboards go
> **blank**, not red.

This does **not** replace the off-host external monitor required by `OPERATIONS.md` §5, and it is not
priority 8 of `CLAUDE.md` §19. §10.2 is unambiguous — *"Langfuse must not be the only system that
knows Langfuse is down"* — and neither may Prometheus be.

Specifically invisible here:

| Blind spot | Why | Covered by |
|---|---|---|
| Host down / network partition | The monitor died with it | Off-host monitor |
| TLS certificate expiry or failure | Probes target `web:3000` on the container network, bypassing Caddy | Off-host monitor |
| DNS failure | Same | Off-host monitor |
| **End-to-end ingestion durability** | Nothing here writes a trace and reads it back | `scripts/ingestion-canary.sh` |
| Backup success / last restore test | Nothing produces those metrics yet | `OPERATIONS.md` §6–7 |
| Per-project ingestion attribution | See §8 | Deferred |

The probes bypassing Caddy is a **deliberate** design choice, not an oversight: it separates "the
application is broken" from "the edge is broken". But it means a green dashboard is not proof the
platform is reachable from the internet.

---

## 6. Queue depth — the one thing most likely to be silently wrong

Worker queue depth is the highest-value metric in this stack (`CLAUDE.md` §11.2). It is also the most
fragile, because it depends on a Redis key layout Langfuse does not document.

**A wrong key pattern produces no error.** `redis_exporter` matches nothing, `redis_key_size` is
absent, and the queue panels render **empty — which is indistinguishable from an idle, healthy
queue.** This is precisely the silent-failure class `CLAUDE.md` §18.11 says to guard hardest against.

So measure it:

```bash
./scripts/discover-queue-keys.sh
```

It scans the live Valkey, prints the real prefix and queue names, and outputs the exact
`REDIS_QUEUE_KEY_PATTERNS=` line to paste into `infra/.env`. Then:

```bash
cd infra && docker compose -f compose.yaml -f compose.monitoring.yaml up -d redis-exporter
./scripts/verify-metric-sources.sh    # fails loudly if depth is still unmeasured
```

If the script finds nothing, the worker has probably never processed a job. Send traffic through
`./scripts/ingestion-canary.sh` and re-run.

`:completed` is deliberately excluded from the patterns — BullMQ retains completed jobs, so that key
can hold tens of thousands of entries, making the per-scrape `SCAN` expensive for a number that
answers no operational question.

### 6.1 Reading depth correctly

From `OPERATIONS.md` §3 — **depth alone misleads in both directions:**

| Depth | Growth | Action |
|---|---|---|
| High | negative (draining) | **No action.** Recovering from a spike |
| Low | positive, sustained | **Scale workers.** A throughput deficit is forming |
| High | positive | **Critical.** Scale now |
| High | positive *after* scaling | **Escalate.** Workers are not the bottleneck — check ClickHouse write latency, S3 throttling, Redis CPU |

The *Ingestion & Queues* dashboard puts depth and derivative side by side for this reason.

---

## 7. Dashboards

All three are provisioned from JSON on disk. **UI edits are discarded on reload** (`allowUiUpdates:
false`) — a dashboard tweaked in a browser and never committed is lost on container replacement, and
its absence is discovered during an incident. Edit the JSON, commit, and Grafana picks it up within
30 seconds.

| Dashboard | Use it for | Read it |
|---|---|---|
| **Platform Overview** | "Is it healthy?" in under a minute. Sections mirror `OPERATIONS.md` §11 exactly | During incidents |
| **Ingestion & Queues** | The worker-scaling decision. Depth + derivative + throughput | Weekly, and when the queue moves |
| **Infrastructure & Capacity** | The tier decision. Disk growth, days-until-full, per-container load | Monthly |

Every panel carries the corresponding `OPERATIONS.md` threshold in its description, so the runbook
and the dashboard cannot drift apart.

### 7.1 The two panels that matter most

**Projected days until disk full** (Platform Overview). `OPERATIONS.md` §11 calls this one of the two
highest-value tiles on any dashboard, because it is a *leading* indicator. A disk at 45% tells you
nothing. A disk at 45% filling at 3 GB/day tells you the date. Under 30 days is a warning; under 14
is critical. ClickHouse disk exhaustion **stops ingestion**, and it is slow-moving enough that there
is no excuse for being surprised by it.

**Redis evictions** (Platform Overview). Not a performance metric. Valkey runs
`--maxmemory-policy noeviction` deliberately because it holds the ingestion queue — so any non-zero
value means queued events were **silently discarded**. Treat it as data loss, not memory pressure.

---

## 8. What is deliberately NOT collected

*"High signal, not maximum logging"* (`CLAUDE.md` §7.5) applied to metrics. Every series must
plausibly change a decision.

- **cAdvisor's per-CPU-core series, `container_tasks_state`, per-device filesystem series.** Dropped
  in `metric_relabel_configs`. cAdvisor is by far the highest-cardinality source here and most of
  that cardinality answers nothing.
- **node-exporter's default collector set.** Trimmed with explicit `--no-collector.*` flags — no
  mdadm, NFS, ZFS, InfiniBand or bcache exists on this box.
- **Most of ClickHouse's ~2000 ProfileEvents counters.** A dozen are actionable. Keeping all of them
  would make ClickHouse the largest contributor to our own TSDB — an unfortunate irony on a box whose
  main risk is disk exhaustion.
- **Per-project ingestion labels.** `OPERATIONS.md` §12 wants these and they are the right thing
  eventually. But the only per-project identifier available at the Caddy layer is the `Authorization`
  header — **which is the API secret.** Putting it in a metric label writes project secrets into the
  TSDB and onto every dashboard. Deferred to the same work that fixes per-project rate limiting;
  tracked in [`AUDIT-2026-08-12.md`](AUDIT-2026-08-12.md) as F-13.
- **Langfuse's internal OTel traces.** `OTEL_EXPORTER_OTLP_ENDPOINT` could point at a collector, but
  that is application tracing, not infrastructure monitoring, and would need a collector plus a trace
  backend.

---

## 9. Security notes

| Control | Where |
|---|---|
| No monitoring service publishes a host port | `compose.monitoring.yaml`; asserted by `test-monitoring-config.sh` |
| Grafana behind `ADMIN_ALLOWLIST` **and** its own login | Caddyfile `{$GRAFANA_DOMAIN}` block |
| Grafana anonymous access and sign-up disabled | `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false` |
| Grafana admin password required, never defaulted | `${GRAFANA_ADMIN_PASSWORD:?}` — an unset value fails the command rather than silently becoming `admin` |
| Caddy's **admin API stays on localhost** | Metrics are served from a separate `:2020` listener, not from `:2019` |
| MinIO metrics unauthenticated, S3 API not | `MINIO_PROMETHEUS_AUTH_TYPE=public` affects `/minio/v2/metrics/*` only, and MinIO publishes no host port |
| No outbound analytics | `GF_ANALYTICS_*=false` — private EU platform |

**The one real privilege grant:** cAdvisor runs `privileged: true` with host mounts. It needs this to
read cgroup and namespace state, and it is effectively root on the box. Accepted because every mount
is read-only and the image is pinned and single-purpose — but it is the largest new attack surface
here and should be the first thing revisited at Tier 2, where these metrics come from the kubelet
instead.

**Grafana SSO is prepared but not enabled.** Entra ID sign-in is wired into
`compose.monitoring.yaml` and defaults to off; turning it on is an `infra/.env` change.
Setup, cut-over and rollback: [`docs/GRAFANA-SSO.md`](GRAFANA-SSO.md).

Two corrections to what this section previously said. Entra ID OAuth is a **first-class
Grafana OSS provider** (`[auth.azuread]`), not something to bolt on through generic OAuth.
And it takes its **own app registration** — sharing Langfuse's would merge two apps' redirect
URIs and app roles, and put both behind one client secret whose expiry takes down the
platform and its monitoring together. Same tenant, separate registration.

SSO also does **not** supersede `ADMIN_ALLOWLIST`. Identity and network reach answer
different questions, and CLAUDE.md §12.1 keeps the UI behind the allowlist regardless.
Relaxing it is a separate decision, not a consequence of enabling SSO.

---

## 10. Maintenance

**Reload Prometheus config without dropping the TSDB head block:**

```bash
cd infra && docker compose -f compose.yaml -f compose.monitoring.yaml kill -s SIGHUP prometheus
```

**After any image version bump — especially ClickHouse:**

```bash
./scripts/verify-metric-sources.sh
```

Metric names are the silent failure mode of this whole stack. ClickHouse's async metrics *can* be
renamed across major versions, and a renamed metric yields an empty panel, not an error. That script
asserts every name the dashboards depend on actually exists on the live endpoint. It is the metrics
analogue of `CLAUDE.md` §7.6 — *fetch the real thing back and audit it*.

**Storage:** 90-day retention with a hard 10 GB size cap. Size retention wins when the two conflict,
because the biggest risk on this box is NVMe exhaustion stopping ingestion — and the monitoring stack
must never become the cause of the failure it exists to warn about. Watch the *Monitoring's own
footprint* panel; a series count climbing without a corresponding platform change means cardinality
is leaking, most likely from cAdvisor.

---

## 11. Next steps

1. **Collect a baseline.** Two to four weeks. Nothing below is worth doing before this.
2. **Calibrate the `OPERATIONS.md` §2 thresholds** against what was actually observed, replacing the
   placeholders.
3. **Add alerting rules** to `rule_files`, plus Alertmanager, routing to a channel the team reads.
4. **Off-host external monitor** (`CLAUDE.md` §19.8) — still outstanding, still not replaceable by
   this stack.
5. **Backup and restore-test metrics** so §11's resilience tiles stop being empty.
6. Grafana SSO via the existing Entra app registration.
