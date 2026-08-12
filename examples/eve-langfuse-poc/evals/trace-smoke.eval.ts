import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

/**
 * One real turn through the real agent, so a real trace lands in Langfuse.
 *
 * This exists to feed `npm run verify:prompt-link`, which reads the trace back
 * and asserts the managed prompt is linked. The two halves are useless apart:
 * this eval proves the agent answers, and the read-back proves the trace says
 * which prompt version produced that answer.
 *
 * Kept deliberately minimal. It is not a quality check — the dataset and the
 * Langfuse experiment do that. It is a wire check: instructions resolved from
 * Langfuse, tool dispatched, span exported, prompt linked.
 */
export default defineEval({
  async test(t) {
    await t.send("What's the weather in Berlin?");

    // The run completed at all. Without this, a failed turn that still produced
    // a trace would pass the read-back and look fine.
    t.succeeded();

    // The tool was actually called. A model answering "19 degrees" from its own
    // weights rather than from the tool would satisfy a text check and mean the
    // instructions were never applied.
    t.calledTool("get_weather");

    // 19 is Berlin's fixed value in the tool table, so this also confirms the
    // tool RESULT reached the answer rather than just the tool being invoked.
    t.check(t.reply, includes("19"));
  },
});
