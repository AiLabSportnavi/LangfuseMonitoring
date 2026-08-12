import { defineEvalConfig } from "eve/evals";

/**
 * Configuration for eve's OWN eval harness.
 *
 * This is deliberately a different thing from the Langfuse experiment runner in
 * `evals/experiment.ts`, and the split is worth understanding before adding to
 * either:
 *
 *   - **eve evals** (`*.eval.ts`, run with `npx eve eval`) boot the real agent
 *     server and drive real turns through the real channel stack. They are the
 *     only thing here that exercises eve's harness — instrumentation,
 *     instructions resolution, session handling, tool dispatch. Use them to prove
 *     the plumbing works.
 *
 *   - **The Langfuse experiment** (`npm run experiment`) evaluates the PROMPT
 *     against the dataset and records scores into a Langfuse dataset run. That is
 *     what gates a prompt change in CI.
 *
 * They are not redundant, and neither replaces the other: a prompt regression is
 * invisible to the smoke eval, and a broken instrumentation wire is invisible to
 * the experiment.
 */
export default defineEvalConfig({});
