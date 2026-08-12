/**
 * The thing under test: the managed prompt, the real tools, the real model.
 *
 * WHY THIS CALLS THE MODEL DIRECTLY INSTEAD OF DRIVING AN eve SERVER
 *
 * A prompt-regression gate should isolate the variable it is gating on. What a
 * prompt change can break is the instructions, the tool contract, and the answer —
 * all of which this exercises with the same prompt text and the same tool
 * implementations the agent uses. What it cannot break is eve's durability,
 * channels or session handling, so routing every item through a live eve server
 * would add a server boot, more latency and more flakiness per run without
 * covering any additional failure mode of a prompt edit.
 *
 * eve's harness is still tested — by `evals/trace-smoke.eval.ts`, which drives a
 * real server and is what `verify:prompt-link` reads back. The two are
 * complementary: this file catches "the new prompt stopped calling the tool", the
 * smoke eval catches "instrumentation broke". Neither substitutes for the other.
 *
 * The tools are imported from `agent/tools/` rather than reimplemented, so a change
 * to a tool cannot silently diverge from what the gate believes it does.
 */

import { generateText, tool, stepCountIs } from "ai";

import getForecast from "../agent/tools/get_forecast.ts";
import getWeather from "../agent/tools/get_weather.ts";
import { resolveModel } from "../agent/model.ts";
import type { ItemInput, TaskOutput, ToolCall } from "./types.ts";

/**
 * Hard cap on the agentic loop.
 *
 * Without it, an item that provokes a retry loop against a deterministically
 * failing tool (the `toolfail-*` items do exactly that) runs until the provider
 * cuts it off, turning one bad item into a multi-minute run. The `tool-contract`
 * evaluator asserts the tighter per-item budget; this is the backstop.
 */
const MAX_STEPS = Number(process.env.EXPERIMENT_MAX_STEPS ?? "6");

/**
 * eve's `defineTool` objects are not AI SDK tools, so unwrap them.
 *
 * Only `inputSchema`, `description` and `execute` are needed, and all three are the
 * same objects eve uses — importing them is what keeps the gate honest about what
 * the tools actually do (including `get_forecast` throwing for unsupported cities,
 * which several dataset items depend on).
 */
function asAiSdkTools(record: ToolCall[]) {
  const wrap = (name: string, definition: { description?: string; inputSchema: unknown; execute: (args: never) => unknown }) =>
    tool({
      description: definition.description,
      inputSchema: definition.inputSchema as never,
      execute: async (args: Record<string, unknown>) => {
        // Record the call BEFORE executing, so a throwing tool still appears in the
        // transcript. A tool that fails and leaves no trace makes the failure look
        // like the model simply choosing not to call it.
        const entry: ToolCall = { name, args };
        record.push(entry);
        try {
          const result = await (definition.execute as (a: unknown) => unknown)(args);
          entry.result = result;
          return result;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          // Rethrow: the model must see the failure and decide what to say about it,
          // which is exactly what the tool-use-failure items are testing.
          throw error;
        }
      },
    });

  return {
    get_weather: wrap("get_weather", getWeather as never),
    get_forecast: wrap("get_forecast", getForecast as never),
  };
}

export interface TaskDeps {
  systemPrompt: string;
  promptName: string;
  promptVersion: number;
  promptLabel: string;
}

/**
 * Build the task the experiment runs per dataset item.
 *
 * The prompt is injected rather than resolved inside, so the caller controls which
 * version is under test — that is what makes "run the dataset against version N"
 * possible at all, and it keeps the task free of hidden global state.
 */
export function makeTask(deps: TaskDeps) {
  const model = resolveModel();

  return async function runItem(input: ItemInput): Promise<TaskOutput> {
    const toolCalls: ToolCall[] = [];
    const base = {
      promptName: deps.promptName,
      promptVersion: deps.promptVersion,
      promptLabel: deps.promptLabel,
    };

    try {
      const result = await generateText({
        model,
        system: deps.systemPrompt,
        messages: input.messages,
        tools: asAiSdkTools(toolCalls),
        stopWhen: stepCountIs(MAX_STEPS),
        temperature: 0,
        // No `experimental_telemetry` — that option was REMOVED in AI SDK v7
        // (pitfall #1). Telemetry is opt-OUT via `telemetry: { isEnabled: false }`
        // once `registerTelemetry()` has run, which `evals/otel.ts` does.
      });

      return { ...base, text: result.text, toolCalls };
    } catch (error) {
      // A thrown turn is a RESULT, not a reason to abort the run: the `no-crash`
      // evaluator scores it, and losing the other 32 items because one crashed
      // would make the gate useless on exactly the inputs it exists to police.
      return {
        ...base,
        text: "",
        toolCalls,
        crashed: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
