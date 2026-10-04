import {
  inlineRuntimeModule,
  runtimeModuleClosure,
  runtimeModuleNodeImports,
  type RuntimeModuleName,
} from "./runtimeSources";

/**
 * Test-time data glue of the export: the thin `cairn*` functions generated
 * tests call to run `value`, `http`, `httpJson`, `network` body / count,
 * `file` and `xlsx` verifiers and `expect.request` steps. Each glue piece only
 * orchestrates (resolve references, send, call the runner module that judges,
 * throw the verdict); the judging itself is always the real runner module
 * embedded by ./runtimeSources.ts — never re-implemented here.
 *
 * A project export writes each piece (and the runtime modules it imports) as
 * `lib/<piece>.ts|js`; a single-file export inlines the pieces it calls after
 * the runtime modules they need (and cannot carry the xlsx reader, which is a
 * file of its own).
 */
type ExportLang = "ts" | "js";

export type DataPiece =
  /**
   * No glue: a single file that calls the request runtime inlines the runner's
   * matcher module for it (a project's `lib/request` imports `lib/runtime/matchers`).
   */
  | "dataMatch"
  | "dataPath"
  | "dataValue"
  | "dataHttp"
  | "dataHttpJson"
  | "dataNetwork"
  | "dataFile"
  | "dataXlsx"
  | "dataTransform";

export const DATA_PIECES: readonly DataPiece[] = [
  "dataPath",
  "dataValue",
  "dataHttp",
  "dataHttpJson",
  "dataNetwork",
  "dataFile",
  "dataXlsx",
  "dataTransform",
];

interface PieceImports {
  /** Runtime modules (and the names the glue takes from each). */
  runtime: Array<{ module: RuntimeModuleName; names: string[] }>;
  /** `import { … } from "<from>"` of node built-ins. */
  node: Array<{ from: string; names: string[] }>;
  /** `@playwright/test` values / types. */
  playwright: { values: string[]; types: string[] };
  /** Needs the workbook reader (`lib/runtime/workbook`). */
  workbook?: string[];
  /** Other glue pieces this one calls. */
  pieces?: Array<{ piece: DataPiece; names: string[] }>;
}

const IMPORTS: Record<DataPiece, PieceImports> = {
  dataMatch: {
    runtime: [{ module: "matchers", names: [] }],
    node: [],
    playwright: { values: [], types: [] },
  },
  dataPath: {
    runtime: [],
    node: [{ from: "node:path", names: ["isAbsolute", "resolve"] }],
    playwright: { values: [], types: [] },
  },
  dataValue: {
    runtime: [
      { module: "matchers", names: ["matchPaths", "summarizeReport"] },
      { module: "refs", names: ["resolveRefsDeep"] },
    ],
    node: [{ from: "node:fs", names: ["readFileSync"] }],
    playwright: { values: [], types: [] },
  },
  dataHttp: {
    runtime: [
      { module: "httpWire", names: [] },
      { module: "responseJudge", names: ["judgeHttp", "judgeResponse"] },
      { module: "url", names: ["isRelativeUrl", "joinUrl"] },
      { module: "redact", names: ["scrubDatasourceText"] },
    ],
    node: [],
    playwright: { values: ["request"], types: ["Page"] },
  },
  dataHttpJson: {
    runtime: [
      { module: "httpJsonMatch", names: ["matchHttpJson", "readJsonPath"] },
    ],
    node: [],
    playwright: { values: [], types: [] },
  },
  dataNetwork: {
    runtime: [
      {
        module: "networkJudge",
        names: [
          "filterNetworkEntries",
          "isInFlight",
          "judgeNetwork",
          "judgeNoFailedRequests",
          "NETWORK_SETTLE_POLL_MS",
          "NETWORK_SETTLE_TIMEOUT_MS",
        ],
      },
    ],
    node: [],
    playwright: { values: [], types: ["Page"] },
  },
  dataFile: {
    runtime: [{ module: "fileWait", names: ["waitForFile"] }],
    node: [],
    playwright: { values: [], types: [] },
  },
  dataTransform: {
    runtime: [],
    node: [
      { from: "node:fs", names: ["existsSync", "mkdirSync"] },
      { from: "node:path", names: ["dirname"] },
    ],
    playwright: { values: [], types: [] },
  },
  dataXlsx: {
    runtime: [{ module: "xlsxJudge", names: ["judgeXlsx"] }],
    node: [{ from: "node:fs", names: ["readFileSync"] }],
    playwright: { values: [], types: [] },
    workbook: ["readWorkbook"],
  },
};

/** Type names a piece takes from a runtime module (TypeScript only). */
const TYPE_IMPORTS: Partial<
  Record<DataPiece, Array<{ module: RuntimeModuleName; names: string[] }>>
> = {
  dataValue: [
    { module: "matchers", names: ["PathMatchers"] },
    { module: "refs", names: ["RefScope"] },
  ],
  dataHttp: [
    {
      module: "httpWire",
      names: ["HttpReply"],
    },
    { module: "responseJudge", names: ["HttpExpectation"] },
  ],
  dataHttpJson: [{ module: "httpJsonMatch", names: ["HttpJsonMatcher"] }],
  dataNetwork: [
    {
      module: "networkJudge",
      names: [
        "NetworkAssignment",
        "NetworkJudgeEntry",
        "NetworkSpec",
        "NoFailedRequestsSpec",
      ],
    },
    { module: "refs", names: ["RefScope"] },
  ],
  dataXlsx: [{ module: "xlsxJudge", names: ["XlsxChecks"] }],
};

/** Value names from httpWire the http glue uses. */
const HTTP_WIRE_VALUES = [
  "buildHttpReply",
  "datasourceHeaders",
  "datasourceOriginViolation",
  "followRedirects",
  "joinBaseUrl",
  "prepareHttpRequest",
];

function annotate(lang: ExportLang): (annotation: string) => string {
  return (annotation) => (lang === "ts" ? annotation : "");
}

function pieceLines(
  piece: DataPiece,
  lang: ExportLang,
  exported: boolean,
): string[] {
  const t = annotate(lang);
  const exp = exported ? "export " : "export ";
  switch (piece) {
    case "dataMatch":
      return [];
    case "dataPath":
      return [
        `/** A file path the way the runner resolves it: absolute as is; relative to the run directory when it came from an artifact reference, else to the spec directory. */`,
        `${exp}function cairnFilePath(input${t(": string")}, usedArtifact${t(": boolean")}, runDir${t(": string")}, specDir${t(": string")})${t(": string")} {`,
        `  if (isAbsolute(input)) return input;`,
        `  return resolve(usedArtifact ? runDir : specDir, input);`,
        `}`,
        ``,
      ];
    case "dataValue":
      return [
        `/** Resolve \${requests|evals|captures|network|fixtures|runs|artifacts.…} references in a value (a whole reference keeps its type); an unresolved one fails like cairn run. */`,
        `${exp}function cairnRefs${t("<T>")}(value${t(": T")}, scope${t(": RefScope")}, what${t(": string")})${t(": T")} {`,
        `  const resolved = resolveRefsDeep(value, scope);`,
        `  if (resolved.missing.length > 0) throw new Error(what + ": unresolved " + resolved.missing.join(", "));`,
        `  return resolved.value;`,
        `}`,
        ``,
        `/** The \`value\` verifier's verdict: every path matcher against \`actual\`. */`,
        `${exp}function cairnAssertValue(actual${t(": unknown")}, expectation${t(": PathMatchers")}, source${t(": string")})${t(": void")} {`,
        `  const report = matchPaths(actual, expectation);`,
        `  if (report.passed) return;`,
        `  const summary = summarizeReport(report);`,
        `  throw new Error("value " + source + ": expected " + summary.expected + "; got " + summary.actual);`,
        `}`,
        ``,
        `/** A JSON file (or its text when it is not JSON): the \`value\` verifier's \`file\` source. */`,
        `${exp}function cairnReadJsonOrText(path${t(": string")})${t(": unknown")} {`,
        `  const text = readFileSync(path, "utf8");`,
        `  try {`,
        `    return JSON.parse(text)${t(" as unknown")};`,
        `  } catch {`,
        `    return text;`,
        `  }`,
        `}`,
        ``,
      ];
    case "dataHttp":
      return [
        `/** The \`http\` verifier's datasource (config \`datasources:\` entry); values are read from the environment when the test runs. */`,
        ...(lang === "ts"
          ? [
              `${exp}interface CairnHttpSource {`,
              `  name: string;`,
              `  baseUrl: string;`,
              `  headers?: Record<string, string>;`,
              `  basic?: string;`,
              `  bearer?: string;`,
              `}`,
              ``,
              `${exp}interface CairnHttpCall {`,
              `  method: string;`,
              `  url: string;`,
              `  headers?: Record<string, string>;`,
              `  body?: unknown;`,
              `  timeoutMs: number;`,
              `  source?: CairnHttpSource;`,
              `  /** Playwright's baseURL (a relative URL without a source needs it). */`,
              `  baseUrl?: string;`,
              `}`,
              ``,
            ]
          : []),
        `/** \${env.X} / \${secrets.X} in a datasource entry: unset (or empty) without a default fails like cairn run. */`,
        `${exp}function cairnDatasourceEnv(source${t(": string")}, reference${t(": string")}, key${t(": string")}, fallback${t("?: string")})${t(": string")} {`,
        `  const value = process.env[key];`,
        `  if (value === undefined || value === "") {`,
        `    if (fallback !== undefined) return fallback;`,
        `    throw new Error("datasource " + source + ": \${" + reference + "} is not set — export it before running the suite");`,
        `  }`,
        `  return value;`,
        `}`,
        ``,
        `/** Send one \`http\` verifier call through Playwright's APIRequestContext (no browser cookies), with the runner's redirect, header and reply rules. */`,
        `${exp}async function cairnHttpSend(call${t(": CairnHttpCall")})${t(": Promise<{ reply: HttpReply; shownUrl: string }>")} {`,
        `  const method = call.method;`,
        `  let url${t(": string")};`,
        `  let headers = call.headers;`,
        `  let secrets${t(": string[]")} = [];`,
        `  const source = call.source;`,
        `  if (source) {`,
        `    const violation = datasourceOriginViolation(source.name, source.baseUrl, call.url);`,
        `    if (violation !== undefined) throw new Error(violation);`,
        `    url = joinBaseUrl(source.baseUrl, call.url);`,
        `    const auth${t(": { basic?: string; bearer?: string }")} = {};`,
        `    if (source.basic !== undefined) auth.basic = source.basic;`,
        `    if (source.bearer !== undefined) auth.bearer = source.bearer;`,
        `    const sourceHeaders = datasourceHeaders({ ...(source.headers ? { headers: source.headers } : {}), auth });`,
        `    headers = { ...sourceHeaders, ...call.headers };`,
        `    secrets = [...Object.values(source.headers ?? {}), source.basic, source.bearer, sourceHeaders["Authorization"]?.replace(/^\\w+ /, "")].filter((value)${t(": value is string")} => typeof value === "string" && value.length >= 4);`,
        `  } else if (isRelativeUrl(call.url)) {`,
        `    if (!call.baseUrl) throw new Error("relative URL \\"" + call.url + "\\" needs source: <http datasource> or an environment baseUrl (Playwright baseURL)");`,
        `    url = joinUrl(call.baseUrl, call.url);`,
        `  } else {`,
        `    url = call.url;`,
        `  }`,
        `  const scrub = (text${t(": string")})${t(": string")} => scrubDatasourceText(text, secrets);`,
        `  const prepared = prepareHttpRequest(headers, call.body);`,
        `  // fetch gives a string body text/plain; Playwright would send octet-stream.`,
        `  if (typeof call.body === "string" && !Object.keys(prepared.headers).some((name) => name.toLowerCase() === "content-type")) {`,
        `    prepared.headers["content-type"] = "text/plain;charset=UTF-8";`,
        `  }`,
        `  const deadline = Date.now() + call.timeoutMs;`,
        `  const api = await request.newContext();`,
        `  try {`,
        `    const followed = await followRedirects(`,
        `      async (hop) => {`,
        `        const remaining = deadline - Date.now();`,
        `        if (remaining <= 0) throw new Error("timed out after " + call.timeoutMs + "ms");`,
        `        const res = await api.fetch(hop.url, { method: hop.method, headers: hop.headers, ...(hop.body !== undefined ? { data: hop.body } : {}), timeout: remaining, maxRedirects: 0, failOnStatusCode: false });`,
        `        return { res, status: res.status(), location: res.headers()["location"] ?? null };`,
        `      },`,
        `      async (hop) => {`,
        `        await hop.res.dispose();`,
        `      },`,
        `      url,`,
        `      method,`,
        `      prepared.headers,`,
        `      prepared.body,`,
        `    );`,
        `    const raw = await followed.res.text().catch(() => "");`,
        `    return { reply: buildHttpReply(followed.status, followed.res.headers(), raw), shownUrl: url };`,
        `  } catch (error) {`,
        `    const message = error instanceof Error ? error.message : String(error);`,
        `    const reason = /Timeout \\d+ms exceeded|timed out/i.test(message) ? "timed out after " + call.timeoutMs + "ms" : (/\\b(E[A-Z]{3,}\\b)/.exec(message)?.[1] ?? message.split("\\n")[0] ?? message);`,
        `    throw new Error(scrub(method + " " + url + " failed: " + reason));`,
        `  } finally {`,
        `    await api.dispose();`,
        `  }`,
        `}`,
        ``,
        `/** The \`http\` verifier: send, judge status / JSON paths, throw the verdict; returns the reply (\`assign\`). */`,
        `${exp}async function cairnHttpVerify(call${t(": CairnHttpCall")}, expectation${t(": HttpExpectation | undefined")})${t(": Promise<HttpReply>")} {`,
        `  const { reply, shownUrl } = await cairnHttpSend(call);`,
        `  const verdict = judgeHttp(expectation, call.method, shownUrl, reply);`,
        `  if (!verdict.passed) throw new Error("http: expected " + verdict.expected + "; got " + verdict.actual);`,
        `  return reply;`,
        `}`,
        ``,
        `/** \`expect.request\`: a session-cookie API call checked like an outcome; GET / HEAD are retried until it holds. */`,
        `${exp}async function cairnExpectRequest(`,
        `  page${t(": Page")},`,
        `  call${t(": { method: string; url: string; headers?: Record<string, string>; body?: unknown }")},`,
        `  expectation${t(": HttpExpectation")},`,
        `  timeoutMs${t(": number")},`,
        `)${t(": Promise<void>")} {`,
        `  const label = call.method + " " + call.url;`,
        `  const retry = call.method === "GET" || call.method === "HEAD";`,
        `  const started = Date.now();`,
        `  for (;;) {`,
        `    let failure${t(": string")};`,
        `    try {`,
        `      const response = await page.request.fetch(call.url, { method: call.method, ...(call.headers ? { headers: call.headers } : {}), ...(call.body !== undefined ? { data: call.body } : {}), timeout: Math.max(1, timeoutMs - (Date.now() - started)) });`,
        `      const text = await response.text();`,
        `      let body${t(": unknown")} = text;`,
        `      try {`,
        `        body = JSON.parse(text)${t(" as unknown")};`,
        `      } catch {`,
        `        body = text;`,
        `      }`,
        `      const checks = judgeResponse(expectation.status, expectation.json, { status: response.status(), body });`,
        `      const failing = checks.filter((check) => !check.passed);`,
        `      if (failing.length === 0) return;`,
        `      failure = "expect.request " + label + ": expected " + checks.map((check) => check.expected).join("; ") + "; got " + failing.map((check) => check.actual).join("; ");`,
        `    } catch (error) {`,
        `      failure = "expect.request " + label + ": " + (error instanceof Error ? error.message.split("\\n")[0] : String(error));`,
        `    }`,
        `    const elapsed = Date.now() - started;`,
        `    if (!retry || elapsed >= timeoutMs) throw new Error(failure);`,
        `    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(250, timeoutMs - elapsed)));`,
        `  }`,
        `}`,
        ``,
      ];
    case "dataHttpJson":
      return [
        `/** The \`httpJson\` verifier's verdict on a parsed response body. */`,
        `${exp}function cairnAssertHttpJson(body${t(": unknown")}, matcher${t(": HttpJsonMatcher")})${t(": void")} {`,
        `  const walked = readJsonPath(body, matcher.jsonPath);`,
        `  const verdict = matchHttpJson(walked.value, walked.exists, matcher);`,
        `  if (!verdict.passed) throw new Error("httpJson: expected " + verdict.expected + "; got " + verdict.actual);`,
        `}`,
        ``,
      ];
    case "dataNetwork":
      return [
        `/** The request log \`network\` / \`noFailedRequests\` outcomes are judged over, like \`cairn run\`'s: every request with its body (kept in memory only) and start time; the status joins when the response headers arrive, and a request that fails (aborted, blocked, DNS, refused) or finishes without a response carries an error. */`,
        `${exp}function cairnTrackRequests(page${t(": Page")})${t(": NetworkJudgeEntry[]")} {`,
        `  const log${t(": NetworkJudgeEntry[]")} = [];`,
        `  const byRequest = new Map${t("<object, NetworkJudgeEntry>")}();`,
        `  page.on("request", (request) => {`,
        `    const postData = request.postData();`,
        `    const entry${t(": NetworkJudgeEntry")} = { url: request.url(), method: request.method(), timestamp: Date.now(), ...(postData !== null ? { postData } : {}) };`,
        `    log.push(entry);`,
        `    byRequest.set(request, entry);`,
        `  });`,
        `  page.on("response", (response) => {`,
        `    const entry = byRequest.get(response.request());`,
        `    if (entry) entry.status = response.status();`,
        `  });`,
        `  page.on("requestfailed", (request) => {`,
        `    const entry = byRequest.get(request);`,
        `    if (entry) entry.error = request.failure()?.errorText ?? "request failed";`,
        `  });`,
        `  page.on("requestfinished", (request) => {`,
        `    const entry = byRequest.get(request);`,
        `    if (entry && entry.status === undefined) entry.error = request.failure()?.errorText ?? "request finished without response status";`,
        `  });`,
        `  return log;`,
        `}`,
        ``,
        `/** Wait (bounded, like \`cairn run\`'s end-of-steps snapshot) while a judged request has neither a status nor an error yet. */`,
        `async function cairnSettleRequests(log${t(": NetworkJudgeEntry[]")}, method${t(": string | undefined")}, urlContains${t(": string")}, settleMs${t(": number")})${t(": Promise<NetworkJudgeEntry[]>")} {`,
        `  const deadline = Date.now() + settleMs;`,
        `  for (;;) {`,
        `    const all = filterNetworkEntries(log, method, urlContains);`,
        `    const remaining = deadline - Date.now();`,
        `    if (!all.some(isInFlight) || remaining <= 0) return all;`,
        `    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(NETWORK_SETTLE_POLL_MS, remaining)));`,
        `  }`,
        `}`,
        ``,
        `/** The \`network\` verifier's verdict over the request log; returns the \`assign\` record. */`,
        `${exp}async function cairnAssertNetwork(log${t(": NetworkJudgeEntry[]")}, network${t(": NetworkSpec")}, scope${t(": RefScope")}, settleMs = NETWORK_SETTLE_TIMEOUT_MS)${t(": Promise<NetworkAssignment | undefined>")} {`,
        `  const judged = judgeNetwork(await cairnSettleRequests(log, network.method, network.urlContains, settleMs), network, scope);`,
        `  if (!judged.passed) throw new Error("network: expected " + judged.expected + "; got " + judged.actual);`,
        `  return judged.assignment;`,
        `}`,
        ``,
        `/** The \`noFailedRequests\` verifier's verdict (4xx/5xx or a network error) over the request log. */`,
        `${exp}async function cairnAssertNoFailedRequests(log${t(": NetworkJudgeEntry[]")}, spec${t(": NoFailedRequestsSpec")}, settleMs = NETWORK_SETTLE_TIMEOUT_MS)${t(": Promise<void>")} {`,
        `  const judged = judgeNoFailedRequests(await cairnSettleRequests(log, spec.method, spec.urlContains, settleMs), spec);`,
        `  if (!judged.passed) throw new Error("noFailedRequests: expected " + judged.expected + "; got " + judged.actual);`,
        `}`,
        ``,
      ];
    case "dataFile":
      return [
        `/** The \`file\` verifier: wait for a file matching the glob (and containing the text). */`,
        `${exp}async function cairnAssertFile(glob${t(": string")}, absGlob${t(": string")}, contains${t(": string | undefined")}, timeoutMs${t(": number")})${t(": Promise<void>")} {`,
        `  const result = await waitForFile(glob, absGlob, contains, timeoutMs);`,
        `  if (!result.passed) throw new Error("file: expected " + result.expected + "; got " + result.actual);`,
        `}`,
        ``,
      ];
    case "dataTransform":
      return [
        `/** A \`transform\` step: run the module's \`transform(ctx)\` (named export, or the default function) in the test's own process, then require the file it was to write. */`,
        `${exp}async function cairnRunTransform(imported${t(": unknown")}, ctx${t(": Record<string, unknown>")}, outputPath${t(": string")})${t(": Promise<void>")} {`,
        `  // Playwright transpiles TS imports to CJS, so a default export may surface as namespace.default.default.`,
        `  const namespace = imported${t(" as { transform?: unknown; default?: unknown }")};`,
        `  const fallback = namespace.default${t(" as { transform?: unknown; default?: unknown } | undefined")};`,
        `  const entry = namespace.transform ?? (typeof fallback === "function" ? fallback : (fallback?.transform ?? fallback?.default));`,
        `  if (typeof entry !== "function") throw new Error("node script must export a function or provide script.run source");`,
        `  mkdirSync(dirname(outputPath), { recursive: true });`,
        `  let returned${t(": { ok?: unknown } | null | undefined")};`,
        `  try {`,
        `    returned = (await entry(ctx))${t(" as { ok?: unknown } | null | undefined")};`,
        `  } catch (error) {`,
        `    throw new Error("node transform failed: " + (error instanceof Error ? error.message : String(error)));`,
        `  }`,
        `  if (returned && typeof returned === "object" && returned.ok === false) throw new Error("node transform returned ok=false");`,
        `  if (!existsSync(outputPath)) throw new Error("node transform did not write " + outputPath);`,
        `}`,
        ``,
      ];
    case "dataXlsx":
      return [
        `/** The \`xlsx\` verifier: read the workbook and run every check. */`,
        `${exp}function cairnAssertXlsx(workbookPath${t(": string")}, checks${t(": XlsxChecks")})${t(": void")} {`,
        `  let workbook${t(": ReturnType<typeof readWorkbook>")};`,
        `  try {`,
        `    workbook = readWorkbook(readFileSync(workbookPath));`,
        `  } catch (error) {`,
        `    throw new Error("xlsx: failed to read workbook at " + workbookPath + ": " + (error instanceof Error ? error.message : String(error)));`,
        `  }`,
        `  const judged = judgeXlsx(workbook, checks);`,
        `  if (judged.failures.length > 0) throw new Error("xlsx checks failed for " + workbookPath + ":\\n" + judged.failures.map((failure) => "- " + failure).join("\\n"));`,
        `}`,
        ``,
      ];
  }
}

/** The names a piece exports. */
export function dataPieceExports(piece: DataPiece): string[] {
  const names = new Set<string>();
  for (const line of pieceLines(piece, "ts", true)) {
    const m =
      /^export (?:async )?(?:function|interface) ([A-Za-z_$][\w$]*)/.exec(line);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

function importLine(
  from: string,
  values: string[],
  types: string[],
  lang: ExportLang,
): string | undefined {
  const items = [
    ...values,
    ...(lang === "ts" ? types.map((name) => `type ${name}`) : []),
  ];
  return items.length === 0
    ? undefined
    : `import { ${items.join(", ")} } from ${JSON.stringify(from)};`;
}

/** Every runtime module a set of pieces needs (dependencies included). */
export function dataRuntimeModules(
  pieces: Iterable<DataPiece>,
): RuntimeModuleName[] {
  const modules: RuntimeModuleName[] = [];
  for (const piece of pieces) {
    for (const entry of IMPORTS[piece].runtime) modules.push(entry.module);
    for (const entry of TYPE_IMPORTS[piece] ?? []) modules.push(entry.module);
    if (IMPORTS[piece].workbook) modules.push("xlsxJudge");
  }
  return runtimeModuleClosure(modules);
}

export function dataNeedsWorkbook(pieces: Iterable<DataPiece>): boolean {
  for (const piece of pieces) if (IMPORTS[piece].workbook) return true;
  return false;
}

/** The `lib/<piece>.ts|js` source of one glue piece. */
export function renderDataPieceModule(
  piece: DataPiece,
  lang: ExportLang,
): string {
  const def = IMPORTS[piece];
  const ext = lang === "js" ? ".js" : "";
  const lines: string[] = [
    `// Generated by \`cairn export playwright --project\`.`,
    `// Test-time glue: resolves references, sends, and hands the judging to the`,
    `// runner modules next to it (lib/*), which are Cairntrace's own sources.`,
  ];
  const playwright = importLine(
    "@playwright/test",
    def.playwright.values,
    def.playwright.types,
    lang,
  );
  if (playwright) lines.push(playwright);
  for (const entry of def.node) {
    const line = importLine(entry.from, entry.names, [], lang);
    if (line) lines.push(line);
  }
  const types = new Map<RuntimeModuleName, string[]>();
  for (const entry of TYPE_IMPORTS[piece] ?? []) {
    types.set(entry.module, [
      ...(types.get(entry.module) ?? []),
      ...entry.names,
    ]);
  }
  const values = new Map<RuntimeModuleName, string[]>();
  for (const entry of def.runtime) {
    values.set(
      entry.module,
      entry.module === "httpWire" ? HTTP_WIRE_VALUES : entry.names,
    );
  }
  for (const module of new Set([...values.keys(), ...types.keys()])) {
    const line = importLine(
      `./runtime/${module}${ext}`,
      values.get(module) ?? [],
      types.get(module) ?? [],
      lang,
    );
    if (line) lines.push(line);
  }
  if (def.workbook) {
    lines.push(
      `import { ${def.workbook.join(", ")} } from "./runtime/workbook.js";`,
    );
  }
  lines.push(``, ...pieceLines(piece, lang, true));
  return lines.join("\n");
}

/** What a single-file export inlines for a set of glue pieces. */
export interface InlinedData {
  /** `@playwright/test` names the glue needs. */
  playwright: { values: string[]; types: string[] };
  /** Node built-in imports, merged. */
  node: Array<{ from: string; names: string[] }>;
  /** Runtime-module and glue source lines, dependencies first. */
  lines: string[];
}

export function inlineDataPieces(
  pieces: Iterable<DataPiece>,
  lang: ExportLang,
): InlinedData {
  const wanted = new Set(pieces);
  const modules = dataRuntimeModules(wanted);
  const playwright = { values: new Set<string>(), types: new Set<string>() };
  const nodeImports = new Map<string, Set<string>>();
  const addNode = (from: string, names: string[]): void => {
    const set = nodeImports.get(from) ?? new Set<string>();
    for (const name of names) set.add(name);
    nodeImports.set(from, set);
  };
  const lines: string[] = [];
  for (const module of modules) {
    for (const entry of runtimeModuleNodeImports(module, lang)) {
      addNode(entry.from, entry.names);
    }
    lines.push(inlineRuntimeModule(module, lang), ``);
  }
  for (const piece of DATA_PIECES) {
    if (!wanted.has(piece)) continue;
    const def = IMPORTS[piece];
    for (const name of def.playwright.values) playwright.values.add(name);
    for (const name of def.playwright.types) playwright.types.add(name);
    for (const entry of def.node) addNode(entry.from, entry.names);
    lines.push(...pieceLines(piece, lang, true));
  }
  return {
    playwright: {
      values: [...playwright.values].toSorted(),
      types: [...playwright.types].toSorted(),
    },
    node: [...nodeImports].map(([from, names]) => ({
      from,
      names: [...names].toSorted(),
    })),
    lines,
  };
}
