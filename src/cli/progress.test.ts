import { describe, expect, it } from "vitest";
import { summarizeStepError } from "./progress";

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
