/**
 * Move an environment label onto a prompt version. The ONLY thing in this repo
 * that changes what is deployed.
 *
 *   promote-prompt.ts --name weather-assistant --version 7 --to staging
 *   promote-prompt.ts --name weather-assistant --from staging --to production
 *   promote-prompt.ts --name weather-assistant --from rollback --to production
 *   promote-prompt.ts --name weather-assistant --show
 *
 * `--from <label>` resolves the version currently carrying that label, so a
 * promotion means "whatever passed staging" rather than a hand-typed integer.
 * Typing the number is how you promote the version you happened to be looking
 * at instead of the one that was actually tested.
 *
 * Protected prompt labels are an Enterprise feature and this deployment is OSS,
 * so nothing server-side prevents someone moving `production` by hand in the UI.
 * The guardrails below are conventions this script enforces, not permissions.
 * That is worth stating plainly rather than implying the label is locked.
 */

import { LangfuseClient } from "@langfuse/client";

/** Labels this script will move. `latest` is assigned by Langfuse and is not promotable. */
const PROMOTABLE = new Set(["dev", "staging", "production", "rollback"]);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (flag: string): boolean => process.argv.includes(flag);

const name = arg("--name");
const to = arg("--to");
const from = arg("--from");
const explicitVersion = arg("--version");
const showOnly = has("--show");

if (!name) {
  console.error("--name is required. Try --show to list current labels.");
  process.exit(1);
}

const langfuse = new LangfuseClient();
const baseUrl = process.env.LANGFUSE_BASE_URL;
const auth =
  "Basic " +
  Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");

/**
 * Resolve which version carries a label.
 *
 * Uses the REST endpoint rather than the SDK because the SDK's typed client
 * caches by design and a stale read here would move a label onto the wrong
 * version — the one failure mode this script must not have.
 */
async function versionForLabel(label: string): Promise<number | undefined> {
  const url = `${baseUrl}/api/public/v2/prompts/${encodeURIComponent(name!)}?label=${encodeURIComponent(label)}`;
  const response = await fetch(url, { headers: { Authorization: auth } });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { version: number }).version;
}

async function currentLabels(): Promise<Record<string, number | undefined>> {
  const entries = await Promise.all(
    ["latest", ...PROMOTABLE].map(async (l) => [l, await versionForLabel(l)] as const),
  );
  return Object.fromEntries(entries);
}

async function main(): Promise<void> {
  if (showOnly) {
    const labels = await currentLabels();
    console.log(`\n${name}`);
    for (const [label, version] of Object.entries(labels)) {
      console.log(`  ${label.padEnd(12)} ${version === undefined ? "—" : `v${version}`}`);
    }
    return;
  }

  if (!to) {
    console.error("--to <label> is required (dev | staging | production | rollback).");
    process.exit(1);
  }
  if (!PROMOTABLE.has(to)) {
    console.error(`--to must be one of: ${[...PROMOTABLE].join(", ")}. Got "${to}".`);
    process.exit(1);
  }
  if (!from && !explicitVersion) {
    console.error("Provide either --from <label> (preferred) or --version <n>.");
    process.exit(1);
  }

  // Resolve the target version.
  let version: number;
  if (from) {
    const resolved = await versionForLabel(from);
    if (resolved === undefined) {
      console.error(`No version carries the label "${from}", so there is nothing to promote.`);
      process.exitCode = 1;
      return;
    }
    version = resolved;
    console.log(`resolved --from ${from} -> v${version}`);
  } else {
    version = Number(explicitVersion);
    if (!Number.isInteger(version) || version < 1) {
      console.error(`--version must be a positive integer. Got "${explicitVersion}".`);
      process.exit(1);
    }
  }

  const before = await currentLabels();

  if (before[to] === version) {
    console.log(`\n${name} ${to} is already v${version}. Nothing to do.`);
    return;
  }

  // Promoting to production pins the OUTGOING version as `rollback` first, so a
  // revert is one command and needs no version archaeology at 3am. Done before
  // the promotion: if the promotion fails, the rollback pointer is still valid.
  if (to === "production" && before.production !== undefined && before.production !== version) {
    await setLabel(before.production, "rollback");
    console.log(`pinned rollback -> v${before.production} (the outgoing production version)`);
  }

  await setLabel(version, to);
  console.log(`\n${name} ${to} -> v${version}`);

  if (to === "production") {
    console.log(`\nrollback with: npm run prompts:promote -- --name ${name} --from rollback --to production`);
  }
}

/**
 * Apply a label to a version.
 *
 * `prompt.update` REPLACES the label set on the target version, so the existing
 * labels must be read and merged. Sending only the new label would strip
 * `staging` off a version being promoted to `production` — which silently
 * un-deploys staging as a side effect of deploying production.
 */
async function setLabel(version: number, label: string): Promise<void> {
  const url = `${baseUrl}/api/public/v2/prompts/${encodeURIComponent(name!)}?version=${version}`;
  const response = await fetch(url, { headers: { Authorization: auth } });
  if (!response.ok) {
    throw new Error(`Reading ${name} v${version} failed: ${response.status} ${await response.text()}`);
  }
  const existing = ((await response.json()) as { labels?: string[] }).labels ?? [];

  // `latest` is managed by Langfuse; echoing it back is meaningless at best.
  const merged = [...new Set([...existing.filter((l) => l !== "latest"), label])];

  await langfuse.prompt.update({ name: name!, version, newLabels: merged });
}

main().catch((error: unknown) => {
  console.error(`\npromote-prompt failed: ${error instanceof Error ? error.message : String(error)}`);
  // exitCode, not process.exit(): an immediate exit while undici holds a
  // keep-alive socket aborts the process on Windows and reports 127 instead of 1.
  // The process.exit() calls above are all reached BEFORE any fetch, so they are safe.
  process.exitCode = 1;
});
