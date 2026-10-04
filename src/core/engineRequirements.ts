import { CAIRN_ENGINE_VERSION } from "./engineVersion";
import { rangeProblem, satisfiesRange } from "./semverRange";

/**
 * F19: `requires: { cairntrace: <range> }` in the config. A cairn that does
 * not satisfy it refuses to run, verify or serve MCP calls on that config
 * (exit 4); `cairn doctor` and `cairn config validate` report it.
 */

/** The running cairn is older (or newer) than the config says it supports. */
export class EngineRequirementError extends Error {
  override name = "EngineRequirementError";
  readonly exitCode = 4 as const;
}

export function engineRequirementProblem(
  config: { requires?: { cairntrace?: string | undefined } | undefined },
  version: string = CAIRN_ENGINE_VERSION,
  configPath?: string,
): string | undefined {
  const range = config.requires?.cairntrace;
  if (range === undefined) return undefined;
  const invalid = rangeProblem(range);
  if (invalid) return `requires.cairntrace: ${invalid}`;
  if (satisfiesRange(version, range)) return undefined;
  return (
    `${configPath ?? "the config"} requires cairntrace ${range}, but this is cairntrace ${version}. ` +
    `Install a matching release (npm i -g @thelacanians/cairntrace@"${range}" or brew upgrade ` +
    `abdul-hamid-achik/tap/cairntrace) or relax requires.cairntrace.`
  );
}

/** Throw {@link EngineRequirementError} when the config's range is not met. */
export function assertEngineRequirement(
  config: { requires?: { cairntrace?: string | undefined } | undefined },
  configPath?: string,
  version: string = CAIRN_ENGINE_VERSION,
): void {
  const problem = engineRequirementProblem(config, version, configPath);
  if (problem) throw new EngineRequirementError(problem);
}
