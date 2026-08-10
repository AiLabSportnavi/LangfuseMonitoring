# Phase 1B — `@org/agent-telemetry` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared tracing package that owns the entire Langfuse tracing standard, so any Eve agent project integrates in ~5 lines and every project produces identically-shaped, high-signal traces.

**Architecture:** A TypeScript package exporting one function, `createLangfuseInstrumentation()`, whose return value is passed directly to Eve's `defineInstrumentation()`. Internally it is built from small pure functions — environment resolution, attribute construction, sampling, auth-header building — each unit-testable without network or framework. The impure OTLP wiring is a thin shell over that tested core.

**Tech Stack:** TypeScript 5.7 (strict) · Node 22 · pnpm · Vitest · `@vercel/otel` · `@opentelemetry/exporter-trace-otlp-http` · `eve`

## Global Constraints

- **Package name:** `@org/agent-telemetry` (replace `@org` with the real npm scope before publishing).
- **Token usage must appear on every generation.** Non-negotiable — Phase 2 cost monitoring cannot backfill it.
- **Trace = one Eve turn.** Not a session (too coarse), not a single model call (too fine).
- **Never sample within a trace.** A partial trace is worse than no trace. Sampling decisions are made once per trace and apply to the whole tree.
- **Preview deployments must never write to `production`.** Environment resolves from `VERCEL_ENV`, never a hand-set flag.
- **Export is best-effort and non-blocking.** Agents must never fail or stall because Langfuse is unreachable.
- **Langfuse OTLP contract:** endpoint `/api/public/otel`, headers `Authorization: Basic base64(pk:sk)` and `x-langfuse-ingestion-version: 4`.
- **TypeScript `strict: true`.** No `any` in exported signatures.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/agent-telemetry/package.json` | Package manifest and deps |
| `packages/agent-telemetry/tsconfig.json` | Strict TS config |
| `packages/agent-telemetry/vitest.config.ts` | Test runner config |
| `src/environment.ts` | Resolve `production`/`staging`/`preview`/`development` |
| `src/auth.ts` | Build Langfuse OTLP auth headers |
| `src/sampling.ts` | Deterministic per-trace head sampling |
| `src/attributes.ts` | Build the standard `langfuse.*` attribute set |
| `src/types.ts` | Shared public types |
| `src/instrumentation.ts` | `createLangfuseInstrumentation()` — the impure shell |
| `src/index.ts` | Public exports |

Pure logic lives in `environment`/`auth`/`sampling`/`attributes` precisely so it can be tested without a running Langfuse or a live Eve process.

---

## Task 1: Package scaffolding

**Files:**
- Create: `packages/agent-telemetry/package.json`
- Create: `packages/agent-telemetry/tsconfig.json`
- Create: `packages/agent-telemetry/vitest.config.ts`
- Create: `packages/agent-telemetry/src/index.ts`
- Create: `packages/agent-telemetry/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a buildable, testable package; `pnpm -C packages/agent-telemetry test` runs Vitest

- [ ] **Step 1: Write the failing test**

`packages/agent-telemetry/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("package", () => {
  it("exposes a version string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/agent-telemetry && pnpm vitest run
```

Expected: FAIL — cannot resolve `../src/index.js`

- [ ] **Step 3: Write minimal implementation**

`packages/agent-telemetry/package.json`:

```json
{
  "name": "@org/agent-telemetry",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
    "@vercel/otel": "^1.10.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.10.0"
  },
  "peerDependencies": { "eve": "*" },
  "peerDependenciesMeta": { "eve": { "optional": true } }
}
```

`packages/agent-telemetry/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"]
}
```

`packages/agent-telemetry/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

`packages/agent-telemetry/src/index.ts`:

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm install && pnpm vitest run
```

Expected: PASS — 1 test passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent-telemetry
git commit -m "feat(telemetry): scaffold @org/agent-telemetry package"
```

---

## Task 2: Environment resolution

**Files:**
- Create: `packages/agent-telemetry/src/environment.ts`
- Create: `packages/agent-telemetry/test/environment.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type LangfuseEnvironment = "production" | "staging" | "preview" | "development"`
  - `resolveEnvironment(env: NodeJS.ProcessEnv): LangfuseEnvironment`

**Why explicit override exists:** Vercel has no native `staging` value for `VERCEL_ENV` — a staging deployment is a *production* deploy of a separate Vercel project. Without `LANGFUSE_ENVIRONMENT`, staging traffic would be indistinguishable from production.

- [ ] **Step 1: Write the failing test**

`packages/agent-telemetry/test/environment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/environment.js";

describe("resolveEnvironment", () => {
  it("maps VERCEL_ENV=production to production", () => {
    expect(resolveEnvironment({ VERCEL_ENV: "production" })).toBe("production");
  });

  it("maps VERCEL_ENV=preview to preview", () => {
    expect(resolveEnvironment({ VERCEL_ENV: "preview" })).toBe("preview");
  });

  it("maps VERCEL_ENV=development to development", () => {
    expect(resolveEnvironment({ VERCEL_ENV: "development" })).toBe("development");
  });

  it("defaults to development when VERCEL_ENV is absent", () => {
    expect(resolveEnvironment({})).toBe("development");
  });

  it("lets LANGFUSE_ENVIRONMENT override VERCEL_ENV (staging has no VERCEL_ENV value)", () => {
    expect(
      resolveEnvironment({ VERCEL_ENV: "production", LANGFUSE_ENVIRONMENT: "staging" }),
    ).toBe("staging");
  });

  it("ignores an invalid LANGFUSE_ENVIRONMENT rather than emitting a bogus environment", () => {
    expect(
      resolveEnvironment({ VERCEL_ENV: "production", LANGFUSE_ENVIRONMENT: "prd" }),
    ).toBe("production");
  });

  it("never resolves a preview deployment to production", () => {
    expect(resolveEnvironment({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("preview");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/environment.test.ts
```

Expected: FAIL — cannot resolve `../src/environment.js`

- [ ] **Step 3: Write minimal implementation**

`packages/agent-telemetry/src/environment.ts`:

```ts
export type LangfuseEnvironment = "production" | "staging" | "preview" | "development";

const VALID: readonly LangfuseEnvironment[] = [
  "production",
  "staging",
  "preview",
  "development",
];

function isValid(value: string | undefined): value is LangfuseEnvironment {
  return value !== undefined && (VALID as readonly string[]).includes(value);
}

/**
 * Resolve the Langfuse environment attribute.
 *
 * Precedence:
 *   1. LANGFUSE_ENVIRONMENT, when it is a valid value. Required for `staging`,
 *      which Vercel cannot express (a staging deploy is VERCEL_ENV=production
 *      of a separate project).
 *   2. VERCEL_ENV.
 *   3. "development".
 *
 * NODE_ENV is deliberately ignored: it is "production" in preview builds and
 * would silently route preview traffic into the production environment.
 */
export function resolveEnvironment(env: NodeJS.ProcessEnv): LangfuseEnvironment {
  const override = env.LANGFUSE_ENVIRONMENT;
  if (isValid(override)) return override;

  switch (env.VERCEL_ENV) {
    case "production":
      return "production";
    case "preview":
      return "preview";
    case "development":
      return "development";
    default:
      return "development";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/environment.test.ts
```

Expected: PASS — 7 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent-telemetry/src/environment.ts packages/agent-telemetry/test/environment.test.ts
git commit -m "feat(telemetry): add environment resolution"
```

---

## Task 3: Langfuse OTLP auth headers

**Files:**
- Create: `packages/agent-telemetry/src/auth.ts`
- Create: `packages/agent-telemetry/test/auth.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `buildAuthHeaders(publicKey: string, secretKey: string): Record<string, string>`, `buildOtlpEndpoint(baseUrl: string): string`

- [ ] **Step 1: Write the failing test**

`packages/agent-telemetry/test/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAuthHeaders, buildOtlpEndpoint } from "../src/auth.js";

describe("buildAuthHeaders", () => {
  it("base64-encodes publicKey:secretKey as HTTP Basic", () => {
    const headers = buildAuthHeaders("pk-lf-abc", "sk-lf-xyz");
    const expected = Buffer.from("pk-lf-abc:sk-lf-xyz").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expected}`);
  });

  it("sets the required Langfuse ingestion version header", () => {
    expect(buildAuthHeaders("pk", "sk")["x-langfuse-ingestion-version"]).toBe("4");
  });

  it("rejects empty credentials rather than emitting an unauthenticated exporter", () => {
    expect(() => buildAuthHeaders("", "sk")).toThrow(/publicKey/);
    expect(() => buildAuthHeaders("pk", "")).toThrow(/secretKey/);
  });
});

describe("buildOtlpEndpoint", () => {
  it("appends the Langfuse OTLP path", () => {
    expect(buildOtlpEndpoint("https://lf.example.com")).toBe(
      "https://lf.example.com/api/public/otel",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(buildOtlpEndpoint("https://lf.example.com/")).toBe(
      "https://lf.example.com/api/public/otel",
    );
  });

  it("rejects a non-URL base", () => {
    expect(() => buildOtlpEndpoint("not-a-url")).toThrow(/baseUrl/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/auth.test.ts
```

Expected: FAIL — cannot resolve `../src/auth.js`

- [ ] **Step 3: Write minimal implementation**

`packages/agent-telemetry/src/auth.ts`:

```ts
/** Build the headers Langfuse's OTLP endpoint requires. */
export function buildAuthHeaders(
  publicKey: string,
  secretKey: string,
): Record<string, string> {
  if (!publicKey) throw new Error("agent-telemetry: publicKey is required");
  if (!secretKey) throw new Error("agent-telemetry: secretKey is required");

  const encoded = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "x-langfuse-ingestion-version": "4",
  };
}

/** Build the Langfuse OTLP trace endpoint from an instance base URL. */
export function buildOtlpEndpoint(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`agent-telemetry: baseUrl is not a valid URL: ${baseUrl}`);
  }
  return `${parsed.origin}/api/public/otel`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/auth.test.ts
```

Expected: PASS — 6 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent-telemetry/src/auth.ts packages/agent-telemetry/test/auth.test.ts
git commit -m "feat(telemetry): add Langfuse OTLP auth and endpoint builders"
```

---

## Task 4: Deterministic per-trace sampling

**Files:**
- Create: `packages/agent-telemetry/src/sampling.ts`
- Create: `packages/agent-telemetry/test/sampling.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `shouldSampleTrace(traceKey: string, rate: number): boolean`

**Why deterministic and keyed on the trace:** sampling must be decided once per trace and produce the same answer for every span in it. A random per-span decision would emit partial traces — worse than no trace, because they mislead. Ships at rate 1.0 (keep everything); the knob exists so a volume spike is a config change, not an emergency refactor.

- [ ] **Step 1: Write the failing test**

`packages/agent-telemetry/test/sampling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldSampleTrace } from "../src/sampling.js";

describe("shouldSampleTrace", () => {
  it("keeps everything at rate 1", () => {
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleTrace(`trace-${i}`, 1)).toBe(true);
    }
  });

  it("drops everything at rate 0", () => {
    for (let i = 0; i < 100; i++) {
      expect(shouldSampleTrace(`trace-${i}`, 0)).toBe(false);
    }
  });

  it("is deterministic — the same key always yields the same decision", () => {
    const first = shouldSampleTrace("turn-abc123", 0.5);
    for (let i = 0; i < 50; i++) {
      expect(shouldSampleTrace("turn-abc123", 0.5)).toBe(first);
    }
  });

  it("approximates the requested rate across many keys", () => {
    const total = 10_000;
    let kept = 0;
    for (let i = 0; i < total; i++) {
      if (shouldSampleTrace(`turn-${i}`, 0.25)) kept++;
    }
    const observed = kept / total;
    expect(observed).toBeGreaterThan(0.22);
    expect(observed).toBeLessThan(0.28);
  });

  it("clamps out-of-range rates instead of throwing", () => {
    expect(shouldSampleTrace("k", 5)).toBe(true);
    expect(shouldSampleTrace("k", -1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/sampling.test.ts
```

Expected: FAIL — cannot resolve `../src/sampling.js`

- [ ] **Step 3: Write minimal implementation**

`packages/agent-telemetry/src/sampling.ts`:

```ts
/** FNV-1a 32-bit hash — small, fast, dependency-free, well-distributed. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Decide whether a trace is sampled.
 *
 * Deterministic in `traceKey` so every span of a trace reaches the same
 * decision. Never sample within a trace: a partial trace misleads a reader
 * into thinking steps did not happen.
 */
export function shouldSampleTrace(traceKey: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return fnv1a(traceKey) / 0x1_0000_0000 < rate;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/sampling.test.ts
```

Expected: PASS — 5 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent-telemetry/src/sampling.ts packages/agent-telemetry/test/sampling.test.ts
git commit -m "feat(telemetry): add deterministic per-trace sampling"
```

---

## Task 5: Standard attribute construction

**Files:**
- Create: `packages/agent-telemetry/src/types.ts`
- Create: `packages/agent-telemetry/src/attributes.ts`
- Create: `packages/agent-telemetry/test/attributes.test.ts`

**Interfaces:**
- Consumes: `LangfuseEnvironment` (Task 2)
- Produces:
  - `interface StandardAttributeInput { project: string; environment: LangfuseEnvironment; agentVersion?: string; userId?: string; sessionId?: string; tags?: string[]; }`
  - `buildStandardAttributes(input: StandardAttributeInput): Record<string, string | string[]>`

This is where the §7.3 required-attribute contract from `CLAUDE.md` becomes executable.

- [ ] **Step 1: Write the failing test**

`packages/agent-telemetry/test/attributes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildStandardAttributes } from "../src/attributes.js";

const base = { project: "support-agent", environment: "production" } as const;

describe("buildStandardAttributes", () => {
  it("always sets project and environment", () => {
    const attrs = buildStandardAttributes({ ...base });
    expect(attrs["langfuse.environment"]).toBe("production");
    expect(attrs["langfuse.trace.metadata.project"]).toBe("support-agent");
  });

  it("maps session and user to the documented Langfuse attributes", () => {
    const attrs = buildStandardAttributes({
      ...base,
      sessionId: "eve-session-1",
      userId: "user-42",
    });
    expect(attrs["langfuse.session.id"]).toBe("eve-session-1");
    expect(attrs["langfuse.user.id"]).toBe("user-42");
  });

  it("maps agentVersion to release and version for regression attribution", () => {
    const attrs = buildStandardAttributes({ ...base, agentVersion: "abc1234" });
    expect(attrs["langfuse.release"]).toBe("abc1234");
    expect(attrs["langfuse.version"]).toBe("abc1234");
  });

  it("always includes project and environment as tags for dashboard filtering", () => {
    const attrs = buildStandardAttributes({ ...base, tags: ["channel:slack"] });
    expect(attrs["langfuse.trace.tags"]).toEqual(
      expect.arrayContaining(["project:support-agent", "env:production", "channel:slack"]),
    );
  });

  it("omits absent optional attributes rather than emitting empty strings", () => {
    const attrs = buildStandardAttributes({ ...base });
    expect(attrs).not.toHaveProperty("langfuse.user.id");
    expect(attrs).not.toHaveProperty("langfuse.session.id");
    expect(attrs).not.toHaveProperty("langfuse.release");
  });

  it("deduplicates tags", () => {
    const attrs = buildStandardAttributes({ ...base, tags: ["env:production"] });
    const tags = attrs["langfuse.trace.tags"] as string[];
    expect(tags.filter((t) => t === "env:production")).toHaveLength(1);
  });

  it("rejects an empty project name", () => {
    expect(() => buildStandardAttributes({ ...base, project: "" })).toThrow(/project/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/attributes.test.ts
```

Expected: FAIL — cannot resolve `../src/attributes.js`

- [ ] **Step 3: Write minimal implementation**

`packages/agent-telemetry/src/types.ts`:

```ts
import type { LangfuseEnvironment } from "./environment.js";

export interface StandardAttributeInput {
  /** Agent project slug. Matches the Langfuse project. */
  project: string;
  environment: LangfuseEnvironment;
  /** Git SHA or release identifier. Enables regression attribution. */
  agentVersion?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
}

export interface AgentTelemetryOptions {
  /** Agent project slug. Must match the provisioned Langfuse project. */
  project: string;
  /** Git SHA. Defaults to VERCEL_GIT_COMMIT_SHA. */
  agentVersion?: string;
  /** Overrides automatic environment resolution. Rarely needed. */
  environment?: LangfuseEnvironment;
  /** Head sampling rate, 0..1. Defaults to 1 (keep everything). */
  sampleRate?: number;
  /** Record full message history per step. Defaults to true. */
  recordInputs?: boolean;
  /** Record model outputs on spans. Defaults to true. */
  recordOutputs?: boolean;
  /** Langfuse base URL. Defaults to LANGFUSE_BASE_URL. */
  baseUrl?: string;
}
```

`packages/agent-telemetry/src/attributes.ts`:

```ts
import type { StandardAttributeInput } from "./types.js";

/**
 * Build the standard Langfuse attribute set required on every trace.
 * Mirrors the required-attribute contract in CLAUDE.md §7.3.
 */
export function buildStandardAttributes(
  input: StandardAttributeInput,
): Record<string, string | string[]> {
  if (!input.project) {
    throw new Error("agent-telemetry: project is required");
  }

  const attrs: Record<string, string | string[]> = {
    "langfuse.environment": input.environment,
    "langfuse.trace.metadata.project": input.project,
  };

  if (input.sessionId) attrs["langfuse.session.id"] = input.sessionId;
  if (input.userId) attrs["langfuse.user.id"] = input.userId;
  if (input.agentVersion) {
    attrs["langfuse.release"] = input.agentVersion;
    attrs["langfuse.version"] = input.agentVersion;
  }

  attrs["langfuse.trace.tags"] = [
    ...new Set([
      `project:${input.project}`,
      `env:${input.environment}`,
      ...(input.tags ?? []),
    ]),
  ];

  return attrs;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/attributes.test.ts
```

Expected: PASS — 7 tests passed

- [ ] **Step 5: Commit**

```bash
git add packages/agent-telemetry/src/types.ts packages/agent-telemetry/src/attributes.ts packages/agent-telemetry/test/attributes.test.ts
git commit -m "feat(telemetry): add standard Langfuse attribute construction"
```

---

## Task 6: `createLangfuseInstrumentation()` — the public entry point

**Files:**
- Create: `packages/agent-telemetry/src/instrumentation.ts`
- Modify: `packages/agent-telemetry/src/index.ts`
- Create: `packages/agent-telemetry/test/instrumentation.test.ts`

**Interfaces:**
- Consumes: `resolveEnvironment` (Task 2), `buildAuthHeaders`/`buildOtlpEndpoint` (Task 3), `shouldSampleTrace` (Task 4), `buildStandardAttributes` (Task 5), `AgentTelemetryOptions` (Task 5)
- Produces: `createLangfuseInstrumentation(options: AgentTelemetryOptions)` returning `{ setup, recordInputs, recordOutputs, events }` — the object Eve's `defineInstrumentation()` accepts

- [ ] **Step 1: Write the failing test**

`packages/agent-telemetry/test/instrumentation.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLangfuseInstrumentation } from "../src/instrumentation.js";

const env = {
  LANGFUSE_BASE_URL: "https://lf.example.com",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
};

afterEach(() => vi.unstubAllEnvs());

function stub(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
}

describe("createLangfuseInstrumentation", () => {
  it("returns an Eve-compatible instrumentation object", () => {
    stub(env);
    const instr = createLangfuseInstrumentation({ project: "pilot-agent" });
    expect(typeof instr.setup).toBe("function");
    expect(typeof instr.events["step.started"]).toBe("function");
  });

  it("defaults to recording inputs and outputs", () => {
    stub(env);
    const instr = createLangfuseInstrumentation({ project: "pilot-agent" });
    expect(instr.recordInputs).toBe(true);
    expect(instr.recordOutputs).toBe(true);
  });

  it("honours explicit recording opt-out", () => {
    stub(env);
    const instr = createLangfuseInstrumentation({
      project: "pilot-agent",
      recordInputs: false,
      recordOutputs: false,
    });
    expect(instr.recordInputs).toBe(false);
    expect(instr.recordOutputs).toBe(false);
  });

  it("throws when credentials are missing rather than silently dropping traces", () => {
    vi.stubEnv("LANGFUSE_BASE_URL", "https://lf.example.com");
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    expect(() => createLangfuseInstrumentation({ project: "pilot-agent" })).toThrow(
      /LANGFUSE_PUBLIC_KEY/,
    );
  });

  it("stamps standard attributes onto every step via runtimeContext", () => {
    stub({ ...env, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "deadbee" });
    const instr = createLangfuseInstrumentation({ project: "pilot-agent" });

    const result = instr.events["step.started"]({
      session: { id: "sess-1", userId: "user-9" },
      turn: { id: "turn-1" },
      step: { index: 0 },
      channel: { kind: "web", metadata: {} },
      modelInput: {},
    });

    expect(result.runtimeContext["langfuse.environment"]).toBe("preview");
    expect(result.runtimeContext["langfuse.session.id"]).toBe("sess-1");
    expect(result.runtimeContext["langfuse.user.id"]).toBe("user-9");
    expect(result.runtimeContext["langfuse.release"]).toBe("deadbee");
  });

  it("never resolves a preview deployment to the production environment", () => {
    stub({ ...env, VERCEL_ENV: "preview", NODE_ENV: "production" });
    const instr = createLangfuseInstrumentation({ project: "pilot-agent" });
    const result = instr.events["step.started"]({
      session: { id: "s" },
      turn: { id: "t" },
      step: { index: 0 },
      channel: { kind: "web", metadata: {} },
      modelInput: {},
    });
    expect(result.runtimeContext["langfuse.environment"]).toBe("preview");
  });

  it("applies the same sampling decision to every step of one turn", () => {
    stub(env);
    const instr = createLangfuseInstrumentation({ project: "pilot-agent", sampleRate: 0.5 });
    const call = (index: number) =>
      instr.events["step.started"]({
        session: { id: "s" },
        turn: { id: "turn-stable" },
        step: { index },
        channel: { kind: "web", metadata: {} },
        modelInput: {},
      }).runtimeContext["langfuse.sampled"];

    const first = call(0);
    for (let i = 1; i < 20; i++) expect(call(i)).toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/instrumentation.test.ts
```

Expected: FAIL — cannot resolve `../src/instrumentation.js`

- [ ] **Step 3: Write minimal implementation**

`packages/agent-telemetry/src/instrumentation.ts`:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerOTel } from "@vercel/otel";

import { buildAuthHeaders, buildOtlpEndpoint } from "./auth.js";
import { buildStandardAttributes } from "./attributes.js";
import { resolveEnvironment } from "./environment.js";
import { shouldSampleTrace } from "./sampling.js";
import type { AgentTelemetryOptions } from "./types.js";

/** Shape Eve passes to the `step.started` event callback. */
export interface StepStartedInput {
  session: { id: string; userId?: string };
  turn: { id: string };
  step: { index: number };
  channel: { kind: string; metadata: Record<string, unknown> };
  modelInput: unknown;
}

export interface StepStartedResult {
  runtimeContext: Record<string, string | string[] | boolean>;
}

export interface LangfuseInstrumentation {
  setup: (context: { agentName: string }) => void;
  recordInputs: boolean;
  recordOutputs: boolean;
  events: {
    "step.started": (input: StepStartedInput) => StepStartedResult;
  };
}

/**
 * Build the Langfuse instrumentation object for an Eve agent.
 *
 * Usage in `agent/instrumentation.ts`:
 *
 *   import { createLangfuseInstrumentation } from "@org/agent-telemetry";
 *   export default createLangfuseInstrumentation({ project: "support-agent" });
 */
export function createLangfuseInstrumentation(
  options: AgentTelemetryOptions,
): LangfuseInstrumentation {
  const env = process.env;

  const baseUrl = options.baseUrl ?? env.LANGFUSE_BASE_URL;
  if (!baseUrl) throw new Error("agent-telemetry: LANGFUSE_BASE_URL is required");

  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey) throw new Error("agent-telemetry: LANGFUSE_PUBLIC_KEY is required");
  if (!secretKey) throw new Error("agent-telemetry: LANGFUSE_SECRET_KEY is required");

  const environment = options.environment ?? resolveEnvironment(env);
  const agentVersion = options.agentVersion ?? env.VERCEL_GIT_COMMIT_SHA;
  const sampleRate = options.sampleRate ?? 1;

  return {
    recordInputs: options.recordInputs ?? true,
    recordOutputs: options.recordOutputs ?? true,

    setup: ({ agentName }) => {
      registerOTel({
        serviceName: agentName,
        traceExporter: new OTLPTraceExporter({
          url: buildOtlpEndpoint(baseUrl),
          headers: buildAuthHeaders(publicKey, secretKey),
        }),
      });
    },

    events: {
      "step.started": (input) => {
        const attrs = buildStandardAttributes({
          project: options.project,
          environment,
          agentVersion,
          sessionId: input.session.id,
          userId: input.session.userId,
          tags: [`channel:${input.channel.kind}`],
        });

        return {
          runtimeContext: {
            ...attrs,
            // Decided once per turn, so every step of a trace agrees.
            "langfuse.sampled": shouldSampleTrace(input.turn.id, sampleRate),
          },
        };
      },
    },
  };
}
```

`packages/agent-telemetry/src/index.ts`:

```ts
export const VERSION = "0.1.0";

export { createLangfuseInstrumentation } from "./instrumentation.js";
export type {
  LangfuseInstrumentation,
  StepStartedInput,
  StepStartedResult,
} from "./instrumentation.js";
export { resolveEnvironment } from "./environment.js";
export type { LangfuseEnvironment } from "./environment.js";
export { buildStandardAttributes } from "./attributes.js";
export { shouldSampleTrace } from "./sampling.js";
export type { AgentTelemetryOptions, StandardAttributeInput } from "./types.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run && pnpm typecheck
```

Expected: PASS — all tests pass, no type errors

- [ ] **Step 5: Commit**

```bash
git add packages/agent-telemetry/src packages/agent-telemetry/test
git commit -m "feat(telemetry): add createLangfuseInstrumentation entry point"
```

---

## Task 7: Pilot integration and real-trace audit

**Files:**
- Create: `agent/instrumentation.ts` (in the pilot Eve project)
- Create: `docs/TRACING-STANDARD.md`

**Interfaces:**
- Consumes: `createLangfuseInstrumentation` (Task 6); pilot project credentials from Stage 1A Task 7
- Produces: a verified, audited trace in Langfuse

**This task is where the plan is proven.** Instrumentation is not done when the code compiles — it is done when a real trace clears the best-practices audit.

- [ ] **Step 1: Integrate into the pilot Eve project**

`agent/instrumentation.ts`:

```ts
import { defineInstrumentation } from "eve/instrumentation";
import { createLangfuseInstrumentation } from "@org/agent-telemetry";

export default defineInstrumentation(
  createLangfuseInstrumentation({ project: "pilot-agent" }),
);
```

Set in the Vercel project (per environment): `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`.

- [ ] **Step 2: Execute the instrumented path end-to-end**

Run a real agent turn that includes at least one model call, one tool call, and — if the agent has
them — one subagent dispatch. A trivial turn will not exercise the structure that matters.

- [ ] **Step 3: Fetch the trace back and audit it**

```bash
npx langfuse-cli api traces list --limit 1
npx langfuse-cli api traces get <trace-id>
```

Then **fetch the guidance fresh — never audit from memory:**

```bash
curl -s https://langfuse.com/docs/observability/best-practices
```

Audit against the §7 contract in `CLAUDE.md`:

- [ ] Trace = one Eve turn (not a session, not a single call)
- [ ] `langfuse.session.id` present and equal to the Eve session id
- [ ] `langfuse.user.id` present where the channel has auth
- [ ] `langfuse.environment` correct for the deployment
- [ ] `langfuse.release` = git SHA
- [ ] Trace name is semantic (`support.turn`), not generic (`trace-1`)
- [ ] Model name captured on every generation
- [ ] **Token usage present on every generation** *(blocking — Phase 2 depends on it)*
- [ ] Tool calls typed `tool`, siblings of the generation that requested them — **not children**
- [ ] Retrieval typed `retriever`, not a generic `tool`
- [ ] Subagents typed `agent`, nested recursively, with distinct names
- [ ] No duplicate dispatch + execution nodes for one subagent
- [ ] No full tool JSON schemas repeated per call
- [ ] Message-history payload growth measured across a multi-step turn (CLAUDE.md §7.5)

- [ ] **Step 4: Fix every gap, re-run, re-fetch**

Repeat steps 2–3 until the trace clears. Record what was audited and changed.

- [ ] **Step 5: Verify serverless and preview behaviour**

```bash
# Deploy to a Vercel PREVIEW deployment, run a turn, then:
npx langfuse-cli api traces list --limit 5
```

- [ ] Traces from the preview deployment carry `langfuse.environment=preview`
- [ ] **No preview trace carries `production`**
- [ ] Traces arrive at all — confirming spans flush before the function returns (CLAUDE.md §6.3). If
      traces are missing here but present locally, the flush lifecycle is the cause; fix before rollout.

- [ ] **Step 6: Document the standard and commit**

Write `docs/TRACING-STANDARD.md`: the Eve→Langfuse mapping table, the required attributes, the
observation-typing rules, the do-not-trace list, and a link to the audited reference trace.

```bash
git add agent/instrumentation.ts docs/TRACING-STANDARD.md
git commit -m "feat(telemetry): integrate pilot agent and document tracing standard"
```

---

## Exit criteria for Stage 1B

- [ ] All unit tests pass; `pnpm typecheck` clean
- [ ] Pilot Eve project integrates in ≤ 5 lines
- [ ] A real trace has been fetched back and audited against freshly-fetched best practices
- [ ] Trace structure matches the §7.1 mapping
- [ ] **Token usage present on every generation**
- [ ] Subagents typed `agent` and appear in the Agent Graph
- [ ] Preview deployments confirmed writing to `preview`, never `production`
- [ ] Serverless flush verified on a real Vercel deployment
- [ ] Message-history payload multiplier measured and recorded
- [ ] `docs/TRACING-STANDARD.md` written

**Then proceed to** Stage 1D (measurement) before writing Stage 1C.

---

## Known gaps carried forward

| Gap | Why deferred |
|---|---|
| Masking hook not implemented | No real PII today (CLAUDE.md requirement 6). The `recordInputs`/`recordOutputs` switches cover the immediate control; a `mask` option is added when a project needs it |
| `langfuse.sampled` is advisory | The attribute is emitted but no exporter-level sampler drops spans yet. Wire a `Sampler` when Stage 1D shows volume requires it — the decision function is already tested |
| Cost attributes not set | `langfuse.observation.cost_details` is Phase 2. Token usage (the input Phase 2 needs) ships now |
