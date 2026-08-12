/**
 * Resolves this agent's system prompt from Langfuse Prompt Management.
 *
 * Retrieval, variable interpolation and fallback are all done by the official SDK
 * (`@langfuse/client`) — `prompt.get()` and `prompt.compile()`. Nothing here
 * reimplements Langfuse behaviour; the only thing this module adds is a small cache
 * so the agent's latency budget is protected during an outage (see CACHING below).
 *
 * Used by TWO callers, sharing one cache so they can never disagree about which
 * version a turn is running:
 *   - `agent/instructions/10-weather-assistant.ts` — supplies the prompt text
 *   - `agent/instrumentation.ts` / `enrich-spans.ts` — stamp the prompt link
 *
 * THE GOVERNING CONSTRAINT: this module must never make the agent fail or stall.
 * CLAUDE.md §4 requirement 10 is that agents never fail because of Langfuse.
 * Observability is best-effort; so is prompt delivery. Nothing here throws.
 */

import { LangfuseClient } from "@langfuse/client";

import { supportedCitiesSentence } from "./cities.ts";
import { FALLBACK_MARKDOWN } from "./prompt-fallback.ts";

export interface ResolvedPrompt {
  /** The COMPILED text, with every {{variable}} substituted. */
  markdown: string;
  name: string;
  /** Langfuse version number, or 0 when serving the bundled fallback. */
  version: number;
  /** The label that was requested, or "fallback". */
  label: string;
  /** True when Langfuse could not be reached. A fallback is never linked to a trace. */
  isFallback: boolean;
  /** The values interpolated into the prompt, recorded for debugging. */
  variables: Record<string, string>;
}

const PROMPT_NAME = process.env.LANGFUSE_PROMPT_NAME ?? "weather-assistant";

/**
 * Which label to serve.
 *
 * Derived from LANGFUSE_ENVIRONMENT rather than needing its own variable, so a
 * preview deployment cannot accidentally run the production prompt because someone
 * forgot to set a second env var. An explicit override stays available for
 * experiments.
 */
const PROMPT_LABEL =
  process.env.LANGFUSE_PROMPT_LABEL ??
  (process.env.LANGFUSE_ENVIRONMENT === "production" ? "production" : "staging");

const TTL_MS = Number(process.env.LANGFUSE_PROMPT_TTL_SECONDS ?? "60") * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.LANGFUSE_PROMPT_TIMEOUT_MS ?? "2000");
const RETRY_AFTER_FAILURE_MS = Number(process.env.LANGFUSE_PROMPT_RETRY_MS ?? "10000");

/**
 * The values substituted into the prompt's {{variables}}.
 *
 * `supported_cities` is derived from the tool table rather than written into the
 * prompt text, so the prompt cannot claim coverage the tools do not have. This is
 * the point of prompt variables here: the prompt owns the WORDING, the code owns
 * the FACTS.
 */
export function promptVariables(): Record<string, string> {
  return {
    supported_cities: supportedCitiesSentence(),
    temperature_unit: process.env.AGENT_TEMPERATURE_UNIT ?? "Celsius",
  };
}

/**
 * CACHING — why there is any at all, given the SDK caches too.
 *
 * The SDK's cache does not cover the case that matters most: when Langfuse is
 * unreachable it returns the fallback but does not remember it, so EVERY turn pays
 * the full `fetchTimeoutMs` again. That turns an observability outage into a
 * latency regression on every request. Caching the resolved value — fallback
 * included, with a shorter retry TTL — bounds that to one slow turn per retry
 * window. The SDK's own cache is therefore disabled (`cacheTtlSeconds: 0`) so there
 * is exactly one cache with one TTL rather than two interleaving.
 *
 * State lives on `globalThis`, NOT in module scope: eve bundles
 * `agent/instrumentation.ts` separately from the agent runtime, so a module-level
 * variable gives each bundle its own copy — the instructions resolver populated one
 * cache while instrumentation read a second, permanently empty one, and no prompt
 * attribute ever reached a span. See docs/INTEGRATION-PITFALLS.md #24a.
 */
interface PromptState {
  cached?: { value: ResolvedPrompt; expiresAt: number };
  inflight?: Promise<ResolvedPrompt>;
  lastFallbackState?: boolean;
  client?: LangfuseClient;
}

const STATE_KEY = Symbol.for("eve-langfuse-poc.promptState");

function state(): PromptState {
  const holder = globalThis as unknown as Record<symbol, PromptState | undefined>;
  holder[STATE_KEY] ??= {};
  return holder[STATE_KEY];
}

/** Lazily constructed so importing this module never requires credentials. */
function client(): LangfuseClient {
  const s = state();
  s.client ??= new LangfuseClient();
  return s.client;
}

function fallbackResult(variables: Record<string, string>): ResolvedPrompt {
  return {
    // Compile the fallback by hand-substituting nothing: the bundled copy is stored
    // already-rendered, because a fallback that needed interpolation to be readable
    // would be one more thing to get wrong during an outage.
    markdown: FALLBACK_MARKDOWN,
    name: PROMPT_NAME,
    version: 0,
    label: "fallback",
    isFallback: true,
    variables,
  };
}

function noteState(next: ResolvedPrompt): ResolvedPrompt {
  const s = state();
  if (s.lastFallbackState !== next.isFallback) {
    s.lastFallbackState = next.isFallback;
    if (next.isFallback) {
      // Deliberately loud. The SDK logs its own fallback at DEBUG, which in practice
      // means nobody sees it: the agent keeps answering, quality silently reverts to
      // the bundled copy, and every trace loses its prompt link at the same time.
      console.warn(
        `[prompt] FALLBACK ACTIVE name=${next.name} — serving the bundled copy. ` +
          `Traces will carry the "prompt-fallback" tag and NO prompt link.`,
      );
    } else {
      console.log(`[prompt] resolved ${next.name} v${next.version} (label=${next.label})`);
    }
  }
  return next;
}

async function fetchPrompt(): Promise<ResolvedPrompt> {
  const variables = promptVariables();

  // Native retrieval. `fallback` makes the SDK return a usable prompt object rather
  // than throwing when Langfuse is unreachable, and marks it `isFallback`.
  const prompt = await client().prompt.get(PROMPT_NAME, {
    label: PROMPT_LABEL,
    type: "text",
    fallback: FALLBACK_MARKDOWN,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    cacheTtlSeconds: 0, // this module owns the cache — see CACHING above
  });

  if (prompt.isFallback) return fallbackResult(variables);

  return {
    // Native interpolation: Langfuse compiles {{variables}} with mustache.
    markdown: prompt.compile(variables),
    name: PROMPT_NAME,
    version: prompt.version,
    label: PROMPT_LABEL,
    isFallback: false,
    variables,
  };
}

function refresh(): Promise<ResolvedPrompt> {
  const s = state();
  s.inflight ??= fetchPrompt()
    .then((resolved) => {
      state().cached = { value: resolved, expiresAt: Date.now() + TTL_MS };
      return noteState(resolved);
    })
    .catch((error: unknown) => {
      // Should be unreachable — `fallback` stops `get()` throwing — but a bad prompt
      // TYPE or a compile error would land here, and this module must not throw.
      const reason = error instanceof Error ? error.message : String(error);
      const retryAt = Date.now() + Math.min(TTL_MS, RETRY_AFTER_FAILURE_MS);
      const existing = state().cached;

      if (existing && !existing.value.isFallback) {
        existing.expiresAt = retryAt;
        console.warn(`[prompt] refresh failed (${reason}); serving cached v${existing.value.version}`);
        return existing.value;
      }

      // Cache the fallback too. Without this, `peekResolvedPrompt()` returns
      // undefined and the "prompt-fallback" trace tag — the only signal that a turn
      // ran on the bundled copy — is never stamped. See pitfall #22.
      const fallback = fallbackResult(promptVariables());
      state().cached = { value: fallback, expiresAt: retryAt };
      console.warn(`[prompt] fetch failed (${reason})`);
      return noteState(fallback);
    })
    .finally(() => {
      state().inflight = undefined;
    });

  return s.inflight;
}

/**
 * Resolve the prompt for a session. Never throws.
 *
 * Stale-while-revalidate: once a value is cached this returns it immediately and
 * refreshes in the background, so a slow Langfuse adds latency to at most the first
 * turn of a process and never to a warm one.
 */
export async function resolvePrompt(): Promise<ResolvedPrompt> {
  const now = Date.now();
  const cached = state().cached;

  if (cached && cached.expiresAt > now) return cached.value;

  if (cached) {
    // Expired but present: kick off a refresh and answer from the stale copy.
    // `void` is intentional — awaiting would reintroduce the latency this branch
    // exists to avoid. `refresh()` cannot reject.
    void refresh();
    return cached.value;
  }

  // Cold start: this one await is unavoidable, and is bounded by FETCH_TIMEOUT_MS.
  return refresh();
}

/**
 * The last resolved prompt, without triggering a fetch.
 *
 * Used by `instrumentation.ts` inside `step.started`, which is synchronous and must
 * stay that way. Safe because instructions resolve at `session.started`, strictly
 * before any step of that session runs, so the cache is already warm.
 */
export function peekResolvedPrompt(): ResolvedPrompt | undefined {
  return state().cached?.value;
}
