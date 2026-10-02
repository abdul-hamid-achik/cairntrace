/**
 * Environment policy: the rules `cairn run` uses to refuse a spec before
 * anything starts, mirrored so Studio can warn before Run.
 *
 * The CLI is the authority. Studio never blocks a run on this verdict: the
 * Specs view warns (and asks once) when a spec would be refused on the
 * environment the user picked, and a refused run shows up like any other run
 * with status `refused`.
 *
 * Contract (additive, every field optional):
 *   config  environments.<name>.policy: { trait?: "owned" | "shared" | "protected",
 *                                          mutations?: "allow" | "deny",
 *                                          description?: string }
 *   spec    requires: { env?: Array<string | { [name]: { optIn: string } }>,
 *                       mutates?: boolean }
 *   run     refusal?: { reason, env, requires }
 *
 * A spec is refused when
 *   - `requires.env` is present and the resolved environment is not listed,
 *     or it is listed only behind opt-in variables none of which is "1" or
 *     "true";
 *   - `requires.mutates` is true and the environment's policy says
 *     `mutations: deny`;
 *   - the environment's trait is `protected` and the spec does not list it in
 *     `requires.env`.
 *
 * Loaded twice on purpose, like format.js and events.js: `require()` in the
 * main process and node:test, and a classic `<script>` in the sandboxed
 * renderer, where the same functions land on `window.CairnPolicy`. It never
 * reads the process environment: the main process answers opt-in questions
 * with booleans (`optInStates`), so no variable value reaches the renderer.
 */

const CairnPolicy = (() => {
  const TRAITS = ["owned", "shared", "protected"];
  const MUTATIONS = ["allow", "deny"];
  /**
   * Opt-in values that grant access, as the contract lists them; compared
   * trimmed and case-insensitively, like the CLI's `isOptInValue`.
   */
  const OPT_IN_VALUES = ["1", "true"];
  /** Bound on free text taken from a config or a run record. */
  const MAX_TEXT = 400;

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  function text(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_TEXT
      ? `${trimmed.slice(0, MAX_TEXT - 1)}…`
      : trimmed;
  }

  /**
   * @param {unknown} value
   * @returns {value is Record<string, any>}
   */
  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * @typedef {{ trait: "owned" | "shared" | "protected" | null, mutations: "allow" | "deny" | null, description: string | null }} EnvPolicy
   * @typedef {{ name: string, optIn: string | null }} RequiredEnv
   * @typedef {{ env: RequiredEnv[] | null, mutates: boolean | null }} Requires
   * @typedef {{ code: string, message: string }} RefusalReason
   */

  /**
   * An environment's `policy:` block, or null when it declares nothing.
   * Unknown trait/mutation words are dropped rather than guessed at.
   * @param {unknown} raw
   * @returns {EnvPolicy | null}
   */
  function normalizePolicy(raw) {
    if (!isRecord(raw)) return null;
    const trait = TRAITS.includes(raw.trait) ? raw.trait : null;
    const mutations = MUTATIONS.includes(raw.mutations) ? raw.mutations : null;
    const description = text(raw.description);
    if (!trait && !mutations && !description) return null;
    return { trait, mutations, description };
  }

  /**
   * A spec's `requires:` block, or null when it declares nothing. `env`
   * entries are a bare name or `{ <name>: { optIn: <ENV_VAR> } }`.
   * @param {unknown} raw
   * @returns {Requires | null}
   */
  function normalizeRequires(raw) {
    if (!isRecord(raw)) return null;
    /** @type {RequiredEnv[] | null} */
    let env = null;
    if (Array.isArray(raw.env)) {
      env = [];
      for (const entry of raw.env) {
        if (typeof entry === "string") {
          if (entry.trim()) env.push({ name: entry.trim(), optIn: null });
          continue;
        }
        if (!isRecord(entry)) continue;
        for (const [name, value] of Object.entries(entry)) {
          if (!name.trim()) continue;
          const optIn =
            isRecord(value) && typeof value.optIn === "string"
              ? value.optIn.trim() || null
              : null;
          env.push({ name: name.trim(), optIn });
        }
      }
    }
    const mutates = typeof raw.mutates === "boolean" ? raw.mutates : null;
    if (env === null && mutates === null) return null;
    return { env, mutates };
  }

  /**
   * Opt-in variable names a `requires:` block references.
   * @param {Requires | null | undefined} requires
   * @returns {string[]}
   */
  function optInNames(requires) {
    const names = new Set();
    for (const entry of requires?.env ?? [])
      if (entry.optIn) names.add(entry.optIn);
    return [...names];
  }

  /**
   * Whether an opt-in variable's value grants access.
   * @param {unknown} value
   * @returns {boolean}
   */
  function optInGranted(value) {
    return (
      typeof value === "string" &&
      OPT_IN_VALUES.includes(value.trim().toLowerCase())
    );
  }

  /**
   * `KEY=value` pairs of a dotenv file (`export ` prefix, quotes and
   * trailing ` # comments` on unquoted values handled), limited to `names`:
   * the main process uses it to answer opt-in questions the way Bun does
   * when it loads the project's `.env` files for cairn. Values never leave
   * the main process (`optInStates` turns them into booleans).
   * @param {string} source dotenv file contents
   * @param {Iterable<string>} names
   * @returns {Record<string, string>}
   */
  function parseDotEnv(source, names) {
    const wanted = new Set(names);
    /** @type {Record<string, string>} */
    const out = {};
    if (!wanted.size || typeof source !== "string") return out;
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match =
        /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
      if (!match || !wanted.has(match[1])) continue;
      let value = match[2];
      const quote = value[0];
      if (
        (quote === '"' || quote === "'" || quote === "`") &&
        value.length > 1
      ) {
        const end = value.indexOf(quote, 1);
        value = end > 0 ? value.slice(1, end) : value.slice(1);
      } else {
        value = value.replace(/\s+#.*$/, "");
      }
      out[match[1]] = value;
    }
    return out;
  }

  /**
   * name → granted? for every opt-in a spec references, read from an env
   * table (the main process passes the environment cairn is spawned with).
   * Only booleans leave this function, never values.
   * @param {Requires | null | undefined} requires
   * @param {Record<string, string | undefined>} env
   * @returns {Record<string, boolean>}
   */
  function optInStates(requires, env) {
    /** @type {Record<string, boolean>} */
    const out = {};
    for (const name of optInNames(requires))
      out[name] = optInGranted(env?.[name]);
    return out;
  }

  /**
   * The environment a run resolves to, in the CLI's order: an explicit
   * `--env`, the spec's `environment:`, the config's `defaultEnvironment`,
   * then `local`.
   * @param {{ override?: string | null, specEnvironment?: string | null, defaultEnvironment?: string | null }} input
   * @returns {{ name: string, source: "override" | "spec" | "config-default" | "fallback" }}
   */
  function resolveEnvironment(input) {
    if (input?.override) return { name: input.override, source: "override" };
    if (input?.specEnvironment)
      return { name: input.specEnvironment, source: "spec" };
    if (input?.defaultEnvironment)
      return { name: input.defaultEnvironment, source: "config-default" };
    return { name: "local", source: "fallback" };
  }

  /**
   * Would the runner refuse this spec on `env`? Every rule that applies is
   * listed, so the warning can say all of them at once.
   * @param {{
   *   requires?: unknown,
   *   env: string,
   *   policy?: unknown,
   *   optIns?: Record<string, boolean> | null,
   * }} input
   * @returns {{ refused: boolean, env: string, reasons: RefusalReason[], summary: string }}
   */
  function evaluateRequires(input) {
    const env = String(input?.env ?? "");
    const requires = isRequires(input?.requires)
      ? input.requires
      : normalizeRequires(input?.requires);
    const policy = isPolicy(input?.policy)
      ? input.policy
      : normalizePolicy(input?.policy);
    const optIns = input?.optIns ?? {};
    /** @type {RefusalReason[]} */
    const reasons = [];
    const listed = (requires?.env ?? []).filter((entry) => entry.name === env);

    if (requires?.env) {
      if (!listed.length) {
        const allowed = requires.env.map((entry) => entry.name);
        reasons.push({
          code: "env-not-listed",
          message: allowed.length
            ? `requires.env lists ${allowed.join(", ")}, not "${env}"`
            : `requires.env is empty: no environment may run this spec`,
        });
      } else if (
        !listed.some((entry) => !entry.optIn || optIns[entry.optIn] === true)
      ) {
        const vars = listed
          .map((entry) => entry.optIn)
          .filter(Boolean)
          .join(" or ");
        reasons.push({
          code: "opt-in-missing",
          message: `"${env}" needs opt-in ${vars}=1 (or true) in the environment cairn runs with`,
        });
      }
    }
    if (requires?.mutates === true && policy?.mutations === "deny")
      reasons.push({
        code: "mutations-denied",
        message: `the spec mutates data and "${env}" denies mutations`,
      });
    if (policy?.trait === "protected" && !listed.length && !requires?.env)
      reasons.push({
        code: "protected-env",
        message: `"${env}" is protected: the spec must list it in requires.env`,
      });

    return {
      refused: reasons.length > 0,
      env,
      reasons,
      summary: reasons.map((reason) => reason.message).join("; "),
    };
  }

  /**
   * @param {unknown} value
   * @returns {value is Requires}
   */
  function isRequires(value) {
    return (
      isRecord(value) &&
      (value.env === null || Array.isArray(value.env)) &&
      (value.mutates === null || typeof value.mutates === "boolean") &&
      (value.env ?? []).every(
        (/** @type {any} */ entry) =>
          isRecord(entry) && typeof entry.name === "string" && "optIn" in entry,
      )
    );
  }

  /**
   * @param {unknown} value
   * @returns {value is EnvPolicy}
   */
  function isPolicy(value) {
    return (
      isRecord(value) &&
      "trait" in value &&
      "mutations" in value &&
      "description" in value
    );
  }

  /**
   * Did a `cairn run` end refused by the environment policy? Exit 7, a run
   * document with status `refused`, or a batch whose every spec was refused
   * (`summary.refused === summary.total`; exit 0 without --strict-requires).
   * @param {number | null | undefined} exitCode
   * @param {unknown} document the `--format json` run or batch document
   * @returns {boolean}
   */
  function isRefusedOutcome(exitCode, document) {
    if (exitCode === 7) return true;
    if (!isRecord(document)) return false;
    if (document.status === "refused") return true;
    const summary = isRecord(document.summary) ? document.summary : null;
    const refused = summary?.refused;
    return (
      typeof refused === "number" && refused > 0 && refused === summary?.total
    );
  }

  /**
   * A `cairn run --format json` RunResult the CLI synthesized without a run
   * directory (`synthetic: true`: refused, or errored/cancelled before its
   * run started). Its `runId` / `runDir` are placeholders: never open them.
   * @param {unknown} document
   * @returns {boolean}
   */
  function isSyntheticResult(document) {
    return isRecord(document) && document.synthetic === true;
  }

  /**
   * The refusal a run or batch document carries: its own `refusal`, else
   * the first refused result's.
   * @param {unknown} document
   * @returns {ReturnType<typeof normalizeRefusal>}
   */
  function documentRefusal(document) {
    if (!isRecord(document)) return null;
    const own = normalizeRefusal(document.refusal);
    if (own) return own;
    const results = Array.isArray(document.results) ? document.results : [];
    for (const result of results)
      if (isRecord(result) && result.status === "refused") {
        const refusal = normalizeRefusal(result.refusal);
        if (refusal) return refusal;
      }
    return null;
  }

  /**
   * `env local, staging (opt-in ALLOW_STAGING) · mutates`, or null.
   * @param {Requires | null | undefined} requires
   * @returns {string | null}
   */
  function describeRequires(requires) {
    if (!requires) return null;
    const parts = [];
    if (requires.env)
      parts.push(
        requires.env.length
          ? `env ${requires.env
              .map((entry) =>
                entry.optIn
                  ? `${entry.name} (opt-in ${entry.optIn})`
                  : entry.name,
              )
              .join(", ")}`
          : "env (none)",
      );
    if (requires.mutates === true) parts.push("mutates");
    else if (requires.mutates === false) parts.push("read-only");
    return parts.length ? parts.join(" · ") : null;
  }

  /**
   * `protected · mutations denied`, or null.
   * @param {EnvPolicy | null | undefined} policy
   * @returns {string | null}
   */
  function describePolicy(policy) {
    if (!policy) return null;
    const parts = [];
    if (policy.trait) parts.push(policy.trait);
    if (policy.mutations)
      parts.push(
        policy.mutations === "deny" ? "mutations denied" : "mutations allowed",
      );
    return parts.length ? parts.join(" · ") : null;
  }

  /**
   * A run record's `refusal` block (or a `run.refused` event), or null.
   * `code` is the runner's machine-readable reason (`env-not-listed`,
   * `opt-in-missing`, `mutations-denied`, `protected-env`), present only
   * when it says one.
   * @param {unknown} raw
   * @returns {{ reason: string | null, env: string | null, requires: Requires | null, requiresText: string | null, code?: string } | null}
   */
  function normalizeRefusal(raw) {
    if (!isRecord(raw)) return null;
    const requires = normalizeRequires(raw.requires);
    const reason = text(raw.reason);
    const env = text(raw.env);
    if (!reason && !env && !requires) return null;
    const code = text(raw.code);
    return {
      reason,
      env,
      requires,
      requiresText: describeRequires(requires),
      ...(code ? { code } : {}),
    };
  }

  /**
   * One line for a refusal: `refused on staging: <reason> (requires env local)`.
   * @param {ReturnType<typeof normalizeRefusal>} refusal
   * @returns {string}
   */
  function refusalText(refusal) {
    if (!refusal) return "refused by the environment policy";
    return `refused${refusal.env ? ` on ${refusal.env}` : ""}: ${
      refusal.reason ?? "environment policy"
    }${refusal.requiresText ? ` (requires ${refusal.requiresText})` : ""}`;
  }

  return {
    TRAITS,
    OPT_IN_VALUES,
    normalizePolicy,
    normalizeRequires,
    optInNames,
    optInGranted,
    optInStates,
    parseDotEnv,
    isRefusedOutcome,
    isSyntheticResult,
    documentRefusal,
    resolveEnvironment,
    evaluateRequires,
    describeRequires,
    describePolicy,
    normalizeRefusal,
    refusalText,
  };
})();

if (typeof module === "object" && module.exports) module.exports = CairnPolicy;
if (typeof globalThis === "object" && globalThis)
  /** @type {any} */ (globalThis).CairnPolicy = CairnPolicy;
