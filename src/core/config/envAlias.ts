/**
 * Environment aliases: `environments.<name>: { alias: <target> }` is the same
 * environment under another name (`extends` inherits and then overrides, an
 * alias does not copy anything). A requested name is canonicalized to its
 * target once, where `--env` is parsed, so suites, policy, state keys, locks
 * and `CAIRN_ENV` only ever see the target name. One hop: an alias never
 * names another alias (the schema rejects chains and cycles).
 */

type EnvironmentMap = Record<
  string,
  { alias?: string | undefined } | undefined
>;

export interface CanonicalEnvironment {
  /** The target environment name (the requested name when it is no alias). */
  name: string;
  /** The alias the caller used, when it named one. */
  alias?: string;
}

/** The environment a requested name stands for. */
export function canonicalEnvironment(
  environments: EnvironmentMap | undefined,
  requested: string,
): CanonicalEnvironment {
  if (!environments || !Object.hasOwn(environments, requested)) {
    return { name: requested };
  }
  const target = environments[requested]?.alias;
  return typeof target === "string" && target.length > 0
    ? { name: target, alias: requested }
    : { name: requested };
}

/** True when the environment is an alias entry. */
export function isEnvironmentAlias(
  environments: EnvironmentMap | undefined,
  name: string,
): boolean {
  return (
    !!environments &&
    Object.hasOwn(environments, name) &&
    typeof environments[name]?.alias === "string"
  );
}

/** Environment names that are real environments (aliases left out). */
export function realEnvironmentNames(
  environments: EnvironmentMap | undefined,
): string[] {
  return Object.keys(environments ?? {}).filter(
    (name) => !isEnvironmentAlias(environments, name),
  );
}

/**
 * Problems with the alias entries of a config, as `[path, message]` pairs
 * (path relative to the config root): an alias combined with other keys, to
 * an unknown environment, to another alias (chains and cycles), or an
 * `extends` that names an alias.
 */
export function environmentAliasProblems(
  environments: Record<string, object | undefined>,
): Array<{ path: string[]; message: string }> {
  const out: Array<{ path: string[]; message: string }> = [];
  const names = Object.keys(environments);
  const aliasOf = (name: string): string | undefined => {
    const value = (environments[name] as { alias?: unknown } | undefined)
      ?.alias;
    return typeof value === "string" ? value : undefined;
  };
  for (const name of names) {
    const env = environments[name] as Record<string, unknown> | undefined;
    const target = aliasOf(name);
    if (target !== undefined) {
      const others = Object.keys(env ?? {}).filter((key) => key !== "alias");
      if (others.length > 0) {
        out.push({
          path: ["environments", name, "alias"],
          message: `an alias is the same environment under another name and takes no other keys (found ${others.join(", ")}); put them on "${target}", or use \`extends: ${target}\` to inherit and override`,
        });
      }
      if (target === name) {
        out.push({
          path: ["environments", name, "alias"],
          message: `alias cycle ${name} → ${name}`,
        });
      } else if (!names.includes(target)) {
        out.push({
          path: ["environments", name, "alias"],
          message: `unknown environment "${target}" (defined: ${names.toSorted().join(", ")})`,
        });
      } else if (aliasOf(target) !== undefined) {
        const seen = [name, target];
        let next = aliasOf(target);
        while (next !== undefined && !seen.includes(next)) {
          seen.push(next);
          next = aliasOf(next);
        }
        const cycle = next !== undefined;
        out.push({
          path: ["environments", name, "alias"],
          message: cycle
            ? `alias cycle ${[...seen, next].join(" → ")}`
            : `alias chain ${seen.join(" → ")}: "${target}" is itself an alias; point at the real environment "${seen.at(-1)}"`,
        });
      }
    }
    const parent = env?.extends;
    if (typeof parent === "string" && aliasOf(parent) !== undefined) {
      out.push({
        path: ["environments", name, "extends"],
        message: `"${parent}" is an alias of "${aliasOf(parent)}"; extend "${aliasOf(parent)}" instead`,
      });
    }
  }
  return out;
}
