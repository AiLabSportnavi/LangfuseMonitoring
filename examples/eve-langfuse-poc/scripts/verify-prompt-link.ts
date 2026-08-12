/**
 * Read traces back out of Langfuse and assert the managed prompt is LINKED, not
 * merely mentioned.
 *
 * Run after producing a trace:
 *   npx eve eval trace-smoke && npm run verify:prompt-link
 *
 * WHY THIS IS A SEPARATE CHECK FROM verify-traces.ts
 *
 * Prompt linking failed three distinct ways while being built, and every one of
 * them produced a working agent, a passing eval, and a trace that looked right:
 *
 *   1. `metadata.langfusePrompt` (what the docs recommend for the Vercel AI SDK)
 *      does not exist in SDK v5 — it writes metadata and links nothing.
 *   2. The prompt cache lived in module scope, and eve bundles instrumentation
 *      separately from the agent runtime, so the reader got a second, empty copy.
 *   3. The attribute was set from runtime context, which lands on the AGENT span —
 *      but Langfuse honours the link on GENERATIONS only, and span attributes are
 *      not inherited by children.
 *
 * The only assertion that would have caught all three is the one below: does the
 * server return a resolved `promptId` on a generation. Metadata presence proves
 * nothing.
 */

const WINDOW_MINUTES = Number(process.env.VERIFY_WINDOW_MINUTES ?? "15");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}
const BASE_URL = required("LANGFUSE_BASE_URL");
const AUTH =
  "Basic " +
  Buffer.from(`${required("LANGFUSE_PUBLIC_KEY")}:${required("LANGFUSE_SECRET_KEY")}`).toString("base64");

interface Generation {
  id: string;
  name: string;
  traceId: string;
  startTime: string;
  promptId?: string | null;
  promptName?: string | null;
  promptVersion?: number | null;
  metadata?: unknown;
}

function metadataOf(observation: Generation): Record<string, unknown> {
  const raw = observation.metadata;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (raw as Record<string, unknown>) ?? {};
}

async function fetchGenerations(): Promise<Generation[]> {
  const from = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  // `prompt` is NOT in the default field set — only `core` and `basic` are. Asking
  // for core+basic and reading promptName returns "" for every observation,
  // which is indistinguishable from an unlinked prompt. Same trap as pitfall #12
  // for input/output.
  const url =
    `${BASE_URL}/api/public/v2/observations?fromStartTime=${from}` +
    `&type=GENERATION&limit=100&fields=core,basic,prompt,metadata&expandMetadata=true`;

  const response = await fetch(url, { headers: { Authorization: AUTH } });
  if (response.status === 401) {
    throw new Error("401 Unauthorized — bad or missing API keys. There is no allowlist to blame (pitfall #16).");
  }
  if (!response.ok) throw new Error(`GET observations -> ${response.status} ${await response.text()}`);
  return ((await response.json()) as { data: Generation[] }).data;
}

/** Confirms the linked version actually exists, rather than trusting the id. */
async function promptVersionExists(name: string, version: number): Promise<boolean> {
  const url = `${BASE_URL}/api/public/v2/prompts/${encodeURIComponent(name)}?version=${version}`;
  const response = await fetch(url, { headers: { Authorization: AUTH } });
  return response.ok;
}

function check(label: string, passed: boolean, detail: string): boolean {
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  return passed;
}

async function main(): Promise<void> {
  const all = await fetchGenerations();

  /**
   * Scope to the MOST RECENT trace, not to the whole time window.
   *
   * The window necessarily contains history, and history contains traces produced
   * before whatever fix is being verified. Asserting across the window makes the
   * result depend on how recently someone last ran a broken build — the check
   * fails for a reason that is not the code under test, which is worse than no
   * check because it trains people to ignore it.
   *
   * Override with VERIFY_ALL_TRACES=1 to audit the whole window instead, which is
   * the right mode for "is production linking prompts at all".
   */
  const auditAll = process.env.VERIFY_ALL_TRACES === "1";
  let generations = all;

  if (!auditAll && all.length > 0) {
    const newest = [...all].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0]!;
    generations = all.filter((g) => g.traceId === newest.traceId);
    const skipped = all.length - generations.length;
    console.log(
      `Scoped to the most recent trace ${newest.traceId} ` +
        `(${generations.length} generation(s)${skipped > 0 ? `; ignored ${skipped} from older traces` : ""}).`,
    );
    console.log(`Set VERIFY_ALL_TRACES=1 to audit every trace in the last ${WINDOW_MINUTES} minutes instead.\n`);
  }

  if (generations.length === 0) {
    console.error(
      `No GENERATION observations in the last ${WINDOW_MINUTES} minutes.\n` +
        `  Produce a trace first:  npx eve eval trace-smoke\n` +
        `  Ingestion is queued, so allow a few seconds before reading back.`,
    );
    process.exitCode = 1;
    return;
  }

  const linked = generations.filter((g) => g.promptId);
  const fellBack = generations.filter((g) => metadataOf(g).promptIsFallback === true);
  const versions = new Set(generations.map((g) => g.promptVersion).filter((v): v is number => typeof v === "number"));

  let ok = true;

  ok =
    check(
      "every generation carries a resolved prompt link",
      linked.length === generations.length,
      `${linked.length}/${generations.length} have a promptId`,
    ) && ok;

  // The distinction that matters: metadata is self-reported by our own enricher,
  // promptId is Langfuse resolving the name+version to a real Prompt row. Only the
  // second one means the UI renders a clickable link.
  const metadataOnly = generations.filter((g) => !g.promptId && metadataOf(g).promptName);
  ok =
    check(
      "no generation has prompt metadata WITHOUT a link",
      metadataOnly.length === 0,
      metadataOnly.length === 0
        ? "metadata and link agree"
        : `${metadataOnly.length} generation(s) claim a prompt in metadata but have no promptId — the classic silent failure`,
    ) && ok;

  ok =
    check(
      "no generation ran on the bundled fallback",
      fellBack.length === 0,
      fellBack.length === 0 ? "all used a managed prompt" : `${fellBack.length} used the fallback`,
    ) && ok;

  // More than one version in the window is not necessarily wrong — a rollout can
  // straddle it — so this warns rather than fails.
  if (versions.size > 1) {
    console.log(`  warn  more than one prompt version in the window: ${[...versions].map((v) => `v${v}`).join(", ")}`);
  }

  for (const version of versions) {
    const name = generations.find((g) => g.promptVersion === version)?.promptName ?? "";
    // eslint-disable-next-line no-await-in-loop -- at most a couple of versions
    const exists = await promptVersionExists(name, version);
    ok = check(`linked version resolves in Langfuse`, exists, `${name} v${version}`) && ok;
  }

  console.log(
    ok
      ? `\nPASS: ${generations.length} generation(s) linked to a managed prompt (${[...versions].map((v) => `v${v}`).join(", ")}).`
      : "\nFAIL: prompt linking is not intact. Metadata presence is not evidence — a generation needs a resolved promptId.",
  );
  process.exitCode = ok ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`\nverify-prompt-link failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
