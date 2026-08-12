/**
 * Shared loader for the git-side prompt sources in `prompts/`.
 *
 * `prompts/` is the source of truth; Langfuse holds the deployed copies.
 * `git log prompts/` is therefore the prompt changelog, and a code review is
 * the review step for a prompt change.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `prompts/` lives beside `scripts/`, so resolve relative to this file. */
export const PROMPTS_DIR = fileURLToPath(new URL("../../prompts/", import.meta.url));

export interface PromptSource {
  /** Langfuse prompt name. Also the filename stem, minus the `.text`/`.chat` part. */
  name: string;
  type: "text" | "chat";
  /** String for text prompts; message array for chat prompts. */
  prompt: unknown;
  /** Arbitrary JSON travelling with the version. Used by evaluators, not by the model. */
  config: Record<string, unknown>;
  tags: string[];
  commitMessage?: string;
  /** Source filename, for error messages. */
  file: string;
}

/**
 * Reads every `prompts/*.{text,chat}.json`.
 *
 * The type lives in the FILENAME rather than only in the JSON body because a
 * prompt's type is immutable in Langfuse once created — you cannot convert a
 * text prompt to a chat prompt later. Encoding it in the filename makes an
 * attempted change a visible rename in review rather than a one-character diff
 * that fails at the API.
 */
export function loadPromptSources(): PromptSource[] {
  const files = readdirSync(PROMPTS_DIR)
    .filter((f) => /\.(text|chat)\.json$/.test(f))
    .sort();

  return files.map((file) => {
    const raw = JSON.parse(readFileSync(join(PROMPTS_DIR, file), "utf8")) as Record<string, unknown>;
    const fileType = /\.chat\.json$/.test(file) ? "chat" : "text";

    if (raw.type !== fileType) {
      throw new Error(
        `${file}: "type" is "${String(raw.type)}" but the filename says "${fileType}".\n` +
          `  A prompt's type is immutable in Langfuse. Rename the file rather than editing "type".`,
      );
    }
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw new Error(`${file}: "name" is required.`);
    }
    if (fileType === "text" && typeof raw.prompt !== "string") {
      throw new Error(`${file}: a text prompt's "prompt" must be a string.`);
    }
    if (fileType === "chat" && !Array.isArray(raw.prompt)) {
      throw new Error(`${file}: a chat prompt's "prompt" must be an array of messages.`);
    }
    if ("labels" in raw && Array.isArray(raw.labels) && raw.labels.length > 0) {
      // Labels are deployment state, not source state. If sync wrote them, every
      // `git push` would silently redeploy to production, which is exactly the
      // uncontrolled change this whole layer exists to prevent.
      throw new Error(
        `${file}: "labels" must be empty. Labels are moved only by scripts/promote-prompt.ts.`,
      );
    }

    return {
      name: raw.name,
      type: fileType,
      prompt: raw.prompt,
      config: (raw.config as Record<string, unknown>) ?? {},
      tags: (raw.tags as string[]) ?? [],
      commitMessage: raw.commitMessage as string | undefined,
      file,
    };
  });
}

/**
 * Stable content fingerprint of the parts of a prompt that define BEHAVIOUR.
 *
 * Covers `prompt` and `config` only. Deliberately excludes:
 *   - `labels`, which are deployment state owned by promote-prompt.ts
 *   - `tags` and `commitMessage`, which are metadata about a version rather
 *     than the version's content
 *
 * This function is the reason sync is idempotent. Without it, every CI run
 * would create a new prompt version: the version history would fill with
 * identical entries, "which version is live?" would stop being answerable
 * from the history, and each spurious version would fire the
 * prompt-version-created automation — which auto-disables itself after five
 * consecutive delivery failures, silently.
 *
 * JSON.stringify is not canonical (key order follows insertion order), so keys
 * are sorted recursively first. Otherwise a cosmetic reordering in the source
 * file would read as a behaviour change.
 */
export function contentHash(source: Pick<PromptSource, "prompt" | "config">): string {
  const canonical = JSON.stringify(sortKeys({ prompt: source.prompt, config: source.config }));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
  );
}
