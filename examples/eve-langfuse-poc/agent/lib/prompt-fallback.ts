/**
 * Fallback for the Langfuse-managed STYLE layer only.
 *
 * WHAT THIS IS NOT
 *
 * This is not a copy of the agent's instructions. The agent's core rules — tool
 * usage, honesty, boundaries — live in `agent/instructions.md`, ship with the code,
 * and are always loaded. That is the property that keeps Langfuse from becoming a
 * single point of failure: if this managed layer is missing, the agent's BEHAVIOUR
 * is unchanged and only its presentation reverts to the default below.
 *
 * An earlier revision duplicated the whole prompt here. That was wrong twice over:
 * it made a Langfuse outage a behavioural change, and because eve concatenates
 * `instructions.md` with `agent/instructions/`, any overlap between the two is
 * emitted twice in every system prompt.
 *
 * Keep this SHORT. It exists so that a first-ever cold start with Langfuse
 * unreachable still produces sensibly formatted answers — nothing more. It is
 * deliberately not kept in sync with the managed prompt: a fallback that tracked
 * the thing it is a fallback for would be no fallback at all.
 */
export const FALLBACK_MARKDOWN = `## Response style

- Answer in one or two short sentences. Lead with the number the user asked for.
- Give temperatures in Celsius unless the user asks for another unit.
`;
