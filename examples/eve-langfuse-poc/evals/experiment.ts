/**
 * Entry point for the prompt experiment. Its only job is ORDERING.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * The Langfuse tracing layer resolves its OTel tracer when `@langfuse/client` is
 * first imported. ES module imports are hoisted and evaluated before any statement
 * in the importing module runs, so a single-file runner that does
 *
 *     import { LangfuseClient } from "@langfuse/client";   // tracer resolved HERE
 *     ...
 *     startOtel();                                          // far too late
 *
 * hands the SDK a no-op tracer. The experiment then completes, prints a summary
 * with plausible average scores, uploads the scores — and stores **no traces at
 * all**. The scores arrive orphaned (`traceId: null`), the dataset run has zero
 * items, and nothing anywhere reports an error. That is exactly what happened, and
 * it is the single most misleading failure in this whole layer, because the summary
 * looks like a successful run.
 *
 * Splitting the bootstrap from the runner is what fixes it: OTel is registered
 * here, then `./run.ts` — and with it `@langfuse/client` — is loaded by dynamic
 * `import()`, which is evaluated at CALL time rather than hoisted.
 *
 * Do not merge this file back into `run.ts`, and do not convert the dynamic import
 * to a static one. Both changes look like tidying and both silently break tracing.
 */

import { shutdownOtel, startOtel } from "./otel.ts";

startOtel();

try {
  const { main } = await import("./run.ts");
  await main();
} catch (error) {
  console.error(`\nexperiment failed: ${error instanceof Error ? error.message : String(error)}`);
  // exitCode rather than process.exit(): undici keep-alive sockets abort the
  // process on Windows and turn a clean 1 into a 127, which reads as a crash in CI.
  process.exitCode = 1;
} finally {
  // Belt and braces — run.ts also shuts down after the experiment so the flush
  // happens before it reads the run back. shutdownOtel() is idempotent.
  await shutdownOtel();
}
