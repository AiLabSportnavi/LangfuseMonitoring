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
| 16 | Read APIs sit behind the admin IP allowlist | Fix committed, applies on next Caddy reload. A `401` does NOT prove the allowlist is off | ✅ silent |
| 17 | The turn root closes before the turn finishes | Trace output is a `tool_call`, not the answer | ✅ silent |
| 18 | `Span.updateName()` is a no-op inside `onEnd` | Renames silently do nothing | ✅ silent |
| 19 | Framework span names embed the model id | Names churn on every model change | ✅ silent |
| 20 | Azure `/openai/v1` endpoint is wrong for a Langfuse LLM connection | `PUT` returns 201, every judge then 404s | ✅ silent |
| 21 | `metadata.langfusePrompt` does nothing on SDK v5 | Metadata looks right, prompt is not linked | ✅ silent |
| 22 | An uncached prompt fallback breaks its own detection | No `prompt-fallback` tag, +2s on every turn | ✅ silent |
| 23 | `scripts/` was outside tsconfig `include` | Typecheck passes having checked nothing | ✅ silent |
| 24a | Module state duplicated across eve's bundles | Prompt resolves, attribute never written | ✅ silent |
| 24b | Prompt link is generation-only; attributes don't inherit | Attribute on `agent-step`, no link anywhere | ✅ silent |

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

## 16. The read APIs are behind the admin IP allowlist; ingest is not — **being retired**

> ### ⚠️ Status: the fix is committed, and applies on the next Caddy reload.
>
> `ADMIN_ALLOWLIST` is removed from the Langfuse site block as part of the move to Entra ID SSO
> (single-tenant). Until the server reloads Caddy, **this pitfall still applies in production** and a
> non-allowlisted client still gets `403`. Check the running container rather than the repo:
> `docker exec langfuse-caddy-1 sh -c 'echo $ADMIN_ALLOWLIST'`.
>
> Once applied, the obsolete advice is **"add the CI runner's egress IP to the admin matcher"** —
> there will be no matcher to add it to. GitHub-hosted runners and Vercel functions reach the full
> public API with keys alone, which is what unblocks the evaluation layer.

> ### ⚠️ How this was misdiagnosed, which is the reusable part
>
> A probe from one client returned `401` (not `403`) on every `/api/public/*` route, and that was
> read as "the allowlist is gone". It was not: **an allowlisted client also sees `401`.** The
> allowlist answers `403` only to addresses outside it, so a single client can never distinguish
> "removed" from "I am inside it". The address in question was allowlisted.
>
> To actually tell them apart: probe an **allowlist-gated surface** that has no API-key layer — the
> Grafana host. A proxied response (302 to its login) means you are inside the allowlist; `403`
> means outside. Or read the container's env directly.
>
> **The obsolete advice was "add the CI runner's egress IP to the admin matcher."** There is no matcher
> to add it to, and chasing one wastes the time this entry was written to save. GitHub-hosted runners
> and Vercel functions both reach the full public API with keys alone.

**Kept because the diagnostic is still worth having.** The 401-vs-403 distinction is how you tell a
credential problem from a network-policy problem on *any* Langfuse deployment:

| Response | Means |
|---|---|
| **401** on a `/api/public/*` route | Bad, missing or revoked API keys — **this is the only case that still occurs here** |
| **403** with a plain-text body | A reverse-proxy network policy rejected you before Langfuse saw the request. Not a key problem. |
| **404** on `/api/public/traces`, `/api/public/observations` | `events_only` mode retired the v3 read APIs — see pitfall #3, not a permissions issue |

**Still true, and still a five-minute detour if you forget it:** `POST /api/public/otel` returns
**404**. The real path is `/api/public/otel/v1/traces` — the exporter appends `/v1/traces` itself.
Probing the bare path and reading the 404 as "ingest is broken" remains the trap it always was.

**Consequence for this integration — now inverted.** Read-back verification, which CLAUDE.md §7.6
calls the only proof that counts, no longer needs an allowlisted host. `npm run verify` works from any
network, and CI can verify traces, run experiments and ingest scores directly. `EVE_SPAN_DEBUG=1`
pre-export inspection drops from "the only available check" to "a faster first check" — it was always
the weaker standard of proof, and there is no longer any reason to settle for it.

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

## 20. The Azure endpoint that works for the agent is wrong for a Langfuse LLM connection

**Symptom.** `PUT /api/public/llm-connections` succeeds with **201**, the connection appears in
project settings, and then every LLM-as-a-judge evaluation fails — or an evaluator cannot be saved
because the test call fails. The 201 proves only that the record was stored; **nothing validates the
URL at write time.**

**Root cause.** Two different Azure surfaces, one environment variable.

`AZURE_AI_CHATBOT_OPENAI_ENDPOINT` is `https://<resource>.openai.azure.com/openai/v1` — Azure's
OpenAI-compatible **v1 surface**, which is exactly what `agent/model.ts` wants (see pitfall #4).

Langfuse does not use that surface. Verified in
`packages/shared/src/server/llm/ai-sdk/providers/azure.ts`, it calls `createAzure` with:

```ts
apiVersion: "2025-02-01-preview",   // pinned
useDeploymentBasedUrls: true,       // appends /deployments/{deployment}{path}
```

So Langfuse builds `{baseURL}/deployments/{model}/chat/completions?api-version=...`. Passing the
`/openai/v1` endpoint therefore yields:

```
https://<resource>.openai.azure.com/openai/v1/deployments/gpt-4o-mini/chat/completions   → 404
                                          ^^^ the v1 that must not be there
```

`translateAzureBaseURL` normalises any URL **containing `/deployments`** back to its parent, but
`/openai/v1` contains no `/deployments`, so it is passed through unchanged. The normaliser cannot
save you here.

**Fix.** Strip the `/v1` when configuring the Langfuse connection — the same normalisation
`model.ts` already performs for the opposite reason:

```ts
const base = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
// → https://<resource>.openai.azure.com/openai
```

**Also required: `customModels`.** Langfuse ships **no default model list for Azure**
(`MODEL_MAP[LLMAdapter.Azure] = []` in `packages/shared/src/server/llm/types.ts`), so a connection
created with `withDefaultModels: true` and no `customModels` has **zero selectable models** and no
evaluator can be configured against it. For Azure the model id **is the deployment name**
(`provider.chat(modelId)`).

⚠️ **`langfuse-cli api llm-connections put` does not expose `customModels`** even though the REST
API accepts it — so the CLI cannot create a working Azure connection. Use raw `PUT`.

**How to verify without the UI.** Reproduce the exact request Langfuse will make, including the
forced tool call that every managed judge depends on:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$BASE/deployments/$DEPLOYMENT/chat/completions?api-version=2025-02-01-preview" \
  -H "api-key: $AZURE_KEY" -H 'Content-Type: application/json' \
  -d '{"temperature":0,"messages":[{"role":"user","content":"hi"}],
       "tools":[{"type":"function","function":{"name":"extract","parameters":{"type":"object","properties":{"score":{"type":"number"}},"required":["score"]}}}],
       "tool_choice":{"type":"function","function":{"name":"extract"}}}'   # expect 200
```

A 200 here with a populated `tool_calls[0]` is the proof. A judge model that cannot do forced tool
calling will fail at evaluation time regardless of a healthy connection record.

---

## 21. `metadata.langfusePrompt` does not link a prompt on SDK v5

**Symptom.** You follow the official
[link-to-traces](https://langfuse.com/docs/prompt-management/features/link-to-traces) guidance for the
Vercel AI SDK, pass `experimental_telemetry: { metadata: { langfusePrompt: prompt.toJSON() } }`, and
the trace shows a `langfusePrompt` blob in observation metadata. It looks right. The prompt is **not
linked**: no clickable prompt on the observation, and no per-version metrics.

**Root cause.** `langfusePrompt` was the **v3 `LangfuseExporter`** convention. It does not exist in
`@langfuse/*@5.x` — verified by grepping the installed tree, where the string appears in **no file**.
Nothing consumes the key, so it falls through to generic metadata like any other unrecognised value.

**Fix.** Set the two span attributes the v5 SDK actually reads:

```
langfuse.observation.prompt.name
langfuse.observation.prompt.version
```

In this repo they ride eve's runtime context from `instrumentation.ts`, because
`promoteRuntimeContext` in `enrich-spans.ts` already strips the AI SDK's
`ai.settings.context.` prefix from any `langfuse.*` key — so no new machinery was needed. The
alternative is `propagateAttributes({ prompt }, fn)` from `@langfuse/core`.

**A fallback prompt is never linked.** Three `isFallback` guards in
`@langfuse/core` and `@langfuse/tracing` drop the attributes when the SDK served a fallback, and it is
logged at **debug** level only. This is the asymmetry that matters: the situation where you most need
the trace to tell you something is exactly the one where Langfuse tells you nothing. Carry your own
signal — this repo stamps a `prompt-fallback` trace tag and asserts on `promptIsFallback` in metadata.

**Verification standard.** Metadata presence is **not** evidence. The prompt name must render as a
*clickable link* on the observation in the Langfuse UI. Nothing short of that click proves the link.

---

## 22. A prompt fallback that is not cached breaks its own detection, twice

**Symptom.** None, on the happy path. During a Langfuse outage: the agent keeps answering (correct),
but the `prompt-fallback` trace tag never appears, and every turn becomes ~2s slower.

**Root cause.** One omission, two consequences. The resolver returned the bundled fallback **without
writing it to the cache**:

1. `peekResolvedPrompt()` reads that cache, and `instrumentation.ts` calls it synchronously inside
   `step.started`. With nothing cached it received `undefined`, took the "no prompt" branch, and
   never stamped the tag — **silently disabling the only signal that a turn ran on the bundled
   prompt.** The detection mechanism was defeated by the very condition it existed to detect.
2. With nothing cached, the value was always expired, so **every turn re-attempted the fetch** and
   paid the full `AbortSignal.timeout` — converting an observability outage into a latency
   regression on every request, which is exactly what CLAUDE.md §4 requirement 10 forbids.

**Fix.** Cache the fallback too, with a shorter retry TTL (`LANGFUSE_PROMPT_RETRY_MS`, default 10s)
so recovery stays quick without retrying per turn. Serve a cached *good* value in preference to the
fallback, so a brief outage does not revert a deployed prompt change.

**How it was found.** `scripts/verify-prompt-resolver.ts` runs the resolver against five
environments — reachable, connection-refused, black-holed, 401, and 404 — each in its own subprocess,
and asserts `peekIsSet` plus a **warm-resolve latency budget**. A test that only asked "does the
prompt resolve?" passes with both bugs present. Run it with `npm run verify:prompt-resolver`.

---

## 23. `tsc --noEmit` reported success while checking none of `scripts/`

**Symptom.** `npm run typecheck` exits 0. The scripts it supposedly checked contain type errors,
including duplicate top-level declarations.

**Root cause.** `tsconfig.json` had `"include": ["agent/**/*.ts", "evals/**/*.ts"]`. `scripts/` was
absent, so every verification and provisioning script — the tooling whose whole job is to catch
problems — was itself unchecked. A green typecheck meant nothing about it.

**Fix.** Add `scripts/**/*.ts` to `include`. Two settings are then required for it to pass, and both
are worth understanding rather than pasting:

- **`"moduleDetection": "force"`** — `verify-traces.ts` and `provision-model-prices.ts` have no
  `import`/`export`, so TypeScript classifies them as **global scripts sharing one scope** and reports
  that they redeclare each other's top-level `BASE_URL` and `auth`. The errors are artefacts of that
  classification, not of the code.
- **`"allowImportingTsExtensions": true`** — `agent/lib/prompt.ts` is imported both by eve's bundler
  and by bare `node --experimental-strip-types`, which does **not** remap `./x.js` onto `x.ts`. That
  import therefore carries an explicit `.ts`, unlike the `.js` convention used elsewhere in `agent/`.

**Generalisation worth keeping.** An `include` list is a silent allowlist: files outside it are not
"passing", they are unexamined. Whenever a new top-level directory of TypeScript appears, the
question is not "does typecheck still pass" but "is this directory in `include` at all".

---

## 24. The prompt attribute was set correctly and still linked nothing, twice

Both halves produced the same symptom — a trace containing
`langfuse.observation.prompt.name` while the observation's `promptName` stayed
empty — and both were found only by reading the trace back and checking for a
resolved `promptId`.

### 24a. Module state does not survive eve's bundling

**Symptom.** The resolver logs `resolved weather-assistant v1`, the agent answers
correctly, and no prompt attribute reaches any span.

**Root cause.** The prompt cache was a module-level `let` in `agent/lib/prompt.ts`.
eve compiles `agent/instrumentation.ts` into a **different bundle** from the agent
runtime that loads `agent/instructions/`, so each bundle received its own copy of
the module and its own cache. The instructions resolver populated one;
`instrumentation.ts` read a second one that was permanently empty, so
`peekResolvedPrompt()` returned `undefined` and the attribute was never written.

**Fix.** Keep the state on `globalThis` behind a `Symbol.for()` key. `globalThis`
is per-realm rather than per-bundle, so both copies share one store.

> Same family as pitfall #2 (the OTel provider singleton): **"one instance per
> import" is an assumption a bundler is free to break.** Any cross-cutting cache
> read by both instrumentation and agent code needs realm-scoped storage, not
> module scope.

### 24b. The link is honoured on GENERATIONS only, and attributes do not inherit

**Symptom.** After 24a was fixed, the attribute appeared in the trace — on the
`agent-step` observation — and `promptName` was still empty on every generation.

**Root cause.** Two facts that are individually harmless:

1. Langfuse honours `langfuse.observation.prompt.name` / `.version` on
   **generations only** ([OTLP attribute mapping](https://langfuse.com/integrations/native/opentelemetry) —
   the `prompt` row is marked *Generation only*).
2. eve's runtime context lands on the **agent-level** span (`invoke_agent` →
   `agent-step`), and OTel span attributes are **not inherited by child spans**.

The generation (`chat` → `call-model`) is a child, so it never saw the attribute.
The attribute was in the trace, on the wrong span, linking nothing.

**Fix.** Write it per-span in the enricher's `onEnd`, gated on the observation
type, after `renameAndType` has decided that type:

```ts
private attachPromptLink(attrs: Record<string, unknown>): void {
  if (attrs["langfuse.observation.type"] !== "generation") return;
  const prompt = peekResolvedPrompt();
  if (!prompt || prompt.isFallback) return;      // fallbacks are never linked
  attrs["langfuse.observation.prompt.name"] = prompt.name;
  attrs["langfuse.observation.prompt.version"] = prompt.version;   // MUST be an integer
}
```

**Version must be an integer.** The mapping table specifies `integer`; a
stringified version is silently ignored.

### The assertion that catches all of it

`scripts/verify-prompt-link.ts` (`npm run verify:prompt-link`) asserts that every
generation has a server-resolved **`promptId`**, and explicitly fails the case
"prompt metadata present but no link" — which is precisely what all three prompt
bugs looked like from the UI.

Two traps in the verifier itself, both worth keeping:

- **`prompt` is not a default field group.** `/api/public/v2/observations` returns
  `core` + `basic` unless told otherwise, and reading `promptName` without
  `fields=...,prompt` yields `""` for everything — indistinguishable from an
  unlinked prompt. Same shape as pitfall #12.
- **Scope to the newest trace, not the time window.** A window contains history,
  and history contains traces from before the fix. Asserting across it fails for
  reasons unrelated to the code under test, which teaches people to ignore the
  check. `VERIFY_ALL_TRACES=1` switches to the whole-window audit deliberately.

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
