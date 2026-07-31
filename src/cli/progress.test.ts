import { afterEach, describe, expect, it } from "vitest";
import {
  clackLine,
  completionMark,
  makeInteractiveListener,
  makePlainListener,
  resolveProgressMode,
  summarizeStepError,
} from "./progress";

describe("summarizeStepError", () => {
  it("keeps the first three accessible-name candidates for ambiguity", () => {
    const rendered = summarizeStepError(
      [
        'ambiguous role=button name="RESERVAR" for click: 70 visible matches',
        '  - button "09:00 RESERVAR" ref=e1',
        '  - button "10:00 RESERVAR" ref=e2',
        '  - button "11:00 RESERVAR" ref=e3',
        '  - button "12:00 RESERVAR" ref=e4',
        '  - button "13:00 RESERVAR" ref=e5',
        "disambiguate with `nth: <index>`",
      ].join("\n"),
    );

    expect(rendered).toEqual([
      'ambiguous role=button name="RESERVAR" for click: 70 visible matches',
      '  - button "09:00 RESERVAR" ref=e1',
      '  - button "10:00 RESERVAR" ref=e2',
      '  - button "11:00 RESERVAR" ref=e3',
      "  …and 67 more",
    ]);
    expect(rendered.join("\n")).not.toContain("12:00");
  });

  it("retains the existing bounded rendering for ordinary errors", () => {
    const rendered = summarizeStepError("x".repeat(250));
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveLength(200);
    expect(rendered[0]!.endsWith("…")).toBe(true);
  });
});

describe("makePlainListener", () => {
  it("renders timestamped, control-code-free milestone lines", () => {
    const lines: string[] = [];
    const listener = makePlainListener({ write: (s) => lines.push(s) });
    listener.onPreconditionStart?.("quiesce", 1_800_000);
    listener.onPreconditionFinish?.("quiesce", 0, 754_000);
    listener.onStepFinish?.(0, "edit_website", "passed", 4_100, undefined);
    listener.onStepStart?.(
      1,
      { when: "notText:Headquarters", open: "/x" } as never,
      "reload_page",
    );
    listener.onStepFinish?.(1, "reload_page", "skipped", 13, undefined);
    listener.onOutcomeStart?.({ id: "processed" } as never);
    listener.onOutcomeFinish?.({ id: "processed" } as never, {
      passed: false,
      expected: "status=done",
      actual: "status=pending",
    } as never);

    const text = lines.join("");
    expect(text).toContain("precondition quiesce started (budget 30m 0s)");
    expect(text).toContain("precondition quiesce ok 12m 34s");
    expect(text).toContain("step edit_website passed 4.1s");
    // A skip must name its gate: "(skipped by when:)" read as a glitch.
    expect(text).toContain(
      'step reload_page skipped (when "notText:Headquarters" not met) 13ms',
    );
    expect(text).toContain("outcome processed verifying…");
    expect(text).toContain("outcome processed failed");
    expect(text).toContain("expected: status=done");
    // Plain is a designed sequential format, not tty minus colors: no cursor
    // or color control codes may ever appear.
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[/);
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] /);
  });

  it("renders precondition timeouts explicitly in plain and TTY modes", () => {
    const plainLines: string[] = [];
    const plain = makePlainListener({ write: (s) => plainLines.push(s) });
    plain.onPreconditionFinish?.("readiness_gate", undefined, 1_250, {
      timedOut: true,
      signal: "SIGTERM",
    });

    const ttyLines: string[] = [];
    const tty = makeInteractiveListener({ color: false });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      ttyLines.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      tty.onPreconditionFinish?.("readiness_gate", undefined, 1_250, {
        timedOut: true,
        signal: "SIGTERM",
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    for (const text of [plainLines.join(""), ttyLines.join("")]) {
      expect(text).toContain(
        "precondition readiness_gate timed out (SIGTERM) 1.3s",
      );
      expect(text).not.toContain("exit undefined");
    }
    // The interactive renderer honors `color: false`: no ANSI may leak even
    // though clack hardcodes its own marks — symbols go through the palette.
    // eslint-disable-next-line no-control-regex
    expect(ttyLines.join("")).not.toMatch(/\x1b\[/);
  });
});

describe("onRunStart env header", () => {
  // Regression: the header used to render `spec.environment` — the spec's
  // own unresolved default — even when `--env` overrode it, so `cairn run
  // spec.yml --env do` still printed `(env=local, ...)`. It must show the
  // environment the run actually resolved to (Runner.ts passes it as the
  // 5th onRunStart argument), independent of what the spec itself declares.
  const spec = { name: "answer_change", environment: "local" } as never;

  it("plain listener: shows the resolved environment, not spec.environment", () => {
    const lines: string[] = [];
    const listener = makePlainListener({ write: (s) => lines.push(s) });
    listener.onRunStart?.(spec, "run_1", "/tmp/run_1", "agent-browser", "do");
    const text = lines.join("");
    expect(text).toContain(
      "run start: answer_change (env=do, backend=agent-browser)",
    );
    expect(text).not.toContain("env=local");
  });

  it("interactive listener: shows the resolved environment, not spec.environment", () => {
    const written: string[] = [];
    const listener = makeInteractiveListener({ color: false });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      listener.onRunStart?.(spec, "run_1", "/tmp/run_1", "agent-browser", "do");
    } finally {
      process.stderr.write = originalWrite;
    }
    const text = written.join("");
    expect(text).toContain("(env=do, backend=agent-browser)");
    expect(text).not.toContain("env=local");
  });
});

describe("completionMark", () => {
  it("renders the clack glyph family, bare without color", () => {
    // Glyphs follow clack's unicode detection (◆/■/▲ or their ASCII
    // fallbacks on a TERM=linux console) — assert the color contract, not
    // the exact glyph.
    const esc = "\u001b[";
    expect(completionMark("passed", false)).not.toContain(esc);
    expect(completionMark("failed", false)).not.toContain(esc);
    expect(completionMark("errored", false)).not.toContain(esc);
    expect(completionMark("passed", true)).toContain(esc);
    expect(completionMark("failed", true)).toContain(esc);
    expect(completionMark("errored", true)).toContain(esc);
  });
});

describe("clackLine", () => {
  it("renders symbol + 2 spaces + text to stderr", () => {
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      clackLine("◆", "Saved checkpoint x → /tmp/x.json");
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(written.join("")).toContain("◆  Saved checkpoint x → /tmp/x.json");
  });
});

describe("resolveProgressMode", () => {
  const saved = {
    force: process.env.CAIRN_FORCE_TTY,
    mode: process.env.CAIRN_PROGRESS,
  };
  afterEach(() => {
    if (saved.force === undefined) delete process.env.CAIRN_FORCE_TTY;
    else process.env.CAIRN_FORCE_TTY = saved.force;
    if (saved.mode === undefined) delete process.env.CAIRN_PROGRESS;
    else process.env.CAIRN_PROGRESS = saved.mode;
  });

  it("honours an explicit flag over everything", () => {
    process.env.CAIRN_FORCE_TTY = "1";
    expect(resolveProgressMode("plain")).toBe("plain");
    expect(resolveProgressMode("tty")).toBe("tty");
  });

  it("rejects unknown modes loudly", () => {
    expect(() => resolveProgressMode("fancy")).toThrow(/auto\|tty\|plain/);
  });

  it("auto follows stderr TTY-ness, with CAIRN_FORCE_TTY as a tty vote", () => {
    delete process.env.CAIRN_FORCE_TTY;
    delete process.env.CAIRN_PROGRESS;
    // Progress renders to stderr (stdout stays reserved for structured
    // output), so auto follows the stderr sink — like docker --progress.
    expect(resolveProgressMode(undefined)).toBe(
      process.stderr.isTTY ? "tty" : "plain",
    );
    process.env.CAIRN_FORCE_TTY = "1";
    expect(resolveProgressMode(undefined)).toBe("tty");
    // CAIRN_PROGRESS is the modern, explicit axis — it outranks the old
    // escape hatch.
    process.env.CAIRN_PROGRESS = "plain";
    expect(resolveProgressMode(undefined)).toBe("plain");
  });
});
