import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  log,
  configureLoggerFromFlags,
  reconfigureWithConfig,
  resolveLogConfig,
  setProgressMarkerActive,
} from "./logger";

/**
 * Capture process.stderr.write output for assertions. The logger always
 * writes to stderr; stdout must stay clean (reserved for results).
 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  const spy = vi.fn((chunk: string) => {
    lines.push(chunk);
    return true;
  });
  const replaced = process.stderr.write;
  process.stderr.write = spy as unknown as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = replaced;
      void original;
    },
  };
}

describe("logger levels + format", () => {
  let cap: { lines: string[]; restore: () => void };

  beforeEach(() => {
    cap = captureStderr();
    delete process.env.NO_COLOR;
    configureLoggerFromFlags({ logLevel: "debug", color: false });
  });

  afterEach(() => {
    cap.restore();
  });

  it("emits info/warn/error lines to stderr (human format)", () => {
    log.info("starting", { phase: "docker" });
    log.warn("slow", { ms: 5000 });
    log.error("boom");
    const out = cap.lines.join("");
    expect(out).toContain("info");
    expect(out).toContain("starting");
    expect(out).toContain("phase=docker");
    expect(out).toContain("warn");
    expect(out).toContain("slow");
    expect(out).toContain("ms=5000");
    expect(out).toContain("error");
    expect(out).toContain("boom");
  });

  it("suppresses levels below the configured threshold", () => {
    configureLoggerFromFlags({ logLevel: "warn", color: false });
    log.debug("hidden-debug");
    log.info("hidden-info");
    log.warn("shown-warn");
    const out = cap.lines.join("");
    expect(out).not.toContain("hidden-debug");
    expect(out).not.toContain("hidden-info");
    expect(out).toContain("shown-warn");
  });

  it("silent emits nothing", () => {
    configureLoggerFromFlags({ logLevel: "silent", color: false });
    log.error("quiet");
    expect(cap.lines.join("")).toBe("");
  });

  it("clears the tty progress marker line before each write", () => {
    // While the tty renderer's live marker is in flight (setProgressMarkerActive),
    // every logger write must retire the marker line first (`\r` + clear-EOL)
    // so the log line lands clean instead of being overwritten by the next
    // spinner redraw. No stray ANSI when color is off.
    configureLoggerFromFlags({ logLevel: "debug", color: false });
    setProgressMarkerActive(true);
    try {
      log.info("mid-step", { wait: "open_page" });
    } finally {
      setProgressMarkerActive(false);
    }
    const line = cap.lines.join("");
    expect(line.startsWith("\r")).toBe(true);
    expect(line).not.toContain("\x1b[");
    expect(line).toContain("mid-step");
    expect(line).toContain("wait=open_page");

    // With color on, the marker line is cleared with a real clear-EOL.
    // The flag from beforeEach (color: false) must be dropped first — flags
    // outrank config — then config.color forces color even in a non-TTY
    // test runner.
    configureLoggerFromFlags({ logLevel: "debug" });
    reconfigureWithConfig({ color: true });
    setProgressMarkerActive(true);
    try {
      log.info("colored");
    } finally {
      setProgressMarkerActive(false);
    }
    const colored = cap.lines.join("");
    expect(colored).toContain("\r\x1b[K");
  });

  it("writes clean lines when no marker is active", () => {
    configureLoggerFromFlags({ logLevel: "debug", color: false });
    log.info("idle");
    expect(cap.lines.join("").startsWith("\r")).toBe(false);
  });

  it("emits NDJSON objects in json format", () => {
    configureLoggerFromFlags({
      logLevel: "info",
      logFormat: "json",
      color: false,
    });
    log.scope("services").info("docker ready", { exitCode: 0 });
    const line = cap.lines[0]!;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.scope).toBe("services");
    expect(parsed.msg).toBe("docker ready");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("raw() streams unformatted chunks only at info or below", () => {
    configureLoggerFromFlags({ logLevel: "info", color: false });
    log.raw("Container mongo Started\n");
    expect(cap.lines.join("")).toContain("Container mongo Started");

    configureLoggerFromFlags({ logLevel: "warn", color: false });
    cap.lines.length = 0;
    log.raw("should be hidden\n");
    expect(cap.lines.join("")).toBe("");
  });

  it("raw() colorizes error/warn/success lines when color is on", () => {
    configureLoggerFromFlags({ logLevel: "info" });
    reconfigureWithConfig({ color: true }); // config.color forces color on (non-TTY)
    log.raw("Error: something failed\n");
    log.raw("Warning: deprecated api\n");
    log.raw("Listening on port 9003\n");
    log.raw("plain line\n");
    const out = cap.lines.join("");
    expect(out).toContain("\x1b[31mError: something failed"); // red
    expect(out).toContain("\x1b[33mWarning: deprecated api"); // yellow
    expect(out).toContain("\x1b[32mListening on port 9003"); // green
    expect(out).toContain("plain line");
    expect(out).not.toContain("\x1b[31mplain line");
  });

  it("human format renders level icons", () => {
    configureLoggerFromFlags({ logLevel: "debug", color: false });
    log.warn("watch out");
    log.error("nope");
    log.info("hi");
    const out = cap.lines.join("");
    expect(out).toContain("⚠");
    expect(out).toContain("✗");
    expect(out).toContain("›");
  });

  it("scope() prefixes messages and nests scopes", () => {
    configureLoggerFromFlags({
      logLevel: "info",
      logFormat: "json",
      color: false,
    });
    log.scope("services").scope("docker").info("ready");
    const parsed = JSON.parse(cap.lines[0]!);
    expect(parsed.scope).toBe("services:docker");
  });

  it("scoped loggers created before configure observe later options", () => {
    configureLoggerFromFlags({ logLevel: "info", color: false });
    const early = log.scope("early");

    configureLoggerFromFlags({
      logLevel: "error",
      logFormat: "json",
      color: false,
    });
    early.warn("hidden");
    early.error("visible");

    expect(cap.lines).toHaveLength(1);
    expect(JSON.parse(cap.lines[0]!)).toMatchObject({
      scope: "early",
      level: "error",
      msg: "visible",
    });
  });
});

describe("resolveLogConfig", () => {
  beforeEach(() => {
    // Make env deterministic.
    delete process.env.CAIRN_LOG_LEVEL;
    delete process.env.CAIRN_LOG_FORMAT;
    delete process.env.NO_COLOR;
  });

  it("flag --log-level wins over config and defaults", () => {
    const opts = resolveLogConfig({
      logLevel: "error",
      config: { level: "debug" },
    });
    expect(opts.level).toBe("error");
  });

  it("--verbose forces debug, overriding config", () => {
    const opts = resolveLogConfig({ verbose: true, config: { level: "warn" } });
    expect(opts.level).toBe("debug");
  });

  it("--quiet forces warn", () => {
    const opts = resolveLogConfig({ quiet: true });
    expect(opts.level).toBe("warn");
  });

  it("config level applies when no flag/env set", () => {
    const opts = resolveLogConfig({ config: { level: "error" } });
    expect(opts.level).toBe("error");
  });

  it("env CAIRN_LOG_LEVEL overrides config", () => {
    process.env.CAIRN_LOG_LEVEL = "error";
    const opts = resolveLogConfig({ config: { level: "debug" } });
    expect(opts.level).toBe("error");
  });

  it("--no-color (color: false) disables color", () => {
    const opts = resolveLogConfig({ color: false });
    expect(opts.color).toBe(false);
  });

  it("NO_COLOR env disables color even if config says true", () => {
    process.env.NO_COLOR = "1";
    const opts = resolveLogConfig({ config: { color: true } });
    expect(opts.color).toBe(false);
  });

  it("--log-format json wins over config human", () => {
    const opts = resolveLogConfig({
      logFormat: "json",
      config: { format: "human" },
    });
    expect(opts.format).toBe("json");
  });
});

describe("reconfigureWithConfig", () => {
  it("merges config under captured flags (flags still win)", () => {
    configureLoggerFromFlags({ logLevel: "error", color: false });
    // A later-loaded config sets format=json — no flag set it, so it applies.
    reconfigureWithConfig({ format: "json" });
    expect(log.format).toBe("json");
    // But the flag-captured level wins over the config level.
    expect(log.level).toBe("error");

    // If no flag captured a level, config level applies.
    configureLoggerFromFlags({ color: false });
    reconfigureWithConfig({ level: "debug" });
    expect(log.level).toBe("debug");
  });
});
