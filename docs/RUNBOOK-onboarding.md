# Runbook — Onboarding an Agent Project

How a new Eve/Vercel agent project starts reporting into the shared platform.

The target is ~5 lines in the project, not a new integration. If onboarding needs
more than this, the shared tracing layer is missing an option — add it there
rather than working around it locally.

---

## 1. Provision credentials

**Never a shared org-wide key.** One key pair per agent project, so a leaked key is
revocable in isolation and ingestion is attributable per project when volume spikes.

```bash
./scripts/provision-project.sh <project-slug>        # 90-day retention by default
```

This appends a per-project block to `infra/.env`, recreates `web` so headless
initialization picks it up, and prints the key pair. Re-running for a project that
already exists is refused — otherwise the previous keys would keep working while
becoming untracked.

Verify before handing the keys over:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... \
  ./scripts/ingestion-canary.sh https://<domain>
```

> Headless init provisions one org/project per startup. That is fine at the current
> project count. Onboarding many at once needs the public API or the EE Instance
> Management API — confirm EE licensing before depending on those.

---

## 2. Set Vercel environment variables

Set **per environment**, never once at the project level:

| Variable | Value |
|---|---|
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-…` from step 1 |
| `LANGFUSE_SECRET_KEY` | `sk-lf-…` from step 1 |
| `LANGFUSE_HOST` | `https://<domain>` |

Because `@org/agent-telemetry` reads credentials from the environment, rotation is
a redeploy — never a code change.

**Do not set the environment name by hand.** It is resolved from `VERCEL_ENV` so a
preview deployment cannot write to `production` because someone forgot a variable.

| Context | `langfuse.environment` |
|---|---|
| Vercel production | `production` |
| Vercel staging | `staging` |
| Vercel preview | `preview` |
| Local `eve dev` | `development` |

---

## 3. Add instrumentation

Install the shared package and add `agent/instrumentation.ts`. Eve auto-discovers
that path; its presence alone enables telemetry.

```ts
import { createLangfuseInstrumentation } from "@org/agent-telemetry";

export default createLangfuseInstrumentation({
  project: "<project-slug>",
  agentVersion: process.env.VERCEL_GIT_COMMIT_SHA,
});
```

That is the whole integration. Anything a project needs to override must be an
explicit option on the package — never a local reimplementation, or the tracing
standard stops being one standard.

> `@org/agent-telemetry` is **Stage 1B** and does not exist yet. Until it ships,
> onboarding stops at step 2 and the project has credentials but no traces.

---

## 4. Verify the project is actually reporting

Do not mark onboarding complete on a green deploy. Confirm all four:

- [ ] A real turn produces a trace in Langfuse under the correct project
- [ ] `langfuse.environment` matches the deployment context — and a **preview
      deployment is confirmed writing to `preview`, never `production`**
- [ ] **Token usage is present on every generation.** Non-negotiable: Phase 2 cost
      monitoring cannot backfill it
- [ ] Session and user IDs are populated

Then audit one real trace against
<https://langfuse.com/docs/observability/best-practices> — **fetched fresh, never
from memory** — and iterate until it is clean.

---

## 5. Watch for dropped traces

A serverless function that returns before its span batch flushes **silently drops
traces**. This is the most likely cause of "traces are missing", and it must be
verified on a real Vercel deployment, not just locally — Eve's durable execution
runs on Vercel Workflow, which changes the lifecycle relative to a plain route
handler.

Also expect long-lived traces: Eve turns park durably while awaiting approvals or
OAuth callbacks, so a single trace can span hours or days. Do not treat wall-clock
turn duration as latency.

---

## 6. Re-validate the PII assumption

Full input/output capture is permitted **because no real PII is expected in
prompts or completions**. That assumption belongs to the current set of projects,
not to the platform.

**Re-validate it for every project that onboards.** If it does not hold, the
masking switch in `@org/agent-telemetry` must be enabled — and note that only
client-side masking keeps raw data off the platform. Server-side ingestion masking
is EE, and it writes the event to blob storage *unmasked* before the callback runs.
