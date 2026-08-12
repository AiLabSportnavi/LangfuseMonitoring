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
import type { LangfuseObservationType } from "@langfuse/tracing";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

import { peekResolvedPrompt } from "./lib/prompt.ts";

/** Prefix the AI SDK gives every runtime-context value it puts on a span. */
const RUNTIME_CONTEXT_PREFIX = "ai.settings.context.";

const LF = {
  TRACE_NAME: "langfuse.trace.name",
  TRACE_INPUT: "langfuse.trace.input",
  TRACE_OUTPUT: "langfuse.trace.output",
  TRACE_METADATA: "langfuse.trace.metadata",
  OBSERVATION_TYPE: "langfuse.observation.type",
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
 *
 * Each rule also declares the Langfuse observation TYPE, because type is what
 * decides how the node renders: a `tool` node gets its own collapsible block
 * with the tool name and a status badge, a `generation` node gets the
 * model/token/cost panel, an `agent` node becomes a node in the Agent Graph,
 * and everything else falls back to a featureless `span`. Langfuse can infer
 * the type from `gen_ai.operation.name`, and does so correctly today — but that
 * inference is a property of the AI SDK's semantic-convention version, not of
 * our code, so a framework upgrade that renames an operation silently demotes
 * every tool call to a plain span. Writing the type explicitly costs one
 * attribute and makes the rendering ours, not the framework's.
 */
const RENAME_RULES: ReadonlyArray<{
  test: (name: string) => boolean;
  name: string;
  type: LangfuseObservationType;
}> = [
  { test: (n) => n === "ai.eve.turn", name: "process-turn", type: "span" },
  { test: (n) => n === "step 1", name: "model-call", type: "span" },
  { test: (n) => n.startsWith("invoke_agent "), name: "agent-step", type: "agent" },
  { test: (n) => n.startsWith("chat "), name: "call-model", type: "generation" },
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

/**
 * Give Langfuse a payload it can render as an expandable JSON tree rather than
 * as one long escaped string.
 *
 * OTel span attributes may only hold primitives, so every structured payload
 * reaches Langfuse as a string and Langfuse parses it back. That works — unless
 * the value is doubly encoded, which is the normal case for tool results: the
 * tool returns an object, the AI SDK serializes it into the tool-result message
 * part, and the telemetry layer serializes *that* onto the span. The attribute
 * then parses to a STRING, and the UI shows `"{\"partnerId\":16499,…}"` as a
 * single unexpandable blob instead of a tree.
 *
 * Unwrapping to the innermost non-string value and re-encoding exactly once
 * fixes it. Bounded at four rounds so a pathological payload cannot spin, and
 * only attempted when the text actually looks like JSON — a plain assistant
 * sentence must stay a sentence, not become a parse attempt.
 */
function normalizeJsonPayload(value: unknown): unknown {
  if (typeof value !== "string") return value === undefined ? undefined : JSON.stringify(value);

  let current: unknown = value;
  for (let round = 0; round < 4 && typeof current === "string"; round++) {
    const text = current.trim();
    const looksLikeJson = /^[[{"]/.test(text);
    if (!looksLikeJson) break;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === current) break; // JSON.parse('"x"') === 'x' would loop
      current = parsed;
    } catch {
      break; // not JSON after all — keep the last good value
    }
  }

  // A payload that unwrapped to a bare string is text, and text renders better
  // as text than as a quoted JSON scalar.
  return typeof current === "string" ? current : JSON.stringify(current);
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

  private readonly options: EnricherOptions;

  /** Per-trace session/user/tags, collected from children and applied to the root. */
  private readonly traceIdentity = new Map<string, Record<string, unknown>>();

  // Written out longhand rather than as a `constructor(private readonly options)`
  // parameter property. This module is imported by `evals/otel.ts`, which runs under
  // bare `node --experimental-strip-types` — strip-only mode ERASES types but cannot
  // SYNTHESISE the assignment a parameter property implies, so it rejects the file
  // outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). eve's bundler compiles properly and
  // accepts either form, which is why this only breaks outside eve.
  constructor(options: EnricherOptions) {
    this.options = options;
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    // ReadableSpan types attributes readonly, but the object handed to onEnd is
    // the live Span, so mutations are visible to processors registered after us.
    const attrs = span.attributes as Record<string, unknown>;
    // Captured before renaming: this is the one reliable, timing-independent
    // signal that this span IS eve's turn wrapper. See correctAppRoot below.
    const isTurnRoot = span.name === "ai.eve.turn";

    this.renameAndType(span, attrs);
    this.promoteRuntimeContext(attrs);
    // AFTER renameAndType: it decides the observation type, and the prompt link
    // is only honoured on generations.
    this.attachPromptLink(attrs);
    this.attachModelInfo(attrs);
    this.rememberTraceIdentity(span, attrs);
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
   * Stamp the managed-prompt link onto GENERATION spans.
   *
   * WHY THIS CANNOT BE DONE FROM RUNTIME CONTEXT
   *
   * `instrumentation.ts` puts the prompt name/version into eve's runtime context,
   * and `promoteRuntimeContext` duly promotes them — but runtime context lands on
   * the AGENT-level span (`invoke_agent` -> `agent-step`), and OTel span
   * attributes are NOT inherited by child spans. The generation (`chat` ->
   * `call-model`) is a child, so it never saw them.
   *
   * That matters because Langfuse honours the prompt link on **generations only**
   * (per the OTLP attribute mapping table in the integration docs). So the
   * attribute was present on the trace, on the wrong span, and linked nothing:
   * the observation carried `langfuse.observation.prompt.name` in its metadata
   * passthrough while `promptName` stayed empty.
   *
   * Writing it here, per-span, is the only placement that satisfies both
   * constraints. The value comes from the shared prompt cache rather than from
   * the span, so it is identical across every generation of the turn.
   *
   * Version MUST be an integer — the mapping table specifies `integer`, and a
   * stringified version is silently ignored.
   */
  /**
   * Publish the model name explicitly on generations.
   *
   * Langfuse infers a model from `gen_ai.request.model` well enough to price the
   * call — cost lands correctly — but the observation's own `providedModelName`
   * stays empty, so the UI shows an anonymous LLM call and "group by model" finds
   * nothing. `langfuse.observation.model.name` is the first-choice attribute in the
   * OTLP mapping table, so setting it removes the ambiguity rather than relying on
   * inference that is a property of the AI SDK's semantic-convention version.
   *
   * Also promotes model PARAMETERS, which nothing else sets, so the UI can show what
   * temperature/max-tokens produced a given answer.
   */
  private attachModelInfo(attrs: Record<string, unknown>): void {
    if (attrs[LF.OBSERVATION_TYPE] !== "generation") return;

    const model = attrs["gen_ai.request.model"] ?? attrs["gen_ai.response.model"];
    if (typeof model === "string" && model.length > 0) {
      attrs["langfuse.observation.model.name"] ??= model;
    }

    if (attrs["langfuse.observation.model.parameters"] === undefined) {
      const parameters: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(attrs)) {
        // `gen_ai.request.model` is the model itself, not a parameter.
        if (!key.startsWith("gen_ai.request.") || key === "gen_ai.request.model") continue;
        parameters[key.slice("gen_ai.request.".length)] = value;
      }
      if (Object.keys(parameters).length > 0) {
        attrs["langfuse.observation.model.parameters"] = JSON.stringify(parameters);
      }
    }
  }

  private attachPromptLink(attrs: Record<string, unknown>): void {
    if (attrs["langfuse.observation.type"] !== "generation") return;

    const prompt = peekResolvedPrompt();
    // A fallback prompt is deliberately not linked: version 0 does not exist in
    // Langfuse, and Langfuse's own SDK drops the link for fallbacks too. The
    // `prompt-fallback` trace tag is the signal for that case.
    if (!prompt || prompt.isFallback) return;

    attrs["langfuse.observation.prompt.name"] = prompt.name;
    attrs["langfuse.observation.prompt.version"] = prompt.version;
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
  private renameAndType(span: ReadableSpan, attrs: Record<string, unknown>): void {
    const rule = RENAME_RULES.find((r) => r.test(span.name));

    /**
     * Tool spans are matched on the `gen_ai.tool.name` ATTRIBUTE first, and only
     * then on the `execute_tool <name>` span-name convention.
     *
     * Under eve the tool span is named plainly `get_weather`, while the AI SDK
     * outside eve names it `execute_tool get_weather`. Matching only the latter
     * left eve's tool spans unrenamed and untyped — they showed up as
     * `get_weather` instead of `call-get-weather`, which breaks the stable-name
     * allowlist and, more importantly, splits Agent Graph nodes between the two
     * spellings. The attribute is set in both cases, so it is the reliable signal.
     */
    const toolAttr = attrs["gen_ai.tool.name"];
    const toolName = rule
      ? undefined
      : typeof toolAttr === "string" && toolAttr.length > 0
        ? `call-${toolAttr.replace(/[\s_]+/g, "-").toLowerCase()}`
        : toolSpanName(span.name);

    const renamed = rule?.name ?? toolName;
    if (!renamed) return;
    (span as unknown as { name: string }).name = renamed;

    // `??=` so a span that already declared its own type — anything created
    // through `@langfuse/tracing` helpers, e.g. a `retriever` sub-step inside a
    // tool — keeps it. This only fills in the framework-generated spans.
    attrs[LF.OBSERVATION_TYPE] ??= rule?.type ?? "tool";
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
      if (own !== undefined) attrs[LF.OBSERVATION_INPUT] = normalizeJsonPayload(own);
    }

    if (attrs[LF.OBSERVATION_OUTPUT] === undefined) {
      const own = attrs["gen_ai.output.messages"] ?? attrs["gen_ai.tool.call.result"];
      if (own !== undefined) attrs[LF.OBSERVATION_OUTPUT] = normalizeJsonPayload(own);
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

    // Prompt provenance in metadata, alongside — not instead of — the real
    // Langfuse prompt link.
    //
    // The link itself is carried by the `langfuse.observation.prompt.name` and
    // `.version` attributes stamped in instrumentation.ts, which make the prompt
    // a clickable, versioned object in the UI and drive Langfuse's per-version
    // metrics. This block is the human-readable copy: it survives in metadata
    // where it can be read without a join, records the LABEL (which the link
    // does not carry), and — most importantly — records `promptIsFallback`,
    // which is the only in-trace evidence that a turn ran on the bundled copy.
    //
    // Superseded: this used to publish a content hash of `gen_ai.system_instructions`
    // under `promptRevision`, because creating a real Prompt object needed an API
    // that was unreachable at the time. Both halves of that constraint are gone —
    // the prompt is managed (prompts/weather-assistant.text.json) and the read
    // APIs are reachable from any network since the SSO cut-over.
    const linkedPrompt = peekResolvedPrompt();

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
      ...(linkedPrompt
        ? {
            promptName: linkedPrompt.name,
            promptLabel: linkedPrompt.label,
            promptVersion: linkedPrompt.version,
            // Always emitted, including when false. A key that only appears on
            // failure is a key nobody writes an assertion against.
            promptIsFallback: linkedPrompt.isFallback,
          }
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
  /**
   * Remember session/user per trace, and stamp them onto the root.
   *
   * eve's runtime context is applied to the MODEL-CALL spans, and OTel attributes
   * are not inherited, so the turn-root span (`process-turn`) never carries
   * `langfuse.session.id` or `langfuse.user.id`. Langfuse reads trace-level
   * identity from the root observation, so Sessions and Users stayed empty in the
   * UI even though every generation underneath had the values — the data was in the
   * trace, on the wrong span.
   *
   * Children always end before their parent, so by the time the root ends every
   * child has already passed through here and the memo is populated.
   */
  private rememberTraceIdentity(span: ReadableSpan, attrs: Record<string, unknown>): void {
    const traceId = span.spanContext().traceId;
    const memo = this.traceIdentity.get(traceId) ?? {};
    for (const key of ["langfuse.session.id", "langfuse.user.id", "langfuse.trace.tags"] as const) {
      const value = attrs[key];
      if (value !== undefined && memo[key] === undefined) memo[key] = value;
    }
    this.traceIdentity.set(traceId, memo);
  }

  private markRoot(span: ReadableSpan, attrs: Record<string, unknown>): void {
    if (attrs[LF.IS_APP_ROOT] !== true) return;

    // Apply whatever identity the children carried. `??=` so a value already on the
    // root always wins.
    const memo = this.traceIdentity.get(span.spanContext().traceId) ?? {};
    for (const [key, value] of Object.entries(memo)) attrs[key] ??= value;
    // The turn is over; drop the memo so a long-lived server does not accumulate one
    // entry per trace forever.
    this.traceIdentity.delete(span.spanContext().traceId);

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
