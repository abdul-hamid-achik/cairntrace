import { dirname } from "node:path";
import {
  isMap,
  isScalar,
  isSeq,
  parse as parseYaml,
  parseDocument,
  type Node as YamlNode,
} from "yaml";

const CONFIG_DIR_TOKEN = "${config.dir}";

/**
 * Marks a `${` that came from an environment VALUE (not from the authored
 * text) while the config is composed, so var references are only ever read
 * from what the author wrote: an env or secret value that happens to hold
 * `${vars.X}` stays inert (as in 3.0.1) instead of being resolved — or
 * breaking the load and quoting the value. {@link restoreInertText} puts
 * the `${` back once composition is done.
 */
const INERT_OPEN = "\uE000{";

/**
 * Marks the `${` of an `${env.X}` written inside a `metrics[].http` block
 * (top level or `environments.<n>.metrics`): the load leaves it alone and
 * the probe resolves it at every sample, scrubbing the value from errors —
 * so a URL path, header or token built from the environment never reaches
 * metrics.json, events or narration (evidence shows the template).
 */
const METRIC_ENV_OPEN = "\uE001{";

/** `${env.` inside every scalar of the metrics http blocks, marked (same length). */
function protectMetricHttpEnv(text: string): string {
  if (!text.includes("${env.") || !text.includes("metrics")) return text;
  let doc;
  try {
    doc = parseDocument(text, { merge: true });
  } catch {
    return text;
  }
  if (doc.errors.length > 0) return text;
  const ranges: Array<[number, number]> = [];
  const collect = (node: unknown): void => {
    if (isScalar(node)) {
      if (node.range) ranges.push([node.range[0], node.range[1]]);
    } else if (isMap(node)) {
      for (const pair of node.items) collect(pair.value);
    } else if (isSeq(node)) {
      for (const item of node.items) collect(item);
    }
  };
  const lists: unknown[] = [doc.get("metrics", true)];
  const envs = doc.get("environments", true);
  if (isMap(envs)) {
    for (const pair of envs.items) {
      if (isMap(pair.value)) lists.push(pair.value.get("metrics", true));
    }
  }
  for (const list of lists) {
    if (!isSeq(list)) continue;
    for (const item of list.items) {
      if (isMap(item)) collect(item.get("http", true) as YamlNode | undefined);
    }
  }
  if (ranges.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0])) {
    if (start < at) continue;
    out +=
      text.slice(at, start) +
      text.slice(start, end).replaceAll("${env.", `${METRIC_ENV_OPEN}env.`);
    at = end;
  }
  return out + text.slice(at);
}

/** Undo the inert marking of env values (deep, keys included). */
export function restoreInertText<T>(value: T): T {
  return replaceInStrings(value, INERT_OPEN, "${") as T;
}

/**
 * Turn raw `cairntrace.config.yml` TEXT into the plain object the schema
 * validates. Every config reader (loadConfig, `cairn config validate`) should
 * go through this so they agree on what a config means:
 *   1. `${env.X}` / `${env.X:-default}` → the invocation environment
 *      (text substitution, as before);
 *   2. YAML parse with merge keys enabled, so `<<: *anchor` can share a
 *      `vars:` map between environments;
 *   3. `${config.dir}` → the directory that holds the config file, inserted
 *      into the PARSED strings. A directory name with YAML-significant
 *      characters (` #`, `: `, quotes, backslashes) can therefore never
 *      truncate or break the config, quoted or not, block or flow style.
 *
 * Files listed under `include:` go through the same function with the
 * including config's path, so `${config.dir}` means the same directory in
 * every file of one config.
 */
export function parseConfigText(
  text: string,
  opts: {
    /** Absolute path of the config file `${config.dir}` refers to. */
    configPath: string;
    envRef?: (name: string) => string;
    env?: Record<string, string | undefined>;
    /** Mark `${` inside substituted env values inert (see {@link restoreInertText}). */
    inertEnvValues?: boolean;
    /** Exporter late binding for every env reference (see {@link substituteEnv}). */
    late?: EnvLateBinding;
  },
): unknown {
  const inert = opts.inertEnvValues
    ? (value: string) => value.replaceAll("${", INERT_OPEN)
    : undefined;
  const protectedText = protectMetricHttpEnv(text);
  const restore = (parsed: unknown): unknown =>
    protectedText === text
      ? parsed
      : replaceInStrings(parsed, METRIC_ENV_OPEN, "${");
  if (!protectedText.includes(CONFIG_DIR_TOKEN)) {
    return restore(
      parseYaml(
        substituteEnv(protectedText, opts.envRef, opts.env, inert, opts.late),
        { merge: true },
      ),
    );
  }
  // Swap the placeholder for a YAML-inert token (letters/underscores only, so
  // it is a valid plain scalar anywhere), parse, then put the real directory
  // into the resulting strings. The swap runs before env substitution so an
  // env VALUE that happens to contain `${config.dir}` stays literal.
  const sentinel = uniqueSentinel(protectedText);
  const configDir = dirname(opts.configPath);
  const parsed: unknown = parseYaml(
    substituteEnv(
      protectedText.replaceAll(CONFIG_DIR_TOKEN, () => sentinel),
      opts.envRef,
      opts.env,
      inert,
      opts.late,
    ),
    { merge: true },
  );
  return restore(replaceInStrings(parsed, sentinel, configDir));
}

function uniqueSentinel(text: string): string {
  let sentinel = "__CAIRNTRACE_CONFIG_DIR__";
  while (text.includes(sentinel)) sentinel = `_${sentinel}_`;
  return sentinel;
}

/** Deep-copy `value`, replacing `token` in every string (keys included). */
function replaceInStrings(
  value: unknown,
  token: string,
  replacement: string,
): unknown {
  if (typeof value === "string") {
    return value.includes(token)
      ? value.replaceAll(token, () => replacement)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceInStrings(item, token, replacement));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key.replaceAll(token, () => replacement)] = replaceInStrings(
        item,
        token,
        replacement,
      );
    }
    return out;
  }
  return value;
}

/**
 * Exporter late binding of `${env.X}` references in text: `defaultRef`
 * replaces a `${env.X:-default}`, and `all` keeps a plain `${env.X}`
 * late-bound even when X is set, so no environment value reaches output.
 */
export interface EnvLateBinding {
  defaultRef?: (name: string, fallback: string) => string;
  all?: boolean;
  /**
   * Validation stand-ins for a late-bound string that a typed field (a URL,
   * a number, an enum) cannot hold: candidates tried in order until the
   * schema accepts the field. Never an environment value — the caller
   * builds them from the authored defaults. A field that needed one is
   * listed on the result (`lateUnbound`); without this hook such a config
   * fails to load.
   */
  standIns?: (text: string) => unknown[];
}

/**
 * `${env.X}` / `${env.X:-default}` in config text (also used for a spec's own
 * `vars:` values, so they resolve like config vars).
 */
export function substituteEnv(
  text: string,
  envRef?: (name: string) => string,
  env: Record<string, string | undefined> = process.env,
  /** Applied to each substituted env VALUE (not to defaults). */
  transformValue?: (value: string) => string,
  /**
   * Exporter late binding (needs `envRef`): `defaultRef` replaces a
   * `${env.X:-default}`, and `all` keeps a plain `${env.X}` late-bound
   * even when X is set, so no environment value reaches generated code.
   */
  late?: EnvLateBinding,
): string {
  return text.replace(
    /\$\{env\.(\w+)(?::-([^}]+))?\}/g,
    (_match, name: string, fallback?: string) => {
      if (envRef) {
        if (fallback !== undefined && late?.defaultRef) {
          return late.defaultRef(name, fallback);
        }
        if (fallback === undefined && late?.all) return envRef(name);
      }
      const value = env[name];
      // `:-` shell semantics: an empty OR unset env var falls back to the
      // default. Matches the spec-parser placeholder behavior so config and
      // specs resolve `${env.X:-default}` identically.
      if (value === undefined || value === "") {
        if (fallback !== undefined) return fallback;
        return envRef ? envRef(name) : "";
      }
      return transformValue ? transformValue(value) : value;
    },
  );
}
