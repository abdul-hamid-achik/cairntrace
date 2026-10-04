import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BrowserBackend } from "../../adapters/browserBackend";
import type {
  EnvAuth,
  EnvAuthAfterStep,
  EnvAuthCheck,
} from "../schema/request.v1";
import {
  useActionVars,
  useRetry,
  type Condition,
  type RequestStep,
  type UseStep,
} from "../schema/spec.v1";
import {
  resolveRequestUrl,
  runRequestStep,
  untilHolds,
  type RequestResponse,
  type RequestStepResult,
} from "./requestStep";
import { resolveResponsePlaceholders } from "./runtimePlaceholders";
import { withCairnPrelude, type AppHandles } from "../prelude/prelude";
import { lookupVar, renderVarValue } from "../config/varValue";

/**
 * F18: the built-in `use: login` — sign a run in through the API with the
 * environment's `auth:` block (config `environments.<name>.auth`):
 *
 *   1. `alreadyAuthenticated?` — a probe; when it holds, nothing else runs.
 *   2. `login` — the sign-in request (`${requests.login.…}` afterwards).
 *   3. `after?` — follow-ups (an OTP verify with the captured bearer), each
 *      with an optional `when` var predicate over runtime values.
 *   4. `hydrate?` — page JavaScript for an app that reads its session from a
 *      client store; it receives `args.login` (the login response body).
 *
 * `${secrets.X}` / `${env.X}` / `${vars.X}` resolve here, from the run's
 * (provider-scoped) environment, and every resolved secret is registered
 * for redaction before the first request leaves — so neither the values nor
 * the bearer a login returns ever reach an artifact.
 */

/** The login request's response name (`${requests.login.…}`). */
export const LOGIN_REQUEST_ASSIGN = "login";
/** The `alreadyAuthenticated` probe's response name. */
export const LOGIN_CHECK_ASSIGN = "login_check";
const DEFAULT_HYDRATE_TIMEOUT_MS = 15_000;

export interface EnvLoginOptions {
  step: UseStep;
  auth: EnvAuth | undefined;
  envName: string;
  backend: BrowserBackend;
  baseUrl?: string;
  /** Run environment (provider secrets included) for `${secrets.X}` / `${env.X}`. */
  env: Record<string, string | undefined>;
  /** Config + spec vars; the `use:` call's `vars` override them. */
  vars: Record<string, unknown>;
  /** `hydrate.file` resolves against the config directory. */
  configDir: string;
  /** `${requests.<name>.…}` values (the login's are added as it records). */
  responses: Record<string, unknown>;
  requestIndex: number;
  registerSecrets: (values: string[]) => void;
  /** Evaluate an `after[].when` var predicate (runtime values). */
  holds: (when: Condition) => Promise<boolean>;
  /** Write `requests/<assign>.json` (+ bind it when it passed). */
  record: (result: RequestStepResult) => Promise<string[]>;
  signal?: AbortSignal;
  /** F20: config `browser.appHandle`, for a hydrate script that uses `__cairn`. */
  appHandles?: AppHandles;
}

export interface EnvLoginResult {
  ok: boolean;
  error?: string;
  /** One line for the step result (`detail`): what the login did. */
  detail?: string;
  /** Run-relative artifacts written. */
  artifacts: string[];
}

export class EnvAuthPlaceholderError extends Error {
  constructor(reference: string, envName: string) {
    super(
      `\${${reference}} is not set — export it or add it to the provider's secrets for environment "${envName}"`,
    );
    this.name = "EnvAuthPlaceholderError";
  }
}

export async function runEnvLogin(
  opts: EnvLoginOptions,
): Promise<EnvLoginResult> {
  const artifacts: string[] = [];
  const fail = (error: string, detail?: string): EnvLoginResult => ({
    ok: false,
    error: `use: login: ${error}`,
    ...(detail ? { detail } : {}),
    artifacts,
  });
  if (!opts.auth) {
    return fail(
      `environment "${opts.envName}" has no auth: block (config environments.${opts.envName}.auth) — add one, or import an action named login`,
    );
  }
  if (useRetry(opts.step)) {
    return fail(
      "the built-in login takes no retry: — set retry on environments.<env>.auth.login",
    );
  }
  const vars = { ...opts.vars, ...useActionVars(opts.step) };
  let auth: EnvAuth;
  try {
    auth = resolveAuthTemplates(opts.auth, {
      env: opts.env,
      vars,
      envName: opts.envName,
      registerSecrets: opts.registerSecrets,
    });
  } catch (e) {
    return fail((e as Error).message);
  }

  const send = async (
    request: RequestStep["request"],
  ): Promise<RequestStepResult> => {
    const result = await runRequestStep({
      step: { request },
      backend: opts.backend,
      requestIndex: opts.requestIndex,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      registerSecrets: opts.registerSecrets,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    artifacts.push(...(await opts.record(result)));
    return result;
  };

  if (auth.alreadyAuthenticated) {
    const check = auth.alreadyAuthenticated;
    const probed = await send(checkRequest(check));
    if (probed.ok && checkHolds(probed.response, check)) {
      return {
        ok: true,
        detail: `already authenticated (${check.method} ${pathOf(check.url)} → ${probed.response.status}); login skipped`,
        artifacts,
      };
    }
  }

  const login = auth.login;
  const signedIn = await send({
    method: login.method,
    url: login.url,
    ...(login.headers ? { headers: login.headers } : {}),
    ...(login.body !== undefined ? { body: login.body } : {}),
    ...(login.timeoutMs ? { timeoutMs: login.timeoutMs } : {}),
    ...(login.expectStatus !== undefined
      ? { expectStatus: login.expectStatus }
      : {}),
    ...(login.retry ? { retry: login.retry } : {}),
    ...(login.capture ? { capture: login.capture } : {}),
    assign: LOGIN_REQUEST_ASSIGN,
  });
  if (!signedIn.ok) return fail(`login request: ${signedIn.error}`);
  const parts = [
    `logged in (${login.method} ${pathOf(login.url)} → ${signedIn.response.status})`,
  ];

  let followUps = 0;
  for (const [index, after] of (auth.after ?? []).entries()) {
    const label = after.id ?? `after[${index}]`;
    if (after.when) {
      let holds: boolean;
      try {
        holds = await opts.holds(after.when as Condition);
      } catch (e) {
        return fail(`${label} when: ${(e as Error).message}`, parts.join("; "));
      }
      if (!holds) continue;
    }
    const followed = await send(afterRequest(after, index, opts.responses));
    if (!followed.ok) {
      return fail(`${label}: ${followed.error}`, parts.join("; "));
    }
    followUps++;
  }
  if (followUps > 0) parts.push(`${followUps} follow-up(s)`);

  if (auth.hydrate) {
    const hydrated = await hydrate(opts, auth, signedIn.response);
    if (!hydrated.ok) {
      return fail(`hydrate: ${hydrated.error}`, parts.join("; "));
    }
    parts.push("hydrated");
  }
  return { ok: true, detail: parts.join("; "), artifacts };
}

function checkRequest(check: EnvAuthCheck): RequestStep["request"] {
  return {
    method: check.method,
    url: check.url,
    ...(check.headers ? { headers: check.headers } : {}),
    ...(check.body !== undefined ? { body: check.body } : {}),
    ...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}),
    assign: LOGIN_CHECK_ASSIGN,
  };
}

/** `status` (default any 2xx) and every `json` matcher. */
export function checkHolds(
  response: Pick<RequestResponse, "status" | "body">,
  check: Pick<EnvAuthCheck, "status" | "json">,
): boolean {
  if (check.status === undefined) {
    if (response.status < 200 || response.status >= 300) return false;
    return check.json ? untilHolds(response, { json: check.json }).holds : true;
  }
  return untilHolds(response, {
    status: check.status,
    ...(check.json ? { json: check.json } : {}),
  }).holds;
}

function afterRequest(
  after: EnvAuthAfterStep,
  index: number,
  responses: Record<string, unknown>,
): RequestStep["request"] {
  const spliced = mapStrings(after.request, (text) =>
    resolveResponsePlaceholders(text, responses),
  ) as EnvAuthAfterStep["request"];
  return {
    ...spliced,
    assign: spliced.assign ?? `login_after_${index + 1}`,
  };
}

async function hydrate(
  opts: EnvLoginOptions,
  auth: EnvAuth,
  login: RequestResponse,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = auth.hydrate!;
  let source: string;
  try {
    source =
      target.eval ??
      (await readFile(
        isAbsolute(target.file!)
          ? target.file!
          : resolve(opts.configDir, target.file!),
        "utf8",
      ));
  } catch (e) {
    return { ok: false, error: `failed to load: ${(e as Error).message}` };
  }
  // The script runs in the app's page: open its origin when nothing is.
  const current = await opts.backend.getUrl().catch(() => "about:blank");
  if (current === "about:blank" || current.startsWith("about:blank")) {
    const resolved = await resolveRequestUrl(auth.login.url, opts);
    if (resolved.ok && /^https?:\/\//i.test(resolved.url)) {
      const opened = await opts.backend.runStep({
        open: new URL(resolved.url).origin,
      });
      if (!opened.ok) {
        return {
          ok: false,
          error: `could not open the app before hydrating: ${
            opened.stderr.trim() || `exit ${opened.exitCode}`
          }`,
        };
      }
    }
  }
  const args = JSON.stringify({ login: login.body });
  // `args.login` is the session (a token): never in a process argv.
  const result = await opts.backend.evaluate(
    `(async (args) => { ${withCairnPrelude(source, opts.appHandles)} })(${args})`,
    {
      timeoutMs: target.timeoutMs ?? DEFAULT_HYDRATE_TIMEOUT_MS,
      sensitive: true,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr.trim() || `exit ${result.exitCode}`,
    };
  }
  return { ok: true };
}

/* ----- templates ----- */

const TEMPLATE_RE =
  /\$\{(secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)(?::-([^}]*))?\}/g;

/**
 * Resolve `${secrets.X}` / `${env.X}` (run environment) and `${vars.X}`
 * (config/spec/use-site vars) in every string of the auth block; runtime
 * references (`${requests.login.…}`) stay for their request. Every resolved
 * secret value is registered for redaction. An unset reference without a
 * `:-default` throws: signing in with "" would only fail later and worse.
 */
export function resolveAuthTemplates(
  auth: EnvAuth,
  scope: {
    env: Record<string, string | undefined>;
    vars: Record<string, unknown>;
    envName: string;
    registerSecrets: (values: string[]) => void;
  },
): EnvAuth {
  const secrets: string[] = [];
  const resolved = mapStrings(auth, (text) =>
    text.replace(
      TEMPLATE_RE,
      (match, ns: string, key: string, fallback: string | undefined) => {
        if (ns === "vars") {
          // F7: `${vars.name.key}` reads inside a typed var; lists and
          // objects render as compact JSON in this string context.
          const hit = lookupVar(scope.vars, key);
          if (hit.found) return renderVarValue(hit.value);
          if (fallback !== undefined) return fallback;
          throw new EnvAuthPlaceholderError(`vars.${key}`, scope.envName);
        }
        // Env and secret names never contain dots.
        if (key.includes(".")) return match;
        const value = scope.env[key];
        if (value === undefined || value === "") {
          if (fallback !== undefined) return fallback;
          throw new EnvAuthPlaceholderError(`${ns}.${key}`, scope.envName);
        }
        if (ns === "secrets") secrets.push(value);
        return value;
      },
    ),
  ) as EnvAuth;
  if (secrets.length > 0) scope.registerSecrets(secrets);
  return resolved;
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}

/** A URL's path for narration (no query string: it may carry a token). */
function pathOf(url: string): string {
  try {
    return new URL(url, "http://cairn.invalid").pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}
