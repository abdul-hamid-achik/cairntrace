import { resolve } from "node:path";
import { resolveEffectiveServices } from "../config/runtimeContext";
import type { Config } from "../schema/config.v1";
import { SuiteError, SuiteResolver } from "./resolve";
import { suiteRequiredEnvs, suiteVarCollisions } from "./schema";
import { realEnvironmentNames } from "../config/envAlias";

/**
 * `cairn config validate` for `suites:`: resolve every suite in every
 * environment it can run in, as `cairn run --suite` would. A reference that
 * names no spec, an ambiguous name, an `order` entry outside the selection
 * and an empty selection are errors (reported once per suite when every
 * environment says the same); an environment `requires` rules out is not a
 * problem. A `seed.postCommands.skip` entry that matches no post-command of
 * any environment (an `env.<n>.seed` one: of that environment) is a
 * warning.
 */
export async function validateSuites(
  config: Config,
  configDir: string,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suites = Object.entries(config.suites ?? {});
  if (suites.length === 0) return { errors, warnings };
  const resolver = new SuiteResolver({
    configDir,
    skipDirs: config.artifactRoot
      ? [resolve(configDir, config.artifactRoot)]
      : [],
  });
  const envNames = realEnvironmentNames(config.environments);
  const targets = envNames.length > 0 ? envNames : ["local"];
  for (const [name, suite] of suites) {
    const byMessage = new Map<string, string[]>();
    for (const envName of targets) {
      try {
        await resolver.resolve({
          name,
          suite,
          envName,
          vars: config.environments[envName]?.vars ?? {},
        });
      } catch (error) {
        if (!(error instanceof SuiteError)) throw error;
        if (error.exitCode === 7) continue;
        byMessage.set(error.message, [
          ...(byMessage.get(error.message) ?? []),
          envName,
        ]);
      }
    }
    for (const [message, envs] of byMessage) {
      errors.push(
        `suites.${name}${
          envs.length < targets.length ? ` (env ${envs.join(", ")})` : ""
        }: ${message}`,
      );
    }
    // Two vars that reach hooks as one CAIRN_SUITE_VAR_<NAME>: the hook
    // would silently see only one of them.
    const collisions = new Map<string, string[]>();
    for (const envName of [undefined, ...Object.keys(suite.env ?? {})]) {
      const keys = Object.keys({
        ...suite.vars,
        ...(envName !== undefined ? suite.env?.[envName]?.vars : {}),
      });
      for (const collision of suiteVarCollisions(keys)) {
        const message = `vars ${collision.keys.join(" and ")} both reach hooks as ${collision.envName}; rename one`;
        collisions.set(message, [
          ...(collisions.get(message) ?? []),
          ...(envName !== undefined ? [envName] : []),
        ]);
      }
    }
    for (const [message, envs] of collisions) {
      errors.push(
        `suites.${name}${
          envs.length > 0 ? ` (env ${envs.join(", ")})` : ""
        }: ${message}`,
      );
    }
    const commands = new Set<string>();
    for (const list of [
      config.services?.seed?.postCommands,
      ...Object.values(config.environments).map((env) =>
        env.services && typeof env.services === "object"
          ? env.services.seed?.postCommands
          : undefined,
      ),
    ]) {
      for (const command of list ?? []) {
        commands.add(
          typeof command === "string" ? command.trim() : command.name,
        );
      }
    }
    for (const entry of suite.seed?.postCommands?.skip ?? []) {
      if (!commands.has(entry.trim())) {
        warnings.push(
          `suites.${name}.seed.postCommands.skip: "${entry}" matches no seed postCommand of the config (a plain command is matched by its text, a named one by its name)`,
        );
      }
    }
    // An environment's own skips name post-commands of that environment.
    for (const [envName, envBlock] of Object.entries(suite.env ?? {})) {
      const skip = envBlock.seed?.postCommands?.skip ?? [];
      if (skip.length === 0) continue;
      const own = new Set(
        (
          resolveEffectiveServices(
            config.services,
            config.environments[envName]?.services,
          )?.seed?.postCommands ?? []
        ).map((command) =>
          typeof command === "string" ? command.trim() : command.name,
        ),
      );
      for (const entry of skip) {
        if (!own.has(entry.trim())) {
          warnings.push(
            `suites.${name}.env.${envName}.seed.postCommands.skip: "${entry}" matches no seed postCommand of environment ${envName} (a plain command is matched by its text, a named one by its name)`,
          );
        }
      }
    }
  }
  return { errors, warnings };
}

/**
 * A suite whose `requires.env` admits an environment that has no
 * `env.<e>` block while another admitted environment has one: a run there
 * silently takes the suite-level specs, vars and hooks, which is rarely the
 * intent of an override written for the sibling. One finding per such
 * (suite, environment): `{ key: "suites.<name>.env.<e>", message }`.
 */
export function suiteEnvFallbackFindings(
  config: Config,
): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  for (const [name, suite] of Object.entries(config.suites ?? {})) {
    const admitted = suiteRequiredEnvs(suite);
    if (admitted.length < 2) continue;
    const overridden = admitted.filter((env) =>
      Object.hasOwn(suite.env ?? {}, env),
    );
    if (overridden.length === 0) continue;
    for (const env of admitted) {
      if (overridden.includes(env)) continue;
      out.push({
        key: `suites.${name}.env.${env}`,
        message: `suites.${name}: requires.env admits "${env}", which has no env.${env} block while ${overridden
          .map((e) => `"${e}"`)
          .join(", ")} ${
          overridden.length > 1 ? "have" : "has"
        } one; a run in "${env}" silently uses the suite-level specs, vars and hooks. Add env.${env} (an empty \`{}\` says the defaults are intended) or drop "${env}" from requires.env`,
      });
    }
  }
  return out;
}
