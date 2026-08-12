/**
 * Guards the two-layer instruction architecture.
 *
 *   npm run verify:instructions
 *
 * eve builds the system prompt by concatenating `agent/instructions.md` with every
 * entry in `agent/instructions/`, root file first. That concatenation is the design
 * — but it means any text present in BOTH layers is emitted twice in every prompt,
 * and a doubled system prompt makes the agent behave *almost* normally, which is the
 * hardest kind of bug to notice.
 *
 * This asserts the split holds:
 *
 *   agent/instructions.md   core rules   local, stable, must always exist
 *   Langfuse prompt         style layer  versioned, safe to lose
 *
 * It is a static check on purpose. It needs no model call, so it can run before any
 * agent is started and it cannot be flaky.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPromptSources } from "./lib/prompt-source.ts";

const INSTRUCTIONS_MD = fileURLToPath(new URL("../agent/instructions.md", import.meta.url));
const INSTRUCTIONS_DIR = fileURLToPath(new URL("../agent/instructions/", import.meta.url));

/** Comments and blank lines carry no prompt text, so they cannot duplicate anything. */
function meaningfulLines(markdown: string): string[] {
  const withoutHtmlComments = markdown.replace(/<!--[\s\S]*?-->/g, "");
  return withoutHtmlComments
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 12 && !line.startsWith("<!--"));
}

function check(label: string, passed: boolean, detail: string): boolean {
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return passed;
}

function main(): void {
  let ok = true;

  // 1. The local core must exist. This is the property that stops Langfuse becoming
  //    a single point of failure, so its absence is the most serious failure here.
  const corePresent = existsSync(INSTRUCTIONS_MD);
  ok = check(
    "agent/instructions.md exists",
    corePresent,
    corePresent ? "core rules ship with the code" : "MISSING — the agent has no local instructions",
  ) && ok;
  if (!corePresent) {
    process.exitCode = 1;
    return;
  }

  const core = readFileSync(INSTRUCTIONS_MD, "utf8");
  const coreLines = meaningfulLines(core);

  // 2. The core must actually carry the rules the agent cannot lose. A file that
  //    exists but has been hollowed out passes an existence check and fails the point.
  const hasToolRule = /get_weather/.test(core);
  const hasHonestyRule = /unknown|inventing|placeholder/i.test(core);
  const hasBoundaryRule = /do not reveal|decline/i.test(core);
  ok = check(
    "core carries tool, honesty and boundary rules",
    hasToolRule && hasHonestyRule && hasBoundaryRule,
    `tools=${hasToolRule} honesty=${hasHonestyRule} boundaries=${hasBoundaryRule}`,
  ) && ok;

  // 3. The managed layer must NOT restate the core.
  const sources = loadPromptSources();
  const managed = sources.find((s) => s.name === (process.env.LANGFUSE_PROMPT_NAME ?? "weather-assistant"));
  ok = check("managed prompt source exists in prompts/", managed !== undefined, managed?.file ?? "not found");

  if (managed && typeof managed.prompt === "string") {
    const managedLines = meaningfulLines(managed.prompt);
    const overlap = managedLines.filter((line) => coreLines.includes(line));
    ok = check(
      "no line appears in BOTH layers",
      overlap.length === 0,
      overlap.length === 0
        ? "layers are disjoint"
        : `${overlap.length} duplicated line(s), e.g. "${overlap[0]?.slice(0, 60)}…" — would be emitted twice per prompt`,
    ) && ok;

    // 4. The managed layer must not smuggle safety or tool rules back in. Those
    //    belong locally: a prompt edit in the UI must not be able to change them.
    const managedText = managed.prompt.toLowerCase();
    const leakedGovernance = ["get_weather", "get_forecast", "do not reveal", "decline"].filter((needle) =>
      managedText.includes(needle),
    );
    ok = check(
      "managed layer holds no tool or safety rules",
      leakedGovernance.length === 0,
      leakedGovernance.length === 0
        ? "style only"
        : `found ${JSON.stringify(leakedGovernance)} — these must stay in agent/instructions.md`,
    ) && ok;
  }

  // 5. Exactly one dynamic resolver, so there is one managed layer rather than several
  //    competing ones.
  const dirEntries = existsSync(INSTRUCTIONS_DIR)
    ? readFileSync(new URL("../agent/instructions/10-managed-style.ts", import.meta.url), "utf8")
    : "";
  ok = check(
    "managed layer is wired through a dynamic resolver",
    dirEntries.includes("defineDynamic") && dirEntries.includes("resolvePrompt"),
    dirEntries ? "agent/instructions/10-managed-style.ts" : "resolver missing",
  ) && ok;

  console.log(
    ok
      ? "\nPASS: core instructions are local and intact; the Langfuse layer adds style only."
      : "\nFAIL: the instruction split is broken — see above.",
  );
  process.exitCode = ok ? 0 : 1;
}

main();
