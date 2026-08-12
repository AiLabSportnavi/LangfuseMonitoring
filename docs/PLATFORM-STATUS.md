# Self-hosted Langfuse — platform status

What works, what is configured, what is verified, and what is blocked. Nothing is
marked working until it has been exercised end to end.

**Instance:** `https://sportnavi-langfuse.sportnavi.de` · **Langfuse 4.6.0 OSS** ·
`events_only` mode · no Enterprise licence
**Agent:** `examples/eve-langfuse-poc` · eve 0.31.3 · `ai` 7.x · `@ai-sdk/azure` 4.x ·
`@langfuse/{client,otel,tracing}` 5.10.0

---

## 1. Deployment

| Component | Detail |
|---|---|
| Orchestration | Docker Compose, one Hetzner box (`infra/compose.yaml`) |
| Langfuse | `langfuse/langfuse:4.6.0` + `langfuse-worker:4.6.0` |
| Postgres | `postgres:17-alpine` |
| ClickHouse | `clickhouse-server:25.12-alpine`, single shard, system-table TTLs applied |
| Cache/queue | `valkey/valkey:8-alpine` |
| Blob | `minio` (S3-compatible) |
| Ingress | Caddy, TLS; UI gated by Entra ID SSO (single-tenant) |
| Licence | **OSS.** `LANGFUSE_EE_LICENSE_KEY` is set nowhere |

**Ingestion mode is `events_only`.** This is the single most consequential deployment
fact and it invalidates several documented endpoints — see §4.

---

## 2. Feature matrix

Legend — **Supported**: by this version/mode · **Configured**: set up here ·
**Verified**: exercised end to end and the data checked.

| Feature | Supported | Configured | Verified | Agent integration | Notes |
|---|---|---|---|---|---|
| Tracing | ✅ | ✅ | ✅ | ✅ | Full tree: `process-turn` → `agent-step` → `model-call` → `call-model` + tool |
| Generations | ✅ | ✅ | ✅ | ✅ | Typed `GENERATION`, input/output present |
| Spans | ✅ | ✅ | ✅ | ✅ | 8 observations per turn, correctly nested |
| Events | ✅ | ➖ | ➖ | ➖ | Supported; this agent emits none |
| Sessions | ✅ | ✅ | ✅ | ✅ | On the root observation (`wrun_…`) |
| Users | ✅ | ✅ | ✅ | ✅ | `local-dev` under `eve dev`; real principal needs real channel auth |
| Environments | ✅ | ✅ | ✅ | ✅ | `development`; experiments isolated in `experiment` |
| Metadata / attributes | ✅ | ✅ | ✅ | ✅ | On all 8 observations |
| Model information | ✅ | ✅ | ✅ | ✅ | `model: gpt-4o-mini`, `internalModelId` resolved |
| Token tracking | ✅ | ✅ | ✅ | ✅ | input / output / cached / total |
| **Cost tracking** | ✅ | ✅ | ✅ | ✅ | ≈ $0.00031 per generation, priced 2/2 |
| Prompt Management | ✅ | ✅ | ✅ | ✅ | `weather-assistant`, v1–v3 |
| Prompt versions | ✅ | ✅ | ✅ | ✅ | Created only on real content change |
| Prompt labels | ✅ | ✅ | ✅ | ✅ | `production`, `staging`, `latest`, `rollback` |
| Prompt variables | ✅ | ✅ | ✅ | ✅ | Native `compile()`; proven behaviourally |
| Prompt → generation link | ✅ | ✅ | ✅ | ✅ | Resolved `promptId` on every generation |
| Rollback / fallback | ✅ | ✅ | ✅ | ✅ | `rollback` label + local fallback |
| LLM Connections | ✅ | ✅ | ⚠️ | n/a | `azure-judge` created; request path verified by direct call |
| Playground | ✅ | ⚠️ | ❌ | n/a | Needs a **default evaluation model** set in the UI — see §3 |
| Datasets | ✅ | ✅ | ✅ | ✅ | `weather-agent/core`, 33 items, 10 categories |
| Dataset items | ✅ | ✅ | ✅ | ✅ | Idempotent upsert by `id` |
| Score configs | ✅ | ✅ | ✅ | n/a | 13 configs; BOOLEAN declared explicitly |
| Scores | ✅ | ✅ | ✅ | ✅ | Attached to traces, readable via v3 API |
| Experiments (SDK) | ✅ | ✅ | ✅ | ✅ | `npm run experiment` |
| Experiments (UI wizard) | ✅ | ⚠️ | ❌ | n/a | Blocked by the same default-model setting |
| Managed evaluators | ✅ | ⚠️ | ❌ | n/a | 22 templates present; blocked by default model |
| Human annotation | ✅ | ❌ | ❌ | n/a | Queues API reachable; none created |
| Monitors / alerts | ✅ | ❌ | ❌ | n/a | Deferred — automation is out of scope |
| Code evaluators | ⚠️ | ❌ | ❌ | n/a | Needs `LANGFUSE_CODE_EVAL_DISPATCHER`; only `insecure-local` off AWS |
| Protected prompt labels | ❌ EE | — | — | — | Enterprise only |
| Server-side masking | ❌ EE | — | — | — | Enterprise only; client-side masking is in use |

---

## 3. The warning triangles on managed evaluators — cause and fix

An evaluator needs a judge model. It gets one from either:

1. an explicit **`modelConfig`** on the evaluator itself, or
2. the **project's default evaluation model**.

All 22 **Langfuse-managed** templates ship with `modelConfig: null`, so they depend on
(2). The project default is not set, which is what the orange warning triangles beside
each managed evaluator in the **Run Experiment → Evaluators** wizard indicate.

> **Correction to an earlier claim in this document:** the default evaluation model is
> **not** on the Project Settings page. That page has General, API Keys, MCP & CLI,
> LLM Connections, Model Definitions, Scores Configs, Members, Integrations, Exports,
> Batch Actions, Audit Logs and Notifications — and no Evaluation entry. It is set from
> the Evaluators surface, not Settings.

**Route (1) works today and needs no UI at all.** A project-scoped evaluator created
with an explicit `modelConfig` bypasses the default entirely:

```jsonc
// mcp upsertEvaluator, or POST the equivalent to the unstable evaluators API
{
  "name": "hallucination-azure",
  "type": "llm_as_judge",
  "modelConfig": { "provider": "azure-judge", "model": "gpt-4o-mini" },
  "prompt": "…{{query}}…{{generation}}…",
  "outputDefinition": { "dataType": "NUMERIC", "reasoning": {…}, "score": {…} }
}
```

`provider` must match the `provider` field of a configured LLM connection — here
`azure-judge`, not `azure`.

**This is verified, not theoretical:** `hallucination-azure` v1 exists in the project
with `modelConfig: {provider: "azure-judge", model: "gpt-4o-mini"}`. Creation runs a
**preflight check** — a bad model or unreachable connection returns `422
evaluator_preflight_failed` — and it passed, so the Azure connection is confirmed usable
for evaluation.

The connection is independently known good: the exact request Langfuse issues
(`{baseURL}/deployments/gpt-4o-mini/chat/completions?api-version=2025-02-01-preview`,
with a forced tool call) returns **200** with a valid structured response.

**Still worth setting the project default**, so the 22 managed templates become usable
from the wizard without cloning each one. Do that from the **Evaluators** page in the
left nav (Evaluation → Evaluators).

> **Azure trap:** the connection `baseURL` must end `/openai`, **not** `/openai/v1`.
> Langfuse appends `/deployments/{model}` itself. The agent's own env var uses the
> `/v1` form for the AI SDK, which is a different surface. See
> `docs/INTEGRATION-PITFALLS.md` #20.

---

## 4. `events_only` mode — what it removes

Verified against the running server, not inferred:

| Endpoint | Status |
|---|---|
| `POST /api/public/otel/v1/traces` | ✅ the ingest path (note the full path; bare `/otel` is 404) |
| `POST /api/public/ingestion` | ⚠️ accepts **score and log** events, **rejects `trace-create`** |
| `GET /api/public/traces`, `/observations` (v3) | ❌ 404 — use `/api/public/v2/observations` |
| `GET /api/public/datasets/{name}/runs` | ❌ unavailable; "dataset runs are replaced by experiments" |
| `GET /api/public/experiments` | ✅ exists, requires `fromStartTime` |
| `GET /api/public/v2/metrics` | ✅ replaces the removed `/api/public/metrics` |

**Consequence for experiments:** SDK experiment runs do not register as queryable
experiments on this deployment, and the scores the SDK uploads arrive with
`traceId: null`. `evals/run.ts` therefore attaches scores explicitly to each item's
`traceId`, which is exact and works regardless of run abstraction.

---

## 5. Field-group traps

Three separate wrong-answer incidents came from the same cause: **the v2/v3 read APIs
return only core fields unless a field group is requested**, and a missing field is
indistinguishable from an empty one.

| To read | You must request |
|---|---|
| `input` / `output` | `fields=core,io` |
| `metadata` | `fields=core,metadata&expandMetadata=true` |
| `model`, `internalModelId`, cost, usage | `fields=core,model,usage` |
| `promptName` / `promptVersion` / `promptId` | `fields=core,prompt` |
| a score's subject (its `traceId`) | `fields=subject` |
| a score's `comment` | `fields=details` |

Also: the observation field is **`model`** (not `providedModelName`, not `modelId`) and
cost is **`totalCost`** (not `totalPrice`). Reading the wrong name yields `undefined`
for every row, which reads exactly like "the pipeline is broken". It is not.

---

## 6. Verification

From `examples/eve-langfuse-poc`, all currently passing:

```bash
npm run verify:instructions      # core instructions local+intact, layers disjoint
npm run verify:prompt-resolver   # 5 outage scenarios; never throws, warm path ~0ms
npx eve eval trace-smoke         # a real turn through the real agent
npm run verify                   # 58 trace-quality checks incl. model, cost, session, user
npm run verify:prompt-link       # generations carry a resolved promptId
npm run prompts:check            # git and Langfuse agree
npm run datasets:check           # 33 items + 13 score configs live
npx tsc --noEmit
```

Two tests worth understanding rather than just running:

- **Variables reach the model** — string-matching the trace is misleading, because the
  system prompt is not recorded verbatim. Run
  `AGENT_TEMPERATURE_UNIT=Fahrenheit npx eve eval trace-smoke`; the agent answers
  **66°F** and the eval's `includes("19")` assertion fails. That failure is the proof.
- **Langfuse is not a single point of failure** — run
  `LANGFUSE_BASE_URL=http://127.0.0.1:1 npx eve eval trace-smoke`. The agent still calls
  the tool and answers correctly (3/3 gates), because the core rules are local.

---

## 7. Remaining work

1. **Set the default evaluation model in the UI** (§3) — unblocks Playground, UI
   experiments and all 22 managed evaluators. Only you can do this.
2. **Human annotation queues** — supported, nothing created yet.
3. **Real `userId`** — currently `local-dev` from eve's local authenticator; needs a real
   channel auth principal to be meaningful.
4. **Monitors/alerts and CI** — deliberately deferred; automation is out of scope.
