/**
 * Push `datasets/<name>/` into Langfuse, and the score configs from
 * `evals/score-configs.json`.
 *
 *   npm run datasets:check   # exit 1 if Langfuse is behind git
 *   npm run datasets:sync    # upsert items and score configs
 *
 * Idempotent by construction: a dataset item's `id` is its upsert key, so
 * re-running never duplicates. That is what makes this safe to run on every CI
 * job rather than only by hand.
 *
 * Emits `dataset_version=<iso>` to $GITHUB_OUTPUT when running in Actions. The
 * experiment must PIN that version: comparing two runs against different dataset
 * versions compares answers to different questions, and the delta is
 * meaningless.
 */

import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_ONLY = process.argv.includes("--check");

const DATASETS_DIR = fileURLToPath(new URL("../datasets/", import.meta.url));
const SCORE_CONFIGS = fileURLToPath(new URL("../evals/score-configs.json", import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.local (see .env.example).`);
  return value;
}
const BASE_URL = required("LANGFUSE_BASE_URL");
const AUTH =
  "Basic " +
  Buffer.from(`${required("LANGFUSE_PUBLIC_KEY")}:${required("LANGFUSE_SECRET_KEY")}`).toString("base64");

interface DatasetItem {
  id: string;
  input: unknown;
  expectedOutput?: unknown;
  metadata?: Record<string, unknown>;
  status?: "ACTIVE" | "ARCHIVED";
}

interface DatasetSource {
  dir: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  items: DatasetItem[];
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

/**
 * Load every immediate subdirectory of `datasets/`.
 *
 * NOTE: do not write the glob for that path inside a block comment — the `*` and
 * `/` sequence closes the comment early and the remaining prose is then parsed as
 * code, desyncing the lexer for the rest of the file. `node --check` accepted it;
 * `tsc` correctly did not.
 *
 * Items are grouped one file per CATEGORY rather than one file per item. Per-item
 * files give conflict-free diffs but 30+ files for one small dataset is hard to
 * read; per-category keeps a change reviewable while staying navigable. The
 * trade-off is real: two people adding items to the same category can conflict.
 */
function loadDatasets(): DatasetSource[] {
  return readdirSync(DATASETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((entry) => {
      const dir = join(DATASETS_DIR, entry.name);
      const meta = JSON.parse(readFileSync(join(dir, "dataset.json"), "utf8")) as {
        name: string;
        description?: string;
        metadata?: Record<string, unknown>;
      };

      const itemsDir = join(dir, "items");
      const files = readdirSync(itemsDir).filter((f) => f.endsWith(".json")).sort();

      const items: DatasetItem[] = [];
      const seen = new Map<string, string>();

      for (const file of files) {
        const parsed = JSON.parse(readFileSync(join(itemsDir, file), "utf8")) as DatasetItem[];
        if (!Array.isArray(parsed)) throw new Error(`${entry.name}/items/${file} must contain a JSON array.`);

        for (const item of parsed) {
          if (!item.id) throw new Error(`${entry.name}/items/${file}: every item needs an "id" (it is the upsert key).`);
          // A duplicate id silently OVERWRITES the earlier item on upsert, so the
          // dataset would end up smaller than the files suggest with no error
          // anywhere. Fail loudly instead.
          const previous = seen.get(item.id);
          if (previous) {
            throw new Error(`Duplicate item id "${item.id}" in ${previous} and ${file}. Ids are upsert keys and must be unique.`);
          }
          seen.set(item.id, file);
          items.push(item);
        }
      }

      return { dir: entry.name, name: meta.name, description: meta.description, metadata: meta.metadata, items };
    });
}

async function syncScoreConfigs(): Promise<{ created: number; existing: number }> {
  const desired = JSON.parse(readFileSync(SCORE_CONFIGS, "utf8")) as {
    name: string;
    dataType: string;
    description?: string;
    minValue?: number;
    maxValue?: number;
    categories?: { label: string; value: number }[];
  }[];

  // Score configs are IMMUTABLE once created (they can only be archived), so
  // this only ever creates missing ones. A changed dataType needs a new name —
  // silently ignoring the change is better than pretending an update happened.
  const response = await api("/api/public/score-configs?limit=100");
  if (!response.ok) throw new Error(`listing score configs failed: ${response.status} ${await response.text()}`);
  const live = ((await response.json()) as { data: { name: string }[] }).data;
  const liveNames = new Set(live.map((c) => c.name));

  let created = 0;
  for (const config of desired) {
    if (liveNames.has(config.name)) continue;
    if (CHECK_ONLY) {
      console.log(`  MISSING score config  ${config.name} (${config.dataType})`);
      created++;
      continue;
    }
    const put = await api("/api/public/score-configs", { method: "POST", body: JSON.stringify(config) });
    if (!put.ok) throw new Error(`creating score config ${config.name} failed: ${put.status} ${await put.text()}`);
    console.log(`  created score config  ${config.name} (${config.dataType})`);
    created++;
  }
  return { created, existing: desired.length - created };
}

async function syncDataset(source: DatasetSource): Promise<{ upserted: number; version?: string }> {
  // Upsert the dataset itself. POST /api/public/v2/datasets upserts on name.
  if (!CHECK_ONLY) {
    const created = await api("/api/public/v2/datasets", {
      method: "POST",
      body: JSON.stringify({ name: source.name, description: source.description, metadata: source.metadata }),
    });
    if (!created.ok) throw new Error(`upserting dataset ${source.name} failed: ${created.status} ${await created.text()}`);
  }

  // Items are listed from /api/public/dataset-items with a datasetName filter.
  // There is no /v2/datasets/{name}/items subpath — that endpoint is GET-only for
  // the dataset itself. Verified against the instance's own OpenAPI spec.
  const encoded = encodeURIComponent(source.name);
  const liveResponse = await api(`/api/public/dataset-items?datasetName=${encoded}&limit=100`);
  const liveItems: { id: string }[] = liveResponse.ok
    ? ((await liveResponse.json()) as { data: { id: string }[] }).data
    : [];
  const liveIds = new Set(liveItems.map((i) => i.id));

  const missing = source.items.filter((i) => !liveIds.has(i.id));

  if (CHECK_ONLY) {
    for (const item of missing) console.log(`  MISSING item  ${source.name}/${item.id}`);
    return { upserted: missing.length };
  }

  // Upsert ALL items, not just the missing ones: an existing item whose
  // expectedOutput changed in git must be updated too, and `id` makes that safe.
  for (const item of source.items) {
    const response = await api("/api/public/dataset-items", {
      method: "POST",
      body: JSON.stringify({
        datasetName: source.name,
        id: item.id,
        input: item.input,
        expectedOutput: item.expectedOutput,
        metadata: item.metadata,
        status: item.status ?? "ACTIVE",
      }),
    });
    if (!response.ok) {
      throw new Error(`upserting item ${item.id} failed: ${response.status} ${await response.text()}`);
    }
  }

  const after = await api(`/api/public/dataset-items?datasetName=${encoded}&limit=100`);
  // Fail loudly. This read-back previously hit a non-existent endpoint, and
  // because a failed response was folded into `0`, the script cheerfully printed
  // "0 live" after successfully upserting 33 items — a read-back that reports
  // nothing looks identical to a write that did nothing.
  if (!after.ok) {
    throw new Error(`read-back of ${source.name} failed: ${after.status} ${await after.text()}`);
  }
  const count = ((await after.json()) as { meta?: { totalItems?: number } }).meta?.totalItems ?? 0;

  // The read-back is the assertion, not the log line: if Langfuse holds fewer
  // items than git, the dataset a CI run would evaluate is not the one in the repo.
  if (count < source.items.length) {
    throw new Error(
      `${source.name}: git has ${source.items.length} item(s) but Langfuse reports ${count} after sync.`,
    );
  }
  console.log(`  ${source.name}: ${source.items.length} item(s) in git, ${count} live (${missing.length} new)`);

  return { upserted: source.items.length };
}

async function main(): Promise<void> {
  const sources = loadDatasets();
  const byCategory = new Map<string, number>();
  for (const source of sources) {
    for (const item of source.items) {
      const category = String(item.metadata?.category ?? "uncategorised");
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    }
  }

  console.log(`Loaded ${sources.length} dataset(s), ${[...byCategory.values()].reduce((a, b) => a + b, 0)} item(s):`);
  for (const [category, count] of [...byCategory.entries()].sort()) {
    console.log(`  ${String(count).padStart(3)}  ${category}`);
  }
  console.log();

  const scores = await syncScoreConfigs();
  let drift = scores.created;
  for (const source of sources) {
    const result = await syncDataset(source);
    if (CHECK_ONLY) drift += result.upserted;
  }

  if (CHECK_ONLY) {
    if (drift === 0) {
      console.log("\nLangfuse matches datasets/ and evals/score-configs.json.");
      return;
    }
    console.error(`\n${drift} item(s)/config(s) missing from Langfuse. Run: npm run datasets:sync`);
    process.exitCode = 1; // not process.exit() — undici keep-alive aborts on Windows
    return;
  }

  // The experiment pins this so a run is always comparable to its baseline.
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const version = new Date().toISOString();
    appendFileSync(output, `dataset_version=${version}\n`);
    console.log(`\ndataset_version=${version} -> $GITHUB_OUTPUT`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nsync-datasets failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
