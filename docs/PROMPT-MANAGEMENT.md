# Prompt Management — how it works and how to use it

How this project uses **Langfuse Prompt Management** on the self-hosted instance, and
how prompts connect to tracing, datasets, evaluators and the Playground.

Target: `examples/eve-langfuse-poc` · Langfuse **4.6.0** OSS · JS SDK **5.10.0**

---

## 1. The rule

> **No prompt that Langfuse manages is hardcoded in the application.**

`agent/instructions.md` is deleted. The agent's system prompt lives in Langfuse and is
fetched at runtime. The only copy in the repo is
[`prompts/weather-assistant.text.json`](../examples/eve-langfuse-poc/prompts/weather-assistant.text.json)
(the *source*, pushed to Langfuse) and
[`agent/lib/prompt-fallback.ts`](../examples/eve-langfuse-poc/agent/lib/prompt-fallback.ts)
(an outage fallback, never the normal path).

---

## 2. The flow

```
prompts/weather-assistant.text.json      git is the source of truth
        │  npm run prompts:sync           creates a version only if content changed
        ▼
Langfuse Prompt Management               versions + labels (dev/staging/production/rollback)
        │  npm run prompts:promote        the ONLY thing that moves a label
        ▼
agent/lib/prompt.ts                      langfuse.prompt.get() → .compile(variables)
        │
        ▼
agent/instructions/10-weather-assistant.ts   eve defineDynamic, per session
        │
        ▼
the model                                compiled text is the system prompt
        │
        ▼
Langfuse trace                           generation carries a resolved promptId
        │
        ▼
datasets · evaluators · experiments · scores
```

Everything above uses official SDK calls. Nothing reimplements Langfuse behaviour.

---

## 3. Creating and changing a prompt

Edit the JSON, sync, promote. A prompt change is a code review.

```bash
cd examples/eve-langfuse-poc

npm run prompts:check     # does Langfuse match git? (exit 1 if not)
npm run prompts:sync      # push — creates a version ONLY if the content changed
npm run prompts:promote -- --name weather-assistant --show
```

`sync` compares a canonical hash of `{prompt, config}` and creates nothing when they
match. That idempotence matters: without it every run bumps the version, the history
fills with identical entries, and "which version is live?" stops being answerable.

**`sync` never moves a label.** Creating a version is not a deployment.

### Promotion

```bash
npm run prompts:promote -- --name weather-assistant --version 7 --to staging
npm run prompts:promote -- --name weather-assistant --from staging --to production
```

`--from <label>` resolves whichever version currently holds that label, so a promotion
means *"whatever passed staging"* rather than a hand-typed integer.

Promoting to `production` first pins the outgoing version as `rollback`:

```bash
npm run prompts:promote -- --name weather-assistant --from rollback --to production
```

> **Protected labels are an Enterprise feature and this deployment is OSS.** Nothing
> server-side stops someone dragging `production` onto a version in the UI. The
> guardrails here are conventions this script enforces, not permissions.

---

## 4. Variables

Langfuse interpolates `{{variable}}` with mustache via `prompt.compile()`. This project
uses variables for **facts the code owns and the prompt should not restate**:

| Variable | Source | Why it is a variable |
|---|---|---|
| `{{supported_cities}}` | `agent/lib/cities.ts` | The city table is also what the tools use. Writing it into the prompt text lets the two drift, and the prompt is the copy that drifts *silently* — the agent refuses a city it could serve, with no error. |
| `{{temperature_unit}}` | `AGENT_TEMPERATURE_UNIT`, default `Celsius` | Deployment-level default, changeable without a prompt version. |

The dividing line: **the prompt owns the wording, the code owns the facts.** Output
format rules, safety rules and persona stay hardcoded *in the prompt* — they are what
the prompt is for.

Values are supplied by `promptVariables()` in
[`agent/lib/prompt.ts`](../examples/eve-langfuse-poc/agent/lib/prompt.ts).

---

## 5. Retrieval, caching and the outage path

`agent/lib/prompt.ts` calls the SDK:

```ts
const prompt = await client().prompt.get(PROMPT_NAME, {
  label: PROMPT_LABEL,          // production when LANGFUSE_ENVIRONMENT=production, else staging
  type: "text",
  fallback: FALLBACK_MARKDOWN,  // native fallback — get() will not throw
  fetchTimeoutMs: 2000,
  cacheTtlSeconds: 0,           // this module owns the cache; see below
});
prompt.compile(promptVariables());
```

**Which label is served** is derived from `LANGFUSE_ENVIRONMENT`, so a preview
deployment cannot accidentally run the production prompt because someone forgot a
second variable. Override with `LANGFUSE_PROMPT_LABEL` for experiments.

**Why a cache on top of the SDK's.** The SDK does not remember a *fallback*, so during
an outage every turn pays the full `fetchTimeoutMs` again — an observability outage
becomes a latency regression on every request. This module caches the resolved value,
fallback included, with a shorter retry TTL. The SDK's own cache is disabled so there is
one cache with one TTL rather than two interleaving.

**The agent never fails because of Langfuse** (CLAUDE.md §4 requirement 10). Every
failure path returns the bundled fallback; nothing in that module throws.

### The fallback is the dangerous state

A fallback prompt is **never linked to a trace** — Langfuse drops the link for
fallbacks, and the SDK logs it at `debug`. So the situation where you most need the
trace to tell you something is the one where Langfuse tells you nothing. Three signals
exist instead:

1. a `prompt-fallback` tag on the trace,
2. `promptIsFallback: true` in observation metadata,
3. `npm run verify:prompt-link` fails.

---

## 6. How prompts link to traces

The link is what makes a bad answer attributable to a version.

Set on **generation** spans by `attachPromptLink()` in `agent/enrich-spans.ts`:

```
langfuse.observation.prompt.name     = "weather-assistant"
langfuse.observation.prompt.version  = 2          # integer, not a string
```

Two things that cost real time and are easy to repeat:

- **`metadata.langfusePrompt` does nothing on SDK v5.** Langfuse's own docs still show
  it for the Vercel AI SDK; it is a v3 convention and the string appears nowhere in
  `@langfuse/*@5.x`. It writes metadata and links nothing.
- **The link is honoured on GENERATIONS only, and span attributes do not inherit.**
  Runtime context lands on the agent-level span, so the generation never sees it.

Full write-up: `docs/INTEGRATION-PITFALLS.md` #21 and #24.

**Verification standard:** metadata presence is not evidence. The prompt name must
render as a *clickable link* on the observation, i.e. the API must return a resolved
`promptId`.

---

## 7. What this unlocks

| Feature | Status | Notes |
|---|---|---|
| **Prompt Management** | working | versions, labels, tags, config, diffs |
| **Variables** | working | native `compile()`, verified behaviourally |
| **Tracing / generations** | working | full tree: turn → agent step → generation → tool |
| **Prompt → generation link** | working | resolved `promptId` on every generation |
| **Playground** | ready | needs an LLM Connection; one exists (`azure-judge`, `gpt-4o-mini`) |
| **Datasets** | working | `weather-agent/core`, 33 items, 10 categories |
| **Score configs** | working | 13 configs, BOOLEAN types declared explicitly |
| **Experiments** | working locally | `npm run experiment` |
| **LLM-as-a-judge evaluators** | available, not wired | 22 managed templates ship with the image |

Everything above is **OSS** — no Enterprise licence. Only *protected prompt labels* is EE.

---

## 8. Manual test procedure

Run from `examples/eve-langfuse-poc` with `.env.local` populated.

### 8.1 One command per property

```bash
npm run prompts:check            # git and Langfuse agree; idempotent
npm run verify:prompt-resolver   # 5 outage scenarios; never throws, warm path ~0ms
npx eve eval trace-smoke         # a real turn through the real agent
npm run verify:prompt-link       # generations carry a resolved promptId
npm run datasets:check           # dataset items and score configs are live
```

### 8.2 Prove variables actually reach the model

The string-matching version of this test is misleading — the system prompt is not
recorded verbatim in the generation input. Test **behaviourally**:

```bash
AGENT_TEMPERATURE_UNIT=Fahrenheit npx eve eval trace-smoke
```

Expected: the agent answers about **66°F** instead of 19°C, and the eval's
`includes("19")` assertion fails. **That failure is the proof** the compiled prompt is
in effect. Re-run without the variable to restore Celsius.

### 8.3 Prove the fallback works

```bash
LANGFUSE_BASE_URL=http://127.0.0.1:1 npx eve eval trace-smoke
```

Expected: the agent still answers, within normal latency, logging
`[prompt] FALLBACK ACTIVE`.

### 8.4 In the UI

1. **Prompts → weather-assistant** — versions 1 and 2, labels `production`, `staging`,
   `latest` on v2 and `rollback` on v1.
2. Open a recent trace → the generation → the prompt name is a **clickable link** to v2.
3. **Playground** — open the prompt, fill `supported_cities` and `temperature_unit`,
   run against `gpt-4o-mini`.
4. **Datasets → weather-agent/core** — 33 items.

---

## 9. Configuration

Set in `examples/eve-langfuse-poc/.env.local`:

| Variable | Purpose |
|---|---|
| `LANGFUSE_BASE_URL` | Self-hosted instance. Not a Cloud URL. |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Per-project keys |
| `LANGFUSE_ENVIRONMENT` | `development` / `staging` / `production`; also selects the prompt label |
| `LANGFUSE_PROMPT_NAME` | Default `weather-assistant` |
| `LANGFUSE_PROMPT_LABEL` | Explicit override; otherwise derived from the environment |
| `LANGFUSE_PROMPT_TTL_SECONDS` | Resolved-prompt cache TTL, default 60 |
| `LANGFUSE_PROMPT_TIMEOUT_MS` | Fetch timeout before falling back, default 2000 |
| `LANGFUSE_PROMPT_RETRY_MS` | Retry delay after a failure, default 10000 |
| `AGENT_TEMPERATURE_UNIT` | Value for `{{temperature_unit}}`, default `Celsius` |

---

## 10. Known limitations

1. **The system prompt is not recorded verbatim in traces.** The generation carries the
   prompt *link*, not the prompt *text*. This is deliberate — repeating the full prompt
   on every observation is the quadratic payload growth CLAUDE.md §7.5 calls the largest
   storage risk here — but it means "what exactly did the model see?" is answered by
   clicking through to the version, not by reading the trace. Test variable changes
   behaviourally (§8.2).
2. **Protected labels are EE.** `production` is enforced by convention only.
3. **The prompt is resolved once per session, not per turn.** A long-lived session keeps
   the version it started with. This is intended: swapping the system prompt mid-conversation
   makes a trace impossible to attribute to one version.
4. **`npm run verify` currently fails four trace-shape checks** — missing model name on
   generations, empty root `sessionId`/`userId`, and the tool span being named
   `get_weather` rather than `call-get-weather`. These are unrelated to prompt management
   (the naming one predates this work) but the model-name gap blocks Phase 2 cost
   tracking and should be fixed next.
