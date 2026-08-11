# Integration Pitfalls — eve Agent → Langfuse Tracing

Companion to [`DEPLOYMENT-PITFALLS.md`](DEPLOYMENT-PITFALLS.md), which covers standing the
platform *up*. This file covers connecting an **eve agent** to it.

Every issue below was hit while building [`examples/eve-langfuse-poc`](../examples/eve-langfuse-poc),
diagnosed to root cause, and fixed. They are recorded because **none were obvious from the
documentation** and most produced no error at all.

> **The recurring theme: silent success.** Six of the ten issues below produce a working
> agent, a clean log, and an empty or subtly wrong Langfuse. Tracing has no natural
> feedback loop — the code path that reports failure is the code path that is broken. The
> only reliable check is to **read the trace back out** and assert on it.

**Read this before changing `agent/instrumentation.ts` or onboarding a new agent project.**

---

## Severity index

| # | Issue | Symptom | Silent? |
|---|---|---|---|
| 1 | AI SDK v7 removed `experimental_telemetry` | No spans emitted at all | ✅ silent |
| 2 | OTel provider is a process-wide singleton | Second exporter receives nothing | ✅ silent |
| 3 | Langfuse v4 `events_only` retires the v3 read APIs | Verification tooling 400s | ❌ loud |
| 4 | Azure `baseURL` double `/v1` | 404 "Resource not found" | ❌ loud |
| 5 | Runtime context is namespaced `ai.settings.context.*` | Empty session, missing tags | ✅ silent |
| 6 | `environment` cannot be set from runtime context | Everything lands in `default` | ✅ silent |
| 7 | No model definition → no cost | Tokens present, cost null | ✅ silent |
| 8 | `eve dev` survives its parent process | Edits appear not to apply | ✅ silent |
| 9 | `.gitignore` `.env*` swallows `.env.example` | Template never committed | ✅ silent |
| 10 | MCP at project scope commits a secret | Credentials in git | ✅ silent |
| 11 | Wrapper spans carry no input/output | Empty box between populated ones | ✅ silent |
| 12 | `/v2/observations` hides IO unless `fields=core,io` | "Inputs and outputs are missing" | ✅ silent |
| 13 | A tool that throws records no output | Failure step is a black box | ✅ silent |
| 14 | Pushing `modelInput` through runtime context | Quadratic payload growth | ✅ silent |
| 15 | Several spans each claim `is_app_root` | Trace-level fields are non-deterministic | ✅ silent |
| 16 | Read APIs sit behind the admin IP allowlist | `403 Not authorized` that reads as a bad key | ❌ loud |
| 17 | The turn root closes before the turn finishes | Trace output is a `tool_call`, not the answer | ✅ silent |
| 18 | `Span.updateName()` is a no-op inside `onEnd` | Renames silently do nothing | ✅ silent |
| 19 | Framework span names embed the model id | Names churn on every model change | ✅ silent |

---

## 1. AI SDK v7 removed `experimental_telemetry`

**Symptom.** The agent runs, the exporter is configured, no spans are ever produced.

**Root cause.** Every guide online — including Langfuse's own current cookbook — shows:

```ts
experimental_telemetry: { isEnabled: true }   // AI SDK v4/v5. GONE in v7.
```

In **AI SDK v7** the option is `telemetry`, and span emission requires registering a
telemetry integration once at startup. Without registration the SDK emits **nothing**:

```ts
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";

registerTelemetry(new OpenTelemetry());
```

Telemetry is then opt-**out** per call (`telemetry: { isEnabled: false }`).

**In eve you do not write this.** eve registers the AI SDK's OpenTelemetry integration
itself, with runtime context enabled. Adding your own is redundant.

**Verified against** `node_modules/ai/docs/03-ai-sdk-core/60-telemetry.mdx` (ai 7.0.58).

> **Lesson: check the installed package's bundled docs, not the web.** `ai` and `eve` both
> ship their documentation inside the package, matching the installed version exactly.

---

## 2. The OTel tracer provider is a process-wide singleton

**Symptom.** An exporter that is provably constructed, with correct credentials, receives
nothing. No error anywhere.

**Root cause.** `@opentelemetry/api` holds **one** global tracer provider. The first
registration wins; every later `registerOTel()` / `NodeSDK.start()` is silently ignored.
Any second provider — a vendor SDK's, `Sentry.init()`'s, or your own — is dropped.

**Fix.** Register exactly one provider and attach every backend to it as a **span
processor**:

```ts
registerOTel({
  serviceName: agentName,
  spanProcessors: [new LangfuseSpanProcessor({ ... })],   // attach, don't re-register
});
```

`registerOTel` accepts `spanProcessors` — verified at
`node_modules/@vercel/otel/dist/types/types.d.ts:99`.

**If the agent also uses Sentry**, Sentry registers the provider first. Attach Langfuse via
`Sentry.init({ openTelemetrySpanProcessors: [...] })` instead, or Langfuse gets nothing.

> **Lesson: "my exporter is configured" and "my exporter is connected" are different claims.**
> Only a read-back distinguishes them.

---

## 3. Langfuse v4 `events_only` mode retires the v3 read APIs

**Symptom.** Verification tooling written against the documented API fails:

```json
{"message":"This endpoint is not available on deployments running in Langfuse v4 events_only mode."}
```

**Root cause.** This deployment runs Langfuse v4 in `events_only` mode. The v3 read
endpoints are gone. Traces are no longer a first-class read model — they are reconstructed
by grouping observations on `traceId`.

| Retired (v3) | Replacement (v4) |
|---|---|
| `GET /api/public/traces` | `GET /api/public/v2/observations?fromStartTime=<from>&toStartTime=<to>` |
| `GET /api/public/traces/:id` | same, then group by `traceId` |
| `GET /api/public/observations/:id` | same |
| `GET /api/public/metrics` | `GET /api/public/v2/metrics?query=<urlencoded json>` |

`GET /api/public/projects` still works and is the cheapest credential check.

**Note both time bounds are mandatory** on `/v2/observations`; omitting them returns an
error, not a default window.

**Fix.** [`scripts/verify-traces.ts`](../examples/eve-langfuse-poc/scripts/verify-traces.ts)
uses the v4 endpoints. Do not "fix" it back to `/api/public/traces`.

---

## 4. Azure `baseURL` produces a double `/v1` and a 404

**Symptom.** Every model call fails:

```
[eve:harness.tool-loop] Resource not found { statusCode: 404, upstreamStatusCode: 404 }
```

The natural reading — wrong deployment name, or a missing Azure resource — is wrong. The
same credentials succeed via `curl`.

**Root cause.** `@ai-sdk/azure` **appends `/v1` itself** for any `*.openai.azure.com` host:

```js
// node_modules/@ai-sdk/azure/dist/index.js
} else {                                          // useAzureOpenAIEndpoint
  fullUrl = new URL(`${baseUrlPrefix}/v1${path}`);
}
```

So the natural-looking `AZURE_..._ENDPOINT=https://x.openai.azure.com/openai/v1` becomes
`…/openai/v1/v1/chat/completions` → 404.

| URL | Result |
|---|---|
| `…/openai/v1/chat/completions?api-version=v1` | **200** |
| `…/openai/v1/v1/chat/completions?api-version=v1` | 404 |

**Fix.** Strip a trailing `/v1` before passing it as `baseURL` — see
[`agent/model.ts`](../examples/eve-langfuse-poc/agent/model.ts). Accepting both forms means
the env var can be copied from the Azure portal as-is.

**Verified against** `@ai-sdk/azure` 4.0.37.

---

## 5. Runtime context arrives namespaced under `ai.settings.context.`

**Symptom.** The trace looks complete — correct tree, generations, timing — but
`sessionId` is empty and tags are missing. No error.

**Root cause.** Values returned from eve's `events["step.started"]` **do** reach the span,
but the AI SDK namespaces them. Returning `"langfuse.session.id"` produces the span
attribute:

```
ai.settings.context.langfuse.session.id      ← what actually arrives
langfuse.session.id                          ← what Langfuse reads
```

Langfuse never sees its own attribute, so it falls back to empty.

**How to detect.** Guessing is expensive here; dump the real keys instead. The PoC ships a
debug span processor behind `EVE_SPAN_DEBUG=1` that prints every span's attribute names.
That one run answered a question that grepping bundles had not.

**Fix.** A span processor that promotes `ai.settings.context.langfuse.*` → `langfuse.*`,
registered **before** `LangfuseSpanProcessor` (processors run in registration order). See
`LangfuseAttributePromoter` in
[`agent/instrumentation.ts`](../examples/eve-langfuse-poc/agent/instrumentation.ts).

> **Lesson: when an attribute "doesn't arrive", check whether it arrived under a different
> name.** The two are indistinguishable from the UI.

---

## 6. `environment` cannot be set from runtime context

**Symptom.** Every trace lands in environment `default` despite
`langfuse.environment` being set in `step.started`.

**Root cause.** Two reasons. Runtime context is namespaced (issue 5) — but even fixed,
`step.started` fires on the **first model call**, while spans opened before it (the agent
root, HTTP, workflow spans) are already underway.

**Fix.** `environment` is a `LangfuseSpanProcessor` constructor parameter. Set it there —
it is stamped in `onStart` on every span:

```ts
new LangfuseSpanProcessor({ environment: process.env.LANGFUSE_ENVIRONMENT ?? "development" })
```

`release` works the same way and should carry `VERCEL_GIT_COMMIT_SHA` in deployed
environments.

> **Lesson: per-call hooks cannot set trace-wide properties.** Anything that must hold for
> the whole trace belongs on the processor.

---

## 7. Token usage arrives, but cost does not

**Symptom.** Generations show correct token counts, yet `modelId`, `inputPrice`,
`outputPrice` and `totalPrice` are all `null`.

**Root cause.** Token usage and cost are separate. Usage comes from the span
(`gen_ai.usage.input_tokens` / `output_tokens`); **cost requires Langfuse to match the
model name against a price definition.** The Azure *deployment* name (`gpt-4o-mini`) did
not match one.

**Confirm usage is genuinely stored** — the `/v2/observations` list does not return usage
fields, so absence there proves nothing. Use the metrics API:

```bash
curl -s -G -H "Authorization: Basic $AUTH" \
  --data-urlencode 'query={"view":"observations","metrics":[{"measure":"totalTokens","aggregation":"sum"}],"dimensions":[{"field":"providedModelName"}],"fromTimestamp":"...","toTimestamp":"..."}' \
  "$LANGFUSE_BASE_URL/api/public/v2/metrics"
# -> {"data":[{"providedModelName":"gpt-4o-mini","sum_totalTokens":22873,...}]}
```

**Fix (deferred).** Add a model definition in Langfuse mapping the deployment name to
prices. Not done here: cost dashboards are **Phase 2**, and CLAUDE.md §3 puts them out of
scope. Token usage — the input Phase 2 needs and the one thing that **cannot be
backfilled** — is confirmed present.

> **Integration note for every new agent project: verify token usage on day one.** A
> project that ships without it cannot be retrofitted.

---

## 8. `eve dev` outlives the process that started it

**Symptom.** You stop the dev server, restart it, and the new code does not take effect:

```
A dev server is already running for this eve agent.
```

Worse, it looks like your fix did not work.

**Root cause.** `eve dev` spawns a server that is not killed when its parent shell exits.
Instrumentation runs **once at startup**, so a stale server means stale instrumentation no
matter how many times you edit the file.

**Fix.** Kill by port (default `2001`):

```bash
netstat -ano | grep ":2001"          # last column is the PID
taskkill //PID <pid> //F             # Windows/Git Bash
```

⚠️ **On a non-English Windows the state column is localised** — German shows `ABHÖREN`, not
`LISTENING`, so `grep LISTENING` silently matches nothing and the kill is skipped. Match on
the port, not the state word.

---

## 9. `.gitignore` `.env*` also ignores `.env.example`

**Symptom.** The env template is never committed, so the next developer has no record of
which variables the agent needs.

**Root cause.** `eve init` writes `.env*`, which matches `.env.example` too.

**Fix.** Re-include it explicitly:

```gitignore
.env*
!.env.example
```

---

## 10. Adding an MCP server at project scope commits a secret

**Symptom.** `claude mcp add --scope project` writes `.mcp.json` **into the repository**,
including any `--header` value — i.e. `Authorization: Basic <base64 pk:sk>` in git.

This directly violates CLAUDE.md §12.3 ("never committed to Git").

**Fix.** Use environment expansion so the file is safe to commit:

```bash
claude mcp add --scope project --transport http langfuse \
  "$LANGFUSE_BASE_URL/api/public/mcp" \
  --header 'Authorization: Basic ${LANGFUSE_MCP_AUTH}'
```

Then set `LANGFUSE_MCP_AUTH` (= `base64(publicKey:secretKey)`) in the environment.

**Note on reachability:** `/api/public/mcp` is *not* in the public-ingest matcher in
[`infra/caddy/Caddyfile`](../infra/caddy/Caddyfile), so it falls through to the admin
allowlist. The MCP server works only from an allowlisted IP. That is correct — it is an
admin surface, not an ingest one — but it means CI runners cannot use it without being
allowlisted.

---

## 11. eve's per-step wrapper spans carry no input or output

**Symptom.** The trace tree is structurally right, but the `step N` span — the level a
human actually reads — is empty. Generation and tool spans below it have full payloads.

**Root cause.** eve creates a wrapper span per step. The AI SDK writes `gen_ai.input.messages`
and `gen_ai.output.messages` onto the *generation*, not onto the wrapper. Nothing populates
the wrapper, so Langfuse renders it blank.

**Fix.** A span processor that bubbles IO upward. Children always end before their parent,
so by the time a wrapper span ends, every child has passed through `onEnd` — one bottom-up
pass suffices. The wrapper takes the **first** child's input and the **last** child's
output, which is exactly "what went into this step" and "what came out of it". See
`LangfuseWorkflowEnricher` in
[`agent/enrich-spans.ts`](../examples/eve-langfuse-poc/agent/enrich-spans.ts).

Register it **before** `LangfuseSpanProcessor` — processors run in registration order.

---

## 12. The observations API hides input/output unless you ask for them

**Symptom.** Every observation appears to have no input and no output. It looks exactly
like a broken exporter, and sends you off rewriting instrumentation that was fine.

**Root cause.** `GET /api/public/v2/observations` returns **different field sets** depending
on the `fields` parameter, and **no single value returns everything**:

| `fields` | Returns |
|---|---|
| *(omitted)* | `id`, `name`, `level`, `statusMessage`, `environment`, `sessionId`, `userId` — **no input/output** |
| `core,io` | `input`, `output` — but **no `id`, no `name`** |
| `core,io,metadata` | the above plus `metadata` and its flattened keys |
| `all` | *fewer* fields than the default — **not** "everything" |

**Fix.** Fetch both projections and merge. `id` is absent from the io projection, so the
join key must be composite — `traceId|startTime|type|parentObservationId`. Implemented in
[`scripts/verify-traces.ts`](../examples/eve-langfuse-poc/scripts/verify-traces.ts).

> **Lesson: before concluding data is missing, confirm your query can return it.** This one
> masqueraded as an instrumentation bug and was purely a read-side projection default.

---

## 13. A tool that throws records no output

**Symptom.** The failing step — the one you opened the trace to understand — is the only
black box in it. Level is `ERROR` and `statusMessage` is set, but `output` is null.

**Root cause.** Output is written from the tool's return value. A tool that throws never
returns, so nothing is written.

**Fix.** In the enricher, when a span ends with error status and no output, synthesise one
from the error:

```ts
if (attrs[OBSERVATION_OUTPUT] === undefined && span.status.code === 2) {
  attrs[OBSERVATION_OUTPUT] = JSON.stringify({ error: span.status.message, status: "ERROR" });
}
```

**Verified** by forcing `get_forecast` to throw:

```
TOOL | get_forecast
  status: No forecast coverage for "Tokyo". Supported cities: Berlin, Hamburg, Munich.
  input : {"city":"Tokyo","days":3}
  output: {"error":"No forecast coverage for \"Tokyo\"...","status":"ERROR"}
```

> **Testing note: the model may refuse to call a tool it believes will fail.** Two attempts
> at the error path produced a polite refusal and no tool call — a *passing* trace that
> tested nothing. Force the call explicitly when verifying failure paths.

---

## 14. Do not push `modelInput` through runtime context

**Symptom.** None at first — then trace payloads grow far faster than step count.

**Root cause.** eve's `events["step.started"]` receives `modelInput` (full instructions and
message list), and returning it as runtime context is the obvious way to get step inputs
onto spans. But runtime context is stamped onto **every** span of the model call and its
children, so the whole message history is duplicated per span. Across a deep turn that is
the quadratic payload growth CLAUDE.md §7.5 identifies as the largest storage risk in this
design.

**Fix.** Bubble IO up from children instead (issue 11) — each payload is stored exactly
once. Keep runtime context small: ids, tags, environment.

---

## 15. Several spans each claim to be the trace root

**Symptom.** The trace tree shows two or three sibling top-level nodes instead of one.
Trace-level name, input and output are *sometimes* right and sometimes not, and change
between otherwise identical runs.

**Root cause.** `LangfuseSpanProcessor` decides `langfuse.internal.is_app_root` in
`markAppRootCandidate`, at span **start**, by asking whether the span's parent was already
recorded as "expected exported" at that instant. eve's true per-turn parent (`ai.eve.turn`)
carries no `gen_ai.*` attribute, so the SDK's default filter drops it — and each
`invoke_agent` child then correctly concludes "my parent isn't being exported, so I'm the
root". With three steps in a tool loop, three spans claim the root.

Langfuse derives trace-level fields from the root observation, so with N roots those fields
are whichever root's values were written last. Verified with `EVE_SPAN_DEBUG=1`: all three
`invoke_agent` spans carried `langfuse.internal.is_app_root=true`.

**Fix in two parts.** Teach `shouldExportSpan` to keep `ai.eve.turn`, *and* correct the
attribute directly rather than trusting the start-time heuristic — adding the span to the
filter alone was **not** sufficient, because some children were still evaluated before the
turn span's verdict had propagated and claimed app-root anyway (2 of 3, reproducibly):

```ts
const isTurnRoot = span.name === "ai.eve.turn";   // captured BEFORE renaming
if (isTurnRoot) attrs[IS_APP_ROOT] = true;
else if (attrs[IS_APP_ROOT] === true) attrs[IS_APP_ROOT] = false;
```

A span processor knows this with certainty from the span's own name — no start/end race.
See `correctAppRoot` in [`agent/enrich-spans.ts`](../examples/eve-langfuse-poc/agent/enrich-spans.ts).

> **Lesson: "the trace has a root" and "the trace has exactly one root" are different
> claims.** Assert the count, not the existence — `verify-traces.ts` now does.

---

## 16. The read APIs are behind the admin IP allowlist; ingest is not

**Symptom.** Every verification and provisioning call fails identically:

```
GET /api/public/v2/observations -> 403 Not authorized
POST /api/public/models         -> 403 Not authorized
```

The natural reading — expired or wrong API keys — is wrong. The same credentials on the
same host ingest traces successfully.

**Root cause.** This is the architecture working as designed (CLAUDE.md §5.3, §12.1). Only
the ingest endpoints are public, because Vercel has no static egress IPs. Everything else —
including every **read** API, `/api/public/models`, `/api/public/v2/prompts` and
`/api/public/mcp` — falls through to the admin allowlist in
[`infra/caddy/Caddyfile`](../infra/caddy/Caddyfile).

**How to tell the two apart in one command each:**

| Probe | Allowlisted | Not allowlisted |
|---|---|---|
| `GET /api/public/health` | 200 | 200 |
| `POST /api/public/otel/v1/traces` | 200 | **200** |
| `GET /api/public/projects` | 200 | **403** |

A bad key gives **401** everywhere, including ingest. A 403 on reads with a 200 on ingest is
always the allowlist.

**Note the OTLP path.** `POST /api/public/otel` returns **404** — the exporter appends
`/v1/traces`. Probing the bare path and reading the 404 as "ingest is broken" is a
five-minute detour worth avoiding.

**Consequence for this integration.** Tracing changes can be verified *pre-export* with
`EVE_SPAN_DEBUG=1`, which prints every span's final attributes. They cannot be verified by
**read-back** except from an allowlisted host or VPN — and per CLAUDE.md §7.6 read-back is
the only proof that counts. Run `npm run verify` from the allowlisted network, or add the
CI runner's egress IP to the admin matcher.

---

## 17. The turn root span closes before the turn finishes

**Symptom.** The trace looks complete, but the trace-level **output** is a `tool_call`
rather than the sentence the user actually received:

```
Root Output:  [{"role":"assistant","parts":[{"type":"tool_call","name":"get_weather",…
```

A non-technical reviewer reads that as "the system replied with a machine-readable blob".

**Root cause.** eve's `ai.eve.turn` span ends once the **first** agentic step completes.
The remaining steps of the tool loop keep ending afterwards, still parented to its
(already-closed) span id. Verified with `EVE_SPAN_DEBUG=1` on both the happy and the failure
path — `process-turn` ended after step 1 of 3:

```
agent-step   finish_reasons=["tool-calls"]   → tool_call output
process-turn                                 ← ROOT ENDS HERE
agent-step   finish_reasons=["tool-calls"]
agent-step   finish_reasons=["stop"]         → "The current weather in Berlin is…"
```

Any processor that fills a parent from its children — the standard bubble-up of issue 11 —
therefore fills the root from the only child that had ended: the first one.

This is consistent with eve's durable execution model (CLAUDE.md §6.4), where a turn can
park and resume hours later. **"Wait for all the children" is not available** to a streaming
span processor, and building on the assumption that a trace closes within one request
lifetime is exactly what §6.4 warns against.

**Fix.** Do not take trace output from the root. Identify the step that actually answered
the user by its finish reason and let *that* span write the trace output:

```ts
// "tool-calls" (hyphen — not the wire format's "tool_calls") while more rounds
// are coming; "stop" on the last one.
if (finishReasons.includes("stop")) attrs[TRACE_OUTPUT] = attrs[OBSERVATION_OUTPUT];
```

Trace-level attributes are aggregated by Langfuse from **any** observation in the trace, not
only the root — already proven for session id in the original PoC. The root keeps trace
*input* (correct: the first child's input is the user's question) and the trace name.

The same span also re-writes the recovered-error rollup, since it is the only one that ends
late enough to have seen every failure in the turn.

> **Lesson: bubble-up assumes children end before parents. Verify that, don't assume it.**
> In a durable-execution framework it is not true.

---

## 18. `Span.updateName()` does nothing inside `onEnd`

**Symptom.** A span processor calls `span.updateName("generate-answer")`, the code runs, no
error is thrown — and the exported span still has its old name.

**Root cause.** `SpanImpl.updateName()` begins with `if (this._isSpanEnded()) return this`.
A `SpanProcessor.onEnd` hook by definition runs *after* `.end()`, so the guard is always
taken. It is a silent no-op, in the same family as the rest of this document.

**Fix.** Assign the property directly. It is a plain field underneath — `updateName`'s own
body is `this.name = name` — and is typed `readonly` only on the `ReadableSpan` *interface*:

```ts
(span as unknown as { name: string }).name = "generate-answer";
```

This is the same escape hatch the enricher already relies on to mutate `span.attributes`,
which `ReadableSpan` also types as readonly while handing you the live object.

---

## 19. Framework span names embed the model id

**Symptom.** Observation names read `invoke_agent gpt-4o-mini`, `chat gpt-4o-mini`,
`step 1`, `execute_tool get_weather`. Everything works — until the model is swapped and
every saved Langfuse filter, dashboard and alert silently stops matching.

**Root cause.** The AI SDK follows the OpenTelemetry GenAI semantic conventions, where the
span name is `<operation> <model>`. That is correct for OTel and wrong for an observability
API: Langfuse's own [best practices](https://langfuse.com/docs/observability/best-practices)
say to name observations after the action, verb first, and to keep model names *out* of the
name. `step 1` additionally never increments — all three steps of a turn are called `step 1`.

**Fix.** Rename in the enricher, before `LangfuseSpanProcessor` sees the span:

| eve / AI SDK name | Exported as |
|---|---|
| `ai.eve.turn` | `process-turn` |
| `invoke_agent <model>` | `agent-step` |
| `step 1` | `model-call` |
| `chat <model>` | `call-model` |
| `execute_tool <tool>` | `call-<tool>` |

Tool names stay in the name — they are stable across executions and give the Agent Graph
distinct nodes. Per-execution values (tool call id, step index, session id) go to metadata.

`verify-traces.ts` asserts every observation name against an exact allowlist, so a framework
upgrade that reintroduces `chat gpt-4o-mini` fails the build instead of quietly breaking
dashboards.

---

## Diagnostic checklist

When traces do not appear, in this order:

1. **Did the instrumentation file even load?** It should log at startup. eve auto-discovers
   `agent/instrumentation.ts`; a typo in the path means no telemetry and no error.
2. **Is exactly one tracer provider registered?** (issue 2)
3. **Are spans being produced at all?** Run with `EVE_SPAN_DEBUG=1`. This separates "never
   emitted" from "emitted but not exported" — the two look identical otherwise.
4. **Are the attributes named what you think?** (issue 5) The same debug dump answers this.
5. **Did the export get accepted?** A 2xx means **queued**, not stored.
6. **Read the trace back.** `npm run verify`. This is the only real proof.
7. **Are you testing the process you think you are?** (issue 8)

---

## Lessons for the verification suite

- **A 2xx from ingestion proves nothing.** Langfuse returns success on *queue*. Assert by
  reading data back, never on the exporter's status code.
- **Assert on structure, not existence.** "A trace exists" passed while every observation
  carried `level: ERROR` from a 404ing model. The verifier now checks error level, nesting,
  timing, model, and session — each of which failed independently at some point.
- **Absence in one API does not prove absence in storage.** `/v2/observations` omits usage
  fields entirely; token usage looked missing until queried through `/v2/metrics`.
