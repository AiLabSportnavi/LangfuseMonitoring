/**
 * Registers a Langfuse model definition so generations get a COST, not just
 * token counts.
 *
 * WHY THIS IS A SEPARATE, MANUAL STEP
 *
 * Token usage and cost are different things and fail independently. Usage
 * comes off the span (`gen_ai.usage.*`) and is already correct. Cost is
 * computed by Langfuse at ingestion by matching the model name the generation
 * reports against a *model definition* in the project — and for Azure the
 * reported name is the DEPLOYMENT name, which matches none of Langfuse's
 * built-in OpenAI definitions. The result is the silent state described in
 * docs/INTEGRATION-PITFALLS.md #7: perfect token counts, `totalPrice: null`.
 *
 * This is idempotent and safe to re-run: an existing definition returns 409
 * and is reported as "already present" rather than duplicated.
 *
 * ⚠️ Requires network access to the ADMIN surface. `/api/public/models` is not
 * in the public-ingest matcher in infra/caddy/Caddyfile, so it is only
 * reachable from an allowlisted IP or the VPN — the same constraint that
 * blocks `npm run verify` (INTEGRATION-PITFALLS #16). A 403 here means "wrong
 * network", not "wrong key".
 *
 * Usage:
 *   npm run provision:prices              # uses the deployment name from .env.local
 *   MODEL_INPUT_PRICE_PER_1M=0.15 MODEL_OUTPUT_PRICE_PER_1M=0.60 npm run provision:prices
 */
const BASE_URL = process.env.LANGFUSE_BASE_URL;
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;

if (!BASE_URL || !PUBLIC_KEY || !SECRET_KEY) {
  console.error("[prices] LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.");
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

/**
 * The name generations actually report. For Azure this is the deployment name
 * (see agent/model.ts), which is why it is read from the same variable the
 * agent uses rather than hard-coded — a definition built against a guessed
 * name matches nothing and fails exactly as silently as having no definition.
 */
const modelName = process.env.AZURE_AI_CHATBOT_DEPLOYMENT_NAME ?? process.env.LANGFUSE_MODEL_NAME;

if (!modelName) {
  console.error(
    "[prices] No model name. Set AZURE_AI_CHATBOT_DEPLOYMENT_NAME (or LANGFUSE_MODEL_NAME)\n" +
      "         to the exact name generations report — check `model` in an observation's metadata.",
  );
  process.exit(1);
}

/**
 * Published list prices for gpt-4o-mini, in USD per 1M tokens. Overridable
 * because negotiated Azure rates differ from list, and a wrong price is worse
 * than no price: it produces confident, wrong cost dashboards in Phase 2.
 */
const inputPricePer1M = Number(process.env.MODEL_INPUT_PRICE_PER_1M ?? 0.15);
const outputPricePer1M = Number(process.env.MODEL_OUTPUT_PRICE_PER_1M ?? 0.6);

if (!Number.isFinite(inputPricePer1M) || !Number.isFinite(outputPricePer1M)) {
  console.error("[prices] MODEL_INPUT_PRICE_PER_1M / MODEL_OUTPUT_PRICE_PER_1M must be numbers.");
  process.exit(1);
}

/** Escape regex metacharacters — deployment names may legitimately contain `.` or `-`. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
  // Langfuse matches this pattern against the reported model name. Anchored
  // and case-insensitive: an unanchored pattern would also claim
  // `gpt-4o-mini-audio` and price it wrongly.
  const matchPattern = `(?i)^(${escapeRegex(modelName!)})$`;

  const body = {
    modelName,
    matchPattern,
    unit: "TOKENS",
    // Langfuse stores price per SINGLE token, not per million.
    inputPrice: inputPricePer1M / 1_000_000,
    outputPrice: outputPricePer1M / 1_000_000,
    tokenizerId: "openai",
    tokenizerConfig: { tokensPerMessage: 3, tokensPerName: 1, tokenizerModel: "gpt-4o-mini" },
  };

  console.log(`[prices] registering "${modelName}"`);
  console.log(`[prices]   match   ${matchPattern}`);
  console.log(`[prices]   input   $${inputPricePer1M}/1M tokens  (${body.inputPrice}/token)`);
  console.log(`[prices]   output  $${outputPricePer1M}/1M tokens  (${body.outputPrice}/token)`);

  const response = await fetch(`${BASE_URL}/api/public/models`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    console.log("[prices] already present — nothing to do.");
    return;
  }

  if (response.status === 403) {
    console.error(
      "[prices] 403 Not authorized.\n" +
        "  This is the admin IP allowlist, NOT a bad key — /api/public/models is not in the\n" +
        "  public-ingest matcher in infra/caddy/Caddyfile. Run from an allowlisted host or VPN.\n" +
        "  Sanity check:  curl -o /dev/null -w '%{http_code}' $LANGFUSE_BASE_URL/api/public/health",
    );
    process.exitCode = 1;
    return;
  }

  if (!response.ok) {
    console.error(`[prices] POST /api/public/models -> ${response.status} ${await response.text()}`);
    process.exitCode = 1;
    return;
  }

  console.log("[prices] created.");
  console.log(
    "[prices] NOTE: pricing applies to generations ingested FROM NOW ON.\n" +
      "         Langfuse does not retroactively price existing observations, so traces\n" +
      "         recorded before this still show totalPrice: null. Token usage on them is\n" +
      "         intact — only the derived cost is missing.",
  );
}

main().catch((error) => {
  console.error("[prices] failed:", error);
  process.exitCode = 1;
});
