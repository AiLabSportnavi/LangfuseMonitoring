/**
 * Langfuse tracing for this eve agent.
 *
 * eve auto-discovers `agent/instrumentation.ts` and runs it at server startup
 * before any agent code. Its mere presence enables telemetry — there is no
 * separate `isEnabled` toggle, and deleting this file makes the agent go dark.
 *
 * WHAT THIS FILE DOES AND DOES NOT DO
 *
 * It attaches Langfuse as a span processor on the OTel provider eve's runtime
 * uses. It does NOT register an AI SDK telemetry integration: eve already
 * registers one (with runtime context enabled) on our behalf. Registering a
 * second *provider* would be worse than redundant — the OTel global tracer
 * provider is a process-wide singleton where the first registration wins and
 * later ones are silently ignored, so the second exporter would receive nothing
 * while looking perfectly wired.
 *
 * PROCESSOR ORDER MATTERS. Processors run in registration order, so every
 * processor that rewrites attributes must come BEFORE LangfuseSpanProcessor,
 * which reads the span on export.
 */
import {
  isDefaultExportSpan,
  isGenAISpan,
  LangfuseSpanProcessor,
  type MaskFunction,
} from "@langfuse/otel";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

import { LangfuseWorkflowEnricher } from "./enrich-spans.js";

/**
 * Prints each span's name, id, parent id, and attribute keys. Enable with
 * EVE_SPAN_DEBUG=1.
 *
 * Exists because "the attribute did not arrive" and "the attribute arrived
 * under a different name" look identical from the Langfuse UI, and the naming
 * of runtime-context attributes is a property of the installed AI SDK version,
 * not something worth guessing at. The id/parent pair is what let us prove
 * `invoke_agent` really is a direct child of `ai.eve.turn` — see the
 * multi-root pitfall below.
 */
class SpanAttributeDebugProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const s = span as unknown as {
      parentSpanId?: string;
      parentSpanContext?: { spanId?: string };
    };
    const parentId = s.parentSpanId ?? s.parentSpanContext?.spanId ?? "(none)";
    // Print values, not just key names — a key merely being PRESENT does not
    // mean the boolean it holds is true. `langfuse.internal.is_app_root`
    // being in this list with value `false` looks identical to `true` if you
    // only print keys, and that distinction is exactly what mattered when
    // chasing the multi-root bug in docs/INTEGRATION-PITFALLS.md #15.
    const lines = Object.entries(span.attributes).map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${text && text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
    });
    console.log(
      `[span] ${span.name}  id=${span.spanContext().spanId} parent=${parentId}\n       ${lines.join("\n       ")}`,
    );
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail at startup rather than letting a missing key surface later as a
    // silent 401 inside the batch exporter, long after the agent has reported
    // a successful turn.
    throw new Error(`[instrumentation] ${name} is not set — copy .env.example to .env.local`);
  }
  return value;
}

const environment = process.env.LANGFUSE_ENVIRONMENT ?? "development";
const release = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.LANGFUSE_RELEASE;

/**
 * eve's own per-turn wrapper span (`ai.eve.turn`) carries no `gen_ai.*`
 * attributes, so Langfuse's default GenAI filter drops it. Its children
 * (`invoke_agent ...`, one per agentic-loop attempt) DO pass the filter, so
 * each becomes a candidate app root independently — one turn was rendering as
 * 2-3 disconnected top-level AGENT nodes with no shared parent, instead of one
 * tree. Verified against the live span ids: every `invoke_agent` span's
 * `parentSpanId` is `ai.eve.turn`'s span id (checked with EVE_SPAN_DEBUG=1),
 * so exporting `ai.eve.turn` explicitly is enough to make it the sole root —
 * see docs/INTEGRATION-PITFALLS.md #15.
 */
/**
 * Matches the turn-root span under BOTH names it can have when this predicate
 * runs, because LangfuseSpanProcessor calls it at two different times:
 *
 *   - At span START (`onStart`, for is_app_root classification) — before
 *     `LangfuseWorkflowEnricher.onEnd` has ever touched this span, so its name
 *     is still eve's original "ai.eve.turn".
 *   - At span END (for the actual export decision) — AFTER the enricher's
 *     `onEnd` has already run (processors run in registration order, and the
 *     enricher is registered first), so the name is now "process-turn".
 *
 * An attribute-based check (e.g. a bare `eve.turn.id`) looked more robust on
 * paper, but broke exactly this: `eve.turn.id` is not present on the span at
 * onStart, only added before it ends, so the start-time evaluation returned
 * false, is_app_root was never set on the turn span, and the three
 * `invoke_agent` children — evaluated later once their own parent's cached
 * "expected exported" verdict was already locked in as false — went right
 * back to independently claiming app-root, reproducing the original bug this
 * function exists to fix. Matching on both known names sidesteps the timing
 * question entirely, at the cost of coupling to `RENAME_RULES` in
 * enrich-spans.ts — see docs/INTEGRATION-PITFALLS.md #15.
 */
function shouldExportSpan({ otelSpan }: { otelSpan: ReadableSpan }): boolean {
  if (isDefaultExportSpan(otelSpan)) return true;
  return (otelSpan.name === "ai.eve.turn" || otelSpan.name === "process-turn") && !isGenAISpan(otelSpan);
}

/**
 * Regex-based redaction applied to every string that reaches Langfuse, on top
 * of `recordInputs`/`recordOutputs`. CLAUDE.md §12.5/§4 requirement 6 says no
 * real PII is expected in payloads, but "no PII expected" is not "no secrets
 * possible" — a tool argument or error message can still carry a bearer
 * token, an Authorization header, or a Langfuse/OpenAI-shaped API key. This
 * is client-side masking, which is the only kind that also protects blob
 * storage (server-side masking runs after the unmasked event is already
 * written to S3 — CLAUDE.md §12.5).
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\bBasic\s+[A-Za-z0-9+/]+=*/gi,
  /\b(?:sk|pk)-lf-[A-Za-z0-9-]+/gi, // Langfuse project keys
  /\bsk-[A-Za-z0-9]{16,}/g, // OpenAI-shaped secret keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\b(?:api[_-]?key|apikey)["']?\s*[:=]\s*["']?[A-Za-z0-9\-_]{12,}["']?/gi,
  /\bpassword["']?\s*[:=]\s*["']?\S+/gi,
];

/** Keys whose value is redacted wholesale, regardless of its shape. */
const SECRET_KEY_PATTERN = /^(authorization|auth|token|access[_-]?token|secret|password|api[_-]?key)$/i;

function redactString(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

function maskValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[REDACTED: max depth]"; // guard against pathological/cyclic payloads
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : maskValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

const secretRedactionMask: MaskFunction = ({ data }) => maskValue(data);

/**
 * Head-based, per-trace sampling. Defaults to 1 (export everything) — per
 * CLAUDE.md §8.4 the knob is a Phase 1 requirement precisely so a volume
 * spike is a config change (`LANGFUSE_SAMPLE_RATE=0.1`) rather than an
 * emergency refactor, not because Tier 1 needs it sampled today.
 *
 * The decision is cached per traceId so every span of one trace gets the same
 * verdict — CLAUDE.md §8.4 is explicit that a partial trace is worse than no
 * trace. Errors are always kept for whichever traces have already been seen
 * to error by the time their spans are evaluated.
 *
 * KNOWN LIMITATION: this is a streaming, not a buffering, sampler. If an
 * error occurs on a span that ends *after* an earlier sibling of the same
 * trace has already been evaluated and dropped, that earlier sibling stays
 * dropped — only a tail-based (buffer-then-decide) sampler could rescue it,
 * and that is out of scope for a client-side OTel processor. At the default
 * rate of 1 this has no effect at all; it only matters once the rate is
 * lowered, and it is documented here rather than silently accepted.
 */
class TraceSampler {
  private readonly decisionByTraceId = new Map<string, boolean>();

  constructor(private readonly rate: number) {}

  /** FNV-1a — fast, dependency-free, stable across processes for the same traceId. */
  private hash(traceId: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < traceId.length; i++) {
      h ^= traceId.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) / 0xffffffff;
  }

  shouldExport(otelSpan: ReadableSpan): boolean {
    if (this.rate >= 1) return true;
    const traceId = otelSpan.spanContext().traceId;
    const isError = otelSpan.status.code === 2; // SpanStatusCode.ERROR
    const cached = this.decisionByTraceId.get(traceId);
    const decision = isError || cached || this.hash(traceId) < this.rate;
    this.decisionByTraceId.set(traceId, decision);
    // Bound growth on a long-lived server: a trace's decision is only needed
    // while its spans are still arriving, so drop it once the turn ends.
    if (otelSpan.name === "ai.eve.turn") this.decisionByTraceId.delete(traceId);
    return decision;
  }
}

const sampler = new TraceSampler(Number(process.env.LANGFUSE_SAMPLE_RATE ?? "1"));

export default defineInstrumentation({
  setup: ({ agentName }) => {
    const baseUrl = required("LANGFUSE_BASE_URL");

    registerOTel({
      // Resolved by eve at compile time from the project, so the service name
      // never drifts from the agent's actual name.
      serviceName: agentName,
      spanProcessors: [
        // Must precede LangfuseSpanProcessor — it rewrites the attributes that
        // Langfuse then reads.
        new LangfuseWorkflowEnricher({
          traceName: `${agentName}.turn`,
          environment,
          release,
        }),

        // Registered AFTER the enricher so the dump reflects what Langfuse
        // will actually receive — promoted attributes, the renamed span, and
        // the assembled metadata JSON — not the raw pre-enrichment state.
        ...(process.env.EVE_SPAN_DEBUG === "1" ? [new SpanAttributeDebugProcessor()] : []),

        new LangfuseSpanProcessor({
          publicKey: required("LANGFUSE_PUBLIC_KEY"),
          secretKey: required("LANGFUSE_SECRET_KEY"),
          baseUrl,
          // Set here rather than through runtime context: `environment` is a
          // processor-level concern, and a value pushed per model call arrives
          // too late for spans that open before the first call.
          environment,
          release,
          // `eve dev` is long-running but a PoC turn is short, and we want the
          // trace visible immediately rather than after a batch window.
          // Production should leave these at their defaults.
          flushAt: 1,
          flushInterval: 1,
          mask: secretRedactionMask,
          // Langfuse's default filter keeps AI spans and drops framework
          // plumbing (`fetch POST .../workflow-world`, `workflow.route.*`).
          // That is the high-signal default CLAUDE.md §7.5 asks for, plus the
          // `ai.eve.turn` exception above (single-root fix) and the sampling
          // verdict. Set LANGFUSE_EXPORT_ALL_SPANS=1 to see the plumbing too.
          shouldExportSpan:
            process.env.LANGFUSE_EXPORT_ALL_SPANS === "1"
              ? () => true
              : ({ otelSpan }) => shouldExportSpan({ otelSpan }) && sampler.shouldExport(otelSpan),
        }),
      ],
    });

    console.log(
      `[instrumentation] Langfuse export -> ${baseUrl}/api/public/otel (env=${environment})`,
    );
  },

  // Full prompts and completions are shipped to Langfuse. Permitted here only
  // because this PoC sends synthetic weather questions and no real user data.
  // Set both to false before pointing this at anything sensitive — this is a
  // single eve-wide switch, so it governs every backend at once. Secrets are
  // additionally masked at export time regardless of this setting (see
  // `secretRedactionMask` above) — recordInputs/Outputs controls *volume*,
  // masking controls *safety*, and the two are independent switches.
  recordInputs: true,
  recordOutputs: true,

  // Wraps each inbound channel request in a SERVER span that parents the turn
  // tree, so the trace starts at "what triggered this workflow" rather than at
  // the first model call.
  traceChannelRequests: true,

  events: {
    /**
     * Runs once per model call, after eve has assembled the model input. The
     * returned `runtimeContext` rides onto the model-call span and its children.
     *
     * Deliberately small. Runtime context is stamped onto EVERY span of the
     * call, so anything large here is duplicated per span — putting the message
     * history in would reproduce the quadratic payload growth CLAUDE.md §7.5
     * warns about. Step inputs/outputs are attached by the enricher instead,
     * which stores each payload exactly once.
     */
    "step.started"(input) {
      // `auth.current` is null for an unauthenticated caller; fall back to the
      // session initiator so a delegated/subagent turn still carries an id.
      // localDev/placeholderAuth synthesize an "anonymous" principal locally —
      // real deployments should replace those channels per CLAUDE.md §12.2.
      const principal = input.session.auth.current ?? input.session.auth.initiator;

      return {
        runtimeContext: {
          // Groups every turn of one conversation into a Langfuse session.
          "langfuse.session.id": input.session.id,
          "langfuse.trace.tags": ["poc", "eve", `channel:${input.channel.kind}`],
          ...(principal?.principalId ? { "langfuse.user.id": principal.principalId } : {}),
        },
      };
    },
  },
});
