import type {
  CountVerifier,
  NetworkVerifier,
  NoFailedRequestsVerifier,
  TextMatcher,
  UrlMatcher,
  Verifier,
} from "../schema/verifier.v1";
import {
  isConsoleVerifier,
  isCountVerifier,
  isHttpJsonVerifier,
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
  isNotTextVerifier,
  isScriptVerifier,
  isTextVerifier,
  isUrlVerifier,
  notTextVerifierRegion,
  textVerifierRegion,
} from "../schema/verifier.v1";
import type {
  BatchSubStep,
  ClickUntil,
  Locator,
  NetworkPostcondition,
  Outcome,
  Spec,
  Step,
} from "../schema/spec.v1";
import { clickLocator, withoutPostcondition } from "../schema/spec.v1";
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { bodyTextContainsExpression } from "../textMatching";
import {
  blank,
  block,
  braces,
  comment,
  iff,
  print,
  raw,
  tryCatch,
  verbatim,
  type Stmt,
} from "./codegen";
import {
  emitStr,
  emitValue,
  hasRefSentinel,
  newRefUsage,
  type RefUsage,
} from "./templateValue";
import { playwrightTestTimeoutBudget } from "./playwrightTimeout";

export type ExportLang = "ts" | "js";

export interface ExportPlaywrightOptions {
  /** Path to the source spec; included in the generated file's header comment. */
  sourcePath?: string;
  /**
   * Path the generated file will be written to. When set, script.file
   * verifier imports are emitted RELATIVE to it (portable across machines);
   * otherwise they fall back to absolute paths.
   */
  outPath?: string;
  /** Override the test title. Defaults to spec.name. */
  testTitle?: string;
  /** Emit TypeScript (default) or plain JavaScript. */
  lang?: ExportLang;
}

export interface ExportCoverageSkip {
  kind: "step" | "outcome" | "when";
  id?: string;
  reason: string;
}

export interface ExportCoverage {
  stepsTotal: number;
  stepsExported: number;
  outcomesTotal: number;
  outcomesExported: number;
  skips: ExportCoverageSkip[];
}

export interface ExportPlaywrightResult {
  source: string;
  lang: ExportLang;
  coverage: ExportCoverage;
  /** Env var names the generated test reads at runtime (late-bound secrets). */
  requiredEnv: string[];
  /** Preconditions that must run before the test (not exportable to Playwright). */
  preconditions: string[];
}

/**
 * Generate a @playwright/test source file from a Cairntrace spec.
 *
 * Architecture (three layers, each owning one concern):
 *  - render*() functions map spec constructs to a statement IR (codegen.ts) —
 *    they decide WHAT code exists, never how it is indented or quoted;
 *  - emitStr()/emitValue() (templateValue.ts) own string quoting and turn
 *    late-bound sentinels (`${secrets.X}`, unset `${env.X}`, `${run.token}`)
 *    into `process.env.X` / RUN_TOKEN splices at the exact emission site;
 *  - print() (codegen.ts) owns indentation and line joining.
 *
 * Steps map to Playwright actions; outcomes map to expect() assertions.
 * Listener-based outcomes (network / noFailedRequests / console) install
 * collectors at the top of the test before any actions, then assert at the end.
 *
 * Output is meant to live in a separate Playwright project; this function
 * doesn't write files — the CLI does. Spec must have `use:` already expanded
 * (run `parseSpec` first and pass `result.resolved`).
 */
export function exportPlaywright(
  spec: Spec,
  opts: ExportPlaywrightOptions = {},
): ExportPlaywrightResult {
  const lang: ExportLang = opts.lang ?? "ts";
  const title = opts.testTitle ?? spec.name;
  const steps = spec.steps ?? [];
  const coverage: ExportCoverage = {
    stepsTotal: steps.length,
    stepsExported: 0,
    outcomesTotal: spec.outcomes.length,
    outcomesExported: 0,
    skips: [],
  };
  const ctx: EmitCtx = {
    lang,
    coverage,
    usage: newRefUsage(),
    ...(opts.sourcePath ? { specDir: dirname(resolve(opts.sourcePath)) } : {}),
    ...(opts.outPath ? { outDir: dirname(resolve(opts.outPath)) } : {}),
    postconditionCounter: 0,
  };
  const timeoutBudget = playwrightTestTimeoutBudget(spec);
  const needsNodeVerifierEvidence =
    ctx.specDir !== undefined && hasNodeFileVerifier(spec);
  if (needsNodeVerifierEvidence) {
    ctx.nodeVerifierRunDir = "cairnRunDir";
    ctx.nodeVerifierEvidence = "cairnNetworkEvidence";
  }

  // ----- test body (rendered FIRST so ctx.usage knows every late-bound ref
  // before the header is assembled) -----
  const body: Stmt[] = [];

  body.push(
    comment(`Derived from sequential step/outcome budgets; bounded to 30m–4h.`),
    ...(timeoutBudget.capped
      ? [
          comment(
            `WARNING: authored budgets exceed the 4h export ceiling; split this spec.`,
          ),
        ]
      : []),
    raw(`test.setTimeout(${timeoutBudget.timeoutMs});`),
    blank,
  );
  const evidenceInsertAt = body.length;

  body.push(...renderOutcomeEvidenceSetup(spec, lang));

  if (steps.length > 0) {
    body.push(comment(`--- steps ---`));
    for (const step of steps) {
      const rendered = renderStep(step, spec.settleMs, ctx);
      if (rendered.exported) coverage.stepsExported += 1;
      body.push(...rendered.stmts);
    }
    body.push(blank);
  }

  body.push(comment(`--- outcomes (the contract) ---`));
  for (const outcome of spec.outcomes) {
    body.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
    const rendered = renderOutcome(outcome, ctx);
    if (rendered.exported) coverage.outcomesExported += 1;
    body.push(...rendered.stmts, blank);
  }

  if (needsNodeVerifierEvidence) {
    body.splice(
      evidenceInsertAt,
      0,
      ...renderNodeVerifierEvidenceSetup(spec, ctx),
    );
  }

  // ----- file assembly -----
  const file: Stmt[] = [];
  const envNames = [...ctx.usage.envNames].toSorted();
  if (envNames.length > 0) {
    file.push(
      comment(
        `Secrets are NOT inlined — set before running: ${envNames.join(", ")}`,
      ),
    );
  }
  file.push(
    comment(
      `Generated by Cairntrace \`cairn export playwright\`. Edit at your own risk —`,
    ),
    comment(
      `re-running export will overwrite. Source: ${opts.sourcePath ?? "<unknown>"}`,
    ),
    comment(`Intent: ${oneLine(spec.intent)}`),
    comment(`Lang: ${lang}`),
  );

  const preCommands = spec.preconditions?.commands ?? [];
  const preconditionLines: string[] = [];
  if (preCommands.length > 0) {
    // Preconditions run OUTSIDE the browser (shell/mongo resets, pipeline
    // gates) and have no Playwright equivalent — surface them so a CI wrapper
    // (globalSetup or a shell step) can run them before the test.
    skip(
      ctx,
      "step",
      `${preCommands.length} precondition command(s) not exported — run them before the test`,
      "preconditions",
    );
    file.push(
      comment(``),
      comment(
        `⚠ PRECONDITIONS (NOT exported — run these before the test, e.g. in globalSetup):`,
      ),
    );
    for (const c of preCommands) {
      const cmd = typeof c === "string" ? c : c.run;
      const name = typeof c === "string" ? undefined : c.name;
      const line = `${name ? `[${name}] ` : ""}${oneLine(cmd).slice(0, 160)}`;
      preconditionLines.push(line);
      file.push(comment(`  ${line}`));
    }
  }

  file.push(blank, raw(`import { expect, test } from "@playwright/test";`));
  if (needsNodeVerifierEvidence) {
    file.push(
      blank,
      verbatim(renderNodeVerifierEvidenceRuntime(lang).trimEnd().split("\n")),
    );
  }
  if (ctx.usage.runToken) {
    // Late-bound `${run.token}`: unique per Playwright invocation so exported
    // tests remain re-runnable (unique values keep emitting change events).
    file.push(
      blank,
      raw(
        `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random().toString(36).slice(2, 10);`,
      ),
    );
  }
  file.push(
    blank,
    block(
      `test(${JSON.stringify(title)}, async ({ page }${
        needsNodeVerifierEvidence ? ", testInfo" : ""
      }) => {`,
      body,
      `});`,
    ),
  );

  return {
    source: `${print(file)}\n`,
    lang,
    coverage,
    requiredEnv: envNames,
    preconditions: preconditionLines,
  };
}

export function hasNodeFileVerifier(spec: Spec): boolean {
  return spec.outcomes.some(
    (outcome) =>
      isScriptVerifier(outcome.verify) &&
      outcome.verify.script.runtime === "node" &&
      outcome.verify.script.file !== undefined,
  );
}

/**
 * Install every listener-backed evidence collector before the first step.
 * Both single-file and project exports use this helper so rendering a network
 * or console outcome can never drift away from declaring its backing buffer.
 */
export function renderOutcomeEvidenceSetup(
  spec: Spec,
  lang: ExportLang,
): Stmt[] {
  const stmts: Stmt[] = [];
  const needsNetwork = spec.outcomes.some(
    (outcome) =>
      isNetworkVerifier(outcome.verify) ||
      isNoFailedRequestsVerifier(outcome.verify),
  );
  const needsConsole = spec.outcomes.some((outcome) =>
    isConsoleVerifier(outcome.verify),
  );

  if (needsNetwork) {
    const typeAnn =
      lang === "ts"
        ? `: Array<{ url: string; method: string; status?: number }>`
        : "";
    stmts.push(
      raw(`const requests${typeAnn} = [];`),
      raw(
        `page.on("response", (r) => requests.push({ url: r.url(), method: r.request().method(), status: r.status() }));`,
      ),
      blank,
    );
  }
  if (needsConsole) {
    const typeAnn = lang === "ts" ? `: string[]` : "";
    stmts.push(
      raw(`const consoleErrors${typeAnn} = [];`),
      raw(
        `page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });`,
      ),
      raw(`page.on("pageerror", (e) => consoleErrors.push(e.message));`),
      blank,
    );
  }

  return stmts;
}

export function renderNodeVerifierEvidenceSetup(
  spec: Spec,
  ctx: EmitCtx,
): Stmt[] {
  const redaction = spec.redaction;
  const emitArray = (values: string[] | undefined): string =>
    `[${(values ?? []).map((value) => emitValue(value, ctx.usage)).join(", ")}]`;
  const configuredValues = emitArray(redaction?.values);
  const headers = emitArray(redaction?.headers);
  const queryParams = emitArray(redaction?.queryParams);
  const storageKeys = emitArray(redaction?.storageKeys);
  // Every late-bound env reference may be a vault secret even when its name is
  // innocuous (MONGO_URI, DATABASE_URL, ...). Feed its runtime value into the
  // artifact scrubber without ever writing that value into generated source.
  const lateBoundValues = [...ctx.usage.envNames]
    .toSorted()
    .map((name) => `process.env[${JSON.stringify(name)}] ?? ""`);
  const values = [`...${configuredValues}`, ...lateBoundValues].join(", ");

  return [
    comment(
      `Node verifiers consume a self-contained, sanitized Cairn-compatible run directory.`,
    ),
    raw(`const ${ctx.nodeVerifierRunDir} = testInfo.outputPath("cairn-run");`),
    raw(
      `const ${ctx.nodeVerifierEvidence} = createCairnNetworkEvidence(page, { headers: ${headers}, queryParams: ${queryParams}, storageKeys: ${storageKeys}, values: [${values}] });`,
    ),
    blank,
  ];
}

/**
 * Self-contained runtime embedded into exported tests that invoke node file
 * verifiers. It intentionally captures no headers and only retains bounded,
 * valid JSON request bodies after recursive redaction.
 */
export function renderNodeVerifierEvidenceRuntime(lang: ExportLang): string {
  const ts = lang === "ts";
  const lines = [
    `// Cairn-compatible network evidence for exported node verifiers.`,
    ...(ts
      ? [
          `interface CairnEvidenceRequest {`,
          `  url(): string;`,
          `  method(): string;`,
          `  postData(): string | null;`,
          `  headers(): Record<string, string>;`,
          `}`,
          `interface CairnEvidenceResponse {`,
          `  request(): CairnEvidenceRequest;`,
          `  status(): number;`,
          `}`,
          `interface CairnEvidencePage {`,
          `  on(event: "request", listener: (request: CairnEvidenceRequest) => void): unknown;`,
          `  on(event: "response", listener: (response: CairnEvidenceResponse) => void): unknown;`,
          `  on(event: "requestfinished", listener: (request: CairnEvidenceRequest) => void): unknown;`,
          `  on(event: "requestfailed", listener: (request: CairnEvidenceRequest) => void): unknown;`,
          `}`,
          `interface CairnEvidenceRedaction {`,
          `  headers?: string[];`,
          `  queryParams?: string[];`,
          `  storageKeys?: string[];`,
          `  values?: string[];`,
          `  responseTimeoutMs?: number;`,
          `}`,
          `interface CairnNetworkEntry {`,
          `  url: string;`,
          `  method: string;`,
          `  timestamp: number;`,
          `  responseTimestamp?: number;`,
          `  durationMs?: number;`,
          `  status?: number;`,
          `  error?: string;`,
          `  postData?: string;`,
          `  postDataBytes?: number;`,
          `  postDataTruncated?: boolean;`,
          `  postDataOmittedReason?: "non-json" | "invalid-json" | "oversized" | "capture-error";`,
          `}`,
          `interface CairnApiRequestEvidence {`,
          `  url: string;`,
          `  method: string;`,
          `  status?: number;`,
          `  timestamp?: number;`,
          `  body?: unknown;`,
          `  contentType?: string;`,
          `}`,
        ]
      : []),
    `const CAIRN_MAX_JSON_POST_DATA_BYTES = 64 * 1024;`,
    `const CAIRN_PATCH_RESPONSE_TIMEOUT_MS = 120_000;`,
    `const CAIRN_SENSITIVE_NAME_RE = /authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|code[_-]?verifier|otp|passcode|credential|assertion/i;`,
    ``,
    `export function createCairnNetworkEvidence(page${
      ts ? ": CairnEvidencePage" : ""
    }, redaction${ts ? ": CairnEvidenceRedaction" : ""} = {}) {`,
    `  const entries${ts ? ": CairnNetworkEntry[]" : ""} = [];`,
    `  const byRequest = new WeakMap${
      ts ? "<CairnEvidenceRequest, CairnNetworkEntry>" : ""
    }();`,
    `  const pendingPatches = new Map${
      ts
        ? "<CairnEvidenceRequest, { promise: Promise<void>; resolve: () => void }>"
        : ""
    }();`,
    `  const responseTimeoutMs = Math.max(1, redaction.responseTimeoutMs ?? CAIRN_PATCH_RESPONSE_TIMEOUT_MS);`,
    `  const configuredNames = new Set(`,
    `    [...(redaction.headers ?? []), ...(redaction.storageKeys ?? [])]`,
    `      .map((name) => name.trim().toLowerCase())`,
    `      .filter(Boolean),`,
    `  );`,
    `  const configuredQueryParams = new Set(`,
    `    (redaction.queryParams ?? [])`,
    `      .map((name) => name.trim().toLowerCase())`,
    `      .filter(Boolean),`,
    `  );`,
    `  const explicitSecrets = (redaction.values ?? [])`,
    `    .map((value) => String(value ?? "").trim())`,
    `    .filter(Boolean);`,
    `  const ambientSecrets = Object.entries(process.env)`,
    `    .filter(([key, value]) => key !== "CAIRN_RUN_TOKEN" && value && CAIRN_SENSITIVE_NAME_RE.test(key))`,
    `    .map((entry) => String(entry[1] ?? "").trim())`,
    `    .filter(Boolean);`,
    `  const literalSecrets = [...new Set([...explicitSecrets, ...ambientSecrets])]`,
    `    .map((value) => String(value ?? "").trim())`,
    `    .filter(Boolean)`,
    `    .sort((a, b) => b.length - a.length);`,
    ``,
    `  const isSensitiveName = (name${ts ? ": string" : ""}) =>`,
    `    CAIRN_SENSITIVE_NAME_RE.test(name) || configuredNames.has(name.toLowerCase());`,
    `  const redactLiteralText = (input${ts ? ": string" : ""}) => {`,
    `    let output = input;`,
    `    for (const secret of literalSecrets) output = output.split(secret).join("[redacted]");`,
    `    return output;`,
    `  };`,
    `  const redactUrl = (input${ts ? ": string" : ""}) => {`,
    `    const scrubbed = redactLiteralText(input);`,
    `    const hasAbsoluteScheme = /^[a-z][a-z\\d+.-]*:/i.test(scrubbed);`,
    `    const isProtocolRelative = scrubbed.startsWith("//");`,
    `    try {`,
    `      const parsed = new URL(scrubbed, "http://cairn.invalid");`,
    `      const safeParams = new URLSearchParams();`,
    `      for (const [key, value] of parsed.searchParams.entries()) {`,
    `        const safeValue =`,
    `          CAIRN_SENSITIVE_NAME_RE.test(key) || configuredQueryParams.has(key.toLowerCase())`,
    `            ? "[redacted]"`,
    `            : redactLiteralText(value);`,
    `        safeParams.append(key, safeValue);`,
    `      }`,
    `      parsed.search = safeParams.toString();`,
    `      if (hasAbsoluteScheme) return parsed.toString();`,
    `      if (isProtocolRelative) return "//" + parsed.host + parsed.pathname + parsed.search + parsed.hash;`,
    `      return parsed.pathname + parsed.search + parsed.hash;`,
    `    } catch {`,
    `      return "[redacted]";`,
    `    }`,
    `  };`,
    `  const redactValue = (input${ts ? ": unknown" : ""})${
      ts ? ": unknown" : ""
    } => {`,
    `    if (typeof input === "string") return redactLiteralText(input);`,
    `    if (input === null || typeof input !== "object") return input;`,
    `    if (Array.isArray(input)) return input.map(redactValue);`,
    `    const record = input${ts ? " as Record<string, unknown>" : ""};`,
    `    const namedValueIsSensitive =`,
    `      typeof record.name === "string" &&`,
    `      (isSensitiveName(record.name) || configuredQueryParams.has(record.name.toLowerCase()));`,
    `    return Object.fromEntries(`,
    `      Object.entries(record).map(([key, value]) => [`,
    `        key,`,
    `        isSensitiveName(key) || (namedValueIsSensitive && key.toLowerCase() === "value")`,
    `          ? "[redacted]"`,
    `          : redactValue(value),`,
    `      ]),`,
    `    );`,
    `  };`,
    `  const captureJsonPostData = (raw${
      ts ? ": string | null" : ""
    }, contentType${ts ? ": string | undefined" : ""})${
      ts ? ": Partial<CairnNetworkEntry>" : ""
    } => {`,
    `    if (raw === null) return {};`,
    `    const bytes = new TextEncoder().encode(raw).byteLength;`,
    `    if (!contentType || !/(?:\\/|\\+)json(?:\\b|;)/i.test(contentType)) {`,
    `      return { postDataBytes: bytes, postDataOmittedReason: "non-json" };`,
    `    }`,
    `    if (bytes > CAIRN_MAX_JSON_POST_DATA_BYTES) {`,
    `      return { postDataBytes: bytes, postDataTruncated: true, postDataOmittedReason: "oversized" };`,
    `    }`,
    `    try {`,
    `      return { postData: JSON.stringify(redactValue(JSON.parse(raw))) };`,
    `    } catch {`,
    `      return { postDataBytes: bytes, postDataOmittedReason: "invalid-json" };`,
    `    }`,
    `  };`,
    `  const captureRequest = (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const timestamp = Date.now();`,
    `    let entry${ts ? ": CairnNetworkEntry" : ""};`,
    `    try {`,
    `      const headers = request.headers();`,
    `      entry = {`,
    `        url: redactUrl(request.url()),`,
    `        method: request.method().toUpperCase(),`,
    `        timestamp,`,
    `        ...captureJsonPostData(request.postData(), headers["content-type"]),`,
    `      };`,
    `    } catch {`,
    `      entry = {`,
    `        url: "[redacted]",`,
    `        method: "UNKNOWN",`,
    `        timestamp,`,
    `        postDataOmittedReason: "capture-error",`,
    `      };`,
    `    }`,
    `    entries.push(entry);`,
    `    byRequest.set(request, entry);`,
    `    if (entry.method === "PATCH") {`,
    `      let resolveCompletion${ts ? ": () => void" : ""} = () => {};`,
    `      const promise = new Promise${ts ? "<void>" : ""}((resolve) => {`,
    `        resolveCompletion = resolve;`,
    `      });`,
    `      pendingPatches.set(request, { promise, resolve: resolveCompletion });`,
    `    }`,
    `  };`,
    `  const finishRequest = (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const pending = pendingPatches.get(request);`,
    `    if (!pending) return;`,
    `    pendingPatches.delete(request);`,
    `    pending.resolve();`,
    `  };`,
    `  page.on("request", captureRequest);`,
    `  page.on("response", (response${
      ts ? ": CairnEvidenceResponse" : ""
    }) => {`,
    `    const entry = byRequest.get(response.request());`,
    `    if (entry) {`,
    `      entry.status = response.status();`,
    `    }`,
    `  });`,
    `  page.on("requestfinished", (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const entry = byRequest.get(request);`,
    `    if (entry) {`,
    `      if (entry.status === undefined) entry.error = "response status unavailable";`,
    `      entry.responseTimestamp = Date.now();`,
    `      entry.durationMs = Math.max(0, entry.responseTimestamp - entry.timestamp);`,
    `    }`,
    `    finishRequest(request);`,
    `  });`,
    `  page.on("requestfailed", (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const entry = byRequest.get(request);`,
    `    if (entry) {`,
    `      entry.error = "request failed";`,
    `      entry.responseTimestamp = Date.now();`,
    `      entry.durationMs = Math.max(0, entry.responseTimestamp - entry.timestamp);`,
    `    }`,
    `    finishRequest(request);`,
    `  });`,
    ``,
    `  return {`,
    `    recordApiRequest(input${ts ? ": CairnApiRequestEvidence" : ""}) {`,
    `      const responseTimestamp = Date.now();`,
    `      const timestamp = input.timestamp ?? responseTimestamp;`,
    `      const timing = {`,
    `        timestamp,`,
    `        responseTimestamp,`,
    `        durationMs: Math.max(0, responseTimestamp - timestamp),`,
    `      };`,
    `      let raw${ts ? ": string | null" : ""} = null;`,
    `      let contentType = input.contentType;`,
    `      if (input.body !== undefined) {`,
    `        try {`,
    `          raw = typeof input.body === "string" ? input.body : JSON.stringify(input.body);`,
    `          if (typeof input.body !== "string" && !contentType) contentType = "application/json";`,
    `        } catch {`,
    `          entries.push({`,
    `            url: redactUrl(input.url),`,
    `            method: input.method.toUpperCase(),`,
    `            ...timing,`,
    `            ...(input.status === undefined ? {} : { status: input.status }),`,
    `            postDataOmittedReason: "capture-error",`,
    `          });`,
    `          return;`,
    `        }`,
    `      }`,
    `      entries.push({`,
    `        url: redactUrl(input.url),`,
    `        method: input.method.toUpperCase(),`,
    `        ...timing,`,
    `        ...(input.status === undefined ? {} : { status: input.status }),`,
    `        ...captureJsonPostData(raw, contentType),`,
    `      });`,
    `    },`,
    `    async persist(runDir${ts ? ": string" : ""})${
      ts ? ": Promise<void>" : ""
    } {`,
    `      const pending = [...pendingPatches.values()].map((completion) => completion.promise);`,
    `      if (pending.length > 0) {`,
    `        let timeoutId${
      ts ? ": ReturnType<typeof setTimeout> | undefined" : ""
    };`,
    `        const completed = await Promise.race([`,
    `          Promise.all(pending).then(() => true),`,
    `          new Promise${ts ? "<boolean>" : ""}((resolve) => {`,
    `            timeoutId = setTimeout(() => resolve(false), responseTimeoutMs);`,
    `          }),`,
    `        ]);`,
    `        if (timeoutId !== undefined) clearTimeout(timeoutId);`,
    `        if (!completed) {`,
    `          throw new Error("Timed out waiting for captured PATCH response evidence.");`,
    `        }`,
    `      }`,
    `      const [{ mkdir, writeFile }, { join }] = await Promise.all([`,
    `        import("node:fs/promises"),`,
    `        import("node:path"),`,
    `      ]);`,
    `      const networkDir = join(runDir, "network");`,
    `      await mkdir(networkDir, { recursive: true });`,
    `      const body = entries.map((entry) => JSON.stringify(entry)).join("\\n");`,
    `      await writeFile(join(networkDir, "requests.ndjson"), body ? body + "\\n" : "", {`,
    `        encoding: "utf8",`,
    `        mode: 0o600,`,
    `      });`,
    `    },`,
    `  };`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}

/* ----- emit context ----- */

export interface EmitCtx {
  lang: ExportLang;
  coverage: ExportCoverage;
  /** Late-bound reference collector (env names, run token). */
  usage: RefUsage;
  /** Absolute dir of the source spec — used to resolve script.file verifiers. */
  specDir?: string;
  /** Absolute dir of the generated file — verifier imports emit relative to it. */
  outDir?: string;
  /**
   * Project mode: emit verifier imports as `<prefix>/<basename>` and record
   * the resolved source path in `verifierFiles` so the CLI can copy it.
   */
  verifierImportPrefix?: string;
  verifierFiles?: Set<string>;
  /** Generated run directory passed to every exported node file verifier. */
  nodeVerifierRunDir?: string;
  /** Generated sanitized network recorder persisted before node verification. */
  nodeVerifierEvidence?: string;
  /** Unique names for per-action network response promises. */
  postconditionCounter?: number;
}

export function newEmitCtx(
  lang: ExportLang,
  init: Partial<Omit<EmitCtx, "lang" | "coverage" | "usage">> = {},
): EmitCtx {
  return {
    lang,
    coverage: {
      stepsTotal: 0,
      stepsExported: 0,
      outcomesTotal: 0,
      outcomesExported: 0,
      skips: [],
    },
    usage: newRefUsage(),
    postconditionCounter: 0,
    ...init,
  };
}

interface Rendered {
  stmts: Stmt[];
  /** True when at least one executable Playwright statement was produced. */
  exported: boolean;
}

function skip(
  ctx: EmitCtx,
  kind: ExportCoverageSkip["kind"],
  reason: string,
  id?: string,
): void {
  ctx.coverage.skips.push({ kind, id, reason });
}

function skipStmt(
  ctx: EmitCtx,
  kind: ExportCoverageSkip["kind"],
  reason: string,
  note: string,
  id?: string,
): Rendered {
  skip(ctx, kind, reason, id);
  return { stmts: [comment(note)], exported: false };
}

/* ----- step rendering ----- */

export function renderStep(
  step: Step,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const whenWrap = "when" in step && step.when ? step.when : undefined;
  const postcondition = step.postcondition?.network;
  const action = postcondition ? withoutPostcondition(step) : step;
  const body = renderStepBody(
    action,
    specSettleMs,
    ctx,
    postcondition !== undefined,
  );
  const guardedBody = postcondition
    ? renderNetworkPostconditionAction(body, postcondition, ctx)
    : body;
  const stmts = step.id
    ? [comment(`step: ${oneLine(step.id)}`), ...guardedBody.stmts]
    : guardedBody.stmts;

  if (!whenWrap) return { stmts, exported: guardedBody.exported };
  return wrapWhen(whenWrap, stmts, guardedBody.exported, ctx, step.id);
}

function wrapWhen(
  when: string,
  body: Stmt[],
  exported: boolean,
  ctx: EmitCtx,
  stepId?: string,
): Rendered {
  const colon = when.indexOf(":");
  const fallthrough = (): Rendered => {
    skip(ctx, "when", `unrecognized when predicate: ${when}`, stepId);
    return {
      stmts: [
        comment(`when: ${oneLine(when)} — not translated; step always runs`),
        ...body,
      ],
      exported,
    };
  };
  if (colon < 0) return fallthrough();

  const kind = when.slice(0, colon);
  const arg = when.slice(colon + 1);
  const str = (s: string) => emitStr(s, ctx.usage);
  let condition: string | undefined;
  switch (kind) {
    case "urlContains":
      condition = `page.url().includes(${str(arg)})`;
      break;
    case "urlNotContains":
      condition = `!page.url().includes(${str(arg)})`;
      break;
    case "urlMatches":
      condition = `new RegExp(${str(arg)}).test(page.url())`;
      break;
    case "text":
      condition = `await page.evaluate(() => ${bodyTextContainsExpression(arg, false)})`;
      break;
    case "notText":
      condition = `await page.evaluate(() => !(${bodyTextContainsExpression(arg, false)}))`;
      break;
    default:
      return fallthrough();
  }
  return {
    stmts: [comment(`when: ${oneLine(when)}`), iff(condition, body)],
    exported,
  };
}

function renderNetworkPostconditionAction(
  body: Rendered,
  postcondition: NetworkPostcondition,
  ctx: EmitCtx,
): Rendered {
  if (!body.exported) return body;
  const counter = (ctx.postconditionCounter ?? 0) + 1;
  ctx.postconditionCounter = counter;
  const promise = `networkPostconditionResponse${counter}`;
  const predicate = renderNetworkPostconditionPredicate(postcondition, ctx);
  const timeout = postcondition.timeoutMs ?? 30_000;
  return {
    exported: true,
    stmts: [
      raw(
        `const ${promise} = page.waitForResponse((response) => ${predicate}, { timeout: ${timeout} });`,
      ),
      raw(`void ${promise}.catch(() => undefined);`),
      ...body.stmts,
      raw(`await ${promise};`),
    ],
  };
}

function renderNetworkPostconditionPredicate(
  postcondition: NetworkPostcondition,
  ctx: EmitCtx,
): string {
  const conditions = [
    ...(postcondition.method
      ? [
          `response.request().method() === ${JSON.stringify(postcondition.method)}`,
        ]
      : []),
    `response.url().includes(${emitStr(postcondition.urlContains, ctx.usage)})`,
  ];
  const status = postcondition.status;
  if (status?.equals !== undefined) {
    conditions.push(`response.status() === ${status.equals}`);
  } else if (status?.below !== undefined) {
    conditions.push(`response.status() < ${status.below}`);
  } else if (status?.atLeast !== undefined) {
    conditions.push(`response.status() >= ${status.atLeast}`);
  } else if (status?.in !== undefined) {
    conditions.push(`[${status.in.join(", ")}].includes(response.status())`);
  }
  return `(${conditions.join(" && ")})`;
}

function renderStepBody(
  step: Step,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
  suppressMutationRetries = false,
): Rendered {
  const str = (s: string) => emitStr(s, ctx.usage);

  if ("open" in step) {
    if (typeof step.open === "string") {
      return one(raw(`await page.goto(${str(step.open)});`));
    }
    const opts: string[] = [
      `waitUntil: ${JSON.stringify(step.open.waitUntil)}`,
    ];
    if (step.open.timeoutMs !== undefined) {
      opts.push(`timeout: ${step.open.timeoutMs}`);
    }
    return one(
      raw(`await page.goto(${str(step.open.path)}, { ${opts.join(", ")} });`),
    );
  }
  if ("click" in step) {
    const settleMs = step.settleMs ?? specSettleMs;
    if (step.click.until && !suppressMutationRetries) {
      return renderClickUntilStep(step, settleMs, ctx);
    }
    const stmts: Stmt[] = [
      raw(`await ${locator(clickLocator(step), ctx)}.click();`),
    ];
    if (settleMs !== undefined && settleMs > 0) {
      stmts.push(
        raw(
          `await page.waitForLoadState("networkidle", { timeout: ${settleMs} });`,
        ),
      );
    }
    return { stmts, exported: true };
  }
  if ("hover" in step) {
    return one(raw(`await ${locator(step.hover, ctx)}.hover();`));
  }
  if ("focus" in step) {
    return one(raw(`await ${locator(step.focus, ctx)}.focus();`));
  }
  if ("fill" in step) {
    const { value, ...loc } = step.fill;
    const target = locator(loc as Locator, ctx);
    const emittedValue = str(value);
    if (suppressMutationRetries || step.verifyFill === false) {
      return one(raw(`await ${target}.fill(${emittedValue});`));
    }
    return renderVerifiedInput(target, emittedValue, "fill");
  }
  if ("type" in step) {
    const { value, delayMs, ...loc } = step.type;
    const opts = delayMs !== undefined ? `, { delay: ${delayMs} }` : "";
    const target = locator(loc as Locator, ctx);
    const emittedValue = str(value);
    if (suppressMutationRetries || step.verifyFill === false) {
      return one(
        raw(`await ${target}.pressSequentially(${emittedValue}${opts});`),
      );
    }
    return renderVerifiedInput(target, emittedValue, "type", opts);
  }
  if ("select" in step) {
    const { value, label, ...loc } = step.select;
    const option =
      value !== undefined
        ? `{ value: ${str(value)} }`
        : `{ label: ${str(label as string)} }`;
    return one(
      raw(`await ${locator(loc as Locator, ctx)}.selectOption(${option});`),
    );
  }
  if ("upload" in step) {
    const { path, ...loc } = step.upload;
    return one(
      raw(`await ${locator(loc as Locator, ctx)}.setInputFiles(${str(path)});`),
    );
  }
  if ("download" in step) {
    const { saveAs, assign: _assign, timeoutMs, ...loc } = step.download;
    const timeout = timeoutMs ?? 30_000;
    return {
      stmts: [
        raw(`const download = await Promise.all([`),
        raw(`  page.waitForEvent("download", { timeout: ${timeout} }),`),
        raw(`  ${locator(loc as Locator, ctx)}.click(),`),
        raw(`]).then(([download]) => download);`),
        raw(`await download.saveAs(${str(saveAs)});`),
      ],
      exported: true,
    };
  }
  if ("transform" in step) {
    return skipStmt(
      ctx,
      "step",
      `transform step not exportable (${step.transform.file})`,
      `transform step skipped — Cairntrace runs ${JSON.stringify(step.transform.file)} in Node`,
      step.id,
    );
  }
  if ("request" in step) {
    return renderRequestStep(step, ctx);
  }
  if ("eval" in step) {
    return renderEvalStep(step, ctx);
  }
  if ("batch" in step) {
    return renderBatchStep(step, specSettleMs, ctx);
  }
  if ("wait" in step) {
    const w = step.wait;
    if ("ms" in w) {
      return one(
        raw(`await new Promise((resolve) => setTimeout(resolve, ${w.ms}));`),
      );
    }
    const timeout = "timeoutMs" in w ? (w.timeoutMs ?? 30_000) : 30_000;
    if ("text" in w) {
      return one(
        raw(
          `await page.waitForFunction(${JSON.stringify(
            bodyTextContainsExpression(w.text, w.caseSensitive ?? false),
          )}, undefined, { timeout: ${timeout} });`,
        ),
      );
    }
    if ("notText" in w) {
      const expression = bodyTextContainsExpression(
        w.notText,
        w.caseSensitive ?? false,
      );
      return one(
        raw(
          `await page.waitForFunction(${JSON.stringify(`!(${expression})`)}, undefined, { timeout: ${timeout} });`,
        ),
      );
    }
    if ("selector" in w) {
      if (w.hasText) {
        return one(
          raw(
            `await expect(page.locator(${str(w.selector)}).filter({ hasText: ${str(w.hasText)} })).not.toHaveCount(0, { timeout: ${timeout} });`,
          ),
        );
      }
      const state = w.state ?? "visible";
      return one(
        raw(
          `await page.waitForSelector(${str(w.selector)}, { timeout: ${timeout}, state: ${JSON.stringify(state)} });`,
        ),
      );
    }
    if ("value" in w) {
      const { equals, ...loc } = w.value;
      return one(
        raw(
          `await expect(${locator(loc as Locator, ctx)}).toHaveValue(${str(equals)}, { timeout: ${timeout} });`,
        ),
      );
    }
    if ("url" in w) {
      const matcher = w.url;
      if (matcher.equals !== undefined) {
        return one(
          raw(
            `await page.waitForURL((url) => url.href === ${str(matcher.equals)}, { timeout: ${timeout} });`,
          ),
        );
      }
      if (matcher.includes !== undefined) {
        return one(
          raw(
            `await page.waitForURL((url) => url.href.includes(${str(matcher.includes)}), { timeout: ${timeout} });`,
          ),
        );
      }
      return one(
        raw(
          `await page.waitForURL(new RegExp(${str(matcher.pattern ?? "")}), { timeout: ${timeout} });`,
        ),
      );
    }
    return one(
      raw(
        `await page.waitForLoadState(${JSON.stringify("load" in w ? w.load : "load")}, { timeout: ${timeout} });`,
      ),
    );
  }
  if ("press" in step) {
    if (step.target) {
      return one(
        raw(`await ${locator(step.target, ctx)}.press(${str(step.press)});`),
      );
    }
    return one(raw(`await page.keyboard.press(${str(step.press)});`));
  }
  if ("scroll" in step) {
    if ("to" in step.scroll) {
      return one(
        raw(`await ${locator(step.scroll.to, ctx)}.scrollIntoViewIfNeeded();`),
      );
    }
    const px = step.scroll.px ?? 400;
    const { direction } = step.scroll;
    const dx = direction === "left" ? -px : direction === "right" ? px : 0;
    const dy = direction === "up" ? -px : direction === "down" ? px : 0;
    return one(raw(`await page.mouse.wheel(${dx}, ${dy});`));
  }
  if ("snapshot" in step) {
    return skipStmt(
      ctx,
      "step",
      "snapshot step not exportable",
      `snapshot step skipped — Playwright traces cover this via context.tracing`,
      step.id,
    );
  }
  if ("monitor" in step) {
    return skipStmt(
      ctx,
      "step",
      "monitor step not exportable (external CLI)",
      `monitor step skipped — no Playwright equivalent for the monitor CLI`,
      step.id,
    );
  }
  if ("use" in step) {
    return skipStmt(
      ctx,
      "step",
      `use: ${step.use} not expanded — pass parseSpec().resolved`,
      `use: ${oneLine(step.use)} — expand imports via \`parseSpec\` before exporting`,
      step.id,
    );
  }
  const unknownStep = step as { id?: string };
  return skipStmt(
    ctx,
    "step",
    `unhandled step shape`,
    `unhandled step: ${JSON.stringify(step)}`,
    unknownStep.id,
  );
}

function renderVerifiedInput(
  target: string,
  value: string,
  action: "fill" | "type",
  typeOptions = "",
): Rendered {
  const invoke =
    action === "fill"
      ? `await ${target}.fill(${value});`
      : `await ${target}.pressSequentially(${value}${typeOptions});`;
  return {
    stmts: [
      braces([
        block(`for (let fillAttempt = 0; ; fillAttempt++) {`, [
          ...(action === "type"
            ? [raw(`if (fillAttempt > 0) await ${target}.fill("");`)]
            : []),
          raw(invoke),
          raw(`await page.waitForTimeout(500);`),
          tryCatch(
            [
              raw(
                `await expect(${target}).toHaveValue(${value}, { timeout: 500 });`,
              ),
              raw(`break;`),
            ],
            "err",
            [
              raw(
                `if (fillAttempt >= 3) throw new Error("hydration wiped value after 4 attempts", { cause: err });`,
              ),
            ],
          ),
        ]),
      ]),
    ],
    exported: true,
  };
}

function renderClickUntilStep(
  step: Extract<Step, { click: unknown }>,
  settleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const until = step.click.until!;
  const timeoutMs = until.timeoutMs ?? 30_000;
  const loop: Stmt[] = [
    raw(`await clickTarget.click();`),
    ...(settleMs !== undefined && settleMs > 0
      ? [
          raw(
            `await page.waitForLoadState("networkidle", { timeout: ${settleMs} });`,
          ),
        ]
      : []),
    raw(
      `const clickUntilRemaining = Math.max(1, clickUntilDeadline - Date.now());`,
    ),
    raw(
      `const clickUntilAttemptTimeout = clickAttempt >= 3 ? clickUntilRemaining : Math.min(clickUntilRemaining, 250 * (2 ** clickAttempt));`,
    ),
    tryCatch([raw(clickUntilAssertion(until, ctx)), raw(`break;`)], "err", [
      raw(
        `if (clickAttempt >= 3 || Date.now() >= clickUntilDeadline) throw new Error("click.until condition was not satisfied after 4 attempts", { cause: err });`,
      ),
    ]),
  ];

  return {
    stmts: [
      braces([
        raw(`const clickTarget = ${locator(clickLocator(step), ctx)};`),
        raw(`const clickUntilDeadline = Date.now() + ${timeoutMs};`),
        block(`for (let clickAttempt = 0; ; clickAttempt++) {`, loop),
      ]),
    ],
    exported: true,
  };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clickUntilAssertion(until: ClickUntil, ctx: EmitCtx): string {
  const str = (value: string): string => emitStr(value, ctx.usage);
  if ("selectorGone" in until) {
    return `await expect(page.locator(${str(until.selectorGone)})).toHaveCount(0, { timeout: clickUntilAttemptTimeout });`;
  }
  if ("selector" in until) {
    return `await expect(page.locator(${str(until.selector)})).not.toHaveCount(0, { timeout: clickUntilAttemptTimeout });`;
  }
  if ("url" in until) {
    if (until.url.equals !== undefined) {
      return `await expect(page).toHaveURL(${str(until.url.equals)}, { timeout: clickUntilAttemptTimeout });`;
    }
    if (until.url.includes !== undefined) {
      return `await expect(page).toHaveURL(new RegExp(${str(escapeRegExpLiteral(until.url.includes))}), { timeout: clickUntilAttemptTimeout });`;
    }
    return `await expect(page).toHaveURL(new RegExp(${str(until.url.pattern!)}), { timeout: clickUntilAttemptTimeout });`;
  }
  if ("text" in until) {
    return `await expect(page.locator("body")).toContainText(${str(until.text)}, { ignoreCase: true, useInnerText: true, timeout: clickUntilAttemptTimeout });`;
  }
  return `await expect(page.locator("body")).not.toContainText(${str(until.notText)}, { ignoreCase: true, useInnerText: true, timeout: clickUntilAttemptTimeout });`;
}

function renderEvalStep(
  step: Extract<Step, { eval: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const e = step.eval;
  if (e.file) {
    skip(ctx, "step", `eval.file not inlined (${e.file})`, step.id);
    return {
      stmts: [
        comment(
          `eval.file ${JSON.stringify(e.file)} is not inlined by the exporter.`,
        ),
        comment(
          `Copy the file body into an eval.js step, or keep the Cairntrace spec as SoT.`,
        ),
      ],
      exported: false,
    };
  }
  const js = e.js ?? "";
  if (hasRefSentinel(js)) {
    // Secrets can't reach the browser context (`process.env` doesn't exist
    // there) — refuse loudly instead of emitting a broken sentinel.
    skip(
      ctx,
      "step",
      "eval source references a secret/run-token — not representable in-browser",
      step.id,
    );
  }
  const argsJson = emitValue(e.args ?? {}, ctx.usage);
  const varName = e.assign ? safeIdent(e.assign) : undefined;

  const asyncFunctionType =
    ctx.lang === "ts"
      ? ` as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>`
      : "";
  const evalCall = (prefix: string): Stmt[] => [
    block(
      `${prefix}await page.evaluate(async ({ source, args }) => {`,
      [
        comment(
          `Cairn eval.js is JavaScript input, so keep it outside the generated TypeScript AST.`,
        ),
        raw(
          `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor${asyncFunctionType};`,
        ),
        raw(`const execute = new AsyncFunction("args", source);`),
        raw(`return await execute(args);`),
      ],
      `}, { source: ${JSON.stringify(js)}, args: ${argsJson} });`,
    ),
  ];

  let stmts: Stmt[];
  if (js.includes("location.reload()")) {
    // agent-browser evals survive an in-page location.reload(); Playwright's
    // evaluate context is destroyed by the navigation instead. Retry in a LOOP
    // (up to 4 contexts): a hot dev server can navigate/reload more than once
    // (HMR recompile) while the rescue eval is in flight.
    stmts = [
      ...(varName ? [raw(`let ${varName};`)] : []),
      block(`for (let evalAttempt = 0; ; evalAttempt++) {`, [
        tryCatch(
          [...evalCall(varName ? `${varName} = ` : ""), raw(`break;`)],
          "err",
          [
            raw(
              `if (evalAttempt >= 3 || !String(err).includes("Execution context was destroyed")) throw err;`,
            ),
            raw(
              `await page.waitForLoadState("networkidle", { timeout: 45000 });`,
            ),
          ],
        ),
      ]),
    ];
  } else {
    stmts = evalCall(varName ? `const ${varName} = ` : "");
  }

  if (e.assign) {
    stmts.push(
      comment(
        `Note: later steps that splice \${evals.${e.assign}…} are not rewritten — wire variables manually if needed.`,
      ),
    );
  }
  return { stmts, exported: true };
}

function renderBatchStep(
  step: Extract<Step, { batch: unknown }>,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const stmts: Stmt[] = [
    comment(
      `batch: expanded sequentially — Playwright cannot preserve hover/focus atomicity like agent-browser batch`,
    ),
  ];
  let any = false;
  for (const sub of step.batch as BatchSubStep[]) {
    // Batch sub-steps are a restricted Step subset; cast through unknown.
    const asStep = sub as unknown as Step;
    const rendered = renderStepBody(asStep, specSettleMs, ctx);
    stmts.push(...rendered.stmts);
    if (rendered.exported) any = true;
  }
  return { stmts, exported: any };
}

function renderRequestStep(
  step: Extract<Step, { request: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const r = step.request;
  const str = (s: string) => emitStr(s, ctx.usage);
  const method = (r.method ?? "GET").toUpperCase();
  const timeout = r.timeoutMs ?? 30_000;
  const headers: Record<string, string> = { ...r.headers };
  if (
    r.body !== undefined &&
    typeof r.body !== "string" &&
    !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }
  const opts: string[] = [
    `method: ${JSON.stringify(method)}`,
    `timeout: ${timeout}`,
  ];
  if (Object.keys(headers).length > 0) {
    opts.push(`headers: ${emitValue(headers, ctx.usage)}`);
  }
  if (r.body !== undefined) {
    opts.push(`data: ${emitValue(r.body, ctx.usage)}`);
  }
  const varName = r.assign ? safeIdent(r.assign) : "_res";
  const evidenceTimestamp = `${varName}CairnRequestTimestamp`;
  const stmts: Stmt[] = [
    comment(
      `request step (${r.assign ?? "unnamed"}) — page.request shares browser context cookies`,
    ),
  ];
  if (ctx.nodeVerifierEvidence) {
    stmts.push(raw(`const ${evidenceTimestamp} = Date.now();`));
  }
  stmts.push(
    raw(
      `const ${varName} = await page.request.fetch(${str(r.url)}, { ${opts.join(", ")} });`,
    ),
  );
  if (ctx.nodeVerifierEvidence) {
    const contentType = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    const evidence: string[] = [
      `url: ${varName}.url()`,
      `method: ${JSON.stringify(method)}`,
      `status: ${varName}.status()`,
      `timestamp: ${evidenceTimestamp}`,
    ];
    if (r.body !== undefined) {
      evidence.push(`body: ${emitValue(r.body, ctx.usage)}`);
    }
    if (contentType !== undefined) {
      evidence.push(`contentType: ${emitStr(contentType, ctx.usage)}`);
    }
    stmts.push(
      raw(
        `${ctx.nodeVerifierEvidence}.recordApiRequest({ ${evidence.join(", ")} });`,
      ),
    );
  }
  if (r.expectStatus !== undefined) {
    if (Array.isArray(r.expectStatus)) {
      stmts.push(
        raw(
          `expect([${r.expectStatus.join(", ")}]).toContain(${varName}.status());`,
        ),
      );
    } else {
      stmts.push(raw(`expect(${varName}.status()).toBe(${r.expectStatus});`));
    }
  }
  if (r.assign) {
    stmts.push(
      comment(
        `Response body: await ${varName}.json() or .text() — \${requests.${r.assign}.*} placeholders are not auto-rewritten below.`,
      ),
    );
  }
  return { stmts, exported: true };
}

function locator(loc: Locator, ctx: EmitCtx): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  // Cairntrace (agent-browser) acts on the FIRST match of a semantic locator;
  // Playwright strict mode instead fails on multiple matches. When no explicit
  // nth is given, emit .first() so the exported test keeps source semantics.
  const nth =
    "nth" in loc && loc.nth !== undefined ? `.nth(${loc.nth})` : ".first()";
  const hasText = "hasText" in loc ? loc.hasText : undefined;
  const textFilter = hasText ? `.filter({ hasText: ${str(hasText)} })` : "";
  const inner = locatorFromRoot("page", loc, ctx);
  const near = "near" in loc ? loc.near : undefined;
  if (!near) {
    return loc.by === "selector"
      ? `${inner}${textFilter}`
      : `${inner}${textFilter}${nth}`;
  }
  const scoped = `page.getByText(${str(near)}).locator("xpath=ancestor-or-self::*").filter({ has: ${inner} }).last()`;
  const scopedLocator = locatorFromRoot(scoped, loc, ctx);
  return loc.by === "selector"
    ? `${scopedLocator}${textFilter}`
    : `${scopedLocator}${textFilter}${nth}`;
}

function locatorFromRoot(root: string, loc: Locator, ctx: EmitCtx): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  switch (loc.by) {
    case "role": {
      const opts: string[] = [];
      if (loc.name) opts.push(`name: ${str(loc.name)}`);
      if (loc.exact) opts.push("exact: true");
      return `${root}.getByRole(${JSON.stringify(loc.role)}${
        opts.length > 0 ? `, { ${opts.join(", ")} }` : ""
      })`;
    }
    case "label":
      return `${root}.getByLabel(${str(loc.name)}${
        loc.exact ? ", { exact: true }" : ""
      })`;
    case "text":
      return `${root}.getByText(${str(loc.text)}${
        loc.exact ? ", { exact: true }" : ""
      })`;
    case "selector":
      return `${root}.locator(${str(loc.selector)})`;
    case "testid":
      return `${root}.getByTestId(${str(loc.testid)})`;
  }
}

/* ----- outcome rendering ----- */

export function renderOutcome(outcome: Outcome, ctx: EmitCtx): Rendered {
  const v = outcome.verify;
  if (isTextVerifier(v))
    return {
      stmts: renderTextOutcome(v.text, textVerifierRegion(v), false, ctx),
      exported: true,
    };
  if (isNotTextVerifier(v))
    return {
      stmts: renderTextOutcome(v.notText, notTextVerifierRegion(v), true, ctx),
      exported: true,
    };
  if (isUrlVerifier(v))
    return { stmts: renderUrlOutcome(v.url, ctx), exported: true };
  if (isCountVerifier(v))
    return { stmts: renderCountOutcome(v, ctx), exported: true };
  if (isNetworkVerifier(v))
    return { stmts: renderNetworkOutcome(v, ctx), exported: true };
  if (isNoFailedRequestsVerifier(v))
    return { stmts: renderNoFailedRequestsOutcome(v, ctx), exported: true };
  if (isConsoleVerifier(v))
    return {
      stmts: [
        raw(
          `expect(consoleErrors.length).toBeLessThanOrEqual(${v.console.errorsMax});`,
        ),
      ],
      exported: true,
    };
  if (isScriptVerifier(v)) return renderScriptOutcome(v, outcome.id, ctx);
  if (isHttpJsonVerifier(v)) return renderHttpJsonOutcome(v, outcome.id, ctx);
  return skipStmt(
    ctx,
    "outcome",
    `unhandled verifier kind: ${Object.keys(v).join(",")}`,
    `unhandled verifier kind for ${JSON.stringify(Object.keys(v))}`,
    outcome.id,
  );
}

function renderTextOutcome(
  m: TextMatcher,
  region: string,
  negated: boolean,
  ctx: EmitCtx,
): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const target =
    region === "page" ? `page.locator("body")` : `page.locator(${str(region)})`;
  const not = negated ? ".not" : "";
  if (m.equals !== undefined) {
    return [
      raw(
        `await expect(${target})${not}.toHaveText(${str(m.equals)}, ${renderTextAssertionOptions(m.caseSensitive ?? false)});`,
      ),
    ];
  }
  if (m.contains !== undefined) {
    return [
      raw(
        `await expect(${target})${not}.toContainText(${str(m.contains)}, ${renderTextAssertionOptions(m.caseSensitive ?? false)});`,
      ),
    ];
  }
  if (m.matches !== undefined) {
    return [
      raw(
        `await expect(${target})${not}.toHaveText(new RegExp(${str(m.matches)}));`,
      ),
    ];
  }
  return [comment(`invalid text matcher`)];
}

function renderTextAssertionOptions(caseSensitive: boolean): string {
  return `{ ignoreCase: ${!caseSensitive}, useInnerText: true }`;
}

function renderUrlOutcome(m: UrlMatcher, ctx: EmitCtx): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  if (m.equals !== undefined) {
    return [raw(`await expect(page).toHaveURL(${str(m.equals)});`)];
  }
  if (m.startsWith !== undefined) {
    return [
      raw(
        `await expect(page).toHaveURL(new RegExp(${JSON.stringify("^" + escapeRegex(m.startsWith))}));`,
      ),
    ];
  }
  if (m.endsWith !== undefined) {
    return [
      raw(
        `await expect(page).toHaveURL(new RegExp(${JSON.stringify(escapeRegex(m.endsWith) + "$")}));`,
      ),
    ];
  }
  if (m.matches !== undefined) {
    return [
      raw(`await expect(page).toHaveURL(new RegExp(${str(m.matches)}));`),
    ];
  }
  return [comment(`invalid url matcher`)];
}

function renderCountOutcome(v: CountVerifier, ctx: EmitCtx): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const c = v.count;
  let target: string;
  const base = c.in_region ? `page.locator(${str(c.in_region)})` : `page`;
  if (c.selector) {
    target = `${base}.locator(${str(c.selector)})`;
  } else if (c.role) {
    target = `${base}.getByRole(${JSON.stringify(c.role)})`;
  } else {
    return [comment(`count verifier requires role/selector`)];
  }
  if (c.equals !== undefined) {
    return [raw(`await expect(${target}).toHaveCount(${c.equals});`)];
  }
  if (c.atLeast !== undefined) {
    return [
      raw(
        `expect(await ${target}.count()).toBeGreaterThanOrEqual(${c.atLeast});`,
      ),
    ];
  }
  if (c.atMost !== undefined) {
    return [
      raw(`expect(await ${target}.count()).toBeLessThanOrEqual(${c.atMost});`),
    ];
  }
  if (c.between !== undefined) {
    const [lo, hi] = c.between;
    return [
      braces([
        raw(`const n = await ${target}.count();`),
        raw(`expect(n).toBeGreaterThanOrEqual(${lo});`),
        raw(`expect(n).toBeLessThanOrEqual(${hi});`),
      ]),
    ];
  }
  return [comment(`invalid count matcher`)];
}

function renderNetworkOutcome(v: NetworkVerifier, ctx: EmitCtx): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const n = v.network;
  const conds: string[] = [];
  if (n.method) conds.push(`r.method === ${JSON.stringify(n.method)}`);
  conds.push(`r.url.includes(${str(n.urlContains)})`);
  const s = n.status;
  if (s.equals !== undefined) conds.push(`r.status === ${s.equals}`);
  else if (s.below !== undefined) conds.push(`(r.status ?? 0) < ${s.below}`);
  else if (s.atLeast !== undefined)
    conds.push(`(r.status ?? 0) >= ${s.atLeast}`);
  else if (s.in !== undefined)
    conds.push(`[${s.in.join(", ")}].includes(r.status ?? -1)`);
  return [
    raw(`expect(requests.some((r) => ${conds.join(" && ")})).toBe(true);`),
  ];
}

function renderNoFailedRequestsOutcome(
  v: NoFailedRequestsVerifier,
  ctx: EmitCtx,
): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const n = v.noFailedRequests;
  const conds = [`r.url.includes(${str(n.urlContains)})`];
  if (n.method) conds.push(`r.method === ${JSON.stringify(n.method)}`);
  return [
    raw(
      `expect(requests.filter((r) => ${conds.join(" && ")} && (r.status ?? 0) >= 400)).toEqual([]);`,
    ),
  ];
}

function renderScriptOutcome(
  v: import("../schema/verifier.v1").ScriptVerifier,
  outcomeId: string,
  ctx: EmitCtx,
): Rendered {
  if (v.script.runtime === "node" && v.script.file && ctx.specDir) {
    if (!ctx.nodeVerifierRunDir || !ctx.nodeVerifierEvidence) {
      return skipStmt(
        ctx,
        "outcome",
        "node verifier runDir evidence runtime unavailable",
        `node verifier skipped — export must provide a sanitized runDir`,
        outcomeId,
      );
    }
    // Playwright tests already run in node and its loader transpiles TS
    // imports, so a `runtime: node` file verifier is directly executable:
    // import the module and call its `verify(ctx)` entry with the same ctx
    // shape the Cairntrace runner passes (fixtures/vars/specDir; artifacts
    // and runDir have no Playwright equivalent and are left empty).
    const abs = isAbsolute(v.script.file)
      ? v.script.file
      : resolve(ctx.specDir, v.script.file);
    // Portable import: project prefix (copied verifiers) > relative to the
    // generated file > absolute machine-local path.
    let importPath: string;
    if (ctx.verifierImportPrefix) {
      ctx.verifierFiles?.add(abs);
      importPath = `${ctx.verifierImportPrefix}/${abs.split("/").pop()}`;
    } else if (ctx.outDir) {
      importPath = toRelativeImport(ctx.outDir, abs);
    } else {
      importPath = abs;
    }
    return {
      stmts: [
        braces([
          comment(
            `node verifier (runs in the test's node context, not the browser)`,
          ),
          raw(
            `await ${ctx.nodeVerifierEvidence}.persist(${ctx.nodeVerifierRunDir});`,
          ),
          raw(
            `const importedVerifier = await import(${JSON.stringify(importPath)});`,
          ),
          comment(
            `ESM/CJS interop: Playwright transpiles TS imports to CJS, so a`,
          ),
          comment(`default export may surface as namespace.default.default.`),
          raw(
            `const verifierNamespace = importedVerifier${
              ctx.lang === "ts"
                ? " as unknown as { verify?: unknown; default?: unknown }"
                : ""
            };`,
          ),
          raw(`const verifierDefault = verifierNamespace.default;`),
          raw(
            `const verifierDefaultNamespace = verifierDefault && typeof verifierDefault === "object"`,
          ),
          raw(
            `  ? verifierDefault${
              ctx.lang === "ts"
                ? " as { verify?: unknown; default?: unknown }"
                : ""
            }`,
          ),
          raw(`  : undefined;`),
          raw(`const verify =`),
          raw(`  verifierNamespace.verify ??`),
          raw(`  (typeof verifierDefault === "function"`),
          raw(`    ? verifierDefault`),
          raw(
            `    : (verifierDefaultNamespace?.verify ?? verifierDefaultNamespace?.default));`,
          ),
          block(`if (typeof verify !== "function") {`, [
            raw(
              `throw new Error("verifier module must export a verify() function");`,
            ),
          ]),
          block(
            `const res = await verify({`,
            [
              raw(
                `fixtures: ${emitValue(v.script.fixtures ?? {}, ctx.usage)},`,
              ),
              raw(`artifacts: {},`),
              raw(`vars: {},`),
              raw(`runDir: ${ctx.nodeVerifierRunDir},`),
              raw(`specDir: ${JSON.stringify(ctx.specDir)},`),
            ],
            `});`,
          ),
          raw(
            `expect(res && res.ok, \`verifier evidence: \${JSON.stringify(res && (res.evidence ?? res))}\`).toBe(true);`,
          ),
        ]),
      ],
      exported: true,
    };
  }
  if (v.script.runtime !== "node" && v.script.file && ctx.specDir) {
    const abs = isAbsolute(v.script.file)
      ? v.script.file
      : resolve(ctx.specDir, v.script.file);
    const loaded = loadBrowserVerifierSource(abs);
    if (loaded.error) {
      return skipStmt(
        ctx,
        "outcome",
        `script.file ${v.script.file} not inlined: ${loaded.error}`,
        `browser verifier file could not be embedded. Keep the Cairntrace spec as the source of truth.`,
        outcomeId,
      );
    }
    return renderBrowserScriptOutcome(v, loaded.source!, ctx);
  }
  if (v.script.runtime === "node" || v.script.file) {
    const reason = v.script.file
      ? `script.file ${v.script.file} not inlined`
      : "script.runtime node (inline source) not exportable";
    return skipStmt(
      ctx,
      "outcome",
      reason,
      `${reason}. Keep the Cairntrace spec as the source of truth.`,
      outcomeId,
    );
  }
  return renderBrowserScriptOutcome(v, v.script.run ?? "", ctx);
}

function renderBrowserScriptOutcome(
  v: import("../schema/verifier.v1").ScriptVerifier,
  source: string,
  ctx: EmitCtx,
): Rendered {
  const asyncFunctionType =
    ctx.lang === "ts"
      ? ` as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>`
      : "";
  const resultType =
    ctx.lang === "ts" ? ` as { ok?: boolean; evidence?: unknown }` : "";
  return {
    stmts: [
      braces([
        block(
          `const result = await page.evaluate(async ({ source, scriptContext }) => {`,
          [
            comment(
              `Verifier source is authored JavaScript, not generated TypeScript.`,
            ),
            raw(
              `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor${asyncFunctionType};`,
            ),
            raw(
              `const execute = new AsyncFunction("fixtures", "artifacts", "vars", "run", source);`,
            ),
            raw(
              `return await execute(scriptContext.fixtures, scriptContext.artifacts, scriptContext.vars, scriptContext.run);`,
            ),
          ],
          `}, { source: ${JSON.stringify(source)}, scriptContext: ${emitValue(
            {
              fixtures: v.script.fixtures ?? {},
              artifacts: {},
              vars: {},
              run: { failedStep: null, lastSuccessfulStep: null },
            },
            ctx.usage,
          )} })${resultType};`,
        ),
        raw(`expect(result.ok).toBe(true);`),
      ]),
    ],
    exported: true,
  };
}

function loadBrowserVerifierSource(absolutePath: string): {
  source?: string;
  error?: string;
} {
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (extname(absolutePath) !== ".ts") return { source };

  const bun = (
    globalThis as typeof globalThis & {
      Bun?: {
        Transpiler?: new (opts: {
          loader: "ts";
        }) => {
          transformSync(source: string): string;
        };
      };
    }
  ).Bun;
  if (!bun?.Transpiler) {
    return {
      error:
        "TypeScript browser verifier transpilation requires Bun.Transpiler",
    };
  }
  try {
    return {
      source: new bun.Transpiler({ loader: "ts" }).transformSync(source),
    };
  } catch (error) {
    return {
      error: `TypeScript transpilation failed: ${(error as Error).message}`,
    };
  }
}

function renderHttpJsonOutcome(
  v: import("../schema/verifier.v1").HttpJsonVerifier,
  outcomeId: string,
  ctx: EmitCtx,
): Rendered {
  const str = (s: string) => emitStr(s, ctx.usage);
  const h = v.httpJson;
  // Best-effort GET + simple equals/contains on a dotted jsonPath.
  const pathExpr = `String(${JSON.stringify(h.jsonPath ?? "$")}).replace(/^\\$\\.?/, "").split(".").filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), body)`;
  const body: Stmt[] = [
    raw(`const res = await page.request.get(${str(h.url)});`),
    raw(`expect(res.ok()).toBeTruthy();`),
    raw(`const body = await res.json();`),
    raw(`const val = ${pathExpr};`),
  ];
  if (h.equals !== undefined) {
    body.push(raw(`expect(val).toEqual(${emitValue(h.equals, ctx.usage)});`));
  } else if (h.contains !== undefined) {
    body.push(
      raw(
        `expect(String(val)).toContain(${emitValue(h.contains, ctx.usage)});`,
      ),
    );
  } else if (h.exists !== undefined) {
    body.push(
      h.exists
        ? raw(`expect(val).not.toBeUndefined();`)
        : raw(`expect(val).toBeUndefined();`),
    );
  } else {
    skip(
      ctx,
      "outcome",
      "httpJson matcher (matches/atLeast/atMost) not fully exported",
      outcomeId,
    );
    body.push(
      comment(
        `httpJson: status ok + path resolved; advanced matchers not exported`,
      ),
    );
  }
  return { stmts: [braces(body)], exported: true };
}

/** Emit a ./-prefixed POSIX relative path for a dynamic import. */
function toRelativeImport(fromDir: string, absTarget: string): string {
  const rel = relative(fromDir, absTarget).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/* ----- helpers ----- */

function one(stmt: Stmt): Rendered {
  return { stmts: [stmt], exported: true };
}

export function oneLine(s: string): string {
  return s.replaceAll(/\s+/g, " ").trim();
}

function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeIdent(name: string): string {
  const cleaned = name.replaceAll(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Used by tests + the CLI to know whether a verifier type is exportable. */
export function isExportable(v: Verifier): boolean {
  return (
    isTextVerifier(v) ||
    isNotTextVerifier(v) ||
    isUrlVerifier(v) ||
    isCountVerifier(v) ||
    isNetworkVerifier(v) ||
    isNoFailedRequestsVerifier(v) ||
    isConsoleVerifier(v) ||
    isScriptVerifier(v) ||
    isHttpJsonVerifier(v)
  );
}

/** Extension for the generated Playwright file. */
export function exportExtension(lang: ExportLang): string {
  return lang === "js" ? ".spec.js" : ".spec.ts";
}
