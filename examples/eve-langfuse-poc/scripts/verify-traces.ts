/**
 * Reads observations back out of Langfuse and asserts what matters.
 *
 * Why read-back and not "the exporter returned 2xx": Langfuse ingestion is
 * asynchronous. The OTLP endpoint accepts a batch and returns success BEFORE a
 * worker has written anything to ClickHouse. A 2xx proves the request was
 * accepted, not that the data exists. Only a successful read proves the whole
 * pipeline — web, queue, worker, ClickHouse — actually ran.
 *
 * v4 API NOTE: this deployment runs Langfuse v4 in `events_only` mode, where
 * the v3 read endpoints (GET /api/public/traces, GET /api/public/observations/:id)
 * return an error instead of data. Reads go through
 *   GET /api/public/v2/observations?fromStartTime=<from>&toStartTime=<to>
 * and traces are reconstructed by grouping observations on traceId. Do not
 * "fix" this back to /api/public/traces — that endpoint is gone here.
 */
const BASE_URL = process.env.LANGFUSE_BASE_URL;
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;

if (!BASE_URL || !PUBLIC_KEY || !SECRET_KEY) {
  console.error("[verify] LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.");
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

interface Observation {
  id: string;
  traceId: string;
  type: string;
  name: string;
  level?: string | null;
  statusMessage?: string | null;
  startTime: string;
  endTime?: string | null;
  latency?: number | null;
  parentObservationId?: string | null;
  isRootObservation?: boolean;
  environment?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  modelId?: string | null;
  totalPrice?: number | null;
  usageDetails?: Record<string, number> | null;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function preview(value: unknown, width = 68): string {
  if (!hasValue(value)) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").slice(0, width);
}

const WINDOW_MINUTES = Number(process.env.VERIFY_WINDOW_MINUTES ?? 30);

/**
 * The v2 observations API returns DIFFERENT field sets per `fields` value, and
 * no single value returns everything:
 *
 *   (omitted)            id, name, level, statusMessage, environment, sessionId
 *   fields=core,io,metadata   input, output, metadata — but NO id and NO name
 *
 * So structure and payload have to be fetched separately and merged. `id` is
 * absent from the io projection, hence the composite key below.
 *
 * Getting this wrong is not a harmless bug: querying only the default
 * projection makes every observation look like it has no input or output, which
 * is precisely the false alarm that sent this investigation down the wrong path
 * in the first place.
 */
function mergeKey(o: Observation): string {
  return [o.traceId, o.startTime, o.type, o.parentObservationId ?? "root"].join("|");
}

async function fetchProjection(fields?: string): Promise<Observation[]> {
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const suffix = fields ? `&fields=${fields}` : "";
  const url = `${BASE_URL}/api/public/v2/observations?fromStartTime=${from}&toStartTime=${to}&limit=100${suffix}`;

  const response = await fetch(url, { headers: { Authorization: auth } });
  if (response.status === 403) {
    // Not a credential problem, and the raw body ("Not authorized") reads
    // exactly like one — which is why this is called out explicitly. Only the
    // ingest endpoints are public (CLAUDE.md §5.3); every read API sits behind
    // the reverse proxy's admin IP allowlist. Same credentials, same host,
    // POST works and GET does not. See docs/INTEGRATION-PITFALLS.md #16.
    throw new Error(
      "GET /api/public/v2/observations -> 403 Not authorized.\n" +
        "  This is an IP allowlist rejection, NOT a bad key: the read APIs are admin\n" +
        "  surfaces behind the proxy allowlist, while /api/public/otel is public.\n" +
        "  Confirm with:  curl -o /dev/null -w '%{http_code}' $LANGFUSE_BASE_URL/api/public/health   (expect 200)\n" +
        "  Run this verifier from an allowlisted host/VPN, or add the runner's egress IP\n" +
        "  to the admin matcher in infra/caddy/Caddyfile.",
    );
  }
  if (!response.ok) {
    throw new Error(`GET /api/public/v2/observations -> ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: Observation[] };
  return body.data ?? [];
}

async function fetchObservations(): Promise<Observation[]> {
  const [structure, payloads] = await Promise.all([
    fetchProjection(),
    fetchProjection("core,io,metadata"),
  ]);

  const byKey = new Map(payloads.map((o) => [mergeKey(o), o]));

  return structure.map((o) => {
    const payload = byKey.get(mergeKey(o));
    return payload ? { ...o, ...payload, name: o.name, id: o.id, level: o.level } : o;
  });
}

/** Ingestion is queued, so an empty result is not yet failure — poll first. */
async function waitForObservations(timeoutMs = 90_000): Promise<Observation[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observations = await fetchObservations();
    if (observations.length > 0) return observations;
    if (Date.now() > deadline) return [];
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function note(label: string, detail = ""): void {
  console.log(`  NOTE  ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * The observation names this instrumentation is allowed to emit.
 *
 * Deliberately an exact allowlist rather than a "looks reasonable" regex.
 * Names are an observability API (stable across releases, safe to build
 * dashboards and saved filters on), so the failure this guards against is a
 * framework upgrade silently reintroducing `invoke_agent gpt-4o-mini` or
 * `step 1` — which breaks every saved filter without breaking the agent.
 *
 * `call-*` covers one node per tool; the tool name is stable, unlike the
 * per-execution values (ids, retry counters) that belong in metadata.
 */
const ALLOWED_NAME = /^(process-turn|agent-step|model-call|call-model|call-[a-z0-9-]+)$/;

/** Names that must never come back: dynamic values or model ids baked in. */
function nameProblem(name: string): string | undefined {
  if (!ALLOWED_NAME.test(name)) return "not in the stable-name allowlist";
  if (/\bgpt|claude|gemini|llama|o[134]-|\d{3,}/i.test(name)) return "model name or id in span name";
  return undefined;
}

/**
 * Patterns that must never reach Langfuse in a payload.
 *
 * Checked on the data actually stored, not on the masking function's unit
 * behaviour: a mask that is correct but wired in the wrong processor order
 * passes its own tests and still exports secrets. This is the assertion that
 * cannot be fooled by a wiring mistake.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "Azure/OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "Langfuse secret key", re: /\bsk-lf-[A-Za-z0-9-]{8,}/ },
  { label: "Bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{16,}/i },
  { label: "Basic auth header", re: /\bBasic\s+[A-Za-z0-9+/=]{24,}/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { label: "api key assignment", re: /"?(api[_-]?key|apikey|password|secret)"?\s*[:=]\s*"[^"]{8,}"/i },
];

function secretsIn(observation: Observation): string[] {
  const haystack = [observation.input, observation.output, observation.metadata]
    .filter((v) => v != null)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join("\n");

  return SECRET_PATTERNS.filter((p) => p.re.test(haystack)).map((p) => p.label);
}

function metadataOf(observation: Observation): Record<string, unknown> {
  const raw = observation.metadata;
  if (raw == null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The step where the model stopped calling tools and answered the user. */
function isFinalAnswer(observation: Observation): boolean {
  const finish = metadataOf(observation).finishReason;
  const text = Array.isArray(finish) ? finish.join(",") : String(finish ?? "");
  return text.includes("stop");
}

/**
 * Token usage is checked through the metrics API, not the observations list.
 *
 * `/v2/observations` does not return usage fields at all, so a generation with
 * perfectly good token counts looks like it has none. Asserting on that list
 * would report a false failure — or, worse, a false pass if the check were
 * written the other way round.
 *
 * This matters more than the rest of the suite: token usage is the one input
 * Phase 2 cost monitoring cannot backfill.
 */
async function totalTokensByModel(): Promise<Record<string, number>> {
  const toTimestamp = new Date(Date.now() + 60_000).toISOString();
  const fromTimestamp = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();

  const query = encodeURIComponent(
    JSON.stringify({
      view: "observations",
      metrics: [{ measure: "totalTokens", aggregation: "sum" }],
      dimensions: [{ field: "providedModelName" }],
      fromTimestamp,
      toTimestamp,
    }),
  );

  const response = await fetch(`${BASE_URL}/api/public/v2/metrics?query=${query}`, {
    headers: { Authorization: auth },
  });
  if (!response.ok) {
    throw new Error(`GET /api/public/v2/metrics -> ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    data: { providedModelName: string | null; sum_totalTokens: number }[];
  };

  const totals: Record<string, number> = {};
  for (const row of body.data ?? []) {
    if (row.providedModelName) totals[row.providedModelName] = row.sum_totalTokens;
  }
  return totals;
}

async function main() {
  console.log(`[verify] reading observations from the last ${WINDOW_MINUTES} minutes`);
  const all = await waitForObservations();

  if (all.length === 0) {
    console.error("\n[verify] no observations arrived. The export path is broken.");
    process.exit(1);
  }

  const traces = new Map<string, Observation[]>();
  for (const o of all) {
    const list = traces.get(o.traceId) ?? [];
    list.push(o);
    traces.set(o.traceId, list);
  }

  console.log(`\n[verify] ${all.length} observations across ${traces.size} traces\n`);

  let allPassed = true;

  for (const [traceId, obs] of traces) {
    obs.sort((a, b) => a.startTime.localeCompare(b.startTime));
    const root = obs.find((o) => o.isRootObservation) ?? obs[0];
    const generations = obs.filter((o) => o.type === "GENERATION");
    const errored = obs.filter((o) => o.level === "ERROR");
    const withModel = generations.filter((g) => !!g.modelId || g.name.includes("chat "));
    const timed = obs.filter((o) => !!o.endTime);
    const nested = obs.filter((o) => !!o.parentObservationId);

    console.log(`=== trace ${traceId} — root "${root?.name}" ===`);

    // The headline requirement: no step may be an unexplained black box.
    const missingInput = obs.filter((o) => !hasValue(o.input));
    // A step that threw legitimately has no output — but it must still explain
    // itself, so a recorded error message counts as its outcome.
    const missingOutput = obs.filter(
      (o) => !hasValue(o.output) && !hasValue(o.statusMessage),
    );
    const withMetadata = obs.filter((o) => hasValue(o.metadata));

    const roots = obs.filter((o) => o.isRootObservation);
    const badNames = obs
      .map((o) => [o.name, nameProblem(o.name)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
    const finalAnswer = [...obs].reverse().find(isFinalAnswer);
    const promptRevisions = new Set(
      obs.map((o) => metadataOf(o).promptRevision).filter((v): v is string => typeof v === "string"),
    );
    const leaked = obs
      .map((o) => [o.name, secretsIn(o)] as const)
      .filter((entry) => entry[1].length > 0);
    // A step that failed must record either a synthesised output or a status
    // message. Both missing means the failure is invisible.
    const unexplainedErrors = errored.filter(
      (o) => !hasValue(o.output) && !hasValue(o.statusMessage),
    );

    const results = [
      check("observations present", obs.length > 0, `${obs.length}`),
      check("generation present", generations.length > 0, `${generations.length}`),
      check("model on every generation", generations.length > 0 && withModel.length === generations.length, `${withModel.length}/${generations.length}`),
      check("timing present on all", timed.length === obs.length, `${timed.length}/${obs.length}`),
      check("tree is nested", nested.length > 0, `${nested.length} children`),
      check("environment set", !!root?.environment, root?.environment ?? ""),
      check("sessionId set", !!root?.sessionId, root?.sessionId || "(empty)"),
      check(
        "INPUT on every observation",
        missingInput.length === 0,
        missingInput.length ? `missing on: ${missingInput.map((o) => o.name).join(", ")}` : `${obs.length}/${obs.length}`,
      ),
      check(
        "OUTPUT on every observation",
        missingOutput.length === 0,
        missingOutput.length ? `missing on: ${missingOutput.map((o) => o.name).join(", ")}` : `${obs.length}/${obs.length}`,
      ),
      check("metadata on every observation", withMetadata.length === obs.length, `${withMetadata.length}/${obs.length}`),
      check("trace has a semantic name", !!root?.name && !/^trace-|^undefined$/.test(root.name), root?.name ?? ""),

      // ── Added for the full-observability pass ────────────────────────────
      //
      // Exactly one root. Langfuse derives trace-level name/input/output from
      // the root observation, so N roots means those fields are whichever of
      // the N wrote last — non-deterministic, and wrong N-1 times out of N.
      // Three competing roots per trace was the real, silent state of this
      // integration before `correctAppRoot`; see INTEGRATION-PITFALLS #15.
      check(
        "exactly one root observation",
        roots.length === 1,
        roots.length === 1 ? "process-turn" : `${roots.length} roots: ${roots.map((o) => o.name).join(", ")}`,
      ),

      // Names are the observability API. A framework upgrade that reverts them
      // breaks every saved dashboard filter without breaking the agent.
      check(
        "observation names are stable and semantic",
        badNames.length === 0,
        badNames.length ? badNames.map(([n, why]) => `${n} (${why})`).join(", ") : `${obs.length}/${obs.length}`,
      ),

      // The single most important payload in the trace: what the user actually
      // got back. Its absence is what "the trace is complete but useless"
      // looks like.
      check(
        "final answer is present and is text, not a tool call",
        !!finalAnswer && hasValue(finalAnswer.output) && !/"type"\s*:\s*"tool_call"/.test(JSON.stringify(finalAnswer.output)),
        finalAnswer ? preview(finalAnswer.output, 48) : "no observation finished with finishReason=stop",
      ),

      // Per-user cost and behaviour analysis, and Phase 5 production eval.
      check("userId set", !!root?.userId, root?.userId || "(empty)"),

      // Which instructions produced this answer. Without it, two traces that
      // differ only because the prompt changed are indistinguishable.
      check(
        "prompt revision recorded",
        promptRevisions.size > 0,
        promptRevisions.size ? [...promptRevisions].join(", ") : "no promptRevision in any observation metadata",
      ),

      // Asserted on stored data, not on the mask function — a correct mask
      // registered in the wrong processor order still exports secrets.
      check(
        "no secrets in stored payloads",
        leaked.length === 0,
        leaked.length ? leaked.map(([n, kinds]) => `${n}: ${kinds.join("/")}`).join("; ") : `${obs.length} observations scanned`,
      ),

      // An errored step that records neither an output nor a message is the
      // one black box a reviewer cannot get past.
      check(
        "every errored observation explains itself",
        unexplainedErrors.length === 0,
        unexplainedErrors.length ? unexplainedErrors.map((o) => o.name).join(", ") : `${errored.length} errored`,
      ),
    ];
    if (results.some((r) => !r)) allPassed = false;

    // Cost is reported, not asserted. Token usage is the input that cannot be
    // backfilled and IS asserted below; cost is derived from it whenever a
    // matching model definition exists, so a null here is a one-time config
    // task in Langfuse (scripts/provision-model-prices.ts), not lost data.
    const priced = generations.filter((g) => typeof g.totalPrice === "number" && g.totalPrice > 0);
    if (priced.length === generations.length && generations.length > 0) {
      const total = priced.reduce((sum, g) => sum + (g.totalPrice ?? 0), 0);
      note("cost calculated", `${priced.length}/${generations.length} generations, total ≈ ${total.toFixed(6)}`);
    } else {
      note(
        "cost NOT calculated",
        `${priced.length}/${generations.length} generations priced — add a model definition matching ` +
          `"${generations.find((g) => !g.modelId)?.name ?? "the deployment name"}" ` +
          "(npm run provision:prices). Token usage is unaffected.",
      );
    }

    if (errored.length > 0) {
      console.log(`  NOTE  ${errored.length} errored observation(s) — expected only for the failure-path turn:`);
      for (const e of errored) console.log(`        ${e.name}: ${e.statusMessage ?? ""}`);
    }

    console.log("\n  step-by-step (input -> output):");
    for (const o of obs) {
      const ms = o.latency != null ? `${(o.latency * 1000).toFixed(0)}ms` : "-";
      const lvl = o.level === "ERROR" ? " [ERROR]" : "";
      console.log(`    ${o.type.padEnd(10)} ${o.name.slice(0, 26).padEnd(28)} ${ms.padEnd(8)}${lvl}`);
      console.log(`      in : ${preview(o.input)}`);
      console.log(`      out: ${preview(o.output)}`);
    }
    console.log();
  }

  console.log("=== token usage (metrics API) ===");
  const tokens = await totalTokensByModel();
  const models = Object.keys(tokens);
  const usageOk = check(
    "token usage recorded",
    models.length > 0 && models.every((m) => tokens[m]! > 0),
    models.map((m) => `${m}=${tokens[m]}`).join(", ") || "none",
  );
  if (!usageOk) allPassed = false;

  console.log(`\n${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  // Set exitCode rather than calling process.exit(): an immediate exit while
  // fetch keep-alive sockets are still open trips a libuv assertion on Windows.
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error) => {
  console.error("[verify] failed:", error);
  process.exitCode = 1;
});
