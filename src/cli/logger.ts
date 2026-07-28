/**
 * Cairntrace logging library.
 *
 * One leveled, format-aware logger for all CLI diagnostic/lifecycle output.
 * Contract: logs ALWAYS go to stderr — stdout is reserved for structured
 * results (JSON/YAML/markdown via `emit()`). This fixes the prior mess where
 * interactive progress and stray notices landed on stdout.
 *
 * Levels: debug < info < warn < error < silent. `raw()` is an unformatted
 * passthrough for live subprocess output (docker/seed streaming) — shown when
 * level <= info, so `--quiet` suppresses it.
 *
 * Format: `human` (colored, scoped, one line) or `json` (one NDJSON object per
 * line for machine/CI consumption). Color is disabled by NO_COLOR, `--no-color`,
 * non-TTY, or `logging.color: false` in config.
 *
 * Configured once at CLI boot via `configureLoggerFromFlags()` from resolved
 * `LoggingConfig` (config block + CLI flags + env). The `log` singleton is
 * imported across the CLI layer; the runner core stays logger-free (it talks
 * via injected `ctx.log`/`onOutput` callbacks that the CLI wires to this logger).
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "human" | "json";

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  color: boolean;
}

export interface LoggingConfig {
  level?: LogLevel;
  format?: LogFormat;
  color?: boolean;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
  silent: "",
};

// Scannable level indicators (rendered before the tag in human format).
const LEVEL_ICON: Record<LogLevel, string> = {
  debug: "·",
  info: "›",
  warn: "⚠",
  error: "✗",
  silent: "",
};

/* ----- ANSI color theme (centralized; replaces scattered escape literals) ----- */

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function levelColor(level: LogLevel): string {
  switch (level) {
    case "error":
      return C.red;
    case "warn":
      return C.yellow;
    case "debug":
      return C.dim;
    default:
      return "";
  }
}

/**
 * Heuristic colorization for live subprocess output (docker/seed/tmux panes):
 * error-ish lines red, warning-ish lines yellow, success-ish lines green.
 * Conservative keyword match — only obvious signals are colored. When color
 * is off, the line is returned unchanged.
 */
function colorizeRaw(line: string, color: boolean): string {
  if (!color || line === "") return line;
  if (
    /\b(error|failed|failure|fatal|cannot|undefined|exception|throw)\b/i.test(
      line,
    )
  ) {
    return `${C.red}${line}${C.reset}`;
  }
  if (/\b(warn(ing)?|deprecated)\b/i.test(line)) {
    return `${C.yellow}${line}${C.reset}`;
  }
  if (
    /\b(listening|ready|connected|started|compiled|done in|✓|success)\b/i.test(
      line,
    )
  ) {
    return `${C.green}${line}${C.reset}`;
  }
  return line;
}

/** Render structured fields as ` dim key=value` pairs, JSON-stringified values. */
function renderFields(
  fields: Record<string, unknown> | undefined,
  color: boolean,
): string {
  if (!fields) return "";
  const entries = Object.entries(fields);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => {
    const val = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
    return color ? `${C.dim}${k}=${val}${C.reset}` : `${k}=${val}`;
  });
  return "  " + parts.join(color ? ` ${C.reset}${C.dim}` : " ");
}

class Logger {
  private opts: LoggerOptions = {
    level: "warn",
    format: "human",
    color: false,
  };
  private scopeName = "";

  constructor(scopeName = "") {
    this.scopeName = scopeName;
  }

  configure(opts: LoggerOptions): void {
    // Scoped loggers share this options object. Mutate it in place so children
    // created at module-import time (runLog/cleanLog) observe the later CLI and
    // project-config resolution instead of staying stuck on the defaults.
    Object.assign(this.opts, opts);
  }

  /** Create a scoped child logger (prefixes lines/JSON with the scope name). */
  scope(name: string): Logger {
    const child = new Logger(
      this.scopeName ? `${this.scopeName}:${name}` : name,
    );
    child.opts = this.opts;
    return child;
  }

  get level(): LogLevel {
    return this.opts.level;
  }

  get format(): LogFormat {
    return this.opts.format;
  }

  private visible(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.opts.level];
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write("debug", msg, fields);
  }

  get color(): boolean {
    return this.opts.color;
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write("info", msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write("warn", msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write("error", msg, fields);
  }

  /**
   * Passthrough for live subprocess output (docker/seed/tmux pane streaming).
   * Shown when level <= info; suppressed by `--quiet`/warn+. When color is on,
   * lines are heuristically colorized (errors red, warnings yellow, success
   * green) so a streaming build/startup tail is scannable at a glance. The
   * content is otherwise the child's own output — no level tags/timestamps.
   */
  raw(chunk: string): void {
    if (LEVEL_WEIGHT[this.opts.level] > LEVEL_WEIGHT.info) return;
    if (!this.opts.color) {
      process.stderr.write(chunk);
      return;
    }
    process.stderr.write(
      chunk
        .split("\n")
        .map((l) => colorizeRaw(l, this.opts.color))
        .join("\n"),
    );
  }

  private write(
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void {
    if (!this.visible(level)) return;
    if (this.opts.format === "json") {
      this.writeJson(level, msg, fields);
    } else {
      this.writeHuman(level, msg, fields);
    }
  }

  private writeHuman(
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> | undefined,
  ): void {
    const color = this.opts.color;
    const icon = LEVEL_ICON[level];
    const tag = LEVEL_TAG[level];
    const iconStr = color ? `${levelColor(level)}${icon}${C.reset}` : icon;
    const tagStr = color ? `${levelColor(level)}${tag}${C.reset}` : tag;
    const scopeStr = this.scopeName
      ? color
        ? `${C.dim}${this.scopeName}${C.reset} `
        : `${this.scopeName} `
      : "";
    const line = `${scopeStr}${iconStr} ${tagStr} ${msg}${renderFields(fields, color)}`;
    process.stderr.write(line + "\n");
  }

  private writeJson(
    level: LogLevel,
    msg: string,
    fields: Record<string, unknown> | undefined,
  ): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      ...fields,
      ...(this.scopeName ? { scope: this.scopeName } : {}),
      msg,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }
}

/** The singleton logger. Configure once at CLI boot via `configureLoggerFromFlags()`. */
export const log = new Logger();

interface RawLogFlags {
  logLevel?: string;
  logFormat?: string;
  quiet?: boolean;
  verbose?: boolean;
  /** `false` when `--no-color` was passed; `undefined` when not specified. */
  color?: boolean;
}

let rawFlags: RawLogFlags = {};
let lastConfig: LoggingConfig | undefined;
let narrationActive = false;

/**
 * Store the CLI flags and configure the logger from flags + env (no config).
 * Called once at CLI boot from the commander `preAction` hook. The stored
 * flags are reused by `reconfigureWithConfig()` so a later-loaded config
 * block can set defaults that the flags still override.
 */
export function configureLoggerFromFlags(flags: RawLogFlags): void {
  rawFlags = flags;
  log.configure(resolveLogConfig(flags));
}

/**
 * Re-resolve the logger with a loaded `logging` config block. Flags + env
 * (captured by `configureLoggerFromFlags`) still win over the config; the
 * config only fills fields neither flags nor env set. Called by commands
 * that load cairntrace.config.yml (run, clean, …) after their config load.
 */
export function reconfigureWithConfig(config: LoggingConfig | undefined): void {
  lastConfig = config;
  log.configure(
    resolveLogConfig({
      ...rawFlags,
      ...(lastConfig ? { config: lastConfig } : {}),
    }),
  );
}

/**
 * Progress narration (`cairn run` in md format) raises the DEFAULT level
 * floor to info: milestone lines (services ready, seed skipped) are part of
 * the narration and must survive a pipe, where the TTY-derived default would
 * silently drop to warn. Flags, env, and config still win — this only moves
 * the default. Order-independent with reconfigureWithConfig().
 */
export function setNarrationDefault(on: boolean): void {
  narrationActive = on;
  log.configure(
    resolveLogConfig({
      ...rawFlags,
      ...(lastConfig ? { config: lastConfig } : {}),
    }),
  );
}

/**
 * Resolve effective logger options from (highest priority first):
 * CLI flags > env > config block > TTY/CI default.
 */
export function resolveLogConfig(opts: {
  logLevel?: string;
  logFormat?: string;
  quiet?: boolean;
  verbose?: boolean;
  /** `false` when `--no-color` was passed; `undefined` when not specified. */
  color?: boolean;
  config?: LoggingConfig;
}): LoggerOptions {
  const tty = Boolean(process.stderr.isTTY);
  const ci = isCiEnv();

  // Default: info on an interactive TTY, warn otherwise (CI / piped / json).
  // Active narration raises the floor to info regardless of TTY — see
  // setNarrationDefault().
  let level: LogLevel = narrationActive || (tty && !ci) ? "info" : "warn";
  if (opts.config?.level) level = opts.config.level;
  if (opts.verbose) level = "debug";
  if (opts.quiet) level = "warn";
  if (opts.logLevel && isLogLevel(opts.logLevel)) level = opts.logLevel;
  const envLevel = process.env.CAIRN_LOG_LEVEL;
  if (envLevel && isLogLevel(envLevel)) level = envLevel;

  let format: LogFormat = opts.config?.format ?? "human";
  const envFormat = process.env.CAIRN_LOG_FORMAT;
  if (envFormat && isLogFormat(envFormat)) format = envFormat;
  if (opts.logFormat && isLogFormat(opts.logFormat)) format = opts.logFormat;

  // Color: --no-color > NO_COLOR env > config.color > TTY default.
  let color = tty && !ci;
  if (opts.config?.color !== undefined) color = opts.config.color;
  if (process.env.NO_COLOR !== undefined) color = false;
  if (opts.color === false) color = false;

  return { level, format, color };
}

function isCiEnv(): boolean {
  return (
    process.env.CI === "true" ||
    process.env.CI === "1" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.CAIRN_CI === "1"
  );
}

function isLogLevel(v: string): v is LogLevel {
  return (
    v === "debug" ||
    v === "info" ||
    v === "warn" ||
    v === "error" ||
    v === "silent"
  );
}

function isLogFormat(v: string): v is LogFormat {
  return v === "human" || v === "json";
}
