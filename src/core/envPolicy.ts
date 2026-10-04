import type { Config, EnvironmentPolicy } from "./schema/config.v1";
import { canonicalEnvironment } from "./config/envAlias";
import type { RunRefusal, RunRefusalCode } from "./schema/run.v1";
import type { RequiresEnvEntry, SpecRequires } from "./schema/spec.v1";

/**
 * Environment policy (F1): may this spec run in that environment?
 *
 * Inputs are the spec's `requires:` block and the resolved environment's
 * `policy:` from cairntrace.config.yml. Pure and synchronous: `cairn run`
 * evaluates it per spec BEFORE services, webServer, hooks, preconditions or
 * a browser start, and `cairn spec verify` reports the same verdicts.
 *
 * Rules, in order:
 *   1. `requires.env` present and the environment is not listed → refused
 *      (`env-not-listed`).
 *   2. `policy.trait: protected` and the spec does not list the environment
 *      explicitly → refused (`protected-env`).
 *   3. Listed with `{ optIn: VAR }` and VAR is not `1`/`true` in the caller's
 *      environment → refused (`opt-in-missing`).
 *   4. `requires.mutates: true` where `policy.mutations: deny` → refused
 *      (`mutations-denied`).
 */

export interface EnvPolicyInput {
  /** The spec's `requires:` block (absent = no requirements). */
  requires?: SpecRequires;
  /** The resolved environment name (`--env`, spec default, config default). */
  envName: string;
  /** `environments.<envName>.policy` from the config, if any. */
  policy?: EnvironmentPolicy;
  /** Caller environment that opt-in variables are read from. */
  env?: Record<string, string | undefined>;
}

export type EnvPolicyVerdict =
  | { allowed: true; optIn?: string }
  | { allowed: false; code: RunRefusalCode; reason: string; optIn?: string };

/** `{ name, optIn? }` of a `requires.env` entry. */
export function requiresEnvEntryName(entry: RequiresEnvEntry): {
  name: string;
  optIn?: string;
} {
  if (typeof entry === "string") return { name: entry };
  const [name, value] = Object.entries(entry)[0] ?? ["", undefined];
  return value?.optIn ? { name, optIn: value.optIn } : { name };
}

/** Every environment name `requires.env` lists, in authored order. */
export function requiredEnvNames(requires: SpecRequires | undefined): string[] {
  return (requires?.env ?? []).map((entry) => requiresEnvEntryName(entry).name);
}

/** `1` / `true` (case-insensitive), the only values that opt in. */
export function isOptInValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

export function evaluateEnvPolicy(input: EnvPolicyInput): EnvPolicyVerdict {
  const { requires, envName, policy } = input;
  const env = input.env ?? process.env;
  const entries = (requires?.env ?? []).map(requiresEnvEntryName);
  const listed = entries.find((entry) => entry.name === envName);
  const described = policy?.description ? ` (${policy.description})` : "";

  if (requires?.env && !listed) {
    return {
      allowed: false,
      code: "env-not-listed",
      reason: `requires.env allows ${entries
        .map((entry) => `"${entry.name}"`)
        .join(", ")}; the resolved environment is "${envName}"`,
    };
  }
  if (policy?.trait === "protected" && !listed) {
    return {
      allowed: false,
      code: "protected-env",
      reason: `environment "${envName}" is protected${described}: a spec must list it in requires.env to run there`,
    };
  }
  if (listed?.optIn && !isOptInValue(env[listed.optIn])) {
    return {
      allowed: false,
      code: "opt-in-missing",
      optIn: listed.optIn,
      reason: `requires.env allows "${envName}" only with ${listed.optIn}=1 (or true) in the environment`,
    };
  }
  if (requires?.mutates === true && policy?.mutations === "deny") {
    return {
      allowed: false,
      code: "mutations-denied",
      ...(listed?.optIn ? { optIn: listed.optIn } : {}),
      reason: `the spec declares requires.mutates: true and environment "${envName}" denies mutations${described}`,
    };
  }
  return { allowed: true, ...(listed?.optIn ? { optIn: listed.optIn } : {}) };
}

/** The refusal document for a refused verdict (RunResult.refusal). */
export function refusalDocument(
  verdict: Extract<EnvPolicyVerdict, { allowed: false }>,
  input: Pick<EnvPolicyInput, "requires" | "envName" | "policy">,
): RunRefusal {
  return {
    reason: verdict.reason,
    env: input.envName,
    requires: input.requires ?? {},
    code: verdict.code,
    ...(input.policy && Object.keys(input.policy).length > 0
      ? { policy: input.policy }
      : {}),
  };
}

export interface EnvironmentEligibility {
  name: string;
  allowed: boolean;
  code?: RunRefusalCode;
  reason?: string;
  /** The opt-in variable this environment needs (whether or not it is set). */
  optIn?: string;
  /** True when the config defines this environment. */
  defined: boolean;
  /** The environment this name is an alias of: it is judged as that environment. */
  alias?: string;
  trait?: EnvironmentPolicy["trait"];
  mutations?: EnvironmentPolicy["mutations"];
}

/**
 * The spec's verdict in every environment the config defines, plus any
 * `requires.env` name the config lacks (reported `defined: false`). Used by
 * `cairn spec verify` without `--env` and by the authoring catalog.
 */
export function environmentEligibility(
  requires: SpecRequires | undefined,
  config: Pick<Config, "environments"> | undefined,
  env: Record<string, string | undefined> = process.env,
): EnvironmentEligibility[] {
  const environments = config?.environments ?? {};
  const names = [
    ...Object.keys(environments).toSorted(),
    ...requiredEnvNames(requires).filter(
      (name) => !Object.hasOwn(environments, name),
    ),
  ];
  return [...new Set(names)].map((name) => {
    const defined = Object.hasOwn(environments, name);
    // An alias is judged as its target: that is the name a run resolves to.
    const canonical = canonicalEnvironment(environments, name);
    const target = canonical.name;
    const policy = defined ? environments[target]?.policy : undefined;
    const verdict = evaluateEnvPolicy({
      ...(requires ? { requires } : {}),
      envName: target,
      ...(policy ? { policy } : {}),
      env,
    });
    return {
      name,
      allowed: verdict.allowed,
      defined,
      ...(canonical.alias !== undefined ? { alias: target } : {}),
      ...(verdict.allowed
        ? {}
        : { code: verdict.code, reason: verdict.reason }),
      ...(verdict.optIn ? { optIn: verdict.optIn } : {}),
      ...(policy?.trait ? { trait: policy.trait } : {}),
      ...(policy?.mutations ? { mutations: policy.mutations } : {}),
    };
  });
}
