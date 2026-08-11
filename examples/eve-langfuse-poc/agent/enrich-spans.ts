/**
 * Span enrichment that turns eve's raw OTel output into a workflow trace a
 * human can actually read in Langfuse.
 *
 * WHAT WAS WRONG WITHOUT THIS
 *
 * Out of the box the trace has gaps, and none of them are visible from the
 * code — they only show up when you read a trace back:
 *
 *   1. eve's per-step wrapper spans ("step 1") carry NO input or output. The
 *      generation underneath them has both, so the step — the level a human
 *      actually reads — renders as an empty box between two populated ones.
 *   2. Runtime context arrives namespaced under `ai.settings.context.`, so
 *      `langfuse.session.id` never reaches Langfuse (see INTEGRATION-PITFALLS §5).
 *   3. Nothing sets a trace name, trace-level input/output, or per-observation
 *      metadata, so the trace list shows `invoke_agent gpt-4o-mini` with no
 *      indication of what was asked or what happened.
 *   4. Observation names embed the model id (`chat gpt-4o-mini`, `invoke_agent
 *      gpt-4o-mini`) and eve's own wrapper is always literally named "step 1"
 *      regardless of its real index — neither is a stable, filterable name
 *      (CLAUDE.md naming guidance: verb-first, no dynamic values in the name).
 *   5. A tool or generation that fails mid-turn is visible on its own node,
 *      but nothing summarizes "this turn recovered from a failure" at the
 *      level a reviewer actually opens first — the root.
 *
 * HOW IT WORKS
 *
 * Children always end before their parent, so by the time a parent span ends,
 * every child has already passed through `onEnd`. That makes a single
 * bottom-up pass sufficient: record each child's input/output (and any error)
 * as it ends, then fill the parent from what was recorded.
 *
 * WHY BUBBLE UP RATHER THAN PUSH DOWN VIA RUNTIME CONTEXT
 *
 * eve's `events["step.started"]` hook receives `modelInput` — the full
 * instructions and message list — and it is tempting to return it as runtime
 * context. Do not. Runtime context is stamped onto EVERY span of the model call
 * and its children, so the full message history would be duplicated per span.
 * In a 200-step turn that is the quadratic payload growth CLAUDE.md §7.5 calls
 * the single largest storage risk in this design. Bubbling up stores each
 * payload once.
 */
import { createHash } from "node:crypto";

import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Prefix the AI SDK gives every runtime-context value it puts on a span. */
const RUNTIME_CONTEXT_PREFIX = "ai.settings.context.";

const LF = {
  TRACE_NAME: "langfuse.trace.name",
  TRACE_INPUT: "langfuse.trace.input",
  TRACE_OUTPUT: "langfuse.trace.output",
  TRACE_METADATA: "langfuse.trace.metadata",
  OBSERVATION_INPUT: "langfuse.observation.input",
  OBSERVATION_OUTPUT: "langfuse.observation.output",
  OBSERVATION_METADATA: "langfuse.observation.metadata",
  OBSERVATION_LEVEL: "langfuse.observation.level",
  OBSERVATION_STATUS: "langfuse.observation.status_message",
  IS_APP_ROOT: "langfuse.internal.is_app_root",
  RELEASE: "langfuse.release",
  VERSION: "langfuse.version",
} as const;

/**
 * Framework-generated span names, rewritten to the stable, verb-first form
 * CLAUDE.md's naming guidance asks for. The dropped information (which model,
 * which eve step index) is not lost — it already lands in `metadata.model` /
 * `metadata.eveStepIndex` below, which is exactly where dynamic values belong.
 *
 * Order matters: `startsWith` rules are checked after the exact-match rules,
 * first match wins.
 */
const RENAME_RULES: ReadonlyArray<{ test: (name: string) => boolean; name: string }> = [
  { test: (n) => n === "ai.eve.turn", name: "process-turn" },
  { test: (n) => n === "step 1", name: "model-call" },
  { test: (n) => n.startsWith("invoke_agent "), name: "agent-step" },
  { test: (n) => n.startsWith("chat "), name: "call-model" },
];

/**
 * `execute_tool get_weather` -> `call-get-weather`.
 *
 * Handled separately from RENAME_RULES because the result depends on the tool
 * name. That is still a STABLE name, not a dynamic one: it identifies which
 * tool ran, and is identical across every execution of that tool. The thing
 * the naming rule forbids is per-execution values (ids, retry counters, user
 * ids), which is why the tool CALL id stays in metadata instead.
 *
 * Distinct names per tool are also what lets Langfuse's Agent Graph tell the
 * tools apart — collapsing them all to one `call-tool` node would merge them.
 */
const EXECUTE_TOOL_PREFIX = "execute_tool ";

function toolSpanName(spanName: string): string | undefined {
  if (!spanName.startsWith(EXECUTE_TOOL_PREFIX)) return undefined;
  const tool = spanName.slice(EXECUTE_TOOL_PREFIX.length).trim();
  if (!tool) return undefined;
  return `call-${tool.replace(/[\s_]+/g, "-").toLowerCase()}`;
}

interface CapturedIO {
  input?: unknown;
  output?: unknown;
  /** Ordering key so the parent takes the FIRST input and the LAST output. */
  startTimeMs: number;
  /**
   * True when this child is the model's final answer to the user rather than
   * another tool-calling round. Drives trace-level output — see
   * `isFinalAnswer` and `markFinalAnswer`.
   */
  isFinal: boolean;
}

interface RecoveredError {
  step: string;
  message: string;
}

function spanIdOf(span: ReadableSpan): string {
  return span.spanContext().spanId;
}

/** OTel JS 2.x moved the parent id off `parentSpanId` onto `parentSpanContext`. */
function parentIdOf(span: ReadableSpan): string | undefined {
  const s = span as { parentSpanId?: string; parentSpanContext?: { spanId?: string } };
  return s.parentSpanId ?? s.parentSpanContext?.spanId;
}

function hrToMs([seconds, nanos]: [number, number]): number {
  return seconds * 1000 + nanos / 1e6;
}

/** Short, stable content fingerprint — changes iff the instructions do. */
function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 10);
}

/**
 * True when a span represents the model finishing its answer to the user,
 * rather than asking for another tool round.
 *
 * `gen_ai.response.finish_reasons` is an array serialized onto the span; the
 * AI SDK writes `["tool-calls"]` (hyphen, not the underscore the OpenAI wire
 * format uses) while more rounds are coming, and `["stop"]` on the last one.
 * Substring matching on the serialized value avoids depending on whether OTel
 * delivered it as a real array or a JSON string.
 */
function isFinalAnswer(attrs: Record<string, unknown>): boolean {
  const raw = attrs["gen_ai.response.finish_reasons"];
  if (raw === undefined) return false;
  const text = Array.isArray(raw) ? raw.join(",") : String(raw);
  return text.includes("stop");
}

/**
 * Drop the oldest entries once a per-trace map outgrows this. These maps are
 * keyed by trace/span id on a long-lived `eve dev` (and, in production, a
 * long-lived server process), and a turn that never reaches its final answer
 * — a crash, a cancelled stream, a durable run parked for days per CLAUDE.md
 * §6.4 — would otherwise leave its entry behind forever.
 */
const MAX_TRACKED_TRACES = 500;

function evictOldest<K, V>(map: Map<K, V>, limit = MAX_TRACKED_TRACES): void {
  if (map.size <= limit) return;
  // Map iterates in insertion order, so this drops the least recently added.
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= limit) break;
  }
}

export interface EnricherOptions {
  /** Semantic trace name, e.g. "weather.turn". Never a generic "trace-1". */
  traceName: string;
  release?: string;
  environment?: string;
}

export class LangfuseWorkflowEnricher implements SpanProcessor {
  /** parentSpanId -> the children that have already ended under it. */
  private readonly childIO = new Map<string, CapturedIO[]>();

  /** traceId -> every error seen anywhere in the trace so far, root included. */
  private readonly errorsByTraceId = new Map<string, RecoveredError[]>();

  constructor(private readonly options: EnricherOptions) {}

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    // ReadableSpan types attributes readonly, but the object handed to onEnd is
    // the live Span, so mutations are visible to processors registered after us.
    const attrs = span.attributes as Record<string, unknown>;
    // Captured before renaming: this is the one reliable, timing-independent
    // signal that this span IS eve's turn wrapper. See correctAppRoot below.
    const isTurnRoot = span.name === "ai.eve.turn";

    this.renameForReadability(span);
    this.promoteRuntimeContext(attrs);
    this.fillInputOutput(span, attrs);
    this.attachMetadata(span, attrs);
    this.recordError(span);
    this.correctAppRoot(attrs, isTurnRoot);
    this.markRoot(span, attrs);
    // AFTER markRoot: on a single-step turn the same span can be both the root
    // and the final answer, and the final answer is the authoritative source
    // of trace-level output.
    this.markFinalAnswer(span, attrs);
    this.recordForParent(span, attrs);
  }

  /**
   * `invoke_agent gpt-4o-mini` -> `agent-step`, etc. See RENAME_RULES.
   *
   * NOT via `Span.updateName()`. That method exists on the live object handed
   * to `onEnd`, but its first line is `if (this._isSpanEnded()) return this`
   * (`@opentelemetry/sdk-trace`'s `SpanImpl`) — and `onEnd` fires only after
   * `.end()` has already run, so `updateName` is unconditionally a no-op here.
   * It fails silently: no throw, no warning, the call just does nothing,
   * which is exactly the "looks wired, exports nothing" failure mode this
   * file exists to avoid elsewhere. `name` is a plain assignable property
   * underneath (confirmed by `updateName`'s own `this.name = name`), typed
   * `readonly` on `ReadableSpan` only at the TS level — the same trick this
   * class already relies on for `attributes` mutation.
   */
  private renameForReadability(span: ReadableSpan): void {
    const renamed = RENAME_RULES.find((r) => r.test(span.name))?.name ?? toolSpanName(span.name);
    if (!renamed) return;
    (span as unknown as { name: string }).name = renamed;
  }

  /**
   * `ai.settings.context.langfuse.x` -> `langfuse.x`.
   * Without this, session id, tags, and user id are silently dropped (pitfall §5).
   */
  private promoteRuntimeContext(attrs: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(attrs)) {
      if (!key.startsWith(RUNTIME_CONTEXT_PREFIX)) continue;
      const bare = key.slice(RUNTIME_CONTEXT_PREFIX.length);
      if (!bare.startsWith("langfuse.")) continue;
      if (attrs[bare] !== undefined) continue; // never clobber a real value
      attrs[bare] = value;
    }
  }

  /**
   * Give every span an input and an output.
   *
   * Generations and tool calls already carry theirs under `gen_ai.*`; those are
   * left alone and merely normalised onto the Langfuse attributes so the UI
   * renders them. Wrapper spans (eve's "step N", renamed to "model-call" above)
   * get the first child's input and the last child's output — which is exactly
   * "what went into this step" and "what came out of it".
   */
  private fillInputOutput(span: ReadableSpan, attrs: Record<string, unknown>): void {
    if (attrs[LF.OBSERVATION_INPUT] === undefined) {
      const own =
        attrs["gen_ai.input.messages"] ??
        attrs["gen_ai.tool.call.arguments"] ??
        attrs["gen_ai.system_instructions"];
      if (own !== undefined) attrs[LF.OBSERVATION_INPUT] = own;
    }

    if (attrs[LF.OBSERVATION_OUTPUT] === undefined) {
      const own = attrs["gen_ai.output.messages"] ?? attrs["gen_ai.tool.call.result"];
      if (own !== undefined) attrs[LF.OBSERVATION_OUTPUT] = own;
    }

    // A step that threw has no output — but "it failed, and this is why" is an
    // outcome, and it is the one a reader most needs. Without this the failing
    // step is the one black box in the trace, which defeats the point.
    if (attrs[LF.OBSERVATION_OUTPUT] === undefined && span.status.code === 2) {
      attrs[LF.OBSERVATION_OUTPUT] = JSON.stringify({
        error: span.status.message ?? "unknown error",
        status: "ERROR",
      });
    }

    // Still empty: this is a wrapper span. Inherit from what ran inside it.
    const children = this.childIO.get(spanIdOf(span));
    if (!children?.length) return;

    children.sort((a, b) => a.startTimeMs - b.startTimeMs);

    if (attrs[LF.OBSERVATION_INPUT] === undefined) {
      const first = children.find((c) => c.input !== undefined);
      if (first) attrs[LF.OBSERVATION_INPUT] = first.input;
    }
    if (attrs[LF.OBSERVATION_OUTPUT] === undefined) {
      const last = [...children].reverse().find((c) => c.output !== undefined);
      if (last) attrs[LF.OBSERVATION_OUTPUT] = last.output;
    }

    this.childIO.delete(spanIdOf(span));
  }

  /**
   * Metadata that answers "which model, which tool, how long, what status,
   * which prompt revision" from the observation itself, without expanding the
   * payload.
   */
  private attachMetadata(span: ReadableSpan, attrs: Record<string, unknown>): void {
    if (attrs[LF.OBSERVATION_METADATA] !== undefined) return;

    const pick = (key: string): unknown => attrs[key] ?? attrs[`${RUNTIME_CONTEXT_PREFIX}${key}`];

    const metadata: Record<string, unknown> = {
      step: span.name,
      durationMs: Math.round(hrToMs(span.endTime) - hrToMs(span.startTime)),
      status: span.status.code === 2 ? "ERROR" : "OK",
    };

    // The system instructions live on the "agent-step" (invoke_agent) span,
    // not the nested "call-model" generation, so this only appears one level
    // up from the raw model call — that is also the node a reviewer expands
    // first to see "what did the agent have to work with".
    //
    // This is NOT a Langfuse-managed prompt link (`OBSERVATION_PROMPT_NAME` /
    // `_VERSION`, which point at a real versioned Prompt object in Langfuse).
    // Creating that object requires the admin API, which is allowlist-gated
    // and unreachable from where this was built — see
    // docs/INTEGRATION-PITFALLS.md #16. A content hash is the honest interim:
    // it answers "did the instructions change between these two traces?"
    // without claiming a link that would 404 in the UI.
    const systemInstructions = pick("gen_ai.system_instructions");

    const optional: Record<string, unknown> = {
      model: pick("gen_ai.request.model"),
      provider: pick("gen_ai.provider.name"),
      operation: pick("gen_ai.operation.name"),
      agentName: pick("gen_ai.agent.name"),
      toolName: pick("gen_ai.tool.name"),
      toolCallId: pick("gen_ai.tool.call.id"),
      finishReason: pick("gen_ai.response.finish_reasons"),
      eveSessionId: pick("eve.session.id"),
      eveTurnId: pick("eve.turn.id"),
      eveStepIndex: pick("eve.step.index"),
      eveChannel: pick("eve.channel.kind"),
      eveVersion: pick("eve.version"),
      environment: this.options.environment,
      ...(systemInstructions !== undefined
        ? { promptName: "weather-assistant-instructions", promptRevision: shortHash(systemInstructions) }
        : {}),
    };

    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined && value !== "") metadata[key] = value;
    }

    if (span.status.code === 2 && span.status.message) {
      metadata.error = span.status.message;
      attrs[LF.OBSERVATION_LEVEL] = "ERROR";
      attrs[LF.OBSERVATION_STATUS] = span.status.message;
    }

    attrs[LF.OBSERVATION_METADATA] = JSON.stringify(metadata);

    if (this.options.release) {
      attrs[LF.RELEASE] ??= this.options.release;
      attrs[LF.VERSION] ??= this.options.release;
    }
  }

  /**
   * Remember every error anywhere in the trace, keyed by traceId rather than
   * by parent/child — an ordinary tool or generation failure already gets its
   * own ERROR-level node (attachMetadata above), but a reviewer who opens only
   * the root should not have to expand the whole tree to learn the turn
   * recovered from one. "A successful final response must not make
   * intermediate failures invisible" — the trace spec this was built against.
   */
  private recordError(span: ReadableSpan): void {
    if (span.status.code !== 2) return;
    const traceId = span.spanContext().traceId;
    const list = this.errorsByTraceId.get(traceId) ?? [];
    list.push({ step: span.name, message: span.status.message ?? "unknown error" });
    this.errorsByTraceId.set(traceId, list);

    // A turn that fails without ever reaching a final answer never triggers the
    // delete in `markFinalAnswer`, so this map needs its own ceiling.
    evictOldest(this.errorsByTraceId);
  }

  /**
   * `LangfuseSpanProcessor` decides `langfuse.internal.is_app_root` exactly
   * once, at span START (`markAppRootCandidate`), by checking whether the
   * span's PARENT was already recorded as "expected exported" at that same
   * instant. Empirically that ordering is not reliable for `ai.eve.turn`:
   * even with `shouldExportSpan` recognizing it by name (see
   * instrumentation.ts), some of its `invoke_agent` children were still
   * evaluated before the turn span's own verdict had propagated, and
   * independently claimed app-root anyway — reproducing the exact bug this
   * whole file exists to fix, just with fewer duplicate roots than before.
   * Verified with EVE_SPAN_DEBUG=1: 2 of 3 `agent-step` children still carried
   * `is_app_root=true` alongside the correctly-flagged `process-turn`.
   *
   * `isTurnRoot` is a fact this processor knows with certainty from the span's
   * own pre-rename name — no start/end race involved — so it corrects the
   * attribute directly rather than trusting the SDK's timing-dependent
   * heuristic. This runs before `LangfuseSpanProcessor.onEnd` (registration
   * order), so the correction is already in place when the span is
   * serialized for export.
   */
  private correctAppRoot(attrs: Record<string, unknown>, isTurnRoot: boolean): void {
    if (isTurnRoot) {
      attrs[LF.IS_APP_ROOT] = true;
    } else if (attrs[LF.IS_APP_ROOT] === true) {
      attrs[LF.IS_APP_ROOT] = false;
    }
  }

  /**
   * Trace-level name, IO, and a recovered-errors rollup. Langfuse takes these
   * from the root observation, so the trace list shows a semantic name and
   * the question that started it rather than an opaque model id.
   *
   * `langfuse.user.id` is deliberately NOT re-derived here. `promoteRuntimeContext`
   * already promotes it (and session id, and tags) to a bare `langfuse.*`
   * attribute on whichever span actually carries the runtime context —
   * Langfuse's ingestion aggregates trace-level fields like session id, user
   * id, and tags from ANY observation in the trace, not only the one marked
   * `is_app_root`. That was already proven true for session id in the
   * original PoC run (recorded root was `invoke_agent`, never the true turn
   * root, and session id still landed).
   */
  private markRoot(span: ReadableSpan, attrs: Record<string, unknown>): void {
    if (attrs[LF.IS_APP_ROOT] !== true) return;

    attrs[LF.TRACE_NAME] ??= this.options.traceName;
    if (attrs[LF.TRACE_INPUT] === undefined && attrs[LF.OBSERVATION_INPUT] !== undefined) {
      attrs[LF.TRACE_INPUT] = attrs[LF.OBSERVATION_INPUT];
    }
    // Trace OUTPUT is deliberately NOT taken from `OBSERVATION_OUTPUT` here.
    // The turn root closes early (see `markFinalAnswer`), so at this moment its
    // bubbled-up output is the FIRST step's `tool_call` — an intermediate
    // request for data, not the answer the user saw. Publishing that as the
    // trace output is worse than publishing nothing: a non-technical reviewer
    // reads the trace's headline output as "what the system replied", and would
    // conclude the agent answered with a machine-readable tool invocation.
    //
    // Only take it when a child that ended in time actually was the final
    // answer (a single-step turn with no tool calls). Otherwise leave it for
    // `markFinalAnswer` to set on the step that really produced it.
    if (attrs[LF.TRACE_OUTPUT] === undefined) {
      const finalChild = this.childIO
        .get(spanIdOf(span))
        ?.find((child) => child.isFinal && child.output !== undefined);
      if (finalChild) attrs[LF.TRACE_OUTPUT] = finalChild.output;
    }

    // Best-effort: this only sees failures from steps that ended before the
    // root did. `markFinalAnswer` re-writes the complete list afterwards.
    this.writeErrorRollup(span, attrs);
  }

  /**
   * Set trace-level output from the step that actually answered the user.
   *
   * WHY THIS EXISTS — the turn root closes before the turn finishes.
   *
   * eve's `ai.eve.turn` span ends once the first agentic step completes, but
   * the remaining steps of the tool loop keep ending under its (already
   * closed) span id. Verified with EVE_SPAN_DEBUG=1 on both the happy and the
   * failure path: `process-turn` ended after step 1 of 3, and steps 2 and 3
   * arrived afterwards. That is consistent with eve's durable execution model
   * (CLAUDE.md §6.4), where a turn may resume long after the request that
   * started it — so "wait for all children" is not an option a streaming span
   * processor has.
   *
   * The consequence is that the root's own bubbled output is always the first
   * step's `tool_call`. The last step — the one carrying the sentence the user
   * actually read — is identified structurally by its finish reason: the AI
   * SDK writes `["tool-calls"]` while more rounds are coming and `["stop"]` on
   * the final one. That span writes the trace output itself.
   *
   * Trace-level attributes are aggregated by Langfuse from ANY observation in
   * the trace, not only the app root — already proven for session id in the
   * original PoC, where session id landed correctly from a non-root span.
   */
  private markFinalAnswer(span: ReadableSpan, attrs: Record<string, unknown>): void {
    if (!isFinalAnswer(attrs)) return;
    if (attrs[LF.OBSERVATION_OUTPUT] === undefined) return;

    attrs[LF.TRACE_OUTPUT] = attrs[LF.OBSERVATION_OUTPUT];

    // This span ends last, so it is the only place with the full picture of
    // what failed and was recovered from during the turn.
    this.writeErrorRollup(span, attrs, { overwrite: true });
    this.errorsByTraceId.delete(span.spanContext().traceId);
  }

  /**
   * Surface failures that the turn recovered from at TRACE level.
   *
   * A turn that retried a failing tool and then answered successfully is a
   * success at the top and a failure in the middle. Without this the trace
   * list shows a clean green row and the failure is only findable by opening
   * the tree — which is exactly the "a successful final response must not make
   * intermediate failures invisible" case.
   */
  private writeErrorRollup(
    span: ReadableSpan,
    attrs: Record<string, unknown>,
    { overwrite = false }: { overwrite?: boolean } = {},
  ): void {
    if (!overwrite && attrs[LF.TRACE_METADATA] !== undefined) return;

    const errors = this.errorsByTraceId.get(span.spanContext().traceId);
    if (!errors?.length) return;

    attrs[LF.TRACE_METADATA] = JSON.stringify({
      recoveredErrors: errors,
      note: "One or more steps failed during this turn; see recoveredErrors for where and why.",
    });
  }

  /** Make this span's IO available to its parent, which ends after it. */
  private recordForParent(span: ReadableSpan, attrs: Record<string, unknown>): void {
    const parentId = parentIdOf(span);
    if (!parentId) return;

    const siblings = this.childIO.get(parentId) ?? [];
    siblings.push({
      input: attrs[LF.OBSERVATION_INPUT],
      output: attrs[LF.OBSERVATION_OUTPUT],
      startTimeMs: hrToMs(span.startTime),
      isFinal: isFinalAnswer(attrs),
    });
    this.childIO.set(parentId, siblings);

    // Steps that end AFTER their parent (see `markFinalAnswer`) re-create the
    // entry the parent just deleted, so nothing is guaranteed to clean it up.
    evictOldest(this.childIO);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.childIO.clear();
    this.errorsByTraceId.clear();
  }
}
