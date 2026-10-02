import { evaluateEnvPolicy, requiresEnvEntryName } from "../envPolicy";
import type { EnvironmentPolicy } from "../schema/config.v1";
import type { SpecRequires } from "../schema/spec.v1";

/**
 * The environment an export resolved and BAKED into its output: absolute
 * `page.goto(<baseUrl>/…)` in a single-file export, `baseURL` in a project's
 * playwright.config. Absent when no baseUrl was baked (relative URLs then
 * follow whatever baseURL the Playwright project supplies).
 */
export interface ExportEnvTarget {
  /** Resolved environment name (`--env`, spec `environment:`, config default). */
  env: string;
  /** `environments.<env>.policy` from the cairntrace config, if any. */
  policy?: EnvironmentPolicy;
}

export interface RequiresGuard {
  /** Comment + `test.skip(...)` lines (JS and TS alike); [] = no guard. */
  lines: string[];
  /**
   * Set when the environment policy refuses the spec in the export's baked
   * environment: the guard then always skips; callers report it as a risk.
   */
  refusedReason?: string;
}

/**
 * `requires:` → a run-time Playwright guard. The exported test reads the
 * environment it runs in from `process.env.CAIRN_ENV`; an entry with
 * `optIn` also needs that variable set to `1`/`true`, like `cairn run`.
 *
 * When the export baked an environment's baseUrl (`target`), the guard is
 * tied to THAT environment: the test runs only when `CAIRN_ENV` names it
 * (and it is allowed), because the URLs it drives belong to it whatever
 * CAIRN_ENV says. If the policy refuses the spec there (not listed,
 * protected, mutations denied) the test always skips and `refusedReason`
 * says why. Opt-in variables are checked at run time, never at export.
 *
 * Without a baked environment the guard accepts any environment
 * `requires.env` lists. `requires.mutates` and the `policy:` blocks of other
 * environments live in the cairntrace config, which an exported suite does
 * not read: they are only noted.
 */
export function renderRequiresEnvGuard(
  requires: SpecRequires | undefined,
  target?: ExportEnvTarget,
): RequiresGuard {
  const entries = (requires?.env ?? []).map(requiresEnvEntryName);
  const mutatesNote = requires?.mutates
    ? [
        "// requires.mutates: true — the cairntrace environment policy is not enforced here.",
      ]
    : [];

  if (target) {
    const verdict = evaluateEnvPolicy({
      ...(requires ? { requires } : {}),
      envName: target.env,
      ...(target.policy ? { policy: target.policy } : {}),
      // Opt-in is a run-time decision (the guard below checks it): evaluate
      // as if every opt-in variable were set, so only the policy can refuse.
      env: Object.fromEntries(
        entries.flatMap((entry) => (entry.optIn ? [[entry.optIn, "1"]] : [])),
      ),
    });
    if (!verdict.allowed) {
      const reason = `exported for environment "${target.env}" (its baseUrl is baked in), where the environment policy refuses this spec: ${verdict.reason}`;
      return {
        lines: [
          `// requires: ${reason}.`,
          `// Re-export with --env set to an environment the spec may run in.`,
          `test.skip(true, ${JSON.stringify(`requires: ${reason}`)});`,
        ],
        refusedReason: reason,
      };
    }
    const entry = entries.find((candidate) => candidate.name === target.env);
    if (!entry) {
      return {
        lines: requires?.mutates
          ? [
              "// requires.mutates: true — this test changes shared data; the cairntrace",
              "// environment policy (environments.<name>.policy) is not enforced here.",
            ]
          : [],
      };
    }
    const described = entry.optIn
      ? `${entry.name} (with ${entry.optIn}=1)`
      : entry.name;
    return {
      lines: [
        `// requires.env: this export targets "${target.env}" (its baseUrl is baked in), so it`,
        `// runs only when CAIRN_ENV is ${described}. Re-export with --env for another environment.`,
        ...mutatesNote,
        `test.skip(`,
        `  !(${guardCondition(entry)}),`,
        `  ${JSON.stringify(`requires.env: exported for ${target.env}; set CAIRN_ENV to ${described}`)},`,
        `);`,
      ],
    };
  }

  if (entries.length === 0) {
    return {
      lines: requires?.mutates
        ? [
            "// requires.mutates: true — this test changes shared data; the cairntrace",
            "// environment policy (environments.<name>.policy) is not enforced here.",
          ]
        : [],
    };
  }
  const described = entries
    .map((entry) =>
      entry.optIn ? `${entry.name} (with ${entry.optIn}=1)` : entry.name,
    )
    .join(", ");
  return {
    lines: [
      `// requires.env: runs only where CAIRN_ENV is ${described}. Set CAIRN_ENV`,
      `// to the environment this suite targets; without it the test is skipped.`,
      ...mutatesNote,
      `test.skip(`,
      `  !(${entries.map(guardCondition).join(" || ")}),`,
      `  ${JSON.stringify(`requires.env: set CAIRN_ENV to ${described}`)},`,
      `);`,
    ],
  };
}

/** `CAIRN_ENV === name` (and the opt-in variable is 1/true). */
function guardCondition(entry: { name: string; optIn?: string }): string {
  const env = "process.env.CAIRN_ENV";
  return entry.optIn
    ? `(${env} === ${JSON.stringify(entry.name)} && /^(1|true)$/i.test(process.env[${JSON.stringify(entry.optIn)}] ?? ""))`
    : `${env} === ${JSON.stringify(entry.name)}`;
}
