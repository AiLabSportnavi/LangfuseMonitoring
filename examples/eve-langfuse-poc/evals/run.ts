/**
 * Run the dataset against a prompt version, score it, and gate on the result.
 *
 *   npm run experiment                          # the staging prompt
 *   npm run experiment -- --label production     # a specific label
 *   npm run experiment -- --version 3            # a specific version
 *   npm run experiment -- --limit 4              # a fast subset while iterating
 *   npm run experiment -- --no-gate              # score without failing
 *
 * The exit code IS the gate: 0 means this prompt version may be promoted, 1 means
 * it may not. Everything printed exists to explain that one bit.
 */

import { LangfuseClient } from "@langfuse/client";

import { evaluateBaseline, formatBaseline } from "./baseline.ts";
import { DETERMINISTIC_EVALUATORS, makeInjectionResistance } from "./evaluators.ts";
import { EXPERIMENT_ENVIRONMENT, shutdownOtel } from "./otel.ts";
import { makeTask } from "./task.ts";
import type { Evaluation, ExpectedOutput, ItemInput, ItemMetadata, TaskOutput } from "./types.ts";

const DATASET_NAME = process.env.EXPERIMENT_DATASET ?? "weather-agent/core";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (flag: string): boolean => process.argv.includes(flag);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}

const BASE_URL = required("LANGFUSE_BASE_URL");
const AUTH =
  "Basic " +
  Buffer.from(`${required("LANGFUSE_PUBLIC_KEY")}:${required("LANGFUSE_SECRET_KEY")}`).toString("base64");

/**
 * Which scores are booleans.
 *
 * Declared explicitly at ingestion. A 0/1 value ingested without `dataType` is
 * inferred as NUMERIC, and then every boolean dashboard and every
 * `scores-boolean` metrics query silently treats a pass-rate as a continuous
 * average — plausible-looking numbers that mean something slightly different from
 * what the widget claims.
 */
const BOOLEAN_SCORES = new Set([
  "tool-contract",
  "format-contract",
  "injection-resistance",
  "no-crash",
  "no-fabricated-data",
]);

export interface ScoredItem {
  traceId: string;
  itemId?: string;
  /** Exactly the scores written for this trace, so the gate knows what to wait for. */
  scoreNames: string[];
  evaluations: { name: string; value: number; comment?: string }[];
}

/**
 * Attach evaluator results to the trace each item actually produced.
 *
 * Returns what was written so the gate can read exactly those traces back, rather
 * than guessing at a time window and hoping no other run overlapped.
 */
async function scoreItems(
  langfuse: LangfuseClient,
  itemResults: readonly {
    traceId?: string;
    item?: unknown;
    input?: unknown;
    output?: unknown;
    expectedOutput?: unknown;
  }[],
  evaluators: ((args: {
    input: ItemInput;
    output: TaskOutput;
    expectedOutput?: ExpectedOutput;
    metadata?: ItemMetadata;
  }) => Evaluation | undefined)[],
): Promise<ScoredItem[]> {
  const scored: ScoredItem[] = [];

  for (const result of itemResults) {
    if (!result.traceId) continue; // nothing to attach to; counted as missing by the gate

    /**
     * Read the item's fields from `result.item`, NOT from the result itself.
     *
     * `ExperimentItemResult` is TYPED as `Pick<ExperimentItem, "input" | "expectedOutput">
     * & {...}`, but at runtime the object carries only
     * `output | evaluations | traceId | datasetRunId | item` — the declared
     * `input`/`expectedOutput` are absent. Trusting the type meant every evaluator
     * received `expectedOutput: undefined`, so each one reported NOT APPLICABLE and
     * the only score that survived was `no-crash`, the single evaluator that needs no
     * expected output. The gate then failed with `gating score "tool-contract" is
     * missing`, which reads like a broken evaluator rather than a plumbing bug.
     */
    const item = result.item as
      | { id?: string; input?: unknown; expectedOutput?: unknown; metadata?: ItemMetadata }
      | undefined;
    // `undefined` means the evaluator does not apply to this item. Those are
    // dropped rather than scored: a not-applicable check recorded as a pass would
    // pad the metric with items that tested nothing.
    const evaluations = evaluators
      .map((evaluate) =>
        evaluate({
          input: (item?.input ?? result.input) as ItemInput,
          output: result.output as TaskOutput,
          expectedOutput: (item?.expectedOutput ?? result.expectedOutput) as ExpectedOutput | undefined,
          metadata: item?.metadata,
        }),
      )
      .filter((evaluation): evaluation is Evaluation => evaluation !== undefined);

    for (const evaluation of evaluations) {
      langfuse.score.create({
        traceId: result.traceId,
        name: evaluation.name,
        value: evaluation.value,
        dataType: BOOLEAN_SCORES.has(evaluation.name) ? "BOOLEAN" : "NUMERIC",
        comment: evaluation.comment,
      });
    }

    scored.push({
      traceId: result.traceId,
      itemId: item?.id,
      scoreNames: evaluations.map((e) => e.name),
      evaluations: evaluations.map((e) => ({ name: e.name, value: e.value, comment: e.comment })),
    });
  }

  // Scores go through the ingestion queue, so they must be flushed before the gate
  // reads them back. Without this the read-back races the upload and the gate sees
  // an empty run — the exact false negative it exists to prevent.
  await langfuse.flush();
  return scored;
}

/** Resolve the prompt under test. Deliberately no fallback: a gate must know what it tested. */
async function loadPrompt(): Promise<{ text: string; name: string; version: number; label: string }> {
  const name = process.env.LANGFUSE_PROMPT_NAME ?? "weather-assistant";
  const version = arg("--version");
  const label = version ? undefined : (arg("--label") ?? "staging");
  const query = version ? `version=${encodeURIComponent(version)}` : `label=${encodeURIComponent(label!)}`;

  const response = await fetch(
    `${BASE_URL}/api/public/v2/prompts/${encodeURIComponent(name)}?${query}`,
    { headers: { Authorization: AUTH } },
  );
  if (!response.ok) {
    throw new Error(`Loading prompt ${name} (${query}) failed: ${response.status} ${await response.text()}`);
  }
  const prompt = (await response.json()) as { prompt: string; version: number; type: string };
  if (prompt.type !== "text") throw new Error(`Prompt ${name} is type "${prompt.type}"; expected text.`);

  return { text: prompt.prompt, name, version: prompt.version, label: label ?? `v${prompt.version}` };
}

export async function main(): Promise<void> {
  const prompt = await loadPrompt();
  const langfuse = new LangfuseClient();

  /**
   * Fetch through the SDK, then pass the items to `experiment.run` explicitly.
   *
   * `dataset.runExperiment` is the shorter spelling, but its type is
   * `Omit<ExperimentParams, "data">` — it always runs EVERY item and silently
   * ignores any subset you thought you selected. `--limit 3` appeared to work and
   * ran all 33.
   *
   * Passing `dataset.items` as `data` keeps the link to the dataset (they are real
   * Langfuse dataset items, which is what the linking depends on — not the calling
   * style) while letting the caller run a subset.
   */
  const dataset = await langfuse.dataset.get(DATASET_NAME);

  /**
   * Sort by item id before subsetting.
   *
   * The API returns items NEWEST FIRST, so `dataset.items.slice(0, 4)` sampled only
   * whichever category was added last — `--limit 4` quietly ran four safety items
   * and nothing else, which is exactly the kind of subset that makes a gate look
   * green. Sorting by id makes the subset deterministic and spread across
   * categories (ids are category-prefixed).
   */
  const category = arg("--category");
  const sorted = [...dataset.items].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const filtered = category
    ? sorted.filter((item) => (item.metadata as { category?: string } | undefined)?.category === category)
    : sorted;

  const limit = arg("--limit");
  // Stride rather than take-the-first-N, so a small subset still spans categories.
  const items = limit
    ? filtered.filter((_, index) => index % Math.max(1, Math.ceil(filtered.length / Number(limit))) === 0).slice(0, Number(limit))
    : filtered;
  if (items.length === 0) {
    throw new Error(`Dataset "${DATASET_NAME}" has no items. Run: npm run datasets:sync`);
  }

  // Pin the dataset version so the baseline comparison is against the same
  // questions. Without a pin, a dataset edit silently invalidates every delta.
  const datasetVersion = arg("--dataset-version") ?? process.env.EXPERIMENT_DATASET_VERSION ?? new Date().toISOString();

  console.log(`prompt   ${prompt.name} v${prompt.version} (${prompt.label})`);
  console.log(`dataset  ${DATASET_NAME} — ${items.length} of ${dataset.items.length} item(s)`);
  console.log(`env      ${EXPERIMENT_ENVIRONMENT}\n`);

  // NOT started here — `evals/experiment.ts` starts OTel before this module is
  // even imported. See the comment there: starting it at this point is too late,
  // because the Langfuse tracing layer has already resolved a tracer by the time
  // this function runs.
  const task = makeTask({
    systemPrompt: prompt.text,
    promptName: prompt.name,
    promptVersion: prompt.version,
    promptLabel: prompt.label,
  });

  // Built from the prompt actually under test, so the leak check can never drift
  // from the text that was really in context.
  const evaluators = [...DETERMINISTIC_EVALUATORS, makeInjectionResistance(prompt.text)];

  const runName = `${process.env.GITHUB_SHA?.slice(0, 7) ?? "local"}-v${prompt.version}-${Date.now()}`;
  let scored: ScoredItem[] = [];

  try {
    const result = await langfuse.experiment.run({
      name: `${prompt.name} v${prompt.version}`,
      runName,
      data: items,
      description: `${prompt.name} v${prompt.version} (${prompt.label}) against ${DATASET_NAME}`,
      metadata: {
        promptName: prompt.name,
        promptVersion: prompt.version,
        promptLabel: prompt.label,
        datasetVersion,
        gitSha: process.env.GITHUB_SHA ?? null,
        gitRef: process.env.GITHUB_REF ?? null,
      },
      task: async ({ input }) => task(input as ItemInput),
      /**
       * No `evaluators` here, deliberately.
       *
       * The SDK does run them and does upload the scores — but on this v4
       * `events_only` server those scores arrive ORPHANED: `traceId: null` and
       * `experimentId: null`. They exist, they have the right names and values, and
       * they are attached to nothing, so no query can associate them with the run
       * that produced them. A gate reading those back cannot tell one run's scores
       * from another's.
       *
       * Scoring is therefore done below, from `result.itemResults`, which carries
       * the `traceId` of each item's execution. Explicit `traceId` also lets us
       * declare `dataType` per score — the SDK ingested every boolean as NUMERIC,
       * which makes Langfuse's boolean widgets read 0/1 as a continuous metric.
       */
      maxConcurrency: Number(process.env.EXPERIMENT_CONCURRENCY ?? "4"),
    });

    console.log(await result.format());
    scored = await scoreItems(langfuse, result.itemResults, evaluators);
  } finally {
    // MUST run even when the experiment throws. Without the flush the process can
    // exit with the span buffer unsent, producing a dataset run with zero traces
    // and no error anywhere — a green-looking run that measured nothing.
    await shutdownOtel();
  }

  /**
   * Gate on what Langfuse actually STORED, not on in-memory results.
   *
   * In-memory results would pass even if every score failed to upload, and a green
   * gate over an empty run is the worst outcome available: it certifies a prompt
   * that nobody measured.
   */
  const baseline = await evaluateBaseline({
    runName,
    promptVersion: prompt.version,
    datasetVersion,
    expectedItemCount: items.length,
    scored,
    baseUrl: BASE_URL,
    auth: AUTH,
  });

  console.log(formatBaseline(baseline));
  console.log(`\nrun  ${BASE_URL}/project/~/datasets`);

  if (has("--no-gate")) {
    console.log("--no-gate: exit code suppressed.");
    return;
  }
  process.exitCode = baseline.passed ? 0 : 1;
}
