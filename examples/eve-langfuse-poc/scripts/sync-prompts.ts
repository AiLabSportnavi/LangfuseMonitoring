/**
 * Push `prompts/*.json` into Langfuse, creating a version only when the content
 * actually changed.
 *
 *   npm run prompts:check   # exit 1 if Langfuse is behind git (PR gate)
 *   npm run prompts:sync    # create the missing versions
 *
 * This script NEVER moves a label. Creating a version is not a deployment; the
 * new version is reachable only by `latest` or by explicit version number until
 * scripts/promote-prompt.ts points an environment label at it.
 */

import { LangfuseClient } from "@langfuse/client";

import { contentHash, loadPromptSources, type PromptSource } from "./lib/prompt-source.ts";

const CHECK_ONLY = process.argv.includes("--check");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}

/**
 * The SDK reads these from the environment itself, but read them here too so a
 * missing variable fails with a clear message instead of a 401 that reads like
 * a revoked key. Pitfall #16: a 401 is always credentials — there is no network
 * policy left to blame.
 */
const BASE_URL = required("LANGFUSE_BASE_URL");
const AUTH =
  "Basic " +
  Buffer.from(`${required("LANGFUSE_PUBLIC_KEY")}:${required("LANGFUSE_SECRET_KEY")}`).toString("base64");

/**
 * Constructed lazily, and only on the write path: `--check` mode does no writes,
 * so CI never needs credentials to be accepted by the SDK, only by the reads.
 */
let client: LangfuseClient | undefined;
function writeClient(): LangfuseClient {
  client ??= new LangfuseClient();
  return client;
}

interface Comparison {
  source: PromptSource;
  action: "unchanged" | "create-version" | "create-first";
  liveVersion?: number;
  liveHash?: string;
  sourceHash: string;
}

/**
 * Compare git against the `latest` label rather than against `production`.
 *
 * `latest` is the newest version that exists; `production` is whatever is
 * deployed and is usually intentionally older. Diffing against `production`
 * would report drift on every prompt awaiting promotion and re-create a version
 * that already exists.
 */
async function compare(source: PromptSource): Promise<Comparison> {
  const sourceHash = contentHash(source);

  // Read over plain fetch rather than langfuse.prompt.get(). Two reasons, both
  // learned the hard way here:
  //   1. A first-run 404 is EXPECTED, and the SDK treats it as an error worth
  //      dumping the whole Response object to stderr — burying the one line of
  //      output that matters behind 30 lines of headers.
  //   2. Constructing the SDK client for a read left a libuv handle open and the
  //      process aborted on exit (UV_HANDLE_CLOSING) on Windows.
  // The SDK is still used for the write, where its typing earns its keep.
  const url = `${BASE_URL}/api/public/v2/prompts/${encodeURIComponent(source.name)}?label=latest`;
  const response = await fetch(url, { headers: { Authorization: AUTH } });

  // A prompt that has never been created 404s. Any other failure is real and
  // must not be misread as "absent", which would create a duplicate v1.
  if (response.status === 404) return { source, action: "create-first", sourceHash };
  if (!response.ok) {
    throw new Error(`Reading prompt "${source.name}" failed: ${response.status} ${await response.text()}`);
  }

  const live = (await response.json()) as {
    version: number;
    prompt: unknown;
    config?: Record<string, unknown>;
  };

  const liveHash = contentHash({
    prompt: live.prompt,
    config: live.config ?? {},
  });

  return {
    source,
    action: liveHash === sourceHash ? "unchanged" : "create-version",
    liveVersion: live.version,
    liveHash,
    sourceHash,
  };
}

async function main(): Promise<void> {
  const sources = loadPromptSources();
  if (sources.length === 0) {
    console.error("No prompt sources found in prompts/. Nothing to do.");
    process.exit(1);
  }

  const comparisons = await Promise.all(sources.map(compare));
  const drifted = comparisons.filter((c) => c.action !== "unchanged");

  for (const c of comparisons) {
    const at = c.liveVersion !== undefined ? ` (live v${c.liveVersion})` : "";
    if (c.action === "unchanged") console.log(`  unchanged     ${c.source.name}${at}`);
    if (c.action === "create-first") console.log(`  NEW           ${c.source.name} — not in Langfuse yet`);
    if (c.action === "create-version") {
      console.log(`  DRIFT         ${c.source.name}${at}: ${c.liveHash} -> ${c.sourceHash}`);
    }
  }

  if (drifted.length === 0) {
    console.log("\nLangfuse matches prompts/. No versions created.");
    return;
  }

  if (CHECK_ONLY) {
    console.error(
      `\n${drifted.length} prompt(s) differ from Langfuse.\n` +
        `  Run: npm run prompts:sync\n` +
        `  Then commit nothing — sync only pushes; the source file is already correct.`,
    );
    // Set exitCode rather than calling process.exit(): killing the process while
    // undici still holds a keep-alive socket aborts it on Windows
    // (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), turning a clean
    // exit 1 into a 127. A CI gate that reports 127 is a gate reporting the wrong
    // reason — and the same crash fires on the PASSING path. Same lesson as
    // verify-traces.ts:448; do not "simplify" this back to process.exit().
    process.exitCode = 1;
    return;
  }

  for (const { source, liveVersion } of drifted) {
    const created = await writeClient().prompt.create({
      name: source.name,
      type: source.type,
      prompt: source.prompt,
      config: source.config,
      tags: source.tags,
      commitMessage: source.commitMessage,
      // No labels, on purpose. See the module comment.
      labels: [],
    } as never);

    const from = liveVersion !== undefined ? ` (was v${liveVersion})` : "";
    console.log(`\ncreated ${source.name} v${created.version}${from} — carries no environment label yet.`);
    console.log(`  promote with: npm run prompts:promote -- --name ${source.name} --version ${created.version} --to staging`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nsync-prompts failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1; // not process.exit() — see the note in main()
});
