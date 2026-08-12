/**
 * OTel bootstrap for the experiment process.
 *
 * Separate from `agent/instrumentation.ts` on purpose: that file is eve-owned and
 * uses `registerOTel` inside eve's server lifecycle. The experiment is a plain
 * Node script with no eve server, so it must stand up and tear down its own SDK.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO PREVENT
 *
 * The Langfuse experiment runner writes its traces through the OTel pipeline. If
 * the process exits before the span processor flushes, the run appears in Langfuse
 * with **zero items and no error anywhere** — the script prints a happy summary,
 * the dataset run exists, and it is empty. `await shutdownOtel()` in a `finally`
 * is the whole mitigation, and `experiment.ts` additionally asserts the item count
 * came back, because a flush that silently dropped half the batch looks identical
 * to a run that only had half the items.
 */

import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";

import { LangfuseWorkflowEnricher } from "../agent/enrich-spans.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}

/**
 * Experiment traces are tagged with their own environment.
 *
 * Keeping them out of `development`/`production` matters: a 33-item experiment
 * produces ~70 generations in a burst, and mixing those into the environment a
 * dashboard or a production evaluation rule reads from would skew both. Langfuse's
 * own managed evaluators do the same thing, running under
 * `langfuse-llm-as-a-judge`.
 */
export const EXPERIMENT_ENVIRONMENT = process.env.LANGFUSE_EXPERIMENT_ENVIRONMENT ?? "experiment";

/**
 * `BasicTracerProvider` rather than `NodeSDK`.
 *
 * `@opentelemetry/sdk-node` is not a dependency of this project and pulling it in
 * for one script would add the whole auto-instrumentation surface for no benefit —
 * the experiment traces its own work explicitly and needs no auto-instrumentation.
 * `sdk-trace-base` is already present transitively and gives exactly the two
 * things required: span processors, and an awaitable `shutdown()`.
 */
let provider: BasicTracerProvider | undefined;

/**
 * Counts spans reaching the pipeline, reported at shutdown.
 *
 * "The run has no traces" has two very different causes that look identical from
 * Langfuse: no spans were ever CREATED (wrong tracer, wrong ordering), or spans
 * were created but never EXPORTED (flush, auth, filtering). This counter separates
 * them in one run, which is otherwise a guessing game.
 */
class SpanCounter {
  count = 0;
  names = new Map<string, number>();
  onStart(): void {}
  onEnd(span: { name: string }): void {
    this.count += 1;
    this.names.set(span.name, (this.names.get(span.name) ?? 0) + 1);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

const counter = new SpanCounter();

export function startOtel(): void {
  if (provider) return;

  provider = new BasicTracerProvider({
    spanProcessors: [
      counter,
      // Reused from the agent so experiment traces carry the SAME observation
      // names and types as production traces. Without it the experiment would
      // emit raw `ai.*` span names, and every saved filter, dashboard and
      // evaluation rule would need a second variant to match them.
      new LangfuseWorkflowEnricher({
        traceName: "experiment.item",
        environment: EXPERIMENT_ENVIRONMENT,
        release: process.env.GITHUB_SHA ?? process.env.LANGFUSE_RELEASE,
      }),
      new LangfuseSpanProcessor({
        publicKey: required("LANGFUSE_PUBLIC_KEY"),
        secretKey: required("LANGFUSE_SECRET_KEY"),
        baseUrl: required("LANGFUSE_BASE_URL"),
        environment: EXPERIMENT_ENVIRONMENT,
        release: process.env.GITHUB_SHA ?? process.env.LANGFUSE_RELEASE,
        // Export everything this process produces. Unlike the agent, there is no
        // framework plumbing to filter out here, and a dropped span in an
        // experiment silently removes an item from the run.
        shouldExportSpan: () => true,
      }),
    ],
  });

  // The Langfuse experiment runner creates its spans through the GLOBAL tracer,
  // so registering the provider globally is what connects the two. Skip this and
  // the runner writes into a no-op tracer: the experiment completes, reports
  // success, and produces a dataset run with no traces attached.
  trace.setGlobalTracerProvider(provider);

  /**
   * Register the AI SDK's telemetry integration.
   *
   * REQUIRED, and easy to miss: in **AI SDK v7 `experimental_telemetry` no longer
   * exists** and span emission is opt-out via `telemetry`, but only once a
   * telemetry integration has been registered. Without this call `generateText`
   * emits nothing at all — the experiment produced exactly ONE span (the runner's
   * own `experiment-item-run` wrapper) and no model or tool spans beneath it, so
   * every item looked like a black box.
   *
   * eve does this for the agent, which is why `agent/instrumentation.ts` does not.
   * The experiment runs outside eve and therefore must do it itself. This is
   * pitfall #1 in docs/INTEGRATION-PITFALLS.md — already documented, and still
   * walked into.
   */
  registerTelemetry(new OpenTelemetry());
}

/**
 * Flush and stop. MUST be awaited before the process exits.
 *
 * Called from a `finally` so it still runs when the experiment throws — a failed
 * run whose traces were discarded is much harder to diagnose than a failed run
 * with traces.
 */
export async function shutdownOtel(): Promise<void> {
  if (!provider) return;
  // forceFlush first, then shutdown. shutdown() flushes too, but flushing
  // explicitly makes an export failure surface here rather than being folded into
  // teardown, where it is easy to mistake for an unrelated exit problem.
  await provider.forceFlush();
  await provider.shutdown();
  provider = undefined;

  const shape = [...counter.names.entries()].map(([n, c]) => `${n}x${c}`).join(" ");
  console.log(`[otel] ${counter.count} span(s) reached the pipeline${shape ? `: ${shape}` : ""}`);
  if (counter.count === 0) {
    console.warn(
      "[otel] NO SPANS WERE CREATED. The experiment ran against a no-op tracer, so the run " +
        "will have no traces and its scores will be orphaned. This is an ordering/tracer " +
        "problem, not an export problem.",
    );
  }
}
