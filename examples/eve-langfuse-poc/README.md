# eve → Langfuse tracing proof-of-concept

> **We are working with the eve Vercel agent framework** (<https://vercel.com/eve>,
> docs at <https://eve.dev>) — **not** a plain Vercel AI SDK script, and not any
> other agent framework. Every instruction in this directory assumes eve. If a
> future change proposes replacing eve with a hand-rolled AI SDK agent, that is
> a different project; do not silently substitute it.

The single question this project answers:

> **Can an eve agent running on Vercel deliver traces to our self-hosted
> Langfuse, with usable metadata, generations, and timing?**

It is a test rig, not a production agent. Keep it minimal.

---

## Required tooling — both plugins are installed and must be used

Langfuse, eve, and the Vercel AI SDK all move fast, and this integration sits
exactly where all three meet. Pretrained knowledge about them is unreliable:
while building this PoC, three separate APIs turned out to have changed
(see [Verified facts](#verified-facts-checked-against-installed-code-not-memory)).

**Base every technical decision on current documentation fetched through these
tools, never on memory.**

| Tool | Status | Use it for |
|---|---|---|
| **Vercel plugin** | ✅ Installed | Vercel projects, deployments, env vars, Agent Runs observability for deployed eve agents, AI Gateway. Skills: `vercel:eve`, `vercel:ai-sdk`, `vercel:deploy`, `vercel:env`. |
| **Context7** | ✅ Installed (`context7@claude-plugins-official`) | Live library docs via `resolve-library-id` → `query-docs`. Useful ids: `/vercel/eve`, `/langfuse/langfuse-docs`, `/websites/langfuse_self-hosting`. |

Note `resolve-library-id` requires **both** `libraryName` and `query`.

**The bundled docs outrank everything.** eve ships its complete documentation
inside the installed package, matching the installed version exactly:

```bash
ls node_modules/eve/docs/          # start at README.md
cat node_modules/eve/docs/guides/instrumentation.md
```

Read those before writing eve code. Context7 is for cross-checking and for
libraries that do not bundle docs.

---

## Architecture

```
  eve agent (agent/agent.ts, agent/tools/*)
        │  eve creates one `ai.eve.turn` span per turn and registers the
        │  AI SDK's OTel integration itself, with runtime context enabled
        ▼
  agent/instrumentation.ts        ← auto-discovered by eve at startup
        │  registerOTel({ spanProcessors: [LangfuseSpanProcessor] })
        ▼
  LangfuseSpanProcessor           ← batches spans, HTTP Basic auth
        │
        ▼  OTLP/HTTP
  https://sportnavi-langfuse.sportnavi.de/api/public/otel
        │  returns 2xx immediately — QUEUED, not stored
        ▼
  Langfuse worker → ClickHouse    ← only a read-back proves this ran
```

### Why it is wired this way

**One provider, not two.** The OTel global tracer provider is a process-wide
singleton: the first registration wins and every later one is silently ignored.
So `instrumentation.ts` registers exactly one provider and attaches Langfuse to
it as a *span processor*. Adding a second provider — or a second AI SDK
telemetry integration on top of the one eve already registers — produces an
agent that looks perfectly wired and exports nothing.

**Presence of the file is the switch.** eve auto-discovers
`agent/instrumentation.ts`; there is no `isEnabled` flag. Delete the file and
the agent goes dark.

**Identity travels on runtime context.** eve injects its own half
(`eve.session.id`, `eve.turn.id`, `eve.step.index`, `eve.channel.kind`,
`eve.environment`). The `events["step.started"]` hook adds the Langfuse half
(`langfuse.session.id`, `langfuse.environment`, tags). In AI SDK v7 per-call
attributes ride on **runtime context**, not on a `metadata` field.

---

## Setup

```bash
cp .env.example .env.local     # then fill in the values
npm install
npm run typecheck
```

`.env.local` needs two independent credentials, which fail in different places:

| Variable | Where to get it | Symptom if wrong |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse UI → Project settings → API keys, or `scripts/provision-project.sh` | Agent runs fine; Langfuse stays empty (401 swallowed inside the batch exporter) |
| `AI_GATEWAY_API_KEY` | <https://vercel.com/[team]/~/ai/api-keys> | Agent fails on the first model call |

`LANGFUSE_BASE_URL` is the base URL only — the instrumentation appends
`/api/public/otel` itself.

## Run and verify

```bash
npm exec -- eve dev            # interactive REPL; ask "What's the weather in Berlin?"
npm run verify                 # read the traces back out of Langfuse
```

`npm run verify` is the part that matters. It fetches traces through the
Langfuse API and asserts:

- the trace exists at all (polling, because ingestion is queued)
- generations are present
- **token usage on every generation** — required for cost monitoring later, and
  it cannot be backfilled
- model name on every generation
- the tool call was traced
- timing (`endTime`, latency) on every observation
- the tree is actually nested, not a flat list of orphans
- `sessionId` and `environment` are set

Pass specific ids with `npm run verify -- <traceId> ...`.

---

## Verified facts (checked against installed code, not memory)

Recorded because each one contradicts what is widely written online, including
in current vendor docs for older versions:

| Fact | Verified against |
|---|---|
| `experimental_telemetry: { isEnabled: true }` **no longer exists**. AI SDK v7 uses `telemetry: {...}`, and telemetry is opt-**out** once an integration is registered. | `node_modules/ai/docs/03-ai-sdk-core/60-telemetry.mdx` (ai 7.0.58) |
| A plain AI SDK app must call `registerTelemetry(new OpenTelemetry())` from `@ai-sdk/otel` or it emits **no spans at all**. **eve does this for you** — do not repeat it here. | same doc + `node_modules/eve/docs/guides/instrumentation.md` |
| `registerOTel` accepts `spanProcessors`, which is the correct attach point for `LangfuseSpanProcessor`. | `node_modules/@vercel/otel/dist/types/types.d.ts:99` |
| Langfuse v4 requires the `x-langfuse-ingestion-version: 4` header. `LangfuseSpanProcessor` sets it; a hand-rolled `OTLPTraceExporter` does not. | Langfuse docs via Context7 |
| `POST /api/public/ingestion` and the OTLP endpoint return success on **queue**, not on store. | Langfuse self-hosting docs |

## The observability standard this implements

The bar: **a non-technical reviewer opens one trace and reconstructs the whole execution
without reading source code.** Concretely, every trace answers:

| Question | Where it is answered |
|---|---|
| What did the user ask? | `langfuse.trace.input` on `process-turn` |
| What was ultimately shown to the user? | `langfuse.trace.output`, written by the step that finished with `stop` |
| Which tools ran, with what arguments and results? | `call-<tool>` observations, input + output |
| Which model, which prompt, what did it return? | `call-model` generations |
| Which instructions produced this? | `promptRevision` in metadata (content hash) |
| How many tokens? | `gen_ai.usage.*` → Langfuse usage details |
| How long did each step take? | `durationMs` in metadata, plus native latency |
| What failed, and did it recover? | ERROR-level nodes **and** a `recoveredErrors` trace rollup |
| Who asked, and in which conversation? | `langfuse.user.id`, `langfuse.session.id` |

### Stable names are an API

Framework names embed the model id (`chat gpt-4o-mini`) and never increment (`step 1` three
times). Both are renamed before export, and `npm run verify` asserts them against an exact
allowlist so a framework upgrade cannot silently break saved dashboard filters:

| eve / AI SDK | Exported as |
|---|---|
| `ai.eve.turn` | `process-turn` |
| `invoke_agent <model>` | `agent-step` |
| `step 1` | `model-call` |
| `chat <model>` | `call-model` |
| `execute_tool get_weather` | `call-get-weather` |

Per-execution values (tool call id, step index, session id) go to metadata, never into names.

### Secrets are redacted, completeness is not compromised

A mask runs on every input, output and metadata payload before export, catching API keys,
bearer/basic credentials and JWTs. `verify-traces.ts` re-scans the **stored** data for the
same patterns — because a correct mask registered in the wrong processor order passes its
own unit tests and still exports secrets.

Nothing operationally important is dropped: tool arguments, tool results, model messages,
retrieval-free step IO, errors and timings are all exported in full.

## Full-workflow observability

Every observation carries **input, output, and metadata** — including wrapper steps and
failed tool calls. A verified multi-tool turn:

```
TRACE  eve-langfuse-poc.turn
  in : [{"role":"user","parts":[{"type":"text","content":"Give me a 3-day forecast…"}]}]
  out: [{"role":"assistant","parts":[{"type":"text","content":"The current weather in B…"}]}]

SPAN        process-turn                        ← the single root, one per turn
  AGENT     agent-step                          finish_reasons=["tool-calls"]
    SPAN    model-call
      GENERATION  call-model                    in: messages   out: tool_call
      TOOL        call-get-weather              in: {"city":"Munich"}  out: {"tempC":23,…}
  AGENT     agent-step                          finish_reasons=["tool-calls"]
    SPAN    model-call
      TOOL        call-get-forecast             in: {"city":"Munich","days":3}
  AGENT     agent-step                          finish_reasons=["stop"]   ← writes trace output
    SPAN    model-call
      GENERATION  call-model                    out: "The current weather in Berlin…"
```

Note the last `agent-step`, not the root, supplies the trace output. The root closes after
step 1 (pitfall 17), so taking its bubbled output would publish an intermediate `tool_call`
as "what the user was shown".

And the failure path, forced by asking for an unsupported city:

```
TOOL  call-get-forecast   [ERROR]
  status: No forecast coverage for "Tokyo". Supported cities: Berlin, Hamburg, Munich.
  in : {"city":"Tokyo","days":3}
  out: {"error":"No forecast coverage for \"Tokyo\"…","status":"ERROR"}

TRACE metadata:
  {"recoveredErrors":[{"step":"call-get-forecast","message":"No forecast coverage for…"}],
   "note":"One or more steps failed during this turn; see recoveredErrors for where and why."}
```

The rollup matters: the turn *succeeded* — the agent explained the limitation and answered.
Without it the trace list shows a clean green row and the failure is only findable by
expanding the tree.

This is not free — [`agent/enrich-spans.ts`](agent/enrich-spans.ts) does the work:

| Gap | Fix |
|---|---|
| Wrapper `step N` spans have no IO | Bubble up: first child's input, last child's output |
| Failed tools record no output | Synthesise `{error, status}` from the span status |
| Runtime context is namespaced | Promote `ai.settings.context.langfuse.*` → `langfuse.*` |
| No per-step metadata | Stamp model, provider, tool, duration, status, eve session/turn/step |
| No trace name or trace-level IO | Set on the app-root span |

**Why bubble up instead of pushing `modelInput` down through runtime context:** runtime
context is stamped on *every* span of a call, so the message history would be duplicated
per span — the quadratic payload growth CLAUDE.md §7.5 warns about. Bubbling stores each
payload once.

**Framework plumbing is filtered out** (`workflow.route.*`, internal `fetch` spans) by
Langfuse's default span filter — the high-signal default §7.5 asks for. Set
`LANGFUSE_EXPORT_ALL_SPANS=1` to see everything while debugging.

## Result

**Baseline (2026-08-10) — verified by read-back.** Run against
`https://sportnavi-langfuse.sportnavi.de`, model `gpt-4o-mini` via Azure OpenAI:

```
=== trace 6b76f875… ===
  PASS  observations present — 7          PASS  tree is nested — 7 children
  PASS  generation present — 2            PASS  environment set — development
  PASS  no errored observations — clean   PASS  sessionId set — wrun_01KZP4TASB…
  PASS  model on every generation — 2/2   PASS  timing present on all — 7/7
=== token usage (metrics API) ===
  PASS  token usage recorded — gpt-4o-mini=10140
ALL CHECKS PASSED
```

**Yes — an eve agent can deliver traces to the self-hosted Langfuse**, with generations,
tool calls, nesting, timing, session identity, environment, and token usage.

**Full-observability pass (2026-08-11) — verified pre-export only.** Ingest returns 200 but
every read API returns 403 from this network (pitfall 16), so this round was verified by
inspecting each span's final attributes with `EVE_SPAN_DEBUG=1` rather than by reading
traces back. What that inspection confirmed, on both the happy and the failure path:

| Checked | Result |
|---|---|
| Exactly one root observation | `process-turn`, `is_app_root=true`; the 3 competing roots are gone |
| Trace input | the user's actual question |
| Trace output | the final assistant **text** — no longer the first step's `tool_call` |
| Observation names | `process-turn` / `agent-step` / `model-call` / `call-model` / `call-get-forecast` |
| Failure path | tool node `level=ERROR` + status message + synthesised output |
| Recovered errors | `recoveredErrors` rollup on the trace, on a turn that ended successfully |

⚠️ **This is not the same standard of proof as the baseline.** Pre-export inspection shows
what was *sent*; only a read-back shows what was *stored*, and CLAUDE.md §7.6 requires the
latter. Run `npm run verify` from an allowlisted host before calling this done.

## Problems hit getting here

Nineteen of them, most silent. Full write-ups — what went wrong, why, and the fix — are in
[`docs/INTEGRATION-PITFALLS.md`](../../docs/INTEGRATION-PITFALLS.md). The ones most likely
to bite the next integration:

- AI SDK v7 removed `experimental_telemetry`; nothing is emitted without registration.
- The OTel provider is a process-wide singleton — a second one is silently ignored.
- eve's runtime context arrives namespaced as `ai.settings.context.*`, so
  `langfuse.session.id` never reaches Langfuse without a promoting span processor.
- `@ai-sdk/azure` appends `/v1` itself, so an endpoint ending in `/v1` 404s.
- This deployment runs Langfuse v4 `events_only`: the v3 read APIs are gone.
- Three spans each claimed `is_app_root`, making trace-level fields non-deterministic.
- The turn root span closes after step 1, so the trace output was a `tool_call`.
- `Span.updateName()` is an unconditional no-op inside `onEnd`.
- A 403 on reads with a 200 on ingest is the admin IP allowlist, not a bad key.

## Known gaps

- **Read-back verification is blocked from this network.** Ingest is public; every *read*
  API is behind the admin IP allowlist, so `npm run verify` returns `403 Not authorized`
  while `POST /api/public/otel/v1/traces` returns 200 from the same host with the same keys.
  The changes above were verified **pre-export** with `EVE_SPAN_DEBUG=1` (which prints each
  span's final attributes), *not* by reading traces back — and per CLAUDE.md §7.6 read-back
  is the only proof that counts. **Run `npm run verify` from an allowlisted host or VPN
  before treating this as done.** See pitfall 16.
- **Cost is not calculated yet.** `scripts/provision-model-prices.ts` is written and runs
  correctly, but `POST /api/public/models` is on the same allowlist. Run
  `npm run provision:prices` from an allowlisted host. Note Langfuse prices at ingestion,
  so this only affects traces recorded *afterwards*. Token usage (the part Phase 2 cannot
  backfill) is recorded regardless. See pitfall 7.
- **Prompt linking is a content hash, not a managed-prompt link.** Generations carry
  `promptName` + `promptRevision` (a hash of the system instructions) in metadata, which
  answers "did the instructions change between these two traces?". A real
  `langfuse.observation.prompt.*` link needs a versioned Prompt object created through the
  admin API — same allowlist. Claiming the link without the object would 404 in the UI.
- **Serverless flush is not proven here.** `eve dev` is a long-running process.
  A Vercel function that returns before its span batch flushes drops traces
  silently — the most likely cause of "traces are missing in production". That
  must be tested on a real Vercel deployment, not locally.
- **Not deployed to Vercel yet.** Local verification only so far.
- **`userId` is derived but unexercised.** It is read from eve's session auth principal
  (`session.auth.current.principalId`). Under `eve dev` the local-dev authenticator supplies
  no real principal, so the value is only proven to flow once this runs behind real channel
  auth.
- **No evaluation scores.** Scores, retrieval and reranking are out of scope for this agent
  — it has no retrieval step and no validation step to score. The requirements covering RAG
  observability apply to the first agent that actually does retrieval.
