# Langfuse Platform — Master Roadmap

> **This is the sequencing document, not an executable plan.** Each stage links to its own
> implementation plan. Execute stages in order; do not start a stage before its predecessor's exit
> criteria are met.

**Goal:** Deliver a centralized, self-hosted Langfuse observability platform for all Eve/Vercel Agent
projects, built foundation-first.

**Governing principle:** Measure first → define thresholds → alert → automate safe actions →
continuously verify. Never scale on intuition.

**Source of truth for architecture:** [`../../../CLAUDE.md`](../../../CLAUDE.md)
**Operational detail:** [`../../OPERATIONS.md`](../../OPERATIONS.md)

---

## Why this is split into multiple plans

Phase 1 covers three subsystems with genuinely different shapes, failure modes, and reviewers:

| Subsystem | Nature | Testable by |
|---|---|---|
| **1A — Deployment** | Infrastructure, YAML/config | Health checks, ingestion canary |
| **1B — Tracing layer** | TypeScript package | Unit tests (TDD), real trace audit |
| **1C — Operations automation** | Monitoring, backups, CI | Alert firing, restore drill |

Each produces working, independently valuable software. Bundling them into one plan would create a
document nobody can review and a branch nobody can merge incrementally.

---

## Phase 1 — Hosting, Scaling, Tracing  ← **CURRENT**

### Stage 1A — Self-hosted Langfuse deployment

📄 **Plan:** [`2026-08-10-phase1a-langfuse-deployment.md`](2026-08-10-phase1a-langfuse-deployment.md)

Stand up Tier 1 Langfuse on a single Hetzner box via Docker Compose: all six components, UTC
everywhere, ClickHouse system-table TTLs applied at install time, TLS via Caddy with the public
ingest / private UI split, and headless project provisioning.

**Exit criteria**
- [ ] `GET /api/public/health?failIfDatabaseUnavailable=true` returns 200
- [ ] `GET /api/public/ready` returns 200; returns 500 after SIGTERM
- [ ] Ingestion canary writes a trace and reads it back successfully
- [ ] UI reachable only from the allowlist; ingest reachable publicly
- [ ] ClickHouse system-table TTLs verified applied
- [ ] Per-project credentials provisioned via `LANGFUSE_INIT_*`, not the UI

**Blocks:** 1B integration testing, 1C entirely.

---

### Stage 1B — `@org/agent-telemetry` shared tracing layer

📄 **Plan:** [`2026-08-10-phase1b-agent-telemetry.md`](2026-08-10-phase1b-agent-telemetry.md)

The highest-priority deliverable. One package owning the entire tracing standard so a new agent
project needs ~5 lines, not a new integration. Environment resolution, attribute stamping, sampling,
OTLP export, masking switch.

**Exit criteria**
- [ ] All unit tests pass; pure functions covered (environment, attributes, sampling, auth)
- [ ] A pilot Eve project integrates in ≤ 5 lines
- [ ] A real trace is fetched back via `langfuse-cli` and **audited against
      <https://langfuse.com/docs/observability/best-practices> fetched fresh**
- [ ] Trace shape matches the §7.1 mapping: turn = trace, session = `session.id`, subagent = `agent`
- [ ] Token usage present on every generation *(non-negotiable — Phase 2 cannot backfill it)*
- [ ] Serverless flush verified on a real Vercel deployment, not just locally
- [ ] Preview deployments confirmed writing to `preview`, never `production`

**Depends on:** 1A (needs a live endpoint to audit against).

---

### Stage 1C — Operations automation

📄 **Plan:** *not yet written — deliberately.*

Monitoring, alerting, backups, restore testing, update automation, vulnerability scanning.
Scoped by [`docs/OPERATIONS.md`](../../OPERATIONS.md) and CLAUDE.md §16 priorities 1–6.

> **Why deferred:** every threshold in this stage must be calibrated against measured behaviour.
> Writing exact alert thresholds before 1A/1B produce real traffic would violate the platform's own
> governing principle and bake in numbers we'd immediately have to unpick. The *structure* is already
> specified in `OPERATIONS.md`; the *values* come from measurement.

**Written once:** 1A and 1B have run in production for long enough to establish baselines
(target: ~2 weeks of real traffic).

**Ordered priorities** (CLAUDE.md §16):
1. External health monitoring + ingestion canary + alerting
2. Resource, queue, disk, DB, ingestion metrics
3. Automated backups
4. Restore testing
5. Update detection + staging deploys
6. Security/vulnerability scanning

---

### Stage 1D — Measurement and right-sizing

Not a build stage — a decision gate.

- [ ] Measure actual traces/day and observations/trace
- [ ] Confirm or refute the 500k+/day figure
- [ ] Measure the **message-history payload multiplier** (CLAUDE.md §7.5) — the largest storage risk
- [ ] Load-test Tier 1 to establish real capacity
- [ ] Calibrate `OPERATIONS.md` thresholds against observed baselines
- [ ] Decide whether §8.7 tier-upgrade triggers are near

**Output:** calibrated thresholds feeding 1C, and an evidence-based answer to "do we need Tier 2?"

---

## Phase 2 — Cost & usage monitoring

**Not started. Do not implement.**

Token usage, LLM cost, model usage; cost per project/agent/user/session; trends, expensive workflows,
anomalies.

**What Phase 1 must have preserved:** token usage on every generation. This cannot be backfilled —
if 1B ships without it, Phase 2 starts with no data.

---

## Phase 3 — Datasets

**Not started.** Promote production traces into evaluation datasets.

**Preserved by Phase 1:** clean, correctly-typed traces. Datasets are only as good as their source.

---

## Phase 4 — Experiments

**Not started.** Prompts, models, agent configs, workflows, retrieval, tool usage.

**Preserved by Phase 1:** stable trace/span naming. Comparison requires comparable structure.

---

## Phase 5 — Evaluations

**Not started.** Automated + human eval, LLM-as-judge, regression testing, quality metrics,
production evaluation.

**Preserved by Phase 1:** session and user identifiers.

---

## Cross-phase rules

1. **Do not start a phase before the previous one's exit criteria are met.**
2. **Do not implement future-phase features early.** Keep them unblocked, not built.
3. **Verify against current documentation before every architectural decision** — Langfuse, Eve, and
   Vercel all move fast. Where docs conflict with `CLAUDE.md`, docs win and `CLAUDE.md` gets updated.
4. **Scale only on measured metrics.** Kubernetes is a Phase 1C/1D outcome at the earliest, and only
   if §8.7 triggers fire.
