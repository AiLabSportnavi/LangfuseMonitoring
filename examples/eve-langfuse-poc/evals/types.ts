/**
 * Shared shapes for the experiment runner and its evaluators.
 *
 * Kept in one place because the dataset's `expectedOutput` is a CONTRACT, and a
 * contract that each evaluator interprets slightly differently is not a contract.
 */

/** One user/assistant message from a dataset item's `input`. */
export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ItemInput {
  messages: Message[];
}

/** A tool call the agent actually made, captured by the task. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Present when the tool threw. */
  error?: string;
  result?: unknown;
}

/**
 * What the task returns, and therefore what every evaluator sees.
 *
 * The tool calls are the important half. Text-only evaluation cannot distinguish
 * "answered correctly from the tool" from "answered correctly from the model's own
 * weights while ignoring its instructions" — and the second is a prompt failure
 * that will silently spread.
 */
export interface TaskOutput {
  text: string;
  toolCalls: ToolCall[];
  /** Set when the turn itself threw, rather than the model answering badly. */
  crashed?: string;
  /** Resolved prompt provenance, so a run is attributable to a version. */
  promptName: string;
  promptVersion: number;
  promptLabel: string;
}

/** The contract a dataset item asserts. Every field is optional. */
export interface ExpectedOutput {
  mode?: "answer" | "refusal" | "clarify";
  mustMentionAll?: string[];
  mustMentionAny?: string[];
  mustNotMention?: string[];
  /** `"*"` means no tool may be called at all. */
  forbiddenTools?: string[];
  expectedTools?: { name: string; args?: Record<string, unknown>; count?: number }[];
  maxToolCalls?: number;
  maxSentences?: number;
  /** The output must parse as JSON (a fenced code block is tolerated). */
  isJson?: boolean;
  /** Reference answer for the LLM judges. Never shown to the task. */
  groundTruth?: string;
}

export interface ItemMetadata {
  category: string;
  /** `gate` blocks a promotion; `soft` is recorded but never fails the build. */
  severity: "gate" | "soft";
  rationale?: string;
}

/**
 * What an evaluator returns. Mirrors the Langfuse `Evaluation` shape.
 *
 * `undefined` means NOT APPLICABLE to this item, and is very different from a pass.
 * An evaluator that returns 1.0 when it had nothing to check inflates its own mean
 * with free passes: `tool-contract` scored a perfect 1.000 on a prompt explicitly
 * told never to call a tool, because the sampled items happened to declare no
 * expected tools. Not-applicable results are excluded from the denominator instead.
 */
export interface Evaluation {
  name: string;
  value: number;
  comment?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluatorArgs {
  input: ItemInput;
  output: TaskOutput;
  expectedOutput?: ExpectedOutput;
  metadata?: ItemMetadata;
}

export type Evaluator = (args: EvaluatorArgs) => Evaluation | undefined;
