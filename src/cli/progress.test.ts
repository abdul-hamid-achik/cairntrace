import { afterEach, describe, expect, it } from "vitest";
import {
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
    expect(text).toContain("outcome processed verifying…");
    expect(text).toContain("outcome processed failed");
    expect(text).toContain("expected: status=done");
    // Plain is a designed sequential format, not tty minus colors: no cursor
    // or color control codes may ever appear.
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\x1b\[/);
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] /);
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

  it("auto follows stdout TTY-ness, with CAIRN_FORCE_TTY as a tty vote", () => {
    delete process.env.CAIRN_FORCE_TTY;
    delete process.env.CAIRN_PROGRESS;
    expect(resolveProgressMode(undefined)).toBe(
      process.stdout.isTTY ? "tty" : "plain",
    );
    process.env.CAIRN_FORCE_TTY = "1";
    expect(resolveProgressMode(undefined)).toBe("tty");
    // CAIRN_PROGRESS is the modern, explicit axis — it outranks the old
    // escape hatch.
    process.env.CAIRN_PROGRESS = "plain";
    expect(resolveProgressMode(undefined)).toBe("plain");
  });
});
