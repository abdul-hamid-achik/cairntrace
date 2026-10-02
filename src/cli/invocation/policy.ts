import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { evaluateEnvPolicy, refusalDocument } from "../../core/envPolicy";
import type {
  OutcomeResult,
  RunRefusal,
  RunResult,
} from "../../core/schema/run.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import type { Backend } from "../../core/schema/shared";
import { SpecRequiresSchema } from "../../core/schema/spec.v1";
import { targetChildEnv } from "../../core/processEnv";
import type { ScopedSecrets } from "../commands/secrets";
import { resolveRunRuntime } from "./options";

/**
 * Environment policy for a run invocation (F1): which planned specs the
 * policy refuses, decided per spec BEFORE secrets, services, webServer,
 * hooks, preconditions or a browser start. A refused spec gets a synthetic
 * `refused` RunResult (exit 7) and never a run directory.
 */

export interface RefusedSpec {
  /** Spec path as the invocation expanded it. */
  specPath: string;
  /** `name:` from the spec (the file stem when it cannot be read). */
  specName: string;
  refusal: RunRefusal;
  /** Outcome ids the spec declares (reported as skipped). */
  outcomeIds: string[];
}

interface SpecPeek {
  name?: string;
  requires?: unknown;
  outcomeIds: string[];
}

async function peekSpec(specPath: string): Promise<SpecPeek | undefined> {
  try {
    const doc = parseYaml(await readFile(specPath, "utf8")) as Record<
      string,
      unknown
    > | null;
    if (!doc || typeof doc !== "object") return undefined;
    const outcomes = Array.isArray(doc.outcomes) ? doc.outcomes : [];
    return {
      ...(typeof doc.name === "string" ? { name: doc.name } : {}),
      ...(doc.requires !== undefined ? { requires: doc.requires } : {}),
      outcomeIds: outcomes
        .map((o) =>
          o &&
          typeof o === "object" &&
          typeof (o as { id?: unknown }).id === "string"
            ? (o as { id: string }).id
            : undefined,
        )
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    };
  } catch {
    return undefined;
  }
}

/** The file stem of a spec path. */
function specStem(specPath: string): string {
  return (
    specPath
      .split("/")
      .pop()
      ?.replace(/\.ya?ml$/, "") ?? specPath
  );
}

/**
 * Evaluate the environment policy of every spec. Specs whose `requires:`
 * block or config cannot be read are NOT refused here: the run reports the
 * parse/config error itself. `callerEnv` supplies opt-in variables.
 */
export async function evaluateSpecPolicies(
  specPaths: readonly string[],
  opts: Pick<RunInvocationOptions, "env" | "config" | "var">,
  callerEnv: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Promise<Map<string, RefusedSpec>> {
  const refused = new Map<string, RefusedSpec>();
  for (const specPath of new Set(specPaths)) {
    const absolute = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);
    const peek = await peekSpec(absolute);
    if (!peek) continue;
    const requires =
      peek.requires === undefined
        ? undefined
        : SpecRequiresSchema.safeParse(peek.requires);
    if (requires && !requires.success) continue;
    let ctx: Awaited<ReturnType<typeof resolveRunRuntime>>;
    try {
      ctx = await resolveRunRuntime(absolute, opts);
    } catch {
      continue;
    }
    const policy = ctx.config?.environments[ctx.envName]?.policy;
    const input = {
      ...(requires?.data ? { requires: requires.data } : {}),
      envName: ctx.envName,
      ...(policy ? { policy } : {}),
    };
    const verdict = evaluateEnvPolicy({ ...input, env: callerEnv });
    if (verdict.allowed) continue;
    refused.set(specPath, {
      specPath,
      specName: peek.name ?? specStem(specPath),
      refusal: refusalDocument(verdict, input),
      outcomeIds: peek.outcomeIds,
    });
  }
  return refused;
}

/** One-line refusal for narration and selection reasons. */
export function describeRefusal(refused: Pick<RefusedSpec, "refusal">): string {
  return `refused in environment "${refused.refusal.env}": ${refused.refusal.reason}`;
}

/**
 * The `refused` RunResult of a spec the policy refused. `runId` / `runDir`
 * are never-written placeholders (like a synthesized errored result) so
 * consumers that join artifact paths do not crash; nothing exists there, and
 * `synthetic: true` tells agents and Studio not to open them.
 */
export function synthesizeRefusedResult(
  refused: RefusedSpec,
  extras: { labels?: Record<string, string>; backend?: Backend } = {},
  cwd: string = process.cwd(),
): RunResult {
  const now = new Date().toISOString();
  const runId = `refused_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const absoluteSpecPath = isAbsolute(refused.specPath)
    ? refused.specPath
    : resolve(cwd, refused.specPath);
  const labels =
    extras.labels && Object.keys(extras.labels).length > 0
      ? extras.labels
      : undefined;
  const outcomes: OutcomeResult[] = refused.outcomeIds.map((id) => ({
    id,
    status: "skipped",
  }));
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    runDir: `${cwd}/.cairntrace/refused/${runId}`,
    synthetic: true,
    spec: { name: refused.specName, path: absoluteSpecPath },
    environment: refused.refusal.env,
    backend: extras.backend ?? "agent-browser",
    coldStart: false,
    ...(labels ? { labels } : {}),
    status: "refused",
    refusal: refused.refusal,
    summary: `refused: ${refused.refusal.reason}`,
    failure: { phase: "policy", message: refused.refusal.reason },
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    outcomes,
    steps: [],
    artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
    exitCode: 7,
  };
}

/**
 * Secret-free scope for an invocation whose every spec was refused: nothing
 * runs, so no secret provider (tvault) is called.
 */
export function noSecretsScope(
  callerEnv: Record<string, string | undefined>,
): ScopedSecrets {
  const env = targetChildEnv(callerEnv);
  return {
    env,
    childEnv: { ...env },
    secretValues: [],
    injectedKeys: [],
    shadowedKeys: [],
    selectedKeys: [],
  };
}
