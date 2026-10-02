import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import type {
  BrowserBackend,
  NetworkEntry,
  ScreenshotResult,
} from "../../adapters/browserBackend";
import { runSpec } from "../runner/Runner";
import type { ConfigVarValue } from "../schema/config.v1";
import type { RunResult, StepResult } from "../schema/run.v1";

/**
 * Discovery executes every step — setup, interactions, replays — through
 * `runSpec`, the same engine `cairn run` uses: config/env/var resolution,
 * `${secrets.X}` from the configured provider, imports and `use:` expansion,
 * the interaction resilience layer (fill read-back, click delivery, waits),
 * request/eval/wait semantics and the environment policy. The steps are
 * written to a short-lived synthetic spec whose only outcome is a no-op, run
 * against the session's live backend (never cold-started), and the run's
 * redacted artifacts (screenshot, network log, eval/request captures) are
 * harvested before its run directory is removed.
 */

/**
 * Hard deadline for one discovery screenshot: a backstop for a backend whose
 * capture never settles. It sits above the built-in backends' own bounds so
 * their diagnostic wins and no capture is still in flight when the next
 * action starts: Playwright gives up at 15s; agent-browser kills the capture
 * at 15s, then gives its daemon's queue up to 20s to finish it before it
 * stops the session (about 37s in all).
 */
export const DISCOVERY_SCREENSHOT_TIMEOUT_MS = 45_000;

/** A session's screenshot state (see {@link withScreenshotDeadline}). */
export interface DiscoveryScreenshots {
  /** Hard deadline for one capture. */
  timeoutMs: number;
  /** Set by the first capture that timed out: its error. Screenshots are off. */
  disabled?: string;
  /** The `screenshots.disabled` event and warning went out. */
  reported?: boolean;
}

/**
 * The backend discovery runs execute on: each screenshot is bounded by
 * `state.timeoutMs`, and once one timed out (a slept or locked display
 * leaves Chromium without a frame) the rest of the session takes none —
 * every action captures one, so a hung capture would otherwise cost each
 * action the full deadline. Only screenshots are touched: the browser,
 * its page and every other call pass through unchanged.
 */
export function withScreenshotDeadline(
  backend: BrowserBackend,
  state: DiscoveryScreenshots,
): BrowserBackend {
  const screenshot: BrowserBackend["screenshot"] = async (opts) => {
    if (state.disabled !== undefined) {
      return {
        ok: false,
        path: opts.path,
        durationMs: 0,
        error: `screenshot skipped: screenshots are off for this discovery session (${state.disabled})`,
      };
    }
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ScreenshotResult>((resolveDeadline) => {
      timer = setTimeout(
        () =>
          resolveDeadline({
            ok: false,
            path: opts.path,
            durationMs: Date.now() - started,
            error: `screenshot capture timed out after ${state.timeoutMs}ms — the browser returned no frame (is the display asleep or locked?)`,
          }),
        state.timeoutMs,
      );
    });
    const capture = Promise.resolve()
      .then(() => backend.screenshot(opts))
      .catch(
        (e: unknown): ScreenshotResult => ({
          ok: false,
          path: opts.path,
          durationMs: Date.now() - started,
          error: `screenshot failed: ${(e as Error).message}`,
        }),
      );
    try {
      const result = await Promise.race([capture, deadline]);
      if (!result.ok && /timed out/i.test(result.error ?? "")) {
        state.disabled ??= result.error;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  return new Proxy(backend, {
    get(target, prop) {
      if (prop === "screenshot") return screenshot;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" && prop !== "constructor"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Secrets resolved for one synthetic spec (see `resolveScopedSecrets`). */
export interface DiscoverySecrets {
  env: Record<string, string | undefined>;
  childEnv?: Record<string, string | undefined>;
  secretValues?: readonly string[];
  selectedTvaultKeys?: readonly string[];
  /**
   * Names a `${secrets.X}` placeholder may use (provider keys, config
   * `secrets.required` / `keys`): a literal value of one of them is
   * recorded as that placeholder, never as the value.
   */
  secretNames?: readonly string[];
}

/** Injected by the CLI/MCP layer (the core never talks to a vault). */
export type ResolveDiscoverySecrets = (
  specPath: string,
) => Promise<DiscoverySecrets>;

export interface DiscoveryRunContext {
  backend: BrowserBackend;
  /** Resolved cairntrace.config.yml (synthetic specs never discover one). */
  configPath?: string;
  /** Explicit environment (`env` input). */
  env?: string;
  /** `var` inputs. */
  vars?: Record<string, ConfigVarValue>;
  /** Where synthetic specs are written by default. */
  workDir: string;
  /** Artifact root of the runs. */
  runsDir: string;
  resolveSecrets?: ResolveDiscoverySecrets;
  /** Every literal secret value seen so far (feeds the session redactor). */
  secretValues: Set<string>;
  /** Called with every secrets resolution (the session derives placeholders). */
  onSecrets?: (secrets: DiscoverySecrets) => void;
}

export interface RunStepsInput {
  /** Synthetic spec name (snake_case). */
  name: string;
  steps: readonly unknown[];
  /** `imports:` of the synthetic spec (absolute, or relative to `specDir`). */
  imports?: readonly string[];
  /** `session.resume` checkpoint. */
  resume?: string;
  /** Extra top-level spec fields (fromSpec: vars, requires, settleMs, …). */
  extra?: Record<string, unknown>;
  /** Directory of the synthetic spec (default: the context's workDir). */
  specDir?: string;
  /** Artifact root of this run (default: the context's runsDir). */
  runsDir?: string;
  /** Capture a screenshot after every step. */
  screenshots?: boolean;
}

export interface RunStepsOutcome {
  result: RunResult;
  steps: StepResult[];
  /** Every step passed. */
  ok: boolean;
  /** First failed step's error. */
  error?: string;
  runDir: string;
  /** Network requests observed during the run (raw: project before showing). */
  network: NetworkEntry[];
  /** Absolute screenshot per step (valid until `dispose()`). */
  screenshots: Array<string | undefined>;
  /** Captured `evals/<assign>.json` / `requests/<assign>.json` values. */
  captures: Record<string, unknown>;
  /** The same captures by kind: `${evals.<assign>…}` (`{ value }`). */
  evals: Record<string, unknown>;
  /** … and `${requests.<assign>…}` (the response: status, body, …). */
  requests: Record<string, unknown>;
  /** Remove the run directory (no-op once removed). */
  dispose(): Promise<void>;
}

const NOOP_OUTCOME = {
  id: "discovery_bookkeeping",
  description: "Discovery bookkeeping only: the steps are what is checked",
  verify: { url: { matches: ".*" } },
};

/** Run `steps` on the context's backend through the runner. */
export async function runStepsThroughRunner(
  ctx: DiscoveryRunContext,
  input: RunStepsInput,
): Promise<RunStepsOutcome> {
  const specDir = resolve(input.specDir ?? ctx.workDir);
  mkdirSync(specDir, { recursive: true, mode: 0o700 });
  const specPath = join(
    specDir,
    `_cairn-${input.name.replace(/_/g, "-")}-${randomBytes(4).toString("hex")}.yml`,
  );
  const spec: Record<string, unknown> = {
    version: 1,
    name: input.name,
    intent: "Discovery session steps (synthetic, removed after the run)",
    ...input.extra,
    ...(input.imports && input.imports.length > 0
      ? { imports: [...input.imports] }
      : {}),
    ...(input.resume ? { session: { resume: input.resume } } : {}),
    artifacts: {
      capture: {
        screenshots: input.screenshots ? "always" : "never",
        snapshots: "never",
        storage: "never",
        trace: "never",
        video: "never",
        agentContext: "never",
      },
    },
    outcomes: [NOOP_OUTCOME],
    steps: [...input.steps],
  };
  await writeFile(specPath, yamlStringify(spec), { mode: 0o600 });
  let result: RunResult;
  try {
    const secrets = ctx.resolveSecrets
      ? await ctx.resolveSecrets(specPath)
      : undefined;
    for (const value of secrets?.secretValues ?? []) {
      if (value) ctx.secretValues.add(value);
    }
    if (secrets) ctx.onSecrets?.(secrets);
    result = await runSpec({
      specPath,
      backend: ctx.backend,
      artifactRoot: input.runsDir ?? ctx.runsDir,
      // The session's browser carries the state being explored.
      coldStart: false,
      heartbeatIntervalMs: 0,
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
      ...(ctx.env !== undefined ? { environmentOverride: ctx.env } : {}),
      ...(ctx.vars && Object.keys(ctx.vars).length > 0
        ? { vars: ctx.vars as Record<string, string | number | boolean> }
        : {}),
      ...(secrets
        ? {
            env: secrets.env,
            ...(secrets.childEnv ? { childEnv: secrets.childEnv } : {}),
            ...(secrets.secretValues
              ? { secretValues: secrets.secretValues }
              : {}),
            ...(secrets.selectedTvaultKeys
              ? { selectedTvaultKeys: secrets.selectedTvaultKeys }
              : {}),
          }
        : {}),
    });
  } finally {
    await rm(specPath, { force: true }).catch(() => undefined);
  }

  const runDir = result.runDir;
  const steps = result.steps;
  const failed = steps.find((step) => step.status === "failed");
  // `use:` steps expand, so the run may report more steps than were given;
  // what matters is whether any of them failed (the no-op outcome cannot),
  // or the run errored before its steps.
  const ok = failed === undefined && result.status !== "errored";
  const error =
    failed?.error ??
    (ok ? undefined : (result.failure?.message ?? `run ${result.status}`));
  // The run cleared the backend's log when it started, so what the log
  // holds now is this run's traffic, unredacted: callers project it to a
  // credential-free shape. The run's own redacted file is the fallback.
  const network =
    (await ctx.backend.getNetworkRequests().catch(() => undefined)) ??
    (await readNdjson(join(runDir, "network", "requests.ndjson")));
  const screenshots = steps.map((step) => {
    const shot = step.artifacts?.find(
      (path) => path.startsWith("screenshots/") && path.endsWith(".png"),
    );
    return shot ? join(runDir, shot) : undefined;
  });
  const captures: Record<string, unknown> = {};
  const evals: Record<string, unknown> = {};
  const requests: Record<string, unknown> = {};
  for (const step of steps) {
    for (const path of step.artifacts ?? []) {
      const match = /^(evals|requests)\/(.+)\.json$/.exec(path);
      if (!match) continue;
      try {
        const value = JSON.parse(
          await readFile(join(runDir, path), "utf8"),
        ) as unknown;
        captures[match[2]!] = value;
        (match[1] === "evals" ? evals : requests)[match[2]!] = value;
      } catch {
        // A capture that cannot be read is simply not returned.
      }
    }
  }
  let disposed = false;
  return {
    result,
    steps,
    ok,
    ...(error ? { error } : {}),
    runDir,
    network,
    screenshots,
    captures,
    evals,
    requests,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function readNdjson(path: string): Promise<NetworkEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const out: NetworkEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as NetworkEntry;
      if (value && typeof value === "object" && typeof value.url === "string") {
        out.push(value);
      }
    } catch {
      // Skip a malformed line.
    }
  }
  return out;
}

/**
 * Resolve secrets once per distinct set of placeholder names: every action
 * of a session would otherwise ask the vault again. The key is the
 * `${secrets.X}` / `${env.X}` names in the synthetic spec plus its imports.
 */
export function memoizeSecrets(
  resolver: ResolveDiscoverySecrets,
): ResolveDiscoverySecrets {
  const cache = new Map<string, Promise<DiscoverySecrets>>();
  return async (specPath: string) => {
    const text = await readFile(specPath, "utf8").catch(() => "");
    const names = new Set<string>();
    for (const match of text.matchAll(
      /\$\{(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      names.add(match[1]!);
    }
    const imports = [...text.matchAll(/^\s*-\s*(\S+\.ya?ml)\s*$/gm)].map(
      (match) => match[1]!,
    );
    const key = `${[...names].toSorted().join(",")}|${imports.join(",")}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = resolver(specPath);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  };
}
