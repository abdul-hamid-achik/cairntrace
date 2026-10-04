/**
 * Export modes (E10): how an exported Playwright suite treats what a plain
 * browser test cannot express — host commands (preconditions, `run:` steps,
 * `teardown:`), readiness gates and fixtures, and the node / datasource
 * verifiers that need infrastructure.
 */

/**
 * `--preconditions`:
 *  - `inline`   commands run through a bounded helper in the generated
 *               runtime: each file's `beforeAll`, plus `run:` steps and
 *               `teardown:` in the test body;
 *  - `global`   preconditions (and gates / fixtures) run ONCE in the
 *               project's global setup (`--project` / `--into` only); `run:`
 *               steps and `teardown:` still run in the test body;
 *  - `skip`     nothing runs; reported as a soft skip;
 *  - `manifest` nothing runs; the commands are listed in `.cairn-export.json`
 *               for the host to run.
 * Without the flag a standalone file skips them and `--project` / `--into`
 * keep the per-file `beforeAll` (`run:` steps and `teardown:` stay unexported).
 */
export const PRECONDITIONS_MODES = [
  "inline",
  "global",
  "skip",
  "manifest",
] as const;
export type ExportPreconditionsMode = (typeof PRECONDITIONS_MODES)[number];

/**
 * `--verifiers`:
 *  - `keep` (default) node file verifiers run; datasource verifiers are hard
 *           skips (`test.fixme`);
 *  - `gate` node / datasource verifiers run only when their required env is
 *           present; otherwise the test ends reported as skipped (never
 *           passed): `test.skip(condition, reason)` after every other
 *           assertion held;
 *  - `drop` they are omitted, with a diagnostic.
 */
export const VERIFIERS_MODES = ["keep", "gate", "drop"] as const;
export type ExportVerifiersMode = (typeof VERIFIERS_MODES)[number];

export function parsePreconditionsMode(
  raw: string | undefined,
): ExportPreconditionsMode | undefined {
  if (raw === undefined) return undefined;
  if ((PRECONDITIONS_MODES as readonly string[]).includes(raw)) {
    return raw as ExportPreconditionsMode;
  }
  throw new Error(
    `--preconditions must be ${PRECONDITIONS_MODES.join("|")} (got ${JSON.stringify(raw)})`,
  );
}

export function parseVerifiersMode(
  raw: string | undefined,
): ExportVerifiersMode | undefined {
  if (raw === undefined) return undefined;
  if ((VERIFIERS_MODES as readonly string[]).includes(raw)) {
    return raw as ExportVerifiersMode;
  }
  throw new Error(
    `--verifiers must be ${VERIFIERS_MODES.join("|")} (got ${JSON.stringify(raw)})`,
  );
}

/** Env var names are what `process.env.<NAME>` can address. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseGateEnv(values: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const value of values ?? []) {
    for (const name of value.split(",")) {
      const trimmed = name.trim();
      if (trimmed.length === 0) continue;
      if (!ENV_NAME.test(trimmed)) {
        throw new Error(
          `--gate-env expects environment variable names (got ${JSON.stringify(trimmed)})`,
        );
      }
      out.add(trimmed);
    }
  }
  return [...out].toSorted();
}

/** What the exporter does with host commands for a given flag and output shape. */
export interface PreconditionsPlan {
  /** Per-file `beforeAll` running the preconditions. */
  inline: boolean;
  /** One-time global-setup running them. */
  global: boolean;
  /** Listed in the manifest. */
  manifest: boolean;
  /** `run:` steps and `teardown:` export through the helper. */
  hostCommands: boolean;
}

export function preconditionsPlan(
  mode: ExportPreconditionsMode | undefined,
  structured: boolean,
): PreconditionsPlan {
  switch (mode) {
    case "inline":
      return {
        inline: true,
        global: false,
        manifest: false,
        hostCommands: true,
      };
    case "global":
      return {
        inline: false,
        global: true,
        manifest: false,
        hostCommands: true,
      };
    case "manifest":
      return {
        inline: false,
        global: false,
        manifest: true,
        hostCommands: false,
      };
    case "skip":
      return {
        inline: false,
        global: false,
        manifest: false,
        hostCommands: false,
      };
    default:
      // Today's behavior: --project / --into run them per file.
      return {
        inline: structured,
        global: false,
        manifest: false,
        hostCommands: false,
      };
  }
}

/**
 * One precondition command as listed in `.cairn-export.json` and rendered
 * into the global setup. `run` still carries late-bound sentinels at this
 * level; the manifest writer restores them to authored `${env.X}` form and
 * never an environment value.
 */
export interface HostPrecondition {
  name?: string;
  run: string;
  /** Absolute directory the command runs in. */
  cwd: string;
  timeoutMs: number;
  /** `preconditions.env` entries (values are late-bound strings). */
  env?: Record<string, string | number | boolean>;
}

/** A config readiness gate the global setup waits on (`cairn wait <gate>`). */
export interface HostGate {
  /** Config gate name, or the `http(s)://` / `tcp://` target. */
  target: string;
}

/** A config fixture the global setup ensures (`cairn fixtures ensure`). */
export interface HostFixture {
  name: string;
  /** `with:` parameters of a `{use, with}` spec ref (late-bound strings). */
  with?: Record<string, unknown>;
  /** Output keys the spec reads (`${fixtures.<name>.<key>}`). */
  keys: string[];
  /** Torn down by the global setup's teardown (a run-scoped fixture). */
  runScoped: boolean;
}
