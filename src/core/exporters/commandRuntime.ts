/**
 * The bounded host-command runtime of exported Playwright tests.
 *
 * One helper family serves every exported host command: spec preconditions,
 * `run:` steps and `teardown:` items, and the `cairn` calls of the generated
 * global setup. It mirrors what `cairn run` does for the same commands:
 *
 *  - the child gets a FILTERED environment (publisher / TinyVault control
 *    credentials stripped), never this process's full one;
 *  - the deadline kills the whole owned process tree, not just the shell;
 *  - a shell command runs as `/bin/sh -c <script> cairn-run <args…>` (`args`
 *    are `$1…$n`); a command that needs no shell is spawned as an argument
 *    vector. A word holding an `${env.X}` / `${secrets.X}` value still runs
 *    through the shell, because `cairn run` substitutes the value into the
 *    command text first (word splitting, globs and an empty value dropping
 *    a word behave the same);
 *  - a failing command's error carries the tail of its output with every
 *    secret value scrubbed BEFORE the tail is cut (sensitive-named env,
 *    the `${env.X}` / `${secrets.X}` values the command read), like the
 *    runner;
 *  - the command settles once its output is drained (`close`), or 500ms
 *    after it exited when a grandchild keeps the pipes open;
 *  - with `capture`, the bounded stdout is returned and `cairnLastJson`
 *    applies the `assign` contract (the last non-empty stdout line is JSON).
 *
 * Single-file exports inline only the pieces they call (a leftover helper
 * would fail `noUnusedLocals`); `--project` / `--into` write all of it to
 * `preconditions.ts`.
 */

type ExportLang = "ts" | "js";

export interface CommandRuntimeParts {
  /** `export` every helper (the `preconditions` module). */
  exported?: boolean;
  /** `cairnLastJson` — the `run.assign` JSON contract. */
  json?: boolean;
  /** `cairnTestContext` — the CAIRN_* run context from a TestInfo. */
  context?: boolean;
  /** `runPrecondition` — the legacy shell-string entry point. */
  precondition?: boolean;
}

/**
 * Source lines of the node imports the helpers need. `cairnTestContext` also
 * needs `join` from `node:path`: a standalone export merges it into its own
 * `node:path` import, the `preconditions` module imports it here.
 */
export function commandRuntimeImports(parts: CommandRuntimeParts): string[] {
  return [
    `import { spawn, spawnSync } from "node:child_process";`,
    `import { existsSync } from "node:fs";`,
    ...(parts.exported ? [`import { join } from "node:path";`] : []),
  ];
}

export function renderCommandRuntimeLines(
  lang: ExportLang,
  parts: CommandRuntimeParts = {},
): string[] {
  const ts = lang === "ts";
  const t = (annotation: string): string => (ts ? annotation : "");
  const exp = parts.exported ? "export " : "";
  const lines: string[] = [
    `const PUBLISHER_ONLY_ENV_KEYS = new Set(["FILECHEAP_INGEST_TOKEN"]);`,
    `const TVAULT_CONTROL_PREFIX = "TVAULT_";`,
    `const CAIRN_TVAULT_ENV = "CAIRN_TVAULT_ENV";`,
    `const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024;`,
    `const COMMAND_TAIL_CHARS = 2000;`,
    `// The raw tail kept before redaction: wide enough that a secret cut at its`,
    `// start never survives into the redacted COMMAND_TAIL_CHARS.`,
    `const COMMAND_RAW_TAIL_CHARS = 4 * COMMAND_TAIL_CHARS;`,
    `const COMMAND_DRAIN_GRACE_MS = 500;`,
    `const COMMAND_SENSITIVE_NAME_RE = /authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|code[_-]?verifier|otp|passcode|credential|assertion|jwt|bearer/i;`,
    ``,
  ];
  if (ts) {
    lines.push(
      `/** A command that needs no shell: spawned as an argument vector. */`,
      `${exp}interface CairnArgv {`,
      `  argv: string[];`,
      `}`,
      ``,
      `${exp}interface CairnCommandOptions {`,
      `  cwd: string;`,
      `  timeoutMs: number;`,
      `  env?: Record<string, string>;`,
      `  /** \`$1…$n\` of a shell command. */`,
      `  args?: string[];`,
      `  /** Resolve with the (bounded) stdout instead of "". */`,
      `  capture?: boolean;`,
      `  /** CAIRN_* run context layered under \`env\`. */`,
      `  context?: Record<string, string>;`,
      `  /** Names the command in errors (never its text: it may carry secrets). */`,
      `  label?: string;`,
      `  /** Env vars the command text read (\${env.X} / \${secrets.X}): their values are scrubbed from errors. */`,
      `  redact?: string[];`,
      `}`,
      ``,
    );
  }
  lines.push(
    `/**`,
    ` * Run a host command with a hard deadline. A string runs through \`/bin/sh -c\``,
    ` * (\`cmd.exe\` on Windows); a \`{ argv }\` is spawned without a shell. A non-zero`,
    ` * exit, a spawn error and the deadline reject; the deadline kills the whole`,
    ` * owned process tree. The error carries the output tail, never the command.`,
    ` */`,
    `${exp}async function cairnCommand(command${t(
      ": string | CairnArgv",
    )}, options${t(": CairnCommandOptions")})${t(": Promise<string>")} {`,
    `  if (!existsSync(options.cwd)) {`,
    `    throw new Error(`,
    `      "Command cwd does not exist: " + options.cwd + ". " +`,
    `        "Set CAIRN_PROJECT_ROOT to the Cairntrace project root (the directory holding the source specs); this export may have been moved.",`,
    `    );`,
    `  }`,
    `  const label = options.label ?? "Command";`,
    `  const env = targetPreconditionEnv({ ...(options.context ?? {}), ...(options.env ?? {}) });`,
    `  const windows = process.platform === "win32";`,
    `  let file${t(": string")};`,
    `  let args${t(": string[]")};`,
    `  if (typeof command === "string") {`,
    `    file = windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";`,
    `    args = windows ? ["/d", "/s", "/c", command] : ["-c", command, "cairn-run", ...(options.args ?? [])];`,
    `  } else {`,
    `    file = command.argv[0]${t("!")};`,
    `    args = command.argv.slice(1);`,
    `  }`,
    `  return await new Promise${t("<string>")}((resolve, reject) => {`,
    `    const child = spawn(file, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });`,
    `    let stdout = "";`,
    `    let tail = "";`,
    `    let settled = false;`,
    `    let exited${t(": { code: number | null; signal: NodeJS.Signals | null } | undefined")};`,
    `    const finish = (error${t("?: Error")}) => {`,
    `      if (settled) return;`,
    `      settled = true;`,
    `      clearTimeout(timer);`,
    `      if (error) reject(error);`,
    `      else resolve(options.capture ? stdout : "");`,
    `    };`,
    `    const timer = setTimeout(() => {`,
    `      const killed = killProcessTreeSync(child.pid);`,
    `      finish(new Error(`,
    `        label + " timed out after " + options.timeoutMs + "ms; killed " + killed.length + " process(es) in the owned tree.",`,
    `      ));`,
    `    }, options.timeoutMs);`,
    `    timer.unref?.();`,
    `    child.stdout.setEncoding("utf8");`,
    `    child.stderr.setEncoding("utf8");`,
    `    child.stdout.on("data", (chunk${t(": string")}) => {`,
    `      if (options.capture) stdout = (stdout + chunk).slice(-COMMAND_OUTPUT_LIMIT);`,
    `      tail = (tail + chunk).slice(-COMMAND_RAW_TAIL_CHARS);`,
    `    });`,
    `    child.stderr.on("data", (chunk${t(": string")}) => {`,
    `      tail = (tail + chunk).slice(-COMMAND_RAW_TAIL_CHARS);`,
    `    });`,
    `    // Settle once the output is drained (the last stdout line of an \`assign\``,
    `    // must not be lost), or shortly after the exit when a grandchild keeps`,
    `    // the pipes open — like \`cairn run\`.`,
    `    const settleExit = () => {`,
    `      if (settled || !exited) return;`,
    `      const { code, signal } = exited;`,
    `      if (code === 0) finish();`,
    `      else {`,
    `        const detail = signal ? " (signal " + signal + ")" : "";`,
    `        // Redact the whole kept output BEFORE cutting it: a secret straddling`,
    `        // the cut would survive as a partial no redactor recognizes.`,
    `        const safe = cairnRedactOutput(tail, options).slice(-COMMAND_TAIL_CHARS).trim();`,
    `        const output = safe ? ": " + safe.split("\\n").slice(-5).join("\\n") : "";`,
    `        finish(new Error(label + " failed with exit " + String(code) + detail + output));`,
    `      }`,
    `    };`,
    `    child.once("error", (error) => finish(error));`,
    `    child.once("exit", (code, signal) => {`,
    `      exited = { code, signal };`,
    `      setTimeout(settleExit, COMMAND_DRAIN_GRACE_MS).unref?.();`,
    `    });`,
    `    child.once("close", (code, signal) => {`,
    `      exited = exited ?? { code, signal };`,
    `      settleExit();`,
    `    });`,
    `  });`,
    `}`,
    ``,
    `/**`,
    ` * Command output with every secret value scrubbed: sensitive-named env`,
    ` * (this process's, the command's own and its run context) and the`,
    ` * \${env.X} / \${secrets.X} values the command text read (\`redact\`).`,
    ` */`,
    `function cairnRedactOutput(text${t(": string")}, options${t(
      ": { env?: Record<string, string>; context?: Record<string, string>; redact?: string[] }",
    )})${t(": string")} {`,
    `  const values = new Set${t("<string>")}();`,
    `  const add = (raw${t(": string | undefined")}, min${t(": number")}) => {`,
    `    const value = String(raw ?? "").trim();`,
    `    if (value.length < min) return;`,
    `    values.add(value);`,
    `    for (const line of value.split(/\\r?\\n/)) {`,
    `      if (line.trim().length >= 8) values.add(line.trim());`,
    `    }`,
    `  };`,
    `  const env = { ...process.env, ...(options.context ?? {}), ...(options.env ?? {}) };`,
    `  for (const [key, value] of Object.entries(env)) {`,
    `    if (key !== "CAIRN_RUN_TOKEN" && COMMAND_SENSITIVE_NAME_RE.test(key)) add(value, 1);`,
    `  }`,
    `  // A short value (a flag, a region) is not told apart from ordinary text.`,
    `  for (const name of options.redact ?? []) add(process.env[name], 6);`,
    `  let output = text;`,
    `  for (const value of [...values].sort((a, b) => b.length - a.length)) {`,
    `    output = output.split(value).join("[redacted]");`,
    `  }`,
    `  return output;`,
    `}`,
    ``,
  );
  if (parts.precondition || parts.exported) {
    lines.push(
      `/** A spec precondition: \`cairnCommand\` with the precondition label. */`,
      `${exp}async function runPrecondition(command${t(
        ": string | CairnArgv",
      )}, options${t(": CairnCommandOptions")})${t(": Promise<void>")} {`,
      `  await cairnCommand(command, { ...options, label: options.label ?? "Precondition" });`,
      `}`,
      ``,
    );
  }
  if (parts.json || parts.exported) {
    lines.push(
      `/** The \`run.assign\` contract: the last non-empty stdout line is JSON. */`,
      `${exp}function cairnLastJson(stdout${t(": string")}, label${t(
        ": string",
      )})${t(": unknown")} {`,
      `  const last = stdout`,
      `    .split("\\n")`,
      `    .map((line) => line.trim())`,
      `    .filter(Boolean)`,
      `    .at(-1);`,
      `  if (last === undefined) throw new Error(label + ": assign: the command printed nothing on stdout");`,
      `  try {`,
      `    return JSON.parse(last)${t(" as unknown")};`,
      `  } catch {`,
      `    throw new Error(label + ": assign: the last stdout line is not JSON");`,
      `  }`,
      `}`,
      ``,
    );
  }
  if (parts.context || parts.exported) {
    lines.push(
      `/** The CAIRN_* run context a \`cairn run\` command sees, from the running test. */`,
      `${exp}function cairnTestContext(`,
      `  info${t(
        ": { project: { use: { baseURL?: string } }; outputDir: string }",
      )},`,
      `  runToken${t("?: string")},`,
      `  status${t("?: string")},`,
      `)${t(": Record<string, string>")} {`,
      `  const context${t(": Record<string, string>")} = { CAIRN_RUN_DIR: join(info.outputDir, "cairn-run") };`,
      `  if (runToken) context.CAIRN_RUN_TOKEN = runToken;`,
      `  const baseUrl = info.project.use.baseURL;`,
      `  if (baseUrl) context.CAIRN_BASE_URL = baseUrl;`,
      `  if (status) context.CAIRN_RUN_STATUS = status;`,
      `  return context;`,
      `}`,
      ``,
    );
  }
  lines.push(
    `${exp}function targetPreconditionEnv(overrides${t(
      ": Record<string, string>",
    )} = {})${t(": Record<string, string>")} {`,
    `  const allowedTvaultKeys = new Set(`,
    `    Object.keys(overrides).filter((key) => key.startsWith(TVAULT_CONTROL_PREFIX)),`,
    `  );`,
    `  return Object.fromEntries(`,
    `    Object.entries({ ...process.env, ...overrides }).filter(`,
    `      (entry) =>`,
    `        entry[1] !== undefined &&`,
    `        !PUBLISHER_ONLY_ENV_KEYS.has(entry[0]) &&`,
    `        entry[0] !== CAIRN_TVAULT_ENV &&`,
    `        (!entry[0].startsWith(TVAULT_CONTROL_PREFIX) ||`,
    `          allowedTvaultKeys.has(entry[0])),`,
    `    ),`,
    `  )${t(" as Record<string, string>")};`,
    `}`,
    ``,
    `function killProcessTreeSync(rootPid${t(": number | undefined")})${t(
      ": number[]",
    )} {`,
    `  if (!rootPid || !Number.isInteger(rootPid) || rootPid <= 1) return [];`,
    `  if (process.platform === "win32") {`,
    `    spawnSync("taskkill", ["/pid", String(rootPid), "/t", "/f"], {`,
    `      stdio: "ignore",`,
    `      timeout: 5_000,`,
    `      env: targetPreconditionEnv(),`,
    `    });`,
    `    return [rootPid];`,
    `  }`,
    `  const tree = [rootPid, ...descendantPidsSync(rootPid)];`,
    `  for (const pid of [...tree].reverse()) {`,
    `    try {`,
    `      process.kill(pid, "SIGKILL");`,
    `    } catch {`,
    `      // A process may exit between discovery and the signal.`,
    `    }`,
    `  }`,
    `  return tree;`,
    `}`,
    ``,
    `function descendantPidsSync(rootPid${t(": number")})${t(": number[]")} {`,
    `  const descendants${t(": number[]")} = [];`,
    `  const pending = [rootPid];`,
    `  const seen = new Set(pending);`,
    `  while (pending.length > 0) {`,
    `    const parentPid = pending.shift()${t("!")};`,
    `    for (const childPid of directChildPidsSync(parentPid)) {`,
    `      if (seen.has(childPid)) continue;`,
    `      seen.add(childPid);`,
    `      descendants.push(childPid);`,
    `      pending.push(childPid);`,
    `    }`,
    `  }`,
    `  return descendants;`,
    `}`,
    ``,
    `function directChildPidsSync(pid${t(": number")})${t(": number[]")} {`,
    `  try {`,
    `    const result = spawnSync("pgrep", ["-P", String(pid)], {`,
    `      encoding: "utf8",`,
    `      timeout: 2_000,`,
    `      env: targetPreconditionEnv(),`,
    `    });`,
    `    if (typeof result.stdout !== "string") return [];`,
    `    return result.stdout`,
    `      .split("\\n")`,
    `      .map((line) => Number(line.trim()))`,
    `      .filter((childPid) => Number.isInteger(childPid) && childPid > 1);`,
    `  } catch {`,
    `    return [];`,
    `  }`,
    `}`,
    ``,
  );
  return lines;
}

/** The `preconditions.ts` module of a `--project` / `--into` export. */
export function renderCommandModule(lang: ExportLang): string {
  return `${[
    `// Generated by \`cairn export playwright --project\` — edit knowingly;`,
    `// Bounded host-command runner: filtered child env, process-tree timeout.`,
    ...commandRuntimeImports({ exported: true }),
    ``,
    ...renderCommandRuntimeLines(lang, { exported: true }),
  ].join("\n")}\n`;
}

/**
 * Classify a spec command for spawning WITHOUT a shell. Returns the argument
 * words (still carrying late-bound sentinels / runtime refs) when the command
 * is a plain `word word 'quoted' "quoted"` line, and `undefined` when it needs
 * `/bin/sh` (pipes, redirection, `&&`, expansion, assignments, builtins,
 * globs, `${…}` runtime splices).
 */
export function simpleCommandWords(run: string): string[] | undefined {
  const text = run.trim();
  if (text.length === 0) return undefined;
  const words: string[] = [];
  let current: string | undefined;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r") return undefined;
      if (current !== undefined) {
        words.push(current);
        current = undefined;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      current = (current ?? "") + text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let chunk = "";
      for (;;) {
        const c = text[j];
        if (c === undefined) return undefined;
        if (c === '"') break;
        if (c === "\\" || c === "$" || c === "`" || c === "\n")
          return undefined;
        chunk += c;
        j += 1;
      }
      current = (current ?? "") + chunk;
      i = j + 1;
      continue;
    }
    if ("|&;<>()$`\\*?[]{}~!#".includes(ch)) return undefined;
    current = (current ?? "") + ch;
    i += 1;
  }
  if (current !== undefined) words.push(current);
  if (words.length === 0) return undefined;
  // `cairn run` substitutes an env / secret VALUE into the command text and
  // hands it to the shell (word splitting, globs, an empty value dropping
  // the word): such a command runs through the shell in the export too.
  if (words.some((word) => LATE_ENV_WORD_RE.test(word))) return undefined;
  const first = words[0]!;
  // `NAME=value cmd` and shell builtins need the shell.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return undefined;
  if (first.includes("=") || SHELL_BUILTINS.has(first)) return undefined;
  return words;
}

const LATE_ENV_WORD_RE = /__CAIRN_(?:SECRET_REF|ENV_DEFAULT)__/;

/**
 * The env vars a host command reads late-bound (`${env.X}`, `${env.X:-d}`,
 * `${secrets.X}`), for the helper's `redact` option: their values are
 * scrubbed from its error output.
 */
export function lateEnvNamesOf(...texts: ReadonlyArray<unknown>): string[] {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(
        /__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__|__CAIRN_ENV_DEFAULT__([0-9a-f]+)_([0-9a-f]*)__/g,
      )) {
        if (m[1] !== undefined) names.add(m[1]);
        else {
          names.add(Buffer.from(m[2]!, "hex").toString("utf8"));
          visit(Buffer.from(m[3] ?? "", "hex").toString("utf8"));
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  for (const text of texts) visit(text);
  return [...names].toSorted();
}

/** `redact: [...]` for a command's options, or "" when it reads no env. */
export function redactOption(...texts: ReadonlyArray<unknown>): string {
  const names = lateEnvNamesOf(...texts);
  return names.length > 0 ? `redact: ${JSON.stringify(names)}` : "";
}

const SHELL_BUILTINS = new Set([
  ".",
  ":",
  "[",
  "alias",
  "bg",
  "cd",
  "command",
  "eval",
  "exec",
  "exit",
  "export",
  "fg",
  "read",
  "readonly",
  "set",
  "shift",
  "source",
  "test",
  "times",
  "trap",
  "type",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]);
