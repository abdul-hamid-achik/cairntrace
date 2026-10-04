/**
 * F18: the exported runtime of `request` v2 and the environment login. One
 * source for the single-file export (only the helpers a test calls, inlined)
 * and `--project`'s `lib/request` (everything, exported), mirroring what
 * `cairn run` does (requestStep.ts / envAuth.ts):
 *
 * - `cairnRequest(page, input)` — `credentials: omit` through an isolated
 *   request context (no cookies out, none kept), `retry` on 5xx / network,
 *   `until` polling with the shared JSON matchers, `capture` (paths with
 *   filters, first match), `expectStatus`. Returns the runner's envelope.
 * - `cairnRequestMatrix(page, input, matrix)` — one request per combination,
 *   `${matrix.<key>…}` spliced; throws listing each mismatch.
 * - `cairnLogin(page, auth)` — `alreadyAuthenticated` / `login` / `after`
 *   through `page.request` (the page's cookie jar), then `hydrate` in the
 *   page with `args.login` only — credentials never reach page.evaluate.
 * - `cairnLoginState(auth, { baseURL, path })` — the same sign-in in a fresh
 *   request context, saved as a Playwright `storageState` file (globalSetup
 *   or a setup project).
 *
 * Code is written once with type annotations between <% and %> (kept for TS,
 * dropped for JS; ASCII on purpose: a transpiler may escape other characters
 * inside String.raw). JSON paths and data matchers are NOT re-implemented here:
 * the helpers call the runner's own \`readPath\` / \`matchPaths\`, which the
 * export carries as \`lib/runtime/matchers\` (see runtimeSources.ts).
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { EnvAuth } from "../schema/request.v1";
import { withCairnPrelude } from "../prelude/prelude";
import { lookupVar, renderVarValue } from "../config/varValue";

type ExportLang = "ts" | "js";

export type RequestHelperName =
  | "cairnRequest"
  | "cairnRequestMatrix"
  | "cairnLogin"
  | "cairnLoginState";

interface Block {
  name: string;
  deps: string[];
  /** Exported from `lib/request` (and callable from tests). */
  api?: boolean;
  code: string;
}

const BLOCKS: Block[] = [
  {
    name: "types",
    deps: [],
    code: String.raw`<%/** One request, as cairn run's request step sends it. */
interface CairnRequestInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  timeout?: number;
  credentials?: "include" | "omit";
  until?: { status?: number[]; json?: Record<string, unknown>; every?: number; timeoutMs?: number };
  retry?: { times: number; on?: string[]; delayMs?: number };
  capture?: Record<string, string>;
  expectStatus?: number[];
  assign?: string;
}

/** The envelope cairn run stores as requests/<name>.json. */
interface CairnRequestEnvelope {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  captures?: Record<string, unknown>;
  attempts?: number;
  matrix?: Array<{ values: Record<string, unknown>; method: string; url: string; status: number; matched: boolean; error?: string }>;
}

%>`,
  },
  {
    name: "typesAuth",
    deps: ["types"],
    code: String.raw`<%/** environments.<env>.auth with secrets as process.env reads. */
interface CairnAuth {
  login: CairnRequestInput;
  alreadyAuthenticated?: CairnRequestInput & { status?: number[]; json?: Record<string, unknown> };
  after?: Array<{ id?: string; when?: { var?: string; equals?: unknown; in?: unknown[]; exists?: boolean; holds?: boolean }; request: CairnRequestInput }>;
  hydrate?: { eval: string; timeoutMs?: number };
}

%>`,
  },
  {
    name: "cairnReadPath",
    deps: [],
    code: String.raw`/** Read a JSON path ($.a.b, items[0], rows[*].id, tasks[?(@.title == "x")].id): the runner's own readPath (lib/matchers). */
function cairnReadPath(root<%: unknown%>, path<%: string%>)<%: { exists: boolean; value: unknown }%> {
  return readPath(root, path);
}

`,
  },
  {
    name: "cairnMatch",
    deps: ["cairnReadPath"],
    code: String.raw`/** The first failing path → matcher (the runner's own matchPaths, lib/runtime/matchers), or undefined when all hold. */
function cairnMatchPaths(root<%: unknown%>, matchers<%: Record<string, unknown>%>)<%: string | undefined%> {
  const failing = matchPaths(root, matchers<% as PathMatchers%>).results.find((result) => !result.passed);
  return failing ? failing.path + " = " + failing.actual + " (expected " + failing.expected + ")" : undefined;
}

`,
  },
  {
    name: "cairnExcerpt",
    deps: [],
    code: String.raw`const CAIRN_SENSITIVE_KEY = /authorization|cookie|token|secret|passw(?:or)?d|pwd|passphrase|passcode|api[_-]?key|credential|otp|jwt|bearer|assertion|code[_-]?verifier|private[_-]?key/i;

/** Like cairn run's error excerpts: credential keys masked, long or token-shaped strings by length, never cut inside a string. */
function cairnExcerpt(value<%: unknown%>, max<%: number%>)<%: string%> {
  const tokenLike = (text<%: string%>)<%: boolean%> =>
    /^[A-Za-z0-9_\-+/=.~]{24,}$/.test(text) && /[0-9]/.test(text) && /[A-Za-z]/.test(text);
  if (typeof value === "string") {
    const masked = value.replace(/[A-Za-z0-9_\-+/=.~]{20,}/g, (word) => (tokenLike(word) ? "<" + word.length + " chars>" : word));
    if (masked.length <= max) return JSON.stringify(masked);
    const head = masked.slice(0, max);
    const cut = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf(">"), head.lastIndexOf(","));
    return JSON.stringify(cut > 0 ? head.slice(0, cut + 1).trimEnd() : head) + "…";
  }
  let text<%: string | undefined%>;
  try {
    text = JSON.stringify(value, (key, item) => {
      if (key !== "" && CAIRN_SENSITIVE_KEY.test(key) && item !== null && item !== undefined) return "[redacted]";
      if (typeof item === "string" && (item.length > 64 || tokenLike(item))) return "<string, " + item.length + " chars>";
      return item;
    });
  } catch {
    text = undefined;
  }
  if (text === undefined) return "<" + typeof value + ">";
  if (text.length <= max) return text;
  let inString = false;
  let escaped = false;
  let safe = 0;
  for (let i = 0; i < max; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        safe = i + 1;
      }
    } else if (ch === '"') inString = true;
    else safe = i + 1;
  }
  return text.slice(0, safe) + "…";
}

`,
  },
  {
    name: "cairnSend",
    deps: ["types", "cairnExcerpt"],
    code: String.raw`/** One call through a request context; a transport failure is a value. */
async function cairnSend(api<%: APIRequestContext%>, input<%: CairnRequestInput%>)<%: Promise<{ response?: CairnRequestEnvelope; error?: string }>%> {
  try {
    const res = await api.fetch(input.url, {
      method: input.method,
      ...(input.headers ? { headers: input.headers } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
      timeout: input.timeout ?? 30000,
      failOnStatusCode: false,
      maxRedirects: 20,
    });
    const text = await res.text();
    let body<%: unknown%> = text;
    try {
      body = JSON.parse(text);
    } catch {
      // a plain-text body
    }
    const status = res.status();
    return { response: { url: res.url(), method: input.method, status, ok: status >= 200 && status < 400, headers: res.headers(), body } };
  } catch (e<%: any%>) {
    return { error: String((e && e.message) || e) };
  }
}

/** retry: re-send after a 5xx or a transport failure (on), at most times more. */
async function cairnRetrySend(api<%: APIRequestContext%>, input<%: CairnRequestInput%>)<%: Promise<{ response?: CairnRequestEnvelope; error?: string; attempts: number }>%> {
  const on = input.retry?.on ?? ["5xx", "network"];
  const max = 1 + (input.retry?.times ?? 0);
  for (let attempts = 1; ; attempts++) {
    const sent = await cairnSend(api, input);
    const retryable = sent.response ? on.includes("5xx") && sent.response.status >= 500 : on.includes("network");
    if (!retryable || attempts >= max) return { ...sent, attempts };
    await new Promise((resolve) => setTimeout(resolve, input.retry?.delayMs ?? 500));
  }
}

function cairnCheckStatus(response<%: CairnRequestEnvelope%>, input<%: CairnRequestInput%>, attempts<%: number%>)<%: void%> {
  if (input.expectStatus && !input.expectStatus.includes(response.status)) {
    throw new Error(
      "request status " + response.status + " not in expectStatus [" + input.expectStatus.join(", ") + "] (" + input.method + " " + input.url + ")" +
        (attempts > 1 ? " after " + attempts + " attempts" : "") + " body: " + cairnExcerpt(response.body, 300),
    );
  }
}

`,
  },
  {
    name: "cairnCapture",
    deps: ["cairnReadPath"],
    code: String.raw`/** capture: { key: path } — a wildcard / filter path keeps its first match. */
function cairnCapture(body<%: unknown%>, capture<%: Record<string, string>%>)<%: Record<string, unknown>%> {
  const out<%: Record<string, unknown>%> = {};
  for (const [key, path] of Object.entries(capture)) {
    const read = cairnReadPath(body, path);
    const multi = /\[\s*(?:\*|\?)|\.\*(?:\.|\[|$)/.test(path);
    const value = multi && Array.isArray(read.value) ? read.value[0] : read.value;
    if (!read.exists || value === undefined) {
      throw new Error("capture " + key + ": " + path + " matched nothing in the response body");
    }
    out[key] = value;
  }
  return out;
}

`,
  },
  {
    name: "cairnContext",
    deps: [],
    code: String.raw`/** credentials: omit — an isolated request context (no cookies out, none kept). */
async function cairnIsolatedContext(page<%: Page%>)<%: Promise<APIRequestContext>%> {
  const current = page.url();
  const baseURL = /^https?:/i.test(current)
    ? new URL(current).origin
    : (test.info().project.use<% as { baseURL?: string }%>).baseURL;
  return request.newContext(baseURL ? { baseURL } : {});
}

`,
  },
  {
    name: "cairnRequest",
    api: true,
    deps: ["cairnSend", "cairnMatch", "cairnCapture", "cairnContext"],
    code: String.raw`/** A Cairntrace request step: credentials, retry, until, capture, expectStatus. */
export async function cairnRequest(page<%: Page%>, input<%: CairnRequestInput%>)<%: Promise<CairnRequestEnvelope>%> {
  const isolated = input.credentials === "omit" ? await cairnIsolatedContext(page) : undefined;
  const api = isolated ?? page.request;
  try {
    let response<%: CairnRequestEnvelope | undefined%>;
    let attempts = 0;
    if (input.until) {
      const until = input.until;
      const started = Date.now();
      const deadline = started + (until.timeoutMs ?? 30000);
      const every = until.every ?? 1000;
      let why = "no attempt finished";
      for (;;) {
        attempts++;
        const sent = await cairnSend(api, { ...input, timeout: Math.max(1, Math.min(input.timeout ?? 30000, deadline - Date.now())) });
        if (sent.response) {
          const status = sent.response.status;
          why = until.status && !until.status.includes(status)
            ? "status " + status + " not in [" + until.status.join(", ") + "]"
            : (until.json && cairnMatchPaths(sent.response.body, until.json)) || "";
          if (!why) {
            response = sent.response;
            break;
          }
        } else {
          why = "request failed: " + sent.error;
        }
        if (Date.now() + every >= deadline) {
          throw new Error("request until not satisfied after " + attempts + " attempt(s) in " + (Date.now() - started) + "ms (" + input.method + " " + input.url + "): " + why);
        }
        await new Promise((resolve) => setTimeout(resolve, every));
      }
    } else {
      const sent = await cairnRetrySend(api, input);
      attempts = sent.attempts;
      if (!sent.response) {
        throw new Error("request failed: " + sent.error + " (" + input.method + " " + input.url + ")" + (attempts > 1 ? " after " + attempts + " attempts" : ""));
      }
      response = sent.response;
    }
    if (attempts > 1) response.attempts = attempts;
    if (input.capture) response.captures = cairnCapture(response.body, input.capture);
    cairnCheckStatus(response, input, attempts);
    return response;
  } finally {
    await isolated?.dispose();
  }
}

`,
  },
  {
    name: "cairnSpliceMatrix",
    deps: ["cairnReadPath"],
    code: String.raw`/** Splice ${"$"}{matrix.<key>…}; a whole reference keeps its value's type. */
function cairnSpliceMatrix(value<%: unknown%>, values<%: Record<string, unknown>%>)<%: unknown%> {
  const read = (key<%: string%>, path<%: string%>)<%: unknown%> => {
    if (!path) return values[key];
    const hit = cairnReadPath(values[key], path.slice(1));
    return hit.exists ? hit.value : undefined;
  };
  if (typeof value === "string") {
    const whole = /^\$\{matrix\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}$/.exec(value);
    if (whole) return read(whole[1], whole[2] ?? "");
    return value.replace(/\$\{matrix\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}/g, (_m<%: string%>, key<%: string%>, path<%: string%>) => {
      const found = read(key, path);
      if (found === undefined || found === null) return "";
      return typeof found === "object" ? JSON.stringify(found) : String(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => cairnSpliceMatrix(item, values));
  if (value !== null && typeof value === "object") {
    const out<%: Record<string, unknown>%> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cairnSpliceMatrix(item, values);
    return out;
  }
  return value;
}

`,
  },
  {
    name: "cairnRequestMatrix",
    api: true,
    deps: ["cairnSend", "cairnSpliceMatrix", "cairnContext", "cairnExcerpt"],
    code: String.raw`/** request.matrix: every combination runs; throws listing the mismatches. */
export async function cairnRequestMatrix(page<%: Page%>, input<%: CairnRequestInput%>, matrix<%: Record<string, unknown[]>%>)<%: Promise<CairnRequestEnvelope>%> {
  let combinations<%: Array<Record<string, unknown>>%> = [{}];
  for (const [key, list] of Object.entries(matrix)) {
    combinations = combinations.flatMap((partial) => list.map((item) => ({ ...partial, [key]: item })));
  }
  const isolated = input.credentials === "omit" ? await cairnIsolatedContext(page) : undefined;
  const api = isolated ?? page.request;
  const results<%: NonNullable<CairnRequestEnvelope["matrix"]>%> = [];
  let lastStatus = 0;
  try {
    for (const values of combinations) {
      const call = cairnSpliceMatrix({ method: input.method, url: input.url, headers: input.headers, data: input.data }, values)<% as { method: string; url: string; headers?: Record<string, unknown>; data?: unknown }%>;
      const headers<%: Record<string, string>%> = {};
      for (const [name, item] of Object.entries(call.headers ?? {})) {
        if (item !== undefined && item !== null) headers[name] = typeof item === "string" ? item : JSON.stringify(item);
      }
      const method = String(call.method).toUpperCase();
      const sent = await cairnRetrySend(api, { ...input, method, url: String(call.url), headers, data: call.data });
      if (!sent.response) {
        results.push({ values, method, url: String(call.url), status: 0, matched: false, error: sent.error });
        continue;
      }
      lastStatus = sent.response.status;
      results.push({ values, method, url: String(call.url), status: lastStatus, matched: !input.expectStatus || input.expectStatus.includes(lastStatus) });
    }
  } finally {
    await isolated?.dispose();
  }
  const mismatches = results.filter((result) => !result.matched);
  if (mismatches.length > 0) {
    throw new Error(
      "request matrix: " + mismatches.length + "/" + results.length + " combination(s) did not match " +
        (input.expectStatus ? "expectStatus [" + input.expectStatus.join(", ") + "]" : "a response") + ": " +
        mismatches
          .map(
            (result) =>
              Object.entries(result.values)
                .map(([key, value]) => key + "=" + (CAIRN_SENSITIVE_KEY.test(key) ? "[redacted]" : cairnExcerpt(value, 80)))
                .join(", ") +
              " → " +
              (result.error ? "failed: " + result.error : result.status),
          )
          .join("; "),
    );
  }
  return { url: input.url, method: input.method, status: lastStatus, ok: true, headers: {}, body: null, matrix: results };
}

`,
  },
  {
    name: "cairnLoginWith",
    deps: ["typesAuth", "cairnSend", "cairnMatch", "cairnCapture"],
    code: String.raw`/** ${"$"}{requests.<name>.<path>} in an auth follow-up, from the login so far. */
function cairnSpliceRequests(value<%: unknown%>, responses<%: Record<string, unknown>%>)<%: unknown%> {
  if (typeof value === "string") {
    return value.replace(/\$\{requests\.([a-z][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}/g, (_m<%: string%>, name<%: string%>, path<%: string%>) => {
      const hit = path ? cairnReadPath(responses[name], path.slice(1)) : { exists: name in responses, value: responses[name] };
      if (!hit.exists || hit.value === undefined || hit.value === null) return "";
      return typeof hit.value === "object" ? JSON.stringify(hit.value) : String(hit.value);
    });
  }
  if (Array.isArray(value)) return value.map((item) => cairnSpliceRequests(item, responses));
  if (value !== null && typeof value === "object") {
    const out<%: Record<string, unknown>%> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cairnSpliceRequests(item, responses);
    return out;
  }
  return value;
}

/** environments.<env>.auth through one request context; undefined = already signed in. */
async function cairnLoginWith(api<%: APIRequestContext%>, auth<%: CairnAuth%>)<%: Promise<CairnRequestEnvelope | undefined>%> {
  const check = auth.alreadyAuthenticated;
  if (check) {
    const probed = await cairnSend(api, check);
    const status = probed.response?.status ?? 0;
    const statusOk = check.status ? check.status.includes(status) : status >= 200 && status < 300;
    if (probed.response && statusOk && !(check.json && cairnMatchPaths(probed.response.body, check.json))) {
      return undefined;
    }
  }
  const signedIn = await cairnRetrySend(api, auth.login);
  if (!signedIn.response) throw new Error("use: login: login request failed: " + signedIn.error);
  const login = signedIn.response;
  cairnCheckStatus(login, auth.login, signedIn.attempts);
  if (auth.login.capture) login.captures = cairnCapture(login.body, auth.login.capture);
  const responses<%: Record<string, unknown>%> = { login };
  for (const [index, after] of (auth.after ?? []).entries()) {
    const when = after.when;
    if (when) {
      let holds = when.holds;
      if (holds === undefined && when.var) {
        const parts = when.var.split(".");
        const hit = parts[0] === "requests" ? cairnReadPath(responses[parts[1]], parts.slice(2).join(".")) : { exists: false, value: undefined };
        const text = hit.exists && hit.value !== undefined && hit.value !== null ? (typeof hit.value === "object" ? JSON.stringify(hit.value) : String(hit.value)) : undefined;
        holds = when.exists !== undefined
          ? (text !== undefined && text !== "") === when.exists
          : when.in !== undefined
            ? text !== undefined && when.in.map(String).includes(text)
            : text !== undefined && text === String(when.equals);
      }
      if (!holds) continue;
    }
    const input = cairnSpliceRequests(after.request, responses)<% as CairnRequestInput%>;
    const followed = await cairnRetrySend(api, input);
    if (!followed.response) throw new Error("use: login: " + (after.id ?? "after[" + index + "]") + ": request failed: " + followed.error);
    cairnCheckStatus(followed.response, input, followed.attempts);
    if (input.capture) followed.response.captures = cairnCapture(followed.response.body, input.capture);
    responses[input.assign ?? "login_after_" + (index + 1)] = followed.response;
  }
  return login;
}

`,
  },
  {
    name: "cairnLogin",
    api: true,
    deps: ["cairnLoginWith"],
    code: String.raw`/**
 * use: login — sign the page's context in through the API (its cookies are the
 * page's), then hydrate the app with args.login only. Undefined when the
 * alreadyAuthenticated probe held.
 */
export async function cairnLogin(page<%: Page%>, auth<%: CairnAuth%>)<%: Promise<CairnRequestEnvelope | undefined>%> {
  const login = await cairnLoginWith(page.request, auth);
  if (login && auth.hydrate) {
    if (!/^https?:/i.test(page.url())) await page.goto(new URL(login.url).origin);
    await page.evaluate("(async (args) => { " + auth.hydrate.eval + " })(" + JSON.stringify({ login: login.body }) + ")");
  }
  return login;
}

`,
  },
  {
    name: "cairnLoginState",
    api: true,
    deps: ["cairnLoginWith"],
    code: String.raw`/**
 * The same sign-in in a fresh request context, saved as a storageState file —
 * call it from globalSetup (or a setup project) and point use.storageState at
 * the path. hydrate needs a page, so it runs only in cairnLogin. The file
 * holds session cookies: owner-only (0600, its folder 0700) and written
 * atomically (a temp file renamed over it), so a worker never reads a
 * half-written state while another signs in.
 */
export async function cairnLoginState(auth<%: CairnAuth%>, opts<%: { baseURL: string; path: string }%>)<%: Promise<void>%> {
  const api = await request.newContext({ baseURL: opts.baseURL });
  try {
    await cairnLoginWith(api, auth);
    const state = await api.storageState();
    const fs = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await fs.mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
    const temp = opts.path + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.rename(temp, opts.path);
    } finally {
      await fs.rm(temp, { force: true });
    }
  } finally {
    await api.dispose();
  }
}

`,
  },
];

const BY_NAME = new Map(BLOCKS.map((block) => [block.name, block]));

/** Blocks a helper set needs, in definition order. */
function closure(names: Iterable<string>): Block[] {
  const wanted = new Set<string>();
  const visit = (name: string): void => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const dep of BY_NAME.get(name)?.deps ?? []) visit(dep);
  };
  for (const name of names) visit(name);
  return BLOCKS.filter((block) => wanted.has(block.name));
}

function renderCode(code: string, lang: ExportLang): string {
  return lang === "ts"
    ? code.replaceAll(/<%([\s\S]*?)%>/g, "$1")
    : code.replaceAll(/<%[\s\S]*?%>/g, "");
}

/**
 * The helpers `names` call, as source lines. `exported` marks the API and
 * the types for `lib/request` (and keeps every block for it).
 */
export function renderRequestHelperLines(
  lang: ExportLang,
  names: Iterable<RequestHelperName>,
  opts: { exported?: boolean } = {},
): string[] {
  const blocks = opts.exported ? BLOCKS : closure(names);
  const out: string[] = [
    `// Cairntrace request runtime (request v2 + environment login): what`,
    `// \`cairn run\` does — credentials, retry, until, capture, matrix, use: login.`,
  ];
  for (const block of blocks) {
    let code = renderCode(block.code, lang);
    if (!opts.exported) code = code.replaceAll(/^export /gm, "");
    else if (block.name.startsWith("types")) {
      code = code.replaceAll(/^interface /gm, "export interface ");
    }
    out.push(...code.trimEnd().split("\n"), "");
  }
  return out;
}

/** What `names` import from "@playwright/test" (values and types). */
export function requestRuntimeImports(
  names: Iterable<RequestHelperName>,
  opts: { exported?: boolean } = {},
): { values: string[]; types: string[] } {
  const blocks = opts.exported ? BLOCKS : closure(names);
  const code = blocks.map((block) => block.code).join("\n");
  return {
    values: ["request", "test"].filter((name) =>
      new RegExp(`\\b${name}\\.(?:newContext|info)\\b`).test(code),
    ),
    types: ["APIRequestContext", "Page"].filter((name) =>
      new RegExp(
        `<%(?:(?!%>)[\\s\\S])*\\b${name}\\b(?:(?!%>)[\\s\\S])*%>`,
      ).test(code),
    ),
  };
}

/** `lib/request` for `--project`: every helper, exported. */
export function renderRequestRuntime(lang: ExportLang): string {
  const imports = requestRuntimeImports([], { exported: true });
  const specifiers = [
    ...imports.values,
    ...(lang === "ts" ? imports.types.map((name) => `type ${name}`) : []),
  ];
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    `import { ${specifiers.join(", ")} } from "@playwright/test";`,
    `import { matchPaths, readPath${
      lang === "ts" ? ", type PathMatchers" : ""
    } } from "./runtime/matchers${lang === "js" ? ".js" : ""}";`,
    ``,
    ...renderRequestHelperLines(lang, [], { exported: true }),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

/* ----- export-time auth (environments.<env>.auth → CairnAuth literal) ----- */

/** The export environment's `auth:` block and what resolves its templates. */
export interface ExportEnvAuth {
  auth: EnvAuth;
  envName: string;
  /** Config + spec vars (`${vars.X}`); a `use:` call's vars override them. */
  vars: Record<string, unknown>;
  /** `hydrate.file` resolves against it. */
  configDir: string;
  /** F20: config `browser.appHandle` (a hydrate script that uses `__cairn`). */
  appHandles?: Record<string, string>;
}

/**
 * The CairnAuth literal for an exported `use: login`: `${secrets.X}`
 * becomes the late-bound secret sentinel (emitted as `process.env.X`),
 * `${vars.X}` its value, `hydrate.file` its source text, and a plain-var
 * `after[].when` its verdict. `${requests.<name>…}` stays for the helper.
 */
export function prepareExportAuth(
  input: ExportEnvAuth,
  useVars: Record<string, unknown> = {},
): Record<string, unknown> {
  const vars = { ...input.vars, ...useVars };
  const { auth } = input;
  const call = (r: {
    method: string;
    url: string;
    headers?: Record<string, string> | undefined;
    body?: unknown;
    timeoutMs?: number | undefined;
    expectStatus?: number | number[] | undefined;
    retry?: unknown;
    capture?: Record<string, string> | undefined;
    assign?: string | undefined;
  }): Record<string, unknown> => ({
    method: r.method.toUpperCase(),
    url: r.url,
    ...(r.headers ? { headers: r.headers } : {}),
    ...(r.body !== undefined ? { data: r.body } : {}),
    timeout: r.timeoutMs ?? 30_000,
    ...(r.expectStatus !== undefined
      ? { expectStatus: list(r.expectStatus) }
      : {}),
    ...(r.retry ? { retry: r.retry } : {}),
    ...(r.capture ? { capture: r.capture } : {}),
    ...(r.assign ? { assign: r.assign } : {}),
  });
  const check = auth.alreadyAuthenticated;
  let hydrate: Record<string, unknown> | undefined;
  if (auth.hydrate) {
    const source =
      auth.hydrate.eval ??
      readFileSync(
        isAbsolute(auth.hydrate.file!)
          ? auth.hydrate.file!
          : resolve(input.configDir, auth.hydrate.file!),
        "utf8",
      );
    hydrate = {
      // F20: like `cairn run`, a hydrate script that uses `__cairn` gets
      // the page prelude first.
      eval: withCairnPrelude(source, input.appHandles),
      ...(auth.hydrate.timeoutMs ? { timeoutMs: auth.hydrate.timeoutMs } : {}),
    };
  }
  const prepared = {
    login: call(auth.login),
    ...(check
      ? {
          alreadyAuthenticated: {
            ...call(check),
            ...(check.status !== undefined
              ? { status: list(check.status) }
              : {}),
            ...(check.json ? { json: check.json } : {}),
          },
        }
      : {}),
    ...(auth.after
      ? {
          after: auth.after.map((after) => {
            const when = after.when;
            let preparedWhen: Record<string, unknown> | undefined;
            if (when && !when.var.includes(".")) {
              const raw = vars[when.var];
              const text = raw === undefined ? undefined : renderVarValue(raw);
              if (text !== undefined && /__CAIRN_[A-Z_]+__/.test(text)) {
                // A late-bound var (read from process.env when the test
                // runs) cannot decide this at export time, and its value
                // must never be baked in.
                throw new Error(
                  `environments.${input.envName}.auth.after: when.var ${when.var} reads \${env.…} / \${secrets.…}, so the export cannot decide it; give the var a literal value (or pass it with --var)`,
                );
              }
              preparedWhen = {
                holds:
                  when.exists !== undefined
                    ? (text !== undefined && text !== "") === when.exists
                    : when.in !== undefined
                      ? text !== undefined && when.in.map(String).includes(text)
                      : text !== undefined && text === String(when.equals),
              };
            } else if (when) {
              preparedWhen = { ...when };
            }
            return {
              ...(after.id ? { id: after.id } : {}),
              ...(preparedWhen ? { when: preparedWhen } : {}),
              request: call(after.request),
            };
          }),
        }
      : {}),
    ...(hydrate ? { hydrate } : {}),
  };
  return mapTemplateStrings(prepared, (text) =>
    text.replace(
      /\$\{(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)(?::-([^}]*))?\}/g,
      (match, ns: string, key: string, fallback: string | undefined) => {
        if (ns === "secrets") {
          return key.includes(".") ? match : `__CAIRN_SECRET_REF__${key}__`;
        }
        // F7: `${vars.name.key}` reads inside a typed var; lists / objects
        // render as compact JSON in this string context.
        const hit = lookupVar(vars, key);
        if (hit.found) return renderVarValue(hit.value);
        if (fallback !== undefined) return fallback;
        throw new Error(
          `environments.${input.envName}.auth: \${vars.${key}} is not defined`,
        );
      },
    ),
  ) as Record<string, unknown>;
}

function list(value: number | number[] | undefined): number[] | undefined {
  return value === undefined
    ? undefined
    : Array.isArray(value)
      ? value
      : [value];
}

function mapTemplateStrings(
  value: unknown,
  fn: (text: string) => string,
): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) {
    return value.map((item) => mapTemplateStrings(item, fn));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapTemplateStrings(item, fn);
    }
    return out;
  }
  return value;
}

/** `lib/auth` for `--project`: the environment's login as CAIRN_AUTH. */
export function renderAuthRuntime(lang: ExportLang, literal: string): string {
  const ts = lang === "ts";
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    `// environments.<env>.auth for use: login. Secrets are read from process.env;`,
    `// cairnLogin / cairnLoginState (lib/request) never pass them to page.evaluate.`,
    ...(ts ? [`import type { CairnAuth } from "./request";`] : []),
    ``,
    `export const CAIRN_AUTH${ts ? ": CairnAuth" : ""} = ${literal};`,
    ``,
  ].join("\n");
}
