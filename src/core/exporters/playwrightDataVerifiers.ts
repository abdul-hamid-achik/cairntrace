/**
 * Export coverage of the verifiers and steps that judge DATA rather than the
 * page: `value`, `http`, `network` with a body / count / assign, `file`,
 * `xlsx`, and the `expect.request` step. Each one resolves its
 * `${requests|evals|captures|network|fixtures|runs|artifacts.…}` references
 * against the bindings the exported steps produced (typed, like the runner:
 * a whole reference keeps its type), then hands the judging to the runner's
 * own matcher / judge modules (src/core/exporters/runtimeSources.ts) through
 * the glue in playwrightRuntimeData.ts. Secrets are never baked: datasource
 * credentials are `process.env` reads when the test runs.
 */
import type {
  FileVerifier,
  HttpVerifier,
  NetworkVerifier,
  NoFailedRequestsVerifier,
  ValueVerifier,
  Verifier,
  XlsxVerifier,
} from "../schema/verifier.v1";
import {
  isFileVerifier,
  isHttpVerifier,
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
  isValueVerifier,
  isXlsxVerifier,
} from "../schema/verifier.v1";
import type { ExpectStep, Outcome, Spec, Step } from "../schema/spec.v1";
import { walkSteps } from "../schema/spec.v1";
import { braces, comment, raw, type Stmt } from "./codegen";
import {
  declareBinding,
  NO_SPLICE,
  oneLine,
  publishBinding,
  skip,
  skipStmt,
  useData,
  wantsBinding,
  withSpliceSources,
  type EmitCtx,
  type Rendered,
} from "./playwrightExporter";
import {
  authoredPlaceholders,
  emitStr,
  emitValue,
  runtimeRefKey,
  bindingIdent,
  type RuntimeRefSource,
} from "./templateValue";

/** A config `kind: http` datasource, reduced to what an export needs. */
export interface ExportHttpDatasource {
  baseUrl: string;
  headers?: Record<string, string>;
  auth?: { basic?: string; bearer?: string };
}

const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_FILE_TIMEOUT_MS = 10_000;
const DEFAULT_EXPECT_REQUEST_TIMEOUT_MS = 5_000;

/* ----- typed references ----- */

const TYPED_REF =
  /\$\{(artifacts|requests|evals|captures|network|fixtures|runs|run)\.([^}]+)\}/g;

/** The `RefScope` key each reference namespace reads (see lookupRef). */
const SCOPE_KEY: Record<string, string> = {
  artifacts: "artifacts",
  requests: "responses",
  evals: "evals",
  captures: "captures",
  network: "networkAssigns",
  fixtures: "fixtureOutputs",
  runs: "runOutputs",
};

export interface TypedRef {
  ns: string;
  /** First path segment: the produced name. */
  name: string;
  /** As written, without the `${…}`. */
  ref: string;
}

/** Every runtime reference in the strings of `value`. */
export function typedRefs(value: unknown, into: TypedRef[] = []): TypedRef[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(TYPED_REF)) {
      into.push({
        ns: m[1]!,
        name: m[2]!.split(".")[0]!,
        ref: `${m[1]}.${m[2]}`,
      });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) typedRefs(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) typedRefs(item, into);
  }
  return into;
}

/** Binding keys (`captures:x`, `network:y`, …) a value reads. */
export function typedRefKeys(
  value: unknown,
  into = new Set<string>(),
): Set<string> {
  for (const ref of typedRefs(value)) {
    if (ref.ns === "run") continue;
    into.add(runtimeRefKey(ref.ns as RuntimeRefSource, ref.name));
  }
  return into;
}

/** Does `verifier` (with `--verifiers`) take the typed data path? */
export function readsTypedRefs(
  verifier: Verifier,
  mode: "keep" | "gate" | "drop" | undefined,
  richNetwork: boolean,
): boolean {
  if (isValueVerifier(verifier) || isXlsxVerifier(verifier)) return true;
  if (isFileVerifier(verifier)) return true;
  if (isHttpVerifier(verifier)) return mode !== "drop";
  if (isNetworkVerifier(verifier)) return richNetwork;
  return false;
}

/** The operand values a data verifier resolves references in. */
export function typedOutcomeOperands(
  verifier: Verifier,
  mode: "keep" | "gate" | "drop" | undefined,
  richNetwork: boolean,
): unknown[] {
  if (!readsTypedRefs(verifier, mode, richNetwork)) return [];
  if (isValueVerifier(verifier)) {
    return [verifier.value.expect, verifier.value.actual, verifier.value.file];
  }
  if (isHttpVerifier(verifier)) {
    const h = verifier.http;
    return [h.url, h.headers, h.body, h.expect?.json];
  }
  if (isNetworkVerifier(verifier)) return [verifier.network.body?.json];
  if (isFileVerifier(verifier)) return [verifier.file.glob];
  if (isXlsxVerifier(verifier)) return [verifier.xlsx];
  return [];
}

/**
 * The producers of `network.assign` and the `expect.request` operands of
 * the steps a spec exports.
 */
export function typedStepOperands(step: Step): unknown[] {
  if ("expect" in step && "request" in step.expect) {
    const r = step.expect.request;
    return [r.url, r.headers, r.body, r.json];
  }
  return [];
}

/** True when a spec has a `network` outcome that needs the rich request log. */
export function specNeedsRichNetworkLog(spec: Spec): boolean {
  return spec.outcomes.some(
    (outcome) =>
      (isNetworkVerifier(outcome.verify) && needsRichNetwork(outcome.verify)) ||
      // judged by the runner's own predicate, network errors included
      isNoFailedRequestsVerifier(outcome.verify),
  );
}

function needsRichNetwork(v: NetworkVerifier): boolean {
  return (
    v.network.body !== undefined ||
    v.network.count !== undefined ||
    v.network.assign !== undefined
  );
}

/** Binding keys the data verifiers / steps of a spec read (for hoisting). */
export function dataRefKeys(
  spec: Spec,
  opts: {
    verifiers?: "keep" | "gate" | "drop" | undefined;
    includeSteps: boolean;
  },
): Set<string> {
  const keys = new Set<string>();
  const rich = specNeedsRichNetworkLog(spec);
  for (const outcome of spec.outcomes) {
    for (const operand of typedOutcomeOperands(
      outcome.verify,
      opts.verifiers,
      rich,
    )) {
      typedRefKeys(operand, keys);
    }
  }
  if (opts.includeSteps) {
    for (const step of walkSteps(spec.steps ?? [])) {
      for (const operand of typedStepOperands(step))
        typedRefKeys(operand, keys);
    }
  }
  return keys;
}

interface ScopeResult {
  /** `{ responses: { … }, captures: { … } }`, undefined without references. */
  expr?: string;
  /** Bound identifiers read (kept alive when the unit cannot be rendered). */
  idents: string[];
  /** True when a reference has no binding in this scope. */
  blocked: boolean;
}

/**
 * The `RefScope` literal a unit resolves its references against, from the
 * bindings the exported steps published. A reference without a binding is
 * recorded the same way a failed splice is (a hard skip: the producing step
 * is not exported in this scope).
 */
function refScope(
  ctx: EmitCtx,
  operands: unknown[],
  where: { kind: "step" | "outcome"; id: string | undefined },
): ScopeResult {
  const refs = operands.flatMap((operand) => typedRefs(operand));
  if (refs.length === 0) return { idents: [], blocked: false };
  const grouped = new Map<string, Map<string, string>>();
  const idents = new Set<string>();
  let blocked = false;
  for (const ref of refs) {
    if (ref.ns === "run") {
      blocked = true;
      skip(
        ctx,
        where.kind,
        `\${${ref.ref}} not exported: the run start time is a cairn run fact with no equivalent in a Playwright test`,
        where.id,
      );
      continue;
    }
    const ident = ctx.usage.bindings.get(
      runtimeRefKey(ref.ns as RuntimeRefSource, ref.name),
    );
    if (!ident) {
      blocked = true;
      ctx.usage.unresolved.add(ref.ref);
      ctx.usage.unresolvedLog.push(ref.ref);
      continue;
    }
    idents.add(ident);
    const key = SCOPE_KEY[ref.ns]!;
    const names = grouped.get(key) ?? new Map<string, string>();
    names.set(ref.name, ident);
    grouped.set(key, names);
  }
  if (blocked) return { idents: [...idents], blocked };
  const parts = [...grouped].map(
    ([key, names]) =>
      `${key}: { ${[...names].map(([name, ident]) => `${JSON.stringify(name)}: ${ident}`).join(", ")} }`,
  );
  return { expr: `{ ${parts.join(", ")} }`, idents: [...idents], blocked };
}

/** A JSON-shaped operand with its runtime references kept as literal text. */
function emitTyped(value: unknown, ctx: EmitCtx): string {
  const before = ctx.usage.literalLog.length;
  const out = withSpliceSources(ctx, NO_SPLICE, () =>
    emitValue(value, ctx.usage),
  );
  // Resolved by cairnRefs at run time, not "compared as literal text".
  ctx.usage.literalLog.length = before;
  return out;
}

function blockedStmts(scope: ScopeResult, note: string): Rendered {
  return {
    stmts: [
      comment(note),
      // Bindings the unit would have read must not trip noUnusedLocals.
      ...(scope.idents.length > 0
        ? [raw(`void [${scope.idents.join(", ")}];`)]
        : []),
    ],
    exported: false,
  };
}

/** `cairnRefs(<operand>, cairnScope, "what")`, or the operand itself without references. */
function resolved(
  operand: unknown,
  scope: ScopeResult,
  what: string,
  ctx: EmitCtx,
): string {
  const literal = emitTyped(operand, ctx);
  if (!scope.expr || typedRefs(operand).length === 0) return literal;
  useData(ctx, "dataValue", "cairnRefs");
  return `cairnRefs(${literal}, cairnScope, ${JSON.stringify(what)})`;
}

function scopeDecl(scope: ScopeResult): Stmt[] {
  return scope.expr ? [raw(`const cairnScope = ${scope.expr};`)] : [];
}

/** `${artifacts.x.path|relativePath}` anywhere in the authored text. */
function usesArtifactRef(text: string): boolean {
  return /\$\{artifacts\.[a-z][A-Za-z0-9_]*\.(?:path|relativePath)\}/.test(
    text,
  );
}

function runDirExpr(ctx: EmitCtx): string {
  ctx.usesTestInfo = true;
  return `test.info().outputPath("cairn-run")`;
}

function specDirExpr(ctx: EmitCtx): string {
  return ctx.specDirExpr ?? JSON.stringify(ctx.specDir ?? ".");
}

/** The path of a verifier's file operand: artifact references spliced, then resolved like the runner. */
function filePathExpr(text: string, ctx: EmitCtx): string {
  useData(ctx, "dataPath", "cairnFilePath");
  const spliced = withSpliceSources(
    ctx,
    new Set<RuntimeRefSource>(["artifacts"]),
    () => emitStr(text, ctx.usage),
  );
  return `cairnFilePath(${spliced}, ${usesArtifactRef(text)}, ${runDirExpr(ctx)}, ${specDirExpr(ctx)})`;
}

/* ----- value ----- */

export function renderValueOutcome(
  v: ValueVerifier,
  outcome: Outcome,
  ctx: EmitCtx,
): Rendered {
  const spec = v.value;
  const scope = refScope(ctx, [spec.expect, spec.actual, spec.file], {
    kind: "outcome",
    id: outcome.id,
  });
  if (scope.blocked) {
    return blockedStmts(
      scope,
      `value verifier not exported: a reference has no producer in this scope`,
    );
  }
  useData(ctx, "dataValue", "cairnRefs", "cairnAssertValue");
  const source =
    spec.file !== undefined
      ? `file ${spec.file}`
      : typeof spec.actual === "string"
        ? spec.actual
        : "value";
  const expectation = resolved(spec.expect, scope, "value expectations", ctx);
  let actual: string;
  if (spec.file !== undefined) {
    useData(ctx, "dataValue", "cairnReadJsonOrText");
    actual = `cairnReadJsonOrText(${filePathExpr(spec.file, ctx)})`;
  } else {
    actual = resolved(spec.actual, scope, "value actual", ctx);
  }
  return {
    stmts: [
      braces([
        ...scopeDecl(scope),
        raw(
          `cairnAssertValue(${actual}, ${expectation}, ${JSON.stringify(authoredPlaceholders(source))});`,
        ),
      ]),
    ],
    exported: true,
  };
}

/* ----- http ----- */

const DS_PLACEHOLDER =
  /\$\{(secrets|env)\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__|__CAIRN_ENV_DEFAULT__([0-9a-f]+)_([0-9a-f]*)__/g;

/**
 * A config datasource string as a source expression: `${secrets.X}` /
 * `${env.X}` become run-time `process.env` reads (never a baked value), a
 * default (`:-d`) is the fallback of an unset or empty variable.
 */
function emitDatasourceString(
  text: string,
  source: string,
  ctx: EmitCtx,
): string {
  const parts: string[] = [];
  let last = 0;
  const literal = (chunk: string): void => {
    if (chunk.length > 0) parts.push(JSON.stringify(chunk));
  };
  for (const m of text.matchAll(DS_PLACEHOLDER)) {
    literal(text.slice(last, m.index));
    last = m.index + m[0].length;
    let ns = "env";
    let key: string;
    let fallback: string | undefined;
    if (m[2] !== undefined) {
      ns = m[1]!;
      key = m[2];
      fallback = m[3];
    } else if (m[4] !== undefined) {
      ns = "secrets";
      key = m[4];
    } else {
      key = Buffer.from(m[5]!, "hex").toString("utf8");
      fallback = Buffer.from(m[6] ?? "", "hex").toString("utf8");
    }
    useData(ctx, "dataHttp", "cairnDatasourceEnv");
    if (fallback === undefined) ctx.usage.envNames.add(key);
    else ctx.usage.optionalEnvNames.add(key);
    parts.push(
      `cairnDatasourceEnv(${JSON.stringify(source)}, ${JSON.stringify(`${ns}.${key}`)}, ${JSON.stringify(key)}${
        fallback !== undefined ? `, ${JSON.stringify(fallback)}` : ""
      })`,
    );
  }
  literal(text.slice(last));
  return parts.length === 0
    ? '""'
    : parts.length === 1
      ? parts[0]!
      : `[${parts.join(", ")}].join("")`;
}

function datasourceLiteral(
  name: string,
  ds: ExportHttpDatasource,
  ctx: EmitCtx,
): string {
  const fields = [
    `name: ${JSON.stringify(name)}`,
    `baseUrl: ${emitDatasourceString(ds.baseUrl, name, ctx)}`,
  ];
  if (ds.headers && Object.keys(ds.headers).length > 0) {
    fields.push(
      `headers: { ${Object.entries(ds.headers)
        .map(
          ([key, value]) =>
            `${JSON.stringify(key)}: ${emitDatasourceString(value, name, ctx)}`,
        )
        .join(", ")} }`,
    );
  }
  if (ds.auth?.basic !== undefined) {
    fields.push(`basic: ${emitDatasourceString(ds.auth.basic, name, ctx)}`);
  }
  if (ds.auth?.bearer !== undefined) {
    fields.push(`bearer: ${emitDatasourceString(ds.auth.bearer, name, ctx)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

/** `{ a, b }`, or `{}` without fields. */
function objectLiteral(fields: string[]): string {
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
}

/** The status expectation of an `http` verifier / `expect.request` as a literal. */
function statusLiteral(status: unknown): string | undefined {
  return status === undefined ? undefined : JSON.stringify(status);
}

export function renderHttpOutcome(
  v: HttpVerifier,
  outcome: Outcome,
  ctx: EmitCtx,
): Rendered {
  const h = v.http;
  const datasource = h.source ? ctx.httpDatasources?.[h.source] : undefined;
  if (h.source && !datasource) {
    return skipStmt(
      ctx,
      "outcome",
      `http verifier not exported: datasource "${h.source}" is not an http datasource of the export environment (unknown, disabled or another kind)`,
      `http verifier skipped — datasource ${h.source} unavailable`,
      outcome.id,
    );
  }
  const scope = refScope(ctx, [h.url, h.headers, h.body, h.expect?.json], {
    kind: "outcome",
    id: outcome.id,
  });
  if (scope.blocked) {
    return blockedStmts(
      scope,
      `http verifier not exported: a reference has no producer in this scope`,
    );
  }
  useData(ctx, "dataHttp", "cairnHttpVerify");
  ctx.usesTestInfo = true;
  const method = (h.method ?? "GET").toUpperCase();
  const operand: Record<string, unknown> = { url: h.url };
  if (h.headers) operand["headers"] = h.headers;
  if (h.body !== undefined) operand["body"] = h.body;
  if (h.expect?.json) operand["json"] = h.expect.json;
  const call = resolved(operand, scope, "http", ctx);
  const callFields = [
    `method: ${JSON.stringify(method)}`,
    `url: String(cairnCall.url)`,
    ...(h.headers ? [`headers: cairnCall.headers`] : []),
    ...(h.body !== undefined ? [`body: cairnCall.body`] : []),
    `timeoutMs: ${h.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS}`,
    ...(datasource
      ? [`source: ${datasourceLiteral(h.source!, datasource, ctx)}`]
      : []),
    `baseUrl: test.info().project.use.baseURL`,
  ];
  const expectFields = [
    ...(h.expect?.status !== undefined
      ? [`status: ${statusLiteral(h.expect.status)}`]
      : []),
    ...(h.expect?.json ? [`json: cairnCall.json`] : []),
  ];
  const stmts: Stmt[] = [
    ...scopeDecl(scope),
    raw(`const cairnCall = ${call};`),
    raw(
      `const cairnReply = await cairnHttpVerify({ ${callFields.join(", ")} }, ${objectLiteral(expectFields)});`,
    ),
  ];
  if (h.assign) {
    const key = runtimeRefKey("captures", h.assign);
    if (wantsBinding(ctx, key)) {
      const ident = declareBinding(
        ctx,
        key,
        bindingIdent("cairnCaptures", h.assign),
      );
      stmts.push(
        raw(`${ident} = { status: cairnReply.status, body: cairnReply.body };`),
      );
      publishBinding(ctx, key, ident);
    } else {
      stmts.push(raw(`void cairnReply;`));
    }
  } else {
    stmts.push(raw(`void cairnReply;`));
  }
  return { stmts: [braces(stmts)], exported: true };
}

/* ----- network (body / count / assign) ----- */

export function renderNetworkJudged(
  v: NetworkVerifier,
  outcome: Outcome,
  ctx: EmitCtx,
): Rendered {
  const n = v.network;
  const scope = refScope(ctx, [n.body?.json], {
    kind: "outcome",
    id: outcome.id,
  });
  if (scope.blocked) {
    return blockedStmts(
      scope,
      `network verifier not exported: a reference has no producer in this scope`,
    );
  }
  useData(ctx, "dataNetwork", "cairnAssertNetwork");
  const spec: Record<string, unknown> = { urlContains: n.urlContains };
  if (n.method) spec["method"] = n.method;
  if (n.status) spec["status"] = n.status;
  if (n.body !== undefined) spec["body"] = n.body;
  if (n.count !== undefined) spec["count"] = n.count;
  if (n.assign) spec["assign"] = n.assign;
  const call = `await cairnAssertNetwork(requests, ${emitTyped(spec, ctx)}, ${
    scope.expr ? "cairnScope" : "{}"
  })`;
  const stmts: Stmt[] = [...scopeDecl(scope)];
  const key = n.assign ? runtimeRefKey("network", n.assign) : undefined;
  if (n.assign && key && wantsBinding(ctx, key)) {
    const ident = declareBinding(
      ctx,
      key,
      bindingIdent("cairnNetwork", n.assign),
    );
    stmts.push(raw(`${ident} = ${call};`));
    publishBinding(ctx, key, ident);
  } else {
    stmts.push(raw(`${call};`));
  }
  return { stmts: [braces(stmts)], exported: true };
}

/**
 * `noFailedRequests`: the runner's own judge (`judgeNoFailedRequests`: a
 * 4xx/5xx status OR a network error — aborted, blocked, DNS, refused) over
 * the request log, which records `requestfailed` too.
 */
export function renderNoFailedRequestsJudged(
  v: NoFailedRequestsVerifier,
  ctx: EmitCtx,
): Rendered {
  useData(ctx, "dataNetwork", "cairnAssertNoFailedRequests");
  const n = v.noFailedRequests;
  const spec: Record<string, unknown> = { urlContains: n.urlContains };
  if (n.method) spec["method"] = n.method;
  return {
    stmts: [
      raw(
        `await cairnAssertNoFailedRequests(requests, ${emitTyped(spec, ctx)});`,
      ),
    ],
    exported: true,
  };
}

/* ----- file / xlsx ----- */

export function renderFileOutcome(v: FileVerifier, ctx: EmitCtx): Rendered {
  const f = v.file;
  useData(ctx, "dataFile", "cairnAssertFile");
  const timeout = f.timeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
  const contains =
    f.contains === undefined ? "undefined" : emitTyped(f.contains, ctx);
  return {
    stmts: [
      raw(
        `await cairnAssertFile(${JSON.stringify(authoredPlaceholders(f.glob))}, ${filePathExpr(f.glob, ctx)}, ${contains}, ${timeout});`,
      ),
    ],
    exported: true,
  };
}

export function renderXlsxOutcome(
  v: XlsxVerifier,
  outcome: Outcome,
  ctx: EmitCtx,
): Rendered {
  if (!ctx.libImportPrefix) {
    return skipStmt(
      ctx,
      "outcome",
      "xlsx verifier needs the workbook reader, which is a file of its own: export with --project (or --into)",
      `xlsx verifier skipped — export with --project to carry the workbook reader`,
      outcome.id,
    );
  }
  const { path, ...checks } = v.xlsx;
  const scope = refScope(ctx, [checks], { kind: "outcome", id: outcome.id });
  if (scope.blocked) {
    return blockedStmts(
      scope,
      `xlsx verifier not exported: a reference has no producer in this scope`,
    );
  }
  useData(ctx, "dataXlsx", "cairnAssertXlsx");
  const operand = resolved(checks, scope, "xlsx checks", ctx);
  return {
    stmts: [
      braces([
        ...scopeDecl(scope),
        raw(`cairnAssertXlsx(${filePathExpr(path, ctx)}, ${operand});`),
      ]),
    ],
    exported: true,
  };
}

/* ----- expect.request ----- */

export function renderExpectRequestStep(
  step: ExpectStep,
  ctx: EmitCtx,
): Rendered {
  const e = step.expect;
  if (!("request" in e)) throw new Error("not an expect.request step");
  const r = e.request;
  const scope = refScope(ctx, [r.url, r.headers, r.body, r.json], {
    kind: "step",
    id: step.id,
  });
  if (scope.blocked) {
    return blockedStmts(
      scope,
      `expect.request ${oneLine(r.url)} not exported: a reference has no producer in this scope`,
    );
  }
  useData(ctx, "dataHttp", "cairnExpectRequest");
  const operand: Record<string, unknown> = { url: r.url };
  if (r.headers) operand["headers"] = r.headers;
  if (r.body !== undefined) operand["body"] = r.body;
  if (r.json) operand["json"] = r.json;
  const call = withSpliceSources(ctx, NO_SPLICE, () =>
    resolved(operand, scope, "expect.request", ctx),
  );
  const callFields = [
    `method: ${JSON.stringify(r.method)}`,
    `url: String(cairnCall.url)`,
    ...(r.headers ? [`headers: cairnCall.headers`] : []),
    ...(r.body !== undefined ? [`body: cairnCall.body`] : []),
  ];
  const expectFields = [
    ...(r.status !== undefined ? [`status: ${statusLiteral(r.status)}`] : []),
    ...(r.json ? [`json: cairnCall.json`] : []),
  ];
  return {
    stmts: [
      braces([
        ...scopeDecl(scope),
        raw(`const cairnCall = ${call};`),
        raw(
          `await cairnExpectRequest(page, { ${callFields.join(", ")} }, ${objectLiteral(expectFields)}, ${e.timeoutMs ?? DEFAULT_EXPECT_REQUEST_TIMEOUT_MS});`,
        ),
      ]),
    ],
    exported: true,
  };
}

export {
  DEFAULT_EXPECT_REQUEST_TIMEOUT_MS,
  DEFAULT_FILE_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
};
