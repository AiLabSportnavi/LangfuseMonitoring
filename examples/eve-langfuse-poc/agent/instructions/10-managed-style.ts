/**
 * The Langfuse-managed STYLE layer, resolved per session.
 *
 * HOW eve ASSEMBLES THE SYSTEM PROMPT
 *
 * eve reads the root `agent/instructions.md` AND this directory, concatenating the
 * root file FIRST and then the directory entries in `localeCompare` order
 * (`node_modules/eve/docs/instructions.mdx`). So the final system prompt is:
 *
 *     agent/instructions.md            core rules — local, stable, always present
 *     + this file's resolved markdown  style layer — versioned in Langfuse
 *
 * That concatenation is the DESIGN, not a hazard — but only because the two layers
 * hold different content. Duplicating anything between them emits it twice in every
 * prompt, which is why `agent/instructions.md` carries no styling rules and the
 * Langfuse prompt carries no tool or safety rules.
 *
 * WHY `defineDynamic` AND NOT A STATIC `defineInstructions`
 *
 * A module-backed static instructions file runs ONCE AT BUILD TIME and is baked into
 * the compiled manifest — eve never re-runs it. That would pin one prompt version
 * into the build and defeat the point of managing prompts in Langfuse: changing a
 * prompt would require a redeploy. Only a `defineDynamic` resolver runs per session.
 *
 * FAILURE BEHAVIOUR
 *
 * `resolvePrompt()` never throws. If Langfuse is unreachable, or the prompt was
 * deleted, or someone saved something broken, this contributes the small bundled
 * style default instead — and the agent still has every core rule from
 * `agent/instructions.md`. A mistake in the Langfuse UI cannot make the agent
 * unusable; at worst it changes the tone.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolvePrompt } from "../lib/prompt.ts";

export default defineDynamic({
  events: {
    /**
     * Resolved once per session rather than per turn.
     *
     * A long-lived session therefore keeps the prompt version it started with, even
     * if `production` moves underneath it. That is intended: swapping the system
     * prompt mid-conversation makes the agent's earlier turns inconsistent with its
     * instructions and makes the trace impossible to attribute to one version.
     */
    "session.started": async () => {
      const prompt = await resolvePrompt();
      return defineInstructions({ markdown: prompt.markdown });
    },
  },
});
