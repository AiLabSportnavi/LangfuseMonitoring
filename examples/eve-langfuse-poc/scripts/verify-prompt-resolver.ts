/**
 * Contract test for `agent/lib/prompt.ts`.
 *
 * This exists because the resolver's failure behaviour is the part most likely
 * to be silently wrong, and two real bugs were found here by running exactly
 * these scenarios:
 *
 *   1. The fallback was not cached, so `peekResolvedPrompt()` returned undefined
 *      and `instrumentation.ts` never stamped the `prompt-fallback` tag —
 *      disabling the ONLY in-trace signal that a turn ran on the bundled prompt.
 *   2. Because it was not cached, every turn re-attempted the fetch and paid the
 *      full 2s timeout, turning a Langfuse outage into a per-turn latency
 *      regression.
 *
 * Neither bug affects the happy path, and neither produces an error. A test that
 * only checked "does the prompt resolve" would have passed on both.
 *
 * Each scenario runs in its OWN subprocess: the resolver's cache is module
 * state, so scenarios cannot share a process without contaminating each other.
 *
 *   npm run verify:prompt-resolver
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Emitted by the child, parsed by the parent. */
interface Probe {
  version: number;
  label: string;
  isFallback: boolean;
  versionIsNumber: boolean;
  peekIsSet: boolean;
  peekMatches: boolean;
  coldMs: number;
  warmMs: number;
  markdownNonEmpty: boolean;
}

const CHILD_MARKER = "--child";
const RESOLVER = new URL("../agent/lib/prompt.ts", import.meta.url).href;
const IS_CHILD = process.argv.includes(CHILD_MARKER);

/** ── child mode ──────────────────────────────────────────────────────────── */
if (IS_CHILD) {
  const { resolvePrompt, peekResolvedPrompt } = (await import(RESOLVER)) as {
    resolvePrompt: () => Promise<{
      markdown: string;
      version: number;
      label: string;
      isFallback: boolean;
    }>;
    peekResolvedPrompt: () => { version: number } | undefined;
  };

  const t0 = Date.now();
  const first = await resolvePrompt();
  const coldMs = Date.now() - t0;

  const t1 = Date.now();
  await resolvePrompt();
  const warmMs = Date.now() - t1;

  const peeked = peekResolvedPrompt();
  const probe: Probe = {
    version: first.version,
    label: first.label,
    isFallback: first.isFallback,
    versionIsNumber: typeof first.version === "number",
    peekIsSet: peeked !== undefined,
    peekMatches: peeked?.version === first.version,
    coldMs,
    warmMs,
    markdownNonEmpty: first.markdown.trim().length > 0,
  };
  console.log(`__PROBE__${JSON.stringify(probe)}`);
  process.exitCode = 0;
}

interface Scenario {
  name: string;
  /** Env overlaid on the inherited environment. */
  env: Record<string, string>;
  /** Assertions against the child's probe. Return a failure message, or undefined. */
  expect: (p: Probe) => string | undefined;
}

/**
 * A warm resolve must be fast in EVERY scenario, including a total outage.
 * This is the assertion that catches the "2s on every turn" bug.
 */
const WARM_BUDGET_MS = 100;

const scenarios: Scenario[] = [
  {
    name: "Langfuse reachable -> managed prompt",
    env: {},
    expect: (p) =>
      p.isFallback
        ? "fell back even though Langfuse is reachable (check LANGFUSE_* in .env.local)"
        : p.version < 1
          ? `expected a real version, got ${p.version}`
          : !p.versionIsNumber
            ? "version is not a number — the trace attribute would be a string"
            : !p.peekMatches
              ? "peekResolvedPrompt() disagrees with resolvePrompt()"
              : undefined,
  },
  {
    name: "connection refused -> bundled fallback",
    env: { LANGFUSE_BASE_URL: "http://127.0.0.1:1" },
    expect: expectFallback,
  },
  {
    name: "black-holed host -> fallback within the timeout",
    // Unroutable RFC1918 address: packets are dropped rather than refused, so
    // this exercises the AbortSignal timeout rather than a fast ECONNREFUSED.
    env: { LANGFUSE_BASE_URL: "http://10.255.255.1" },
    expect: (p) =>
      expectFallback(p) ??
      (p.coldMs > 6000 ? `cold resolve took ${p.coldMs}ms — the fetch timeout is not bounding it` : undefined),
  },
  {
    name: "bad credentials (401) -> bundled fallback",
    env: { LANGFUSE_SECRET_KEY: "sk-lf-deliberately-wrong" },
    expect: expectFallback,
  },
  {
    name: "prompt does not exist (404) -> bundled fallback",
    env: { LANGFUSE_PROMPT_NAME: "no-such-prompt-exists-here" },
    expect: expectFallback,
  },
];

function expectFallback(p: Probe): string | undefined {
  if (!p.isFallback) return "expected the bundled fallback, but a managed prompt was returned";
  if (!p.markdownNonEmpty) return "fallback markdown is empty — the agent would have no instructions";
  if (p.version !== 0) return `fallback version should be the 0 sentinel, got ${p.version}`;
  if (p.label !== "fallback") return `fallback label should be "fallback", got "${p.label}"`;
  // The bug that mattered most: without a cached fallback, peek returns
  // undefined and the `prompt-fallback` trace tag is never stamped.
  if (!p.peekIsSet) return "peekResolvedPrompt() is undefined — the prompt-fallback trace tag would never be set";
  if (p.warmMs > WARM_BUDGET_MS) {
    return `warm resolve took ${p.warmMs}ms (budget ${WARM_BUDGET_MS}ms) — every turn is paying the fetch timeout`;
  }
  return undefined;
}

async function main(): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;

  for (const scenario of scenarios) {
    const result = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env.local", "--experimental-strip-types", self, CHILD_MARKER],
      {
        encoding: "utf8",
        // The overlay goes AFTER process.env so a scenario can override a real
        // value from .env.local. Node applies --env-file before this, but the
        // parent already has those values loaded, so they are inherited here.
        env: { ...process.env, ...scenario.env },
      },
    );

    const line = result.stdout.split("\n").find((l) => l.startsWith("__PROBE__"));
    if (!line) {
      failures++;
      console.log(`  FAIL  ${scenario.name}`);
      console.log(`        the child produced no probe — it likely threw, which the resolver must never do`);
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n        ");
      if (detail) console.log(`        ${detail}`);
      continue;
    }

    const probe = JSON.parse(line.slice("__PROBE__".length)) as Probe;
    const problem = scenario.expect(probe);
    const shape = `fallback=${probe.isFallback} v${probe.version} cold=${probe.coldMs}ms warm=${probe.warmMs}ms`;

    if (problem) {
      failures++;
      console.log(`  FAIL  ${scenario.name}  (${shape})`);
      console.log(`        ${problem}`);
    } else {
      console.log(`  ok    ${scenario.name}  (${shape})`);
    }
  }

  console.log(
    failures === 0
      ? `\nPASS: prompt resolver honours its contract across ${scenarios.length} scenarios.`
      : `\nFAIL: ${failures}/${scenarios.length} scenario(s) failed.`,
  );
  // exitCode rather than process.exit(): the child processes and any keep-alive
  // sockets must be allowed to unwind. See verify-traces.ts:448.
  process.exitCode = failures === 0 ? 0 : 1;
}

/**
 * Parent mode runs LAST, after `scenarios` is initialized.
 *
 * `main()` cannot be called from an `else` branch beside the child block above:
 * `scenarios` is a `const` declared further down, so calling main() earlier hits
 * its temporal dead zone and throws `Cannot access 'scenarios' before
 * initialization` — before a single scenario runs.
 */
if (!IS_CHILD) await main();
