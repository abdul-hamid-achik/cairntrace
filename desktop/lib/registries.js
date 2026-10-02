/**
 * The config registries a spec author reuses, summarized for display:
 * `datasources:` (per environment, with `environments.<n>.datasources`
 * overrides merged the way the runner merges them), `gates:` and
 * `fixtures:`.
 *
 * Built from the config parsed WITHOUT `${env.X}` substitution, so a value
 * that comes from the environment shows as its reference (`${env.MONGO_URI}`,
 * `${secrets.MONGO_URI}`), never as the value; a reference's `:-default`
 * is redacted like a literal. Literal connection strings are redacted
 * (userinfo masked, query dropped), credentials (`auth.basic`,
 * `auth.bearer`, header values) are reduced to their kind, and command
 * lines are scrubbed of inline credentials. Command scrubbing is
 * pattern-based (the shapes `scrubText` lists): a password passed in a
 * shape it does not know, such as a bare positional argument, still shows.
 *
 * Main process only; pure.
 */

const DATASOURCE_KINDS = new Set(["mongo", "temporal", "http"]);
const GATE_KINDS = ["tcp", "http", "command", "gate", "all", "any"];
const FIXTURE_VERBS = ["ensure", "reset", "verify", "teardown"];
/** Rows per registry. */
const MAX_ENTRIES = 300;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function str(value) {
  return typeof value === "string" && value.length ? value : null;
}

/** `${secrets.X}` / `${env.X}` / `${vars.X}` references inside a string. */
const PLACEHOLDER =
  /\$\{(?:secrets|env|vars)\.[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/g;

/** One placeholder, its parts captured: the reference and its default. */
const REFERENCE =
  /^\$\{((?:secrets|env|vars)\.[A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/;

/** A variable name that says it holds a credential. */
const SECRET_NAME =
  /pass(?:word|wd|phrase)?|(?:^|[._-])pwd?(?:$|[._-])|secret|token|api[-_]?key|apikey|credential|cookie|private[-_]?key|bearer|auth/i;

const MASK = "••••••";

/**
 * A placeholder as display text: the reference kept, its `:-default`
 * redacted. A URL default loses its userinfo and query; a `secrets.*`
 * default, a credential-named variable's default, or any default when
 * `secret` is set is masked whole; anything else is scrubbed like a command
 * line. Null when the text is not one placeholder.
 * @param {string} text
 * @param {{ secret?: boolean }} [options]
 * @returns {string | null}
 */
function redactReference(text, options = {}) {
  const match = REFERENCE.exec(String(text ?? "").trim());
  if (!match) return null;
  const [, name, fallback] = match;
  if (fallback === undefined) return `\${${name}}`;
  if (fallback === "") return `\${${name}:-}`;
  const shown =
    options.secret || name.startsWith("secrets.") || SECRET_NAME.test(name)
      ? MASK
      : (redactUrl(fallback) ?? scrubText(fallback, 160));
  return `\${${name}:-${shown}}`;
}

/**
 * A URL-shaped string with its userinfo masked (`***@`) and its query
 * dropped; null when the text is not `scheme://…`.
 * @param {string} text
 * @returns {string | null}
 */
function redactUrl(text) {
  const match =
    /^([a-z][a-z0-9+.-]*:\/\/)(?:([^@/?#]*)@)?([^?#]*)(\?[^#]*)?/i.exec(text);
  if (!match) return null;
  const [, scheme, userinfo, rest, query] = match;
  const path = (rest ?? "").replace(
    PLACEHOLDER,
    (ref) => redactReference(ref) ?? ref,
  );
  return `${scheme}${userinfo ? "***@" : ""}${path}${query ? "?…" : ""}`;
}

/**
 * A credential value as display text: masked whole, unless it is a
 * reference (`${secrets.X}`, kept with any default masked) or already
 * masked. Quotes around it are kept.
 * @param {string} value
 * @returns {string}
 */
function maskCredential(value) {
  const quote = /^(["']).*\1$/s.test(value) ? value[0] : "";
  const inner = quote ? value.slice(1, -1) : value;
  if (inner === MASK) return value;
  return `${quote}${redactReference(inner, { secret: true }) ?? MASK}${quote}`;
}

/**
 * A connection string or URL as a display target: a placeholder kept (its
 * default redacted), userinfo masked (`***@`), the query string dropped.
 * @param {unknown} value
 * @returns {string | null}
 */
function redactTarget(value) {
  const text = str(value);
  if (!text) return null;
  return redactReference(text) ?? redactUrl(text) ?? scrubText(text);
}

/** Header names whose value is a credential. */
const SECRET_HEADER =
  /^(?:(?:proxy-)?authorization|(?:set-)?cookie|[a-z0-9-]*(?:api-?key|apikey|token|secret|password|session|signature|auth)[a-z0-9-]*)$/i;

/** Credential flags whose value may be the next word (`--password pw`). */
const SECRET_FLAG =
  /^--?[a-z0-9-]*(?:pass(?:word|wd|phrase)?|secret|token|api-?key|apikey|credential)[a-z0-9-]*$/i;

/** Clients whose `-p` takes a password (mongosh, mysql, sshpass, …). */
const PASSWORD_P_CLIENT =
  /(?:^|[\s/])(?:mongosh|mongo|mongodump|mongorestore|mongoexport|mongoimport|mysql|mysqldump|mysqladmin|mariadb|sshpass)(?=\s|$)/;

/**
 * Port-shaped (`27017`, `8080:80`, `53/udp`): such a `-p` is a port.
 * @param {string} value
 * @returns {boolean}
 */
function portShaped(value) {
  return /^\d+(?::\d+)*(?:\/(?:tcp|udp))?$/.test(value);
}

/**
 * One command segment (no `&&` / `;` / `|`) with credential flag values
 * masked: `--password pw`, `--token pw`, redis-cli `-a pw`, and `-p pw` /
 * `-ppw` where `-p` means a password (the segment names a user with `-u` /
 * `--username`, or runs a client whose `-p` is a password), never a port.
 * @param {string} segment
 * @returns {string}
 */
function scrubFlags(segment) {
  const words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (!words.length) return segment;
  const pIsPassword =
    words.some((word) => /^(?:-u|--user(?:name)?)$/.test(word)) ||
    PASSWORD_P_CLIENT.test(segment);
  const redisCli = /(?:^|[\s/])redis-cli(?=\s|$)/.test(segment);
  const attachedP = (/** @type {string} */ word) =>
    pIsPassword && /^-p[^\s=]+$/.test(word) && !portShaped(word.slice(2));
  /** @type {string[]} */
  const out = [];
  let changed = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const next = words[index + 1];
    if (attachedP(word)) {
      const shown = `-p${maskCredential(word.slice(2))}`;
      if (shown !== word) changed = true;
      out.push(shown);
      continue;
    }
    out.push(word);
    if (next === undefined || next.startsWith("-")) continue;
    if (
      SECRET_FLAG.test(word) ||
      (word === "-p" && pIsPassword && !portShaped(next)) ||
      (word === "-a" && redisCli)
    ) {
      const shown = maskCredential(next);
      if (shown !== next) changed = true;
      out.push(shown);
      index += 1;
    }
  }
  // Re-joining normalizes nothing else: whitespace is already one space.
  return changed ? out.join(" ") : segment;
}

/**
 * A command line or free text with inline credentials removed: URI
 * userinfo, placeholder defaults, `--password=…` and `--password …` flags,
 * `-p …` where it is a password, `-u user:pass`, credential headers
 * (`Authorization:`, `Cookie:`, `X-Api-Key:`, …), quoted JSON credential
 * keys, `TOKEN=…` assignments. References stay readable.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function scrubText(value, max = 300) {
  let text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(PLACEHOLDER, (match) => redactReference(match) ?? match)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, "$1***@")
    // schemeless userinfo: root:pw@localhost:27017
    .replace(
      /(^|[\s=('"])[A-Za-z0-9._~%+-]+:[^\s/@'"{}]+@(?=[^\s@])/g,
      "$1***@",
    )
    // quoted headers: -H 'Cookie: a=1; b=2', "Authorization: Bearer x"
    .replace(
      /(["'])([A-Za-z][A-Za-z0-9-]*)(\s*:\s*)(.*?)\1/g,
      (match, quote, name, sep, item) => {
        if (!SECRET_HEADER.test(name)) return match;
        const scheme = /^(?:basic|bearer)\s+/i.exec(item)?.[0] ?? "";
        const ref = redactReference(item.slice(scheme.length), {
          secret: true,
        });
        return `${quote}${name}${sep}${ref ? scheme + ref : MASK}${quote}`;
      },
    )
    // quoted JSON keys: {"password": "x"}
    .replace(
      /(["'])([A-Za-z0-9_-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|apikey|credential)[A-Za-z0-9_-]*)\1(\s*:\s*)("[^"]*"|'[^']*')/gi,
      (_match, quote, key, sep, item) =>
        `${quote}${key}${quote}${sep}${maskCredential(item)}`,
    )
    // unquoted headers and assignments: Authorization: Bearer x, Cookie: x
    .replace(
      /(\b(?:proxy-)?authorization\s*[:=](?!-)\s*)((?:basic|bearer)\s+)?("[^"]*"|'[^']*'|[^\s"']+)/gi,
      (_match, head, scheme, item) => {
        const shown = maskCredential(item);
        return shown === MASK
          ? `${head}${MASK}`
          : `${head}${scheme ?? ""}${shown}`;
      },
    )
    .replace(
      /(\b(?:set-)?cookie\s*:(?!-)\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi,
      (_match, head, item) => `${head}${maskCredential(item)}`,
    )
    // --password=x, PGPASSWORD=x, api_key: x
    .replace(
      /((?:--?)?[A-Za-z0-9_-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|apikey|credential)[A-Za-z0-9_-]*\s*[=:](?!-)\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi,
      (_match, head, item) => `${head}${maskCredential(item)}`,
    )
    .replace(
      /(\s(?:-u|--user)(?:\s+|=))(["']?)[^\s:"']+:[^\s"']+\2/g,
      "$1$2••••••$2",
    );
  text = text
    .split(/(\s*(?:&&|\|\||[;|])\s*)/)
    .map((part, index) => (index % 2 ? part : scrubFlags(part)))
    .join("");
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

/**
 * The credential kind of an `auth:` block (never its value).
 * @param {unknown} auth
 * @returns {string | null} `basic` / `bearer` (with `· ${secrets.X}` when a reference)
 */
function authKind(auth) {
  if (!isRecord(auth)) return null;
  for (const kind of ["basic", "bearer"]) {
    const value = auth[kind];
    if (value === undefined || value === null) continue;
    const ref =
      typeof value === "string"
        ? redactReference(value, { secret: true })
        : isRecord(value) && typeof value.password === "string"
          ? redactReference(value.password, { secret: true })
          : null;
    return ref ? `${kind} · ${ref}` : kind;
  }
  return null;
}

/**
 * Merge an environment override over a top-level datasource, the way the
 * runner does (src/core/datasources/resolve.ts mergeDatasource).
 * @param {Record<string, any> | undefined} base
 * @param {Record<string, any> | undefined} override
 * @returns {Record<string, any> | undefined}
 */
function mergeDatasource(base, override) {
  if (!override) return base;
  if (!base) return override;
  if (override.kind !== undefined && override.kind !== base.kind)
    return override;
  /** @type {Record<string, any>} */
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const previous = merged[key];
    merged[key] =
      isRecord(previous) && isRecord(value) ? { ...previous, ...value } : value;
  }
  if (
    base.kind === "mongo" &&
    override.uri !== undefined &&
    override.docker === undefined &&
    override.transport === undefined
  )
    delete merged.docker;
  return merged;
}

/**
 * One datasource entry for display.
 * @param {string} name
 * @param {unknown} entry
 */
function describeDatasource(name, entry) {
  const ds = isRecord(entry) ? entry : {};
  const kind = str(ds.kind);
  /** @type {string | null} */
  let target = null;
  /** @type {string | null} */
  let transport = null;
  /** @type {Array<[string, string]>} */
  const facts = [];
  const add = (/** @type {string} */ label, /** @type {unknown} */ value) => {
    if (value === null || value === undefined || value === "") return;
    facts.push([
      label,
      Array.isArray(value) ? value.map(String).join(", ") : String(value),
    ]);
  };
  if (kind === "mongo") {
    const docker = isRecord(ds.docker) ? ds.docker : null;
    transport =
      str(ds.transport) ?? (str(ds.uri) ? "driver | mongosh" : "docker");
    if (str(ds.uri) && transport !== "docker") target = redactTarget(ds.uri);
    else if (docker)
      target = [
        str(docker.service)
          ? `compose service ${docker.service}`
          : str(docker.container)
            ? `container ${docker.container}`
            : "docker",
        str(docker.project) ? `project ${docker.project}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    else if (str(ds.uri)) target = redactTarget(ds.uri);
    add("database", str(ds.database));
    add("mode", str(ds.mode) ?? "read-write");
    if (isRecord(ds.guard)) {
      add("guard databases", ds.guard.databases);
      add("guard hosts", ds.guard.hosts);
    }
    if (docker && str(docker.uri))
      add("uri in container", redactTarget(docker.uri));
  } else if (kind === "temporal") {
    target = redactTarget(ds.api);
    add("namespace", str(ds.namespace));
    add("auth", authKind(ds.auth));
  } else if (kind === "http") {
    target = redactTarget(ds.baseUrl);
    add("auth", authKind(ds.auth));
    if (isRecord(ds.headers))
      add("headers", Object.keys(ds.headers).slice(0, 20));
  }
  return {
    name,
    kind: kind ?? "unknown",
    target,
    transport,
    database: kind === "mongo" ? str(ds.database) : null,
    namespace: kind === "temporal" ? str(ds.namespace) : null,
    mode: kind === "mongo" ? (str(ds.mode) ?? "read-write") : null,
    facts,
    known: kind !== null && DATASOURCE_KINDS.has(kind),
  };
}

/**
 * `datasources:` per environment: each environment's effective entries
 * (inherited, overridden, disabled with `false`, or declared only there).
 * @param {Record<string, any>} doc config parsed without env substitution
 */
function summarizeDatasources(doc) {
  const top = isRecord(doc.datasources) ? doc.datasources : {};
  const envs = isRecord(doc.environments) ? doc.environments : {};
  const topLevel = Object.entries(top)
    .slice(0, MAX_ENTRIES)
    .map(([name, entry]) => describeDatasource(name, entry));
  const environments = Object.entries(envs).map(([envName, envValue]) => {
    const overrides =
      isRecord(envValue) && isRecord(envValue.datasources)
        ? envValue.datasources
        : {};
    const names = [
      ...new Set([...Object.keys(top), ...Object.keys(overrides)]),
    ].slice(0, MAX_ENTRIES);
    return {
      env: envName,
      datasources: names.map((name) => {
        const override = overrides[name];
        if (override === false)
          return {
            ...describeDatasource(name, top[name]),
            state: "disabled",
          };
        const merged = mergeDatasource(
          isRecord(top[name]) ? top[name] : undefined,
          isRecord(override) ? override : undefined,
        );
        return {
          ...describeDatasource(name, merged),
          state:
            top[name] === undefined
              ? "env-only"
              : override === undefined
                ? "inherited"
                : "override",
        };
      }),
    };
  });
  return { topLevel, environments };
}

/**
 * A gate ref (string or inline node) as short text.
 * @param {unknown} ref
 * @returns {string}
 */
function gateRefText(ref) {
  if (typeof ref === "string") return redactTarget(ref) ?? ref;
  if (!isRecord(ref)) return "?";
  const described = describeGate(str(ref.name) ?? "(inline)", ref);
  return `${described.probe} ${described.target ?? ""}`.trim();
}

/**
 * A gate duration as written (`2m`), or milliseconds as `120000ms`.
 * @param {unknown} item
 * @returns {string | null}
 */
function duration(item) {
  return typeof item === "number"
    ? `${item}ms`
    : typeof item === "string"
      ? item
      : null;
}

/**
 * One gate for display: its probe kind, target, and waiting policy.
 * @param {string} name
 * @param {unknown} node
 */
function describeGate(name, node) {
  const gate = isRecord(node) ? node : {};
  const probe = GATE_KINDS.find((kind) => gate[kind] !== undefined) ?? "?";
  /** @type {string | null} */
  let target = null;
  /** @type {Array<[string, string]>} */
  const facts = [];
  /** @type {string[]} */
  const refs = [];
  const value = gate[probe];
  if (probe === "tcp")
    target =
      typeof value === "string"
        ? redactTarget(value)
        : isRecord(value)
          ? scrubText(`${value.host ?? "?"}:${value.port ?? "?"}`, 160)
          : null;
  else if (probe === "http") {
    if (typeof value === "string") target = redactTarget(value);
    else if (isRecord(value)) {
      target = `${str(value.method) ?? "GET"} ${redactTarget(value.url) ?? "?"}`;
      if (value.status !== undefined)
        facts.push([
          "status",
          Array.isArray(value.status)
            ? value.status.join(" | ")
            : String(value.status),
        ]);
      if (isRecord(value.json))
        facts.push(["json", Object.keys(value.json).join(", ")]);
      if (str(value.text)) facts.push(["text", scrubText(value.text, 80)]);
      const auth = authKind(value.auth);
      if (auth) facts.push(["auth", auth]);
    }
  } else if (probe === "command") {
    const run =
      typeof value === "string" ? value : isRecord(value) ? value.run : null;
    target = run ? scrubText(run, 160) : null;
    if (isRecord(value) && value.exitCode !== undefined)
      facts.push([
        "exit",
        Array.isArray(value.exitCode)
          ? value.exitCode.join(" | ")
          : String(value.exitCode),
      ]);
  } else if (probe === "gate") {
    target = str(value);
    if (target) refs.push(target);
  } else if (probe === "all" || probe === "any") {
    const list = Array.isArray(value) ? value : [];
    target = list.map(gateRefText).join(probe === "all" ? " + " : " | ");
    for (const ref of list)
      if (typeof ref === "string" && !/^(?:https?|tcp):\/\//i.test(ref))
        refs.push(ref);
  }
  return {
    name,
    probe,
    target,
    description: str(gate.description),
    timeout: duration(gate.timeout),
    every: duration(gate.every),
    stable: typeof gate.stable === "number" ? gate.stable : null,
    facts,
    refs,
    usedBy: /** @type {string[]} */ ([]),
  };
}

/**
 * Registry names referenced from a single-or-list gate field.
 * @param {unknown} field
 * @returns {string[]}
 */
function refNames(field) {
  const list = Array.isArray(field)
    ? field
    : field === undefined
      ? []
      : [field];
  return list.filter(
    (ref) => typeof ref === "string" && !/^(?:https?|tcp):\/\//i.test(ref),
  );
}

/**
 * `gates:` with where the config waits on each (services, web server).
 * @param {Record<string, any>} doc
 */
function summarizeGates(doc) {
  const registry = isRecord(doc.gates) ? doc.gates : {};
  const gates = Object.entries(registry)
    .slice(0, MAX_ENTRIES)
    .map(([name, node]) => describeGate(name, node));
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const use = (/** @type {unknown} */ field, /** @type {string} */ where) => {
    for (const name of refNames(field)) {
      const gate = byName.get(name);
      if (gate && !gate.usedBy.includes(where)) gate.usedBy.push(where);
    }
  };
  /** @param {unknown} services @param {string} prefix */
  const fromServices = (services, prefix) => {
    if (!isRecord(services)) return;
    if (isRecord(services.docker))
      use(services.docker.ready, `${prefix}docker.ready`);
    const windows = isRecord(services.tmux) ? services.tmux.windows : null;
    for (const window of Array.isArray(windows) ? windows : []) {
      if (!isRecord(window)) continue;
      const label = str(window.name) ?? "window";
      use(window.after, `${prefix}tmux ${label}.after`);
      if (isRecord(window.readyOn))
        use(window.readyOn.gate, `${prefix}tmux ${label}.readyOn`);
    }
  };
  fromServices(doc.services, "services.");
  if (isRecord(doc.webServer)) use(doc.webServer.ready, "webServer.ready");
  if (isRecord(doc.environments))
    for (const [envName, env] of Object.entries(doc.environments))
      if (isRecord(env)) fromServices(env.services, `${envName} services.`);
  return gates;
}

/**
 * `fixtures:` for display: adapter, scope, verbs, ownership, outputs (names
 * only), dependencies. Commands, documents and request bodies stay out.
 * @param {Record<string, any>} doc
 */
function summarizeFixtures(doc) {
  const registry = isRecord(doc.fixtures) ? doc.fixtures : {};
  return Object.entries(registry)
    .slice(0, MAX_ENTRIES)
    .map(([name, entry]) => {
      const fixture = isRecord(entry) ? entry : {};
      const outputs = isRecord(fixture.outputs)
        ? Object.keys(fixture.outputs)
        : Array.isArray(fixture.outputs)
          ? fixture.outputs.filter((item) => typeof item === "string")
          : [];
      return {
        name,
        kind: str(fixture.kind) ?? "?",
        scope: str(fixture.scope) ?? "run",
        verbs: FIXTURE_VERBS.filter((verb) => fixture[verb] !== undefined),
        owner: str(fixture.owner),
        ttl:
          typeof fixture.ttl === "number"
            ? `${fixture.ttl}ms`
            : str(fixture.ttl),
        needs: Array.isArray(fixture.needs)
          ? fixture.needs.filter((item) => typeof item === "string")
          : [],
        outputs: outputs.slice(0, 30),
        datasource: str(fixture.source) ?? str(fixture.datasource),
        description: str(fixture.description),
      };
    });
}

/**
 * Every registry, for `project:inspect` (Environment and Catalog views).
 * @param {unknown} doc the config parsed without `${env.X}` substitution
 */
function summarizeRegistries(doc) {
  if (!isRecord(doc))
    return {
      datasources: { topLevel: [], environments: [] },
      gates: [],
      fixtures: [],
    };
  return {
    datasources: summarizeDatasources(doc),
    gates: summarizeGates(doc),
    fixtures: summarizeFixtures(doc),
  };
}

/**
 * The fixture ledger name the CLI uses for a project: the config's
 * `project:` (default `cairntrace`), when it is a plain name (letters,
 * digits, `.`, `_`, `-`, starting with a letter — src/core/fixtures/
 * ledger.ts projectLedgerPath); null otherwise (the CLI keeps no ledger).
 * @param {unknown} name the config's `project:` value
 * @returns {string | null}
 */
function ledgerProjectName(name) {
  const text = name === undefined || name === null ? "cairntrace" : str(name);
  if (!text || text.length > 128) return null;
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(text) && !text.includes("..")
    ? text
    : null;
}

module.exports = {
  PLACEHOLDER,
  summarizeRegistries,
  summarizeDatasources,
  summarizeGates,
  summarizeFixtures,
  describeDatasource,
  describeGate,
  mergeDatasource,
  redactTarget,
  redactReference,
  scrubText,
  authKind,
  ledgerProjectName,
};
