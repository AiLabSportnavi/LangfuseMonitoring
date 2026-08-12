/**
 * Sub-step observations *inside* a tool.
 *
 * WHAT THIS ADDS OVER enrich-spans.ts
 *
 * The span processor works on spans the framework already emits, so it can only
 * describe a tool call as a single node: name, arguments, result, duration. That
 * is enough to read most tools. It is not enough for a tool that is itself a
 * small pipeline — a search that resolves a city, queries a store, filters, and
 * ranks — because every one of those stages collapses into one opaque box, and
 * "the tool returned 5 of 40" gives no way to see which stage did the trimming.
 *
 * These helpers open real child observations for those stages, so the tool node
 * becomes expandable in exactly the way the rest of the trace already is.
 *
 * WHY THE TYPE MATTERS AND `span` IS THE WRONG DEFAULT
 *
 * A lookup is a `retriever`, not a `tool` and not a generic `span`. Langfuse
 * keys its retrieval analytics off that type, and CLAUDE.md §7.2 requires the
 * most specific type available. `span` is the fallback for genuine plumbing.
 *
 * NESTING IS AMBIENT, NOT PASSED
 *
 * `startActiveObservation` puts the new observation on the OTel context for the
 * duration of the callback, so anything started inside it — including a nested
 * `observeStep` and any model call the AI SDK makes — parents itself
 * automatically. There is no span object to thread through call signatures. The
 * corollary is that the context must still be active: work started with a bare
 * `void somePromise` inside the callback, or resumed after the callback
 * returned, attaches to whatever context is current *then*, not to this step.
 *
 * EXPORT PATH
 *
 * These spans come from the Langfuse tracer, which `isDefaultExportSpan`
 * recognizes by instrumentation scope, so `shouldExportSpan` in
 * instrumentation.ts keeps them without needing a rule of its own. They ride
 * the tracer provider registered by `registerOTel` — the same singleton
 * everything else uses — so this file must never register a provider itself.
 */
import { startActiveObservation, type LangfuseObservationType } from "@langfuse/tracing";

export interface ObserveStepOptions {
  /**
   * Most specific type that fits. `retriever` for a lookup, `evaluator` for a
   * scoring/ranking pass, `guardrail` for a safety check, `chain` for glue.
   */
  as?: LangfuseObservationType;
  /** Recorded verbatim as the observation's input. */
  input?: unknown;
  /** Small facts about the step. Not a place for payloads — see CLAUDE.md §7.5. */
  metadata?: Record<string, unknown>;
}

/**
 * Run `fn` as its own observation, recording its return value as the output.
 *
 * ```ts
 * const partners = await observeStep(
 *   "lookup-partners-by-city",
 *   { as: "retriever", input: { city, tags } },
 *   () => store.findPartners({ city, tags }),
 * );
 * ```
 *
 * The name is stable per step — never interpolate the city or a request id into
 * it, or every execution becomes its own node in the Agent Graph and every
 * saved dashboard filter stops matching. Per-execution values go in `input` or
 * `metadata`.
 *
 * A throwing `fn` marks the observation ERROR with the message, ends it, and
 * rethrows — the tool's own error handling is unchanged, and the failure is
 * visible at the stage that caused it rather than only at the tool boundary.
 */
export async function observeStep<T>(
  name: string,
  options: ObserveStepOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const { as = "span", input, metadata } = options;

  return startActiveObservation(
    name,
    async (observation) => {
      observation.update({ input, metadata });
      try {
        const output = await fn();
        observation.update({ output });
        return output;
      } catch (error) {
        observation.update({
          level: "ERROR",
          statusMessage: error instanceof Error ? error.message : String(error),
          // A failed step has no result, but "it failed, and this is why" is an
          // outcome — and the one a reader most needs. Mirrors the synthesised
          // error output in enrich-spans.ts so both look the same in the UI.
          output: {
            error: error instanceof Error ? error.message : String(error),
            status: "ERROR",
          },
        });
        throw error;
      }
    },
    // The overloads are keyed on a literal `asType`, which a widened
    // LangfuseObservationType variable cannot satisfy. The runtime accepts any
    // of them; only the compile-time overload resolution needs the nudge.
    { asType: as } as { asType: "span" },
  );
}
