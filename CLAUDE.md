# Langfuse Observability Platform

Centralized, self-hosted LLM observability for all Eve/Vercel Agent projects.

---

## 1. Project objective

We run a growing fleet of **Eve** agents deployed on **Vercel**. Today each project's behaviour is
opaque in production: we cannot reliably answer why an agent made a decision, which step was slow,
what a run cost, or whether quality regressed after a change.

This repository builds a **single shared Langfuse platform** that every current and future
Eve/Vercel Agent project reports into — rather than a bespoke observability setup per project.

The guiding requirement is not "collect logs." It is:

> A developer opens one trace in Langfuse and understands the complete execution flow from the
> incoming request to the final response, without reading any code.

**High signal, not maximum logging.** A noisy trace is a failed trace.

---

## 2. Long-term vision

Langfuse becomes the central place to understand, across every agent project:

| Area | What we get |
|---|---|
| Behaviour | Agent decisions, workflow steps, tool calls, sub-agent delegation |
| Debugging | Errors, retries, failure points, full parent/child execution tree |
| Performance | Latency per step, slow tools, bottlenecks |
| Cost | Token usage, model usage, cost per project / agent / session / user |
| Context | Sessions, users, environments, releases, tenants |
| Quality | Scores, evaluations, experiments, regression detection |

Reached in ordered phases (§10) — foundation first.

---

## 2.1 Current Objective: Self-Hosted Langfuse Platform Completeness

> **Make the self-hosted Langfuse platform fully functional and correctly integrated with the
> application. Every Langfuse feature supported by the installed OSS version and deployment mode
> must be configured, verified, and usable from the self-hosted Langfuse UI.**

This objective is **broader than connecting the agent to Langfuse**, and broader than prompt
management. The Langfuse UI is the primary place the platform is operated from. A feature is not
"working" because its page loads — it is working when it has been exercised end to end and the data
appears correctly.

**Standing constraints for this phase:**

- **`agent/instructions.md` must never be removed, renamed or replaced.** It holds the agent's core
  rules and ships with the code. It was deleted once; that was wrong and has been reverted.
- **Local instructions stay part of the application.** Langfuse manages a *separate*, additive layer.
- **Langfuse must not be a single point of failure.** A mistaken prompt edit in the UI, or Langfuse
  being unreachable, must degrade tone at worst — never remove the agent's core instructions and
  never stop it answering.
- **No duplicate system instructions.** eve concatenates `agent/instructions.md` with every entry in
  `agent/instructions/`, so any text present in both layers is emitted twice in every prompt.
  Enforced by `npm run verify:instructions`.
- **Prompt versions, labels and rollback must work**, including a local fallback.
- **Traces must carry correct model, session, user and environment metadata** — an anonymous LLM
  call is a defect, not a cosmetic issue, because cost attribution depends on it.
- **Playground, Datasets, Evaluators, Experiments, Scores and LLM Connections must work** where the
  installed version supports them.
- **Unsupported features are documented, never faked.** If OSS, `events_only` mode, or the installed
  version blocks something, say so precisely instead of building a replacement.
- **Automation is out of scope for this phase.** No CI/CD prompt deployment, no scheduled evaluation,
  no automatic promotion or rollback jobs, no background synchronisation. The platform must first be
  operable by hand through the UI.

Feature-by-feature status, verification commands and known limitations:
[`docs/PLATFORM-STATUS.md`](docs/PLATFORM-STATUS.md).
Prompt architecture and the two-layer split: [`docs/PROMPT-MANAGEMENT.md`](docs/PROMPT-MANAGEMENT.md).

---

## 3. Current phase

> ### **Phase 1 — Self-hosted Langfuse hosting, scaling, and high-quality tracing.**

**In scope now:** self-hosted deployment, its scale path, the centralized project model, and the
shared tracing layer.

**Explicitly out of scope now:** cost dashboards, datasets, experiments, evaluations. The
architecture must not *block* them; it must not *implement* them.

---

## 4. Confirmed requirements

Established during the architecture interview. These are decisions, not assumptions.

| # | Requirement | Decision |
|---|---|---|
| 1 | Agent framework | **Eve** (`eve.dev`), deployed on Vercel |
| 2 | Project count | "Many" — the platform is multi-project from day one |
| 3 | Hosting | **Self-hosted on Hetzner** (EU). *Not* on Vercel — see §5.1 |
| 4 | Drivers | Data residency, cost control at volume, internal policy/compliance |
| 5 | Residency & retention | **EU / GDPR, ~90 days** |
| 6 | PII | **No real PII in prompts/completions** → full input/output capture permitted |
| 7 | Trace depth | Deep: 50–200+ observations per trace |
| 8 | Volume ceiling | 500k+ traces/day *aspirational, unvalidated* — see §8.1 |
| 9 | Ops capacity | Small team, some devops skill → **operational simplicity outranks theoretical scale** |
| 10 | Availability | **Best-effort, non-blocking.** Agents must never fail or stall on Langfuse |
| 11 | Budget | **< €150/month** at Tier 1 |
| 12 | Project model | One Langfuse project per agent project; environment as an attribute |
| 13 | Environments | dev / staging / production, plus Vercel previews and local dev |
| 14 | CI/CD | GitHub Actions |

### 4.1 Open items to validate

- **Actual trace volume is unmeasured.** Tier 1 sizing is provisional until measured (§8.1).
- Capacity figures in §8.2 are **engineering estimates**. Langfuse publishes sizing rules for Redis
  (§8.5) and ClickHouse resource presets, but no end-to-end events/second throughput numbers. Tier
  capacity must be confirmed by load test before being relied on.

---

## 5. Architecture

### 5.1 Why Langfuse does not run on Vercel

A recurring proposal — and it is not viable. Per
[langfuse.com/self-hosting](https://langfuse.com/self-hosting), Langfuse requires **six long-running,
stateful components**:

| Component | Role |
|---|---|
| Langfuse **Web** | UI + API |
| Langfuse **Worker** | Asynchronous event processing |
| **Postgres** | Transactional database |
| **ClickHouse** | OLAP store for traces, observations, scores |
| **Redis / Valkey** | Queue and cache |
| **S3 / blob storage** | Raw events, multimodal payloads, large exports |

Vercel runs ephemeral serverless/edge functions. It cannot host ClickHouse, a persistent queue
worker, or Redis. Supported production targets are Kubernetes (Helm) or AWS/Azure/GCP via Terraform.

**Vercel stays on the producer side.** Agents run on Vercel and export traces over OTLP to Langfuse
hosted on Hetzner. This split is deliberate and correct.

### 5.2 Topology

```
┌────────────────────────── Vercel (EU) ──────────────────────────┐
│  Eve Agent A     Eve Agent B     Eve Agent C   ...  (many)      │
│      │                │                │                        │
│      └──── agent/instrumentation.ts ───┴───────────┐            │
│            (@org/agent-telemetry — shared package)  │            │
└─────────────────────────────────────────────────────┼───────────┘
                                                      │
                              OTLP/HTTP over TLS, async, fire-and-forget
                              Basic auth (per-project Langfuse keys)
                                                      │
┌──────────────── Hetzner dedicated, EU (Falkenstein/Helsinki) ───▼───────────┐
│  Caddy  ── TLS termination, rate limiting                                    │
│      ├── /api/public/otel/v1/traces, /api/public/ingestion → PUBLIC (keys)   │
│      ├── /api/public/health , /api/public/ready            → PUBLIC (probes) │
│      ├── rest of /api/public/* (prompts, datasets, scores) → PUBLIC (keys)   │
│      └── UI / admin / /api/auth/*                → Entra ID SSO, 1 tenant    │
│                                                                              │
│  langfuse-web  ×N     langfuse-worker ×N                                     │
│  Postgres    ClickHouse (1 shard)    Redis/Valkey                            │
│                                                                              │
│  Hetzner Object Storage (S3-compatible, EU) — events, exports, backups       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Key design decisions

**Hetzner, EU.** Satisfies GDPR residency, and storage/compute costs roughly an order of magnitude
below hyperscalers — directly serving requirements 4, 5 and 11.

**Docker Compose at Tier 1, not Kubernetes.** Requirement 9 (small team, part-time ops) outweighs
theoretical elasticity. Kubernetes + a self-operated ClickHouse cluster is a real ongoing job. The
scale path to Helm exists (§8.2) and is taken only when a measured trigger fires.

**The API is public and key-authenticated; the UI is public and identity-gated.** Vercel serverless
functions have **no static egress IPs** outside Enterprise Secure Compute, so IP-allowlisting ingest
was never possible. That constraint has since been generalised: `ADMIN_ALLOWLIST` is **removed**, and
the whole surface is internet-reachable, protected by TLS, per-project API keys and reverse-proxy
rate limiting — with the **UI and admin routes gated by Entra ID SSO (single-tenant)** rather than by
network position. See §12.1 for what this changes and why. Langfuse's own guidance supports it: the
`langfuse/langfuse` container is designed to be exposed publicly, has undergone penetration testing,
and is the same image serving Langfuse Cloud.

**Best-effort export.** OTLP export is asynchronous and non-blocking. Langfuse being down degrades
observability, never the agent. No durable ingest buffer at Tier 1 — losing an outage window of
traces is an accepted trade (requirement 10). Revisit only if traces ever become billing or
compliance evidence.

**All infrastructure runs in UTC.** Langfuse explicitly requires ClickHouse and Postgres timezones
set to UTC. Non-negotiable; a wrong timezone corrupts analytics silently.

---

## 6. Eve/Vercel Agent integration

### 6.1 The integration surface

Eve's [instrumentation guide](https://eve.dev/docs/guides/instrumentation.md) defines exactly one
hook. A file at `agent/instrumentation.ts` with a default export is **auto-discovered**, and its
mere presence enables telemetry:

```ts
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) =>
    registerOTel({ serviceName: agentName, traceExporter: /* OTLP → Langfuse */ }),
});
```

Langfuse accepts OTLP at **`/api/public/otel/v1/traces`** with:

```
Authorization: Basic base64(pk-lf-...:sk-lf-...)
x-langfuse-ingestion-version: 4
```

No bespoke SDK glue is required — this is a standards-based OTel path end to end.

> ⚠️ **The path is `/api/public/otel/v1/traces`, not `/api/public/otel`.** Verified 2026-08-11
> against the live 4.6.0 instance: a bare `POST /api/public/otel` returns **404**. The Caddy matcher
> `/api/public/otel*` is a wildcard, so it already covers the real path — but any hand-written curl,
> canary or exporter config using the bare path will silently fail.

### 6.2 The shared tracing layer — `@org/agent-telemetry`

**This is the core Phase 1 deliverable.** Adding a new agent project must not mean reinventing
instrumentation. A single internal package owns the entire standard, and each project's
`agent/instrumentation.ts` reduces to:

```ts
import { createLangfuseInstrumentation } from "@org/agent-telemetry";

export default createLangfuseInstrumentation({
  project: "support-agent",
  agentVersion: process.env.VERCEL_GIT_COMMIT_SHA,
});
```

The package owns, in one place for every project:

- OTLP exporter construction, endpoint, auth, batching and flush behaviour
- Environment resolution (§7.4) including Vercel preview detection
- The `events["step.started"]` hook that stamps standard attributes on every span
- Naming conventions, sampling policy, and any masking hook
- Version pinning of `@vercel/otel` and OTel dependencies

Changing the tracing standard is then one package release, not N pull requests. Anything a project
needs to override must be an explicit option on this package — never a local reimplementation.

### 6.3 Serverless flush semantics — the failure mode to watch

A serverless function that returns before its span batch is flushed **silently drops traces**. This
is the most likely cause of "traces are missing" and must be verified during Phase 1 on real Vercel
deployments, not only locally. Eve's durable execution runs on Vercel Workflow, which changes the
lifecycle relative to a plain route handler — flush behaviour must be validated empirically per
deployment target.

### 6.4 Long-parked runs

Eve turns **park durably** while awaiting human approval, OAuth callbacks, or subagent completion,
holding no compute and resuming later. A single trace can therefore span hours or days. The tracing
layer must not assume a trace closes within one request lifetime, and dashboards must not treat
wall-clock turn duration as latency. Report *active* step latency separately from parked time.

---

## 7. Tracing philosophy

### 7.1 The mapping

Eve's execution model maps almost 1:1 onto Langfuse's data model. **Follow this mapping exactly** —
it is the reason traces will be consistent across projects.

| Eve concept | Langfuse concept | Notes |
|---|---|---|
| **Session** (durable, days/weeks) | `session.id` | From `eve.session.id`, injected automatically |
| **Turn** (user message → response) | **Trace** | The unit a developer opens and reads |
| **Step** (one model call + its tools) | `generation` + child tool spans | |
| Tool call | `tool` span | Child of the step, **sibling of** the generation that requested it |
| Retrieval / lookup | `retriever` observation | Not a generic `tool` |
| **Subagent** (`$eve.type: "subagent"`) | `agent` observation, nested recursively | Not a `tool`/`span` |

**A trace is one turn.** Not one session (too coarse — unreadable), not one model call (too fine —
loses the flow).

### 7.2 Observation typing rules

Correct typing drives Langfuse's model analytics and Agent Graph. Per the installed Langfuse skill:

- Give every call its **most specific type** — `retriever` for a lookup, `agent` for a subagent —
  never a generic `tool`/`span` when something more precise exists.
- **Type a subagent's execution as `agent`.** A bare tool span hides its entire internal structure
  and removes it from the Agent Graph.
- **Never emit duplicate dispatch + execution nodes.** One `agent` observation per subagent, not a
  `tool` "dispatch" span plus a sibling `agent` node.
- **Name subagents distinctly.** Graph nodes key on name; framework-default generic role names make
  subagents indistinguishable. Derive a name from the subagent's actual task.
- Tools are siblings of the generation that requested them, **not children of it**.

### 7.3 Required attributes on every trace

| Attribute | Source | Purpose |
|---|---|---|
| `langfuse.trace.name` | Semantic, e.g. `support.turn` — never `trace-1` | Findable, filterable |
| `langfuse.session.id` | `eve.session.id` | Groups a conversation |
| `langfuse.user.id` | Channel auth context | Per-user cost & behaviour |
| `langfuse.environment` | Resolved (§7.4) | Isolates prod from noise |
| `langfuse.release` / `langfuse.version` | `VERCEL_GIT_COMMIT_SHA` | Regression attribution |
| `langfuse.trace.tags` | Project, agent, channel, tenant | Dashboard slicing |
| Model name | `gen_ai.request.model` | Model comparison |
| Token usage | `langfuse.observation.usage_details` | **Required for cost calculation (Phase 2)** |

Token usage is mandatory from day one. Without it, Phase 2 cost monitoring has no data to work from
and cannot be backfilled.

Eve additionally emits `$eve.*` workflow tags (`$eve.type`, `$eve.model`, `$eve.input_tokens`,
`$eve.output_tokens`, `$eve.cache_read_tokens`, `$eve.trigger`) to Vercel's Agent Runs dashboard.
That is a **separate surface from OTel export** — useful, but not a substitute for Langfuse.

### 7.4 Environment resolution

One Langfuse project per agent project; `langfuse.environment` separates the rest:

| Context | Value |
|---|---|
| Vercel production | `production` |
| Vercel staging | `staging` |
| Vercel preview deployment | `preview` |
| Local `eve dev` | `development` — or Eve's built-in on-disk `/traces` viewer, no export |

**Preview deployments must never write to `production`.** Resolve from `VERCEL_ENV`, never from a
hand-set variable a developer can forget.

### 7.5 High signal — what NOT to trace

> Avoid noisy traces. The goal is high signal, not maximum logging.

- **Full message history on every step.** Eve's `recordInputs` defaults to `true` and records the
  *entire message history per step*. In a 200-step turn this is roughly **quadratic payload
  growth** — the single largest storage and readability risk in this design. Measure it early;
  prefer recording deltas or the first/last step's context where the framework allows.
- Full tool JSON schemas on every call — static, belongs in code, not in every trace.
- Unchanged system prompts repeated per step.
- Health checks, static asset requests, and other non-agent traffic.
- Verbose framework internals with no decision value.

Ask of every observation: *does this help a developer understand what context the agent had when it
made its decision?* If not, drop it.

### 7.6 Self-audit is part of the work

Instrumentation is not done when the code compiles. Per the Langfuse skill, after instrumenting:
run the path end-to-end, **fetch the real trace back** (via `langfuse-cli`), audit it against
<https://langfuse.com/docs/observability/best-practices> — **fetched fresh, never from memory** —
fix gaps, and repeat until clean.

---

## 8. Scaling strategy

### 8.1 The volume question

The stated ceiling of 500k+ traces/day × 50–200 observations implies **25–100M observations/day**,
or **~2–9 billion rows** resident at 90-day retention. That is not compatible with a <€150/month
budget; it is a €800–2000/month tier.

Since actual volume is **unmeasured**, we build Tier 1 lean and move up on measured triggers.
**First engineering task: measure real agent request rate and step depth.** Every number below is
an estimate pending that measurement and a load test.

### 8.2 Scale tiers

| | **Tier 1 — now** | **Tier 2** | **Tier 3** |
|---|---|---|---|
| Deploy | Docker Compose, 1 dedicated box | App box + dedicated ClickHouse box; **ingest and UI split** | Kubernetes + Helm |
| ClickHouse | Single node, 1 shard | 3 replicas, 1 shard | 3 replicas, S3 external disks |
| Storage | Local NVMe + Object Storage | + tiered S3 | S3-backed, auto-scaling |
| HA | None | Partial | Full |
| Est. cost | **~€120/mo** | €300–600/mo | €800–2000/mo |
| Est. capacity | *low millions of obs/day* | *mid tens of millions* | *approaching the ceiling* |

**Tier 1 concretely:** one Hetzner AX102-class dedicated server (~16 cores, 128 GB RAM, ~3.8 TB
NVMe, ~€105/mo) running all six components via Docker Compose, plus Hetzner Object Storage
(S3-compatible, EU) and a Storage Box for backups.

### 8.3 The hard ceiling — read this before planning capacity

Per Langfuse's ClickHouse documentation: **"Langfuse does not support multi-shard clusters."**
Shard count must remain **1**.

You therefore **cannot scale ClickHouse horizontally by sharding**. You scale by:

1. Vertical growth (bigger box)
2. Replicas — minimum **3** for production redundancy; a replica count of 1 is no redundancy at all
3. **Retention** — Langfuse's built-in policy deletes aged data nightly (90 days for us)
4. **Sampling** (§8.4)
5. Blob storage as ClickHouse external disks for durable, auto-scaling capacity

A single shard handles "multiple terabytes." Beyond that, the documented options are ClickHouse
Cloud/BYOC or contacting Langfuse — both of which conflict with requirement 4 and must go through
compliance review before being considered.

Also note: **replica count cannot be increased at runtime** without manual intervention or downtime.
Plan replica topology before it is urgent.

### 8.4 Sampling is a Phase 1 requirement

Because sharding is unavailable and traces are deep, sampling is **not** a future optimisation.
Design it into `@org/agent-telemetry` now, even if it ships at 100% initially:

- **Always keep, unsampled:** errors, retries, and any turn with a negative score or user feedback.
- **Sample:** routine successful turns, head-based, with a per-project configurable rate.
- **Never sample within a trace.** Partial traces are worse than no trace — they mislead.

Shipping the knob at 100% costs nothing and means the response to a volume spike is a config change
rather than an emergency refactor.

### 8.5 Documented scaling levers

From <https://langfuse.com/self-hosting/scaling> — the official strategies, in the order to reach for them:

1. **Scale worker containers.** Ingestion is asynchronous: the OTLP endpoint queues events and returns
   immediately. Throughput is governed by worker count and concurrency, not by the web tier.
2. **Separate ingestion from UI.** Run distinct web deployments for ingest and for the UI so heavy
   analytical queries by humans cannot starve ingestion. **This is the Tier 2 upgrade to make first**
   — it is a topology change, cheaper than new hardware.
3. **Reduce ClickHouse reads.**
4. **Increase blob-storage write concurrency** via `LANGFUSE_S3_CONCURRENT_WRITES` (e.g. `100`) when
   the S3 client hits socket exhaustion or throttling. Raise gradually and observe.
5. **Shard queues across Redis nodes** under high Redis CPU. Note the trap:
   `LANGFUSE_INGESTION_QUEUE_PROCESSING_CONCURRENCY` and `LANGFUSE_TRACE_UPSERT_WORKER_CONCURRENCY`
   count **per shard** — with 10 shards and a target of 20 per worker, set concurrency to **2**, not 20.

**Redis sizing rule:** roughly **1 GB of memory per 100,000 events/minute**. Even at the aspirational
ceiling (~70k events/min) Redis needs only single-digit GB — it is not the bottleneck. ClickHouse is.

### 8.6 Protect the disk — mandatory at Tier 1

On a single box, ClickHouse's own system tables will consume the NVMe if left at defaults. Apply
aggressive TTLs and disable the query profiler **at install time, not after the disk fills**.

**Implemented in [`infra/clickhouse/config.d/langfuse-ttl.xml`](infra/clickhouse/config.d/langfuse-ttl.xml).**

⚠️ **An earlier revision of this section prescribed an `<engine>`-based config for every table. That
does not work** — verified empirically against ClickHouse 25.12, where it prevents the server from
starting at all (exit 36). ClickHouse rejects mixing `<engine>` with `<partition_by>`/`<ttl>` in
*both* directions, and which form is legal depends on what the stock `config.xml` ships per table:

| Stock definition | Tables | Correct form |
|---|---|---|
| `<partition_by>` | `query_log`, `trace_log`, `part_log` | bare `<ttl>` |
| neither | `metric_log`, `asynchronous_metric_log` | bare `<ttl>` |
| `<engine>` | `opentelemetry_span_log` | replace the element; TTL **inside** the engine |

The config file documents this mapping inline. Do not normalise it to one form — it is inconsistent
because the upstream defaults are inconsistent.

This is distinct from Langfuse's 90-day *trace* retention — it governs ClickHouse's internal
logging, a common and avoidable cause of disk exhaustion on single-node deployments.

### 8.7 Tier-upgrade triggers

Move up a tier when any of these is observed — not on intuition:

- ClickHouse disk > 60% of capacity at steady state
- Ingestion lag (worker queue depth) sustained above a defined threshold
- p95 UI query latency degrading past usability
- Sustained CPU saturation on the ClickHouse node

---

## 9. Operations philosophy

> **Measure first → define thresholds → alert → automate safe actions → continuously verify.**

The deliverable is not "Langfuse is running." It is a platform that **monitors all agents, monitors
itself, detects failure early, protects its data, automates safe operational work, and scales when
real traffic demands it** — with a controlled path for updates, backups, and recovery.

**The governing constraint:**

> We do not scale because we think we might need to. We measure the workload, define thresholds, and
> scale when real metrics demonstrate that capacity is required.

"We have many agents" is not a scaling signal. Queue growth is. Concretely: do **not** introduce
Kubernetes at Tier 1. Introduce it when §8.7 triggers fire.

Every automated action must have a stated **reason, threshold, rollback path, and alert**. Automation
should reduce toil, never replace engineering judgement.

📖 **Thresholds, procedures, runbooks and the dashboard specification live in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).** This section holds the decisions; that document holds
the detail. *(Kept separate deliberately: `CLAUDE.md` loads into every session's context, so
runbook-depth material belongs beside it, not inside it.)*

---

## 10. Monitoring and alerting

### 10.1 What is monitored

Langfuse Web · Langfuse Worker · ClickHouse · PostgreSQL · Redis/Valkey · host/cluster.
Full metric list and thresholds: [`docs/OPERATIONS.md §2`](docs/OPERATIONS.md).

**Implemented** as Prometheus + Grafana in [`infra/compose.monitoring.yaml`](infra/compose.monitoring.yaml),
merged explicitly alongside `compose.yaml`. Stack, metric sources and blind spots:
[`docs/MONITORING.md`](docs/MONITORING.md). **Alerting is deliberately deferred** until a baseline
exists — the thresholds in `OPERATIONS.md` §2 were written before anything was measured.

> **Langfuse exposes no Prometheus endpoint** — verified, not assumed
> ([discussion #1816](https://github.com/orgs/langfuse/discussions/1816) is open; the only built-in
> queue-metrics publisher targets CloudWatch). Its signals are therefore *derived*: worker queue
> depth from BullMQ's Redis keys, ingestion throughput from ClickHouse inserted rows, availability
> from blackbox probes, request load from Caddy. Do not go looking for `/metrics` on web or worker.
>
> Throughput is read at ClickHouse rather than at the edge on purpose: the ingest endpoint answers
> **on enqueue**, so an edge request rate can look healthy while nothing is persisted.

The two dominant risks, both slow-moving and both catchable well in advance:

1. **ClickHouse disk exhaustion** → ingestion stops. Track GB/day and **projected days-until-full**,
   not just current percentage. Alert on the projection.
2. **Worker queue backlog** → traces silently delayed or lost.

### 10.2 External health monitoring

> **Langfuse must not be the only system that knows Langfuse is down.**

An independent, **off-host** monitor probes the platform from outside. Verified endpoints:

| Endpoint | Use |
|---|---|
| `GET /api/public/health` | Liveness. `?failIfDatabaseUnavailable=true` for deep check |
| `GET /api/public/ready` | Readiness — **returns 500 after SIGTERM**, so traffic drains on shutdown |

**The ingestion canary is the check that matters most:** write a trace, then read it back. Ingest
accepts on *enqueue*, not on store — so an accepted write, and even a healthy `/health`, can coexist
with a completely backlogged pipeline. Only a read-back proves the path works.

> ⚠️ **This server runs ingestion in `events_only` mode.** Verified 2026-08-11:
> `POST /api/public/ingestion` still authenticates, but **rejects `trace-create` events** — it accepts
> only **score and log** events. The v3 read endpoints (`/api/public/traces`, `/api/public/observations`)
> return **404** in this mode.
>
> The canary must therefore write via `POST /api/public/otel/v1/traces` and read back via
> `GET /api/public/v2/observations`. [`scripts/ingestion-canary.sh`](scripts/ingestion-canary.sh)
> already does exactly this and documents why — **do not "fix" it back to the legacy endpoint.**
> The consequence that matters positively: **score ingestion over `/api/public/ingestion` still works**,
> which is what the evaluation layer depends on.

### 10.3 Alert severity

Four levels — **INFO** (normal events), **WARNING** (trending wrong, act in days), **CRITICAL**
(act now, includes backup failure), **EMERGENCY** (platform down or data at risk). Full matrix in
[`docs/OPERATIONS.md §4`](docs/OPERATIONS.md).

Alerts route to a channel the team actually reads. An unread alert is worse than no alert — it
manufactures false confidence.

---

## 11. Scaling execution

### 11.1 Layer separation

| Layer | Components | Policy |
|---|---|---|
| **Application** | Web, Worker | **Horizontally scalable.** Safe to autoscale on real metrics |
| **Data** | Postgres, ClickHouse, Redis, object storage | **Capacity-planned, never blindly autoscaled** |

**Never autoscale stateful databases.** ClickHouse replica count in particular cannot be increased
at runtime without manual intervention or downtime — plan topology before it is urgent.

### 11.2 Worker scaling signal

The worker is the ingestion bottleneck. Scale on **queue depth *and* growth rate together** — depth
alone misleads:

- A **large but draining** queue needs no action; it is recovering from a spike.
- A **small but steadily growing** queue needs immediate action; a throughput deficit is forming.
- A queue **still growing after scaling** means workers are not the bottleneck. Escalate and look at
  ClickHouse write latency, S3 throttling, or Redis CPU.

Scale-down uses stabilization windows and cooldowns to avoid thrash; never to zero. Decision table
in [`docs/OPERATIONS.md §3`](docs/OPERATIONS.md).

### 11.3 Target autoscaling topology (Tier 3)

```
                    Langfuse
                       │
             ┌─────────┴─────────┐
          Web Pods           Worker Pods     ← HPA on real metrics
             └─────────┬─────────┘
                 Data Services               ← capacity-planned
```

Adopted **only when §8.7 triggers fire.** Exact Helm HPA/probe/resource keys are **not yet verified**
— confirm against the [`langfuse-k8s` README](https://github.com/langfuse/langfuse-k8s) before
designing on them.

---

## 12. Security

### 12.1 Network isolation

**Never expose to the public internet:** PostgreSQL · ClickHouse · Redis/Valkey. Only the required
Langfuse application endpoints are externally reachable.

The ingest/UI split from §5.3 is a security boundary, not just a scaling one:

| Surface | Exposure | Controls |
|---|---|---|
| `/api/public/otel*`, `/api/public/ingestion*` | **Public** (Vercel has no static egress IPs outside Enterprise) | TLS · per-project keys · rate limiting · request-size limits · abuse protection |
| `/api/public/health`, `/api/public/ready` | **Public** | Required by the off-host monitor (§10.2); deliberately not rate limited |
| Rest of `/api/public/*` (prompts, datasets, scores, metrics) | **Public, key-authenticated** | TLS · per-project keys · rate limiting |
| UI / admin / `/api/auth/*` | **Public, identity-gated** | **Entra ID SSO, single-tenant** · RBAC · signup disabled · `/api/auth/*` rate limited |

> Do not expose the entire administration surface merely because ingestion must be public — but note
> that "restricted" now means **identity**, not network position.

#### ⚠️ `ADMIN_ALLOWLIST` is retired — access control is identity, not IP

The IP-allowlist model is replaced by **Microsoft Entra ID SSO (single-tenant)** for the Langfuse
site block. The config change lands in the same commit as this section; it takes effect on the
**next Caddy reload**, so treat the server as the source of truth until then
(`docker exec langfuse-caddy-1 sh -c 'echo $ADMIN_ALLOWLIST'`).

Pre-flight evidence gathered 2026-08-11, before the cut-over: `caddy validate` passes in the
server's own `langfuse-caddy:2.11.4-ratelimit-0.1.0` image, and password login is genuinely
refused (`POST /api/auth/callback/credentials` → redirect to `signin?csrf=true`,
`GET /api/auth/session` → `{}`), so SSO is enforcing rather than merely configured.

> **A `401` from an API does not prove the allowlist is off.** An allowlisted client sees `401`
> too — the allowlist rejects with `403` only for addresses *outside* it. Distinguishing the two
> from a single client is impossible; probe an allowlist-gated surface (the Grafana host) or read
> the running container's env. This was gotten wrong once already, by reading `401` as "no network
> gate" from an address that turned out to be allowlisted.

Two consequences that matter for **every future integration**:

1. **A `403` from a Langfuse API is no longer an allowlist rejection.** Do not go looking for an IP to
   add — that advice is obsolete and sends you down a dead end. A `401` means bad or missing keys.
2. **Agents on Vercel and GitHub-hosted CI runners can both reach the full public API.** Runtime
   prompt fetching, dataset sync, experiment runs and score ingestion need **no** network exception.

The driver was operational, not cosmetic: the operator's allowlist entry was a **dynamic residential
IP**, so a rotation simultaneously locked out the UI, the REST API and the MCP endpoint — and handed
allowlisted admin reach to whichever ISP customer inherited the address.

> `infra/caddy/Caddyfile` in this repo may still lag the deployed server. **The server is the source
> of truth for exposure**; verify with `curl` before designing around either.

All external traffic is HTTPS/TLS — agent→ingest and developer→UI alike. Internal traffic protected
per the deployment topology. Certificate expiry is monitored (§5 of the runbook).

### 12.2 Per-project credentials

**Never one global credential.** Each agent project gets its own Langfuse key pair, separated by
environment where appropriate:

```
support-agent   → own key      production
sales-agent     → own key      staging
research-agent  → own key      preview / development
```

A leaked key is then revocable for one project alone. This is also what makes per-project ingestion
attribution possible when volume spikes.

**Provisioning is automatable.** Langfuse supports **headless initialization** via `LANGFUSE_INIT_*`
environment variables — `LANGFUSE_INIT_ORG_ID`, `LANGFUSE_INIT_PROJECT_ID`,
`LANGFUSE_INIT_PROJECT_PUBLIC_KEY`, `LANGFUSE_INIT_PROJECT_SECRET_KEY`,
`LANGFUSE_INIT_PROJECT_RETENTION`, `LANGFUSE_INIT_USER_*` — creating resources at startup if absent.
This makes project and credential provisioning infrastructure-as-code.

> **Caveat:** headless init provisions a **single** org/project per startup. Onboarding "many"
> projects needs the public API, or the EE **Instance Management API** / **Organization Creators**.
> Confirm EE licensing before depending on those.

### 12.3 Secrets

Never committed to Git — not in source, not in checked-in config. Stored in Vercel environment
variables (per environment), Kubernetes Secrets, or CI/CD secret storage.

**Secrets must be rotatable without application code changes.** Because `@org/agent-telemetry` reads
credentials from the environment, rotation is a redeploy, not a refactor.

### 12.4 Rate limiting and abuse protection

The public ingest endpoint is protected at the reverse proxy against accidental telemetry floods,
malicious requests, compromised keys, runaway agents, and misconfigured projects. Ingestion metrics
are **labelled per project** so an abnormal producer is identifiable in minutes and throttled or
revoked in isolation.

### 12.5 Data protection

No real PII is expected in payloads (requirement 6), so full capture is permitted today. The masking
switch still exists in `@org/agent-telemetry`, because that assumption may not survive the next
project — **re-validate it whenever a project onboards.**

Two documented facts to note if the assumption ever changes:

- Langfuse offers **client-side masking** (SDK, open source) and **server-side ingestion masking**
  (`LANGFUSE_INGESTION_MASKING_CALLBACK_URL`, `..._TIMEOUT_MS`, `..._FAIL_CLOSED`) — the latter is **EE**.
- **Server-side masking does not protect blob storage:** the event is written to S3 *unmasked*
  before the worker applies the callback. Only client-side masking keeps raw data off the platform.

Eve's docs additionally note that recording full message history may require disclosure in privacy
materials.

---

## 13. Data protection, backups and recovery

**Backups** are automated, encrypted, stored off the primary host in EU storage, retained per the
90-day policy, and **monitored for both success and failure**.

**Restore testing is mandatory.** A backup is not valid because the job reported success — it is
valid because a restore worked. Scheduled restores into an isolated environment verify the databases,
confirm Langfuse starts and passes its health check, and confirm sample traces are queryable.
**Last successful restore test is a dashboard tile**; if it goes stale, disaster recovery is theory.

**Disaster recovery** is documented per failure scenario with agreed RTO/RPO. Note the priority
ordering: **Postgres is the crown jewel** — losing ClickHouse costs trace history, losing Postgres
costs the platform's identity and every project credential. Redis loss forfeits in-flight queued
events, which is acceptable under the best-effort policy (requirement 10).

All infrastructure is **defined as code** and reproducible. No hand-configured production hosts.

Procedures and the scenario matrix: [`docs/OPERATIONS.md §6–8`](docs/OPERATIONS.md).

---

## 14. Updates and supply chain

**Never `latest` in production. Pin versions.**

```text
Release detected → PR → CI (config, tests, lint) → staging → smoke tests
→ [human approval for majors] → production → post-deploy verification → rollback on failure
```

- **Patch/minor:** may auto-merge to staging on green CI; production remains gated.
- **Major:** always explicit human review against the current Langfuse upgrade guide, with specific
  attention to **ClickHouse schema migrations** — the risky, often irreversible ones.
- **Rollback is not safe across a schema migration.** That path needs its own tested procedure.

**Security updates are prioritized above feature updates** and tracked separately —
Dependabot/Renovate, GitHub security alerts, and container vulnerability scanning across Langfuse
images, Node dependencies, base images, and Kubernetes components.

**Deployment safety:** pre-deploy validates config, secrets, tests, and pending migrations, and
confirms a current backup exists; post-deploy runs health, ready, **ingestion canary**, UI smoke
test, worker check, and an error-rate window before the deploy is declared good.

---

## 15. Automation boundaries

Automate the safe and repetitive. These require human judgement regardless of confidence:

- Deleting production data · changing retention
- High-risk database migrations · major Langfuse upgrades
- Destructive infrastructure changes · modifying ClickHouse topology
- Changing authentication · rotating all credentials simultaneously
- Changing backup retention

---

## 16. Phase 1 automation priorities

Strictly ordered. **Do not skip ahead** — each step's value depends on the one before it.

| # | Capability | Why this order |
|---|---|---|
| 1 | Health monitoring ✅ + alerting ⏸ | Without it, nothing else is observable. Monitoring built (`docs/MONITORING.md`); alerting deliberately deferred until a baseline exists |
| 2 | Resource, queue, disk, DB, ingestion metrics ✅ | Thresholds require measurement first — this is what produces the measurements |
| 3 | Automated backups | Protect data before optimising anything |
| 4 | Restore testing | An untested backup is not a backup |
| 5 | Update detection + staging deploys | Safe change flow |
| 6 | Security/vulnerability scanning | Ongoing supply-chain hygiene |
| 7 | Kubernetes migration | **Only when measured workload requires it** |
| 8 | Web/Worker autoscaling | Requires k8s and calibrated thresholds |

Items 7–8 are explicitly **not** Phase 1 work unless §8.7 triggers fire.

---

## 17. Future roadmap

Design must not block these. **Do not implement them now.**

| Phase | Scope | Status |
|---|---|---|
| **1. Hosting / Scaling / Tracing** | Self-hosted Langfuse, scale path, centralized project model, shared tracing layer | **Current** |
| **2. Cost & usage** | Token usage, LLM cost, model usage; cost per project/agent/user/session; trends, expensive workflows, anomalies | Planned |
| **3. Datasets** | Promote production traces into evaluation datasets | Planned |
| **4. Experiments** | Prompts, models, agent configs, workflows, retrieval, tool usage | Planned |
| **5. Evaluations** | Automated + human eval, LLM-as-judge, regression testing, quality metrics, production eval | Planned |

**What Phase 1 must preserve for later phases:**

- **Token usage on every generation** — Phase 2 is impossible without it and it cannot be backfilled.
- **Clean, well-typed traces** — Phase 3 datasets are only as good as the traces they come from.
- **Stable trace/span naming** — Phase 4 experiment comparison depends on comparable structure.
- **Session and user identifiers** — Phase 5 production evaluation needs them.

> **Architectural principle: build the foundation correctly before adding advanced features.**
> Do not start datasets, experiments, or evaluations until the observability architecture is right.

---

## 18. Research and tooling requirements

**Base technical decisions on current documentation, not pretrained knowledge.** Langfuse, Eve, and
the Vercel AI SDK all move quickly; several facts in this document (ClickHouse single-shard limit,
Eve's instrumentation hook, the OTLP header contract) are exactly the kind that change between
releases.

> ### ⚠️ We are working with the **Eve Vercel agent framework**
>
> The agent side of this platform is **Eve** (<https://vercel.com/eve>, docs <https://eve.dev>) —
> *not* a hand-rolled Vercel AI SDK script, and not another agent framework. Instrumentation goes
> through Eve's auto-discovered `agent/instrumentation.ts` hook. Do not substitute a plain AI SDK
> integration for it.
>
> **The Vercel plugin, Context7, the Langfuse MCP server, the Langfuse skill, and Superpowers are all
> installed, and you are expected to use them.** Do not answer Eve, Vercel, or Langfuse API questions
> from memory — three separate APIs turned out to have changed while building the PoC (see
> [`examples/eve-langfuse-poc/README.md`](examples/eve-langfuse-poc/README.md)).
>
> **Eve ships its full docs inside the installed package** — `node_modules/eve/docs/`, matching the
> installed version exactly. Read those first; they outrank Context7, this file, and any web source.

| Resource | Status | Use for |
|---|---|---|
| **Langfuse skill** | ✅ Installed at `.claude/skills/langfuse/` | Langfuse features, CLI, instrumentation, best practices. Use it rather than re-deriving. |
| **Eve documentation** | ✅ <https://eve.dev/docs> | Instrumentation, execution model, deployment. Page index at `/llms.txt`. |
| **Vercel plugin** | ✅ Available | Vercel projects, deployments, env vars, platform capabilities |
| **Context7 plugin** | ✅ Installed (`context7@claude-plugins-official`, user scope) | Real-time library docs via `resolve-library-id` → `query-docs`. Useful IDs: `/websites/langfuse_self-hosting`, `/langfuse/langfuse-k8s`, `/langfuse/langfuse-docs`. |
| **Langfuse MCP server** | ✅ Installed, project scope — [`.mcp.json`](.mcp.json) | Direct access to *our* live Langfuse instance (`https://sportnavi-langfuse.sportnavi.de/api/public/mcp`). Use for querying real traces/prompts on the deployed platform, not for docs. |
| **Superpowers skills** | ✅ Installed (user scope) | Process skills — `brainstorming` before creative work, `systematic-debugging` before fixing bugs, `test-driven-development`, `writing-plans`, `requesting-code-review`, `verification-before-completion`. Process skills come first, then implementation skills. |

> **Two Langfuse surfaces, do not confuse them.** The **skill** (`.claude/skills/langfuse/`, pinned in
> [`skills-lock.json`](skills-lock.json)) is documentation and CLI know-how. The **MCP server** talks to our
> running instance. Docs question → skill. "What does trace X actually contain?" → MCP server or `langfuse-cli`.
> The MCP server needs `LANGFUSE_MCP_AUTH` (base64 `pk:sk`) in the environment; if its tools are missing, that
> variable is unset — see §12.3, never hardcode it into `.mcp.json`.

> **Context7 session caveat:** the plugin spawns `npx -y @upstash/context7-mcp` (v4.0.0, verified working).
> If its tools are absent from a session's tool list, the MCP server did not register at session start —
> restart the session. Note `resolve-library-id` requires **both** `libraryName` and `query` arguments.

### Key reference pages

- Langfuse self-hosting overview — <https://langfuse.com/self-hosting>
- ClickHouse requirements *(single-shard limit)* — <https://langfuse.com/self-hosting/infrastructure/clickhouse>
- **Scaling guide** *(worker scaling, ingest/UI split, Redis sharding, S3 concurrency)* — <https://langfuse.com/self-hosting/scaling>
- Cache/Redis sizing — <https://langfuse.com/self-hosting/deployment/infrastructure/cache>
- Health & readiness endpoints — <https://langfuse.com/self-hosting/configuration/health-readiness-endpoints>
- Headless initialization *(`LANGFUSE_INIT_*`)* — <https://langfuse.com/self-hosting/administration/headless-initialization>
- Administration — <https://langfuse.com/self-hosting/administration>
- Authentication & SSO — <https://langfuse.com/self-hosting/security/authentication-and-sso>
- Data masking *(server-side is EE)* — <https://langfuse.com/self-hosting/security/data-masking>
- Langfuse self-observability via OTel — <https://langfuse.com/self-hosting/configuration/observability>
- Kubernetes / Helm — <https://langfuse.com/self-hosting/deployment/kubernetes-helm>
- Helm values reference *(HPA, probes — **unverified, check here**)* — <https://github.com/langfuse/langfuse-k8s>
- OTLP endpoint & attribute mapping — <https://langfuse.com/integrations/native/opentelemetry>
- Tracing best practices *(fetch fresh when auditing)* — <https://langfuse.com/docs/observability/best-practices>
- Observation types — <https://langfuse.com/docs/observability/features/observation-types>
- Prompt management — <https://langfuse.com/docs/prompt-management/get-started>
- Prompt → trace linking *(**see the §18.1 caveat below before following it**)* — <https://langfuse.com/docs/prompt-management/features/link-to-traces>
- Experiments via SDK — <https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk>
- Experiments in CI/CD — <https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd>
- LLM-as-a-judge — <https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge>
- LLM connection *(required before any managed evaluator can run)* — <https://langfuse.com/docs/administration/llm-connection>
- Alerts / Monitors — <https://langfuse.com/docs/metrics/features/alerts>
- Metrics API v2 — <https://langfuse.com/docs/metrics/features/metrics-api>
- **Versions & compatibility matrix** *(what OSS v4 actually supports)* — <https://langfuse.com/self-hosting/upgrade/versioning#sdk-server>
- Licensing — what is EE vs OSS — <https://langfuse.com/self-hosting/license-key>

### 18.1 Verified version facts — check these before writing integration code

Established 2026-08-11 against the live instance and the installed SDK. **These are the facts that
were wrong in the docs or in this file, and each one cost time.**

| Fact | Detail |
|---|---|
| **Server** | Langfuse **4.6.0**, OSS, **no EE licence**. |
| **What is EE** | Only: project-level RBAC roles · **protected prompt labels** · retention policies · audit logs · server-side masking · UI customization · org creators · Org/Instance Management APIs. **Prompts, datasets, evaluators, experiments, annotation queues, alerts and automations are all OSS.** |
| **JS SDK family is v5, not v4** | `@langfuse/{client,tracing,otel,core}` are at **5.x**. JS SDK v4 is *deprecated* and v3/v2 *unsupported* against an OSS v4 server. The legacy monolithic `langfuse` package is effectively dead here despite npm not flagging it. Pin ≥5.3.0 for the CI experiment action and ≥5.4.0 for real-time evaluation. |
| **Metrics API** | `/api/public/metrics` is **gone**. Use **`/api/public/v2/metrics`**. The `traces` view no longer exists — use `observations` with the `isRootObservation` dimension. Cannot group by `id`/`traceId`/`userId`/`sessionId`; max 1000 rows. |
| **Managed evaluators** | **22 templates ship with the image** (Hallucination, Faithfulness, Correctness, Relevance, Toxicity, Out-of-Scope Request, …). They carry no model — an **LLM Connection** must exist per project before any of them can run. |
| **Code evaluators** | Disabled unless `LANGFUSE_CODE_EVAL_DISPATCHER` is set. Off AWS the only option is `insecure-local`, which runs evaluator code **unsandboxed in the worker**. Deliberately left disabled — deterministic checks belong in SDK evaluators. |
| **Evaluation Rules / Evaluators REST API** | Officially labelled **unstable**. Manage rules in the UI; treat any script as a read-only auditor. |

> #### ⚠️ `metadata.langfusePrompt` does **not** link a prompt on SDK v5
>
> The official docs tell you to link a prompt to a Vercel AI SDK generation with
> `experimental_telemetry: { metadata: { langfusePrompt: prompt.toJSON() } }`. **That is the v3
> `LangfuseExporter` convention and it does nothing on `@langfuse/*@5.x`** — verified by grepping the
> installed tree, where the string `langfusePrompt` does not appear at all. It silently lands a JSON
> blob in observation metadata and creates **no link**.
>
> On v5 the mechanisms that exist are the span attributes **`langfuse.observation.prompt.name`** and
> **`langfuse.observation.prompt.version`**, plus `propagateAttributes({ prompt }, fn)` from
> `@langfuse/core`.
>
> **A fallback prompt never links.** Three `isFallback` guards drop the attributes when
> `prompt.isFallback` is true, and it is logged only at `debug` level. So the situation where you most
> need the trace to tell you something is exactly the one where Langfuse tells you nothing — carry an
> explicit trace tag for it.
>
> **Verification standard: metadata presence is not evidence.** The prompt name must render as a
> *clickable link* in the trace UI. Nothing else proves it.
- Eve instrumentation — <https://eve.dev/docs/guides/instrumentation.md>
- Eve execution model & durability — <https://eve.dev/docs/concepts/execution-model-and-durability.md>
- Eve deployment on Vercel — <https://eve.dev/docs/guides/deployment/vercel.md>

### Working rules

1. Validate architectural assumptions against current docs before committing to them.
2. Prefer simple, maintainable architecture over unnecessary complexity.
3. Design for scale; do not prematurely over-engineer.
4. Tracing quality is the highest priority in Phase 1.
5. Tracing must be reusable — a new agent project should need ~5 lines, not a new integration.
6. Keep future phases unblocked without implementing them.
7. Clearly separate what is being implemented now from what is planned.
8. **Scale on measured metrics, never on intuition or agent count.**
9. Every automated action needs a reason, threshold, rollback path, and alert.
10. **When documentation conflicts with this file, the current official documentation wins** — verify,
    then update this file to match.
11. **Document every mistake, bug, and surprise — immediately, in the knowledge base.** Any
    integration issue, configuration problem, or unexpected behaviour gets written up with **what went
    wrong, why it happened, and how it was fixed**, plus the config/dependency/command detail needed
    to avoid it again. Infrastructure issues go in [`docs/DEPLOYMENT-PITFALLS.md`](docs/DEPLOYMENT-PITFALLS.md);
    agent/tracing integration issues go in [`docs/INTEGRATION-PITFALLS.md`](docs/INTEGRATION-PITFALLS.md).
    If it could affect a future integration, add a troubleshooting note there rather than only fixing
    the code. **These are living documents — keep them current as new issues are found.**

    > Record the *silent* failures most carefully. In this project the majority of tracing bugs
    > produced a working agent, a clean log, and wrong or missing data. Those cost the most time and
    > are the least discoverable from the code alone.

---

## 19. Immediate next steps

Not yet started — Phase 1 implementation begins here.

1. **Measure actual trace volume and step depth.** Everything in §8 is provisional until this exists.
2. Stand up Tier 1 Langfuse on Hetzner via Docker Compose (UTC, TLS, split public ingest / private UI),
   **including the ClickHouse system-table TTLs from §8.6 at install time.**
3. Build `@org/agent-telemetry` with the standard attribute set and the sampling knob.
4. Integrate one pilot Eve project end to end.
5. **Audit a real trace** against Langfuse best practices; iterate until it clears (§7.6).
6. Verify serverless flush behaviour on a real Vercel deployment (§6.3).
7. Confirm the message-history payload multiplier (§7.5) against measured data.
8. **External health monitoring + ingestion canary** (automation priority 1) — off-host, alerting to
   a channel the team reads.
9. ~~**Metrics collection** for worker queue depth/growth and ClickHouse days-until-full (priority 2)~~
   — ✅ **built** ([`docs/MONITORING.md`](docs/MONITORING.md)). Now **run it and collect 2–4 weeks of
   baseline**, then calibrate the placeholder thresholds in `docs/OPERATIONS.md` §2 and add alerting.
   Item 1 above (measure real trace volume and step depth) is answered by the *Rows persisted to
   ClickHouse* panel — until it has data, everything in §8 remains provisional.
10. Backups configured (priority 3) **and a restore tested** (priority 4).
11. Provision per-project credentials via `LANGFUSE_INIT_*` / API — never a shared key.
12. Roll out to remaining projects via the shared package.

> Priorities 5–8 of §16 (update automation, vulnerability scanning, Kubernetes, autoscaling) are
> deliberately **not** in this list. They come after the platform is measured.
