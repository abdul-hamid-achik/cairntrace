import { describe, expect, it } from "vitest";
import { clipPointsToLabels, parseClipLabel } from "./vidtraceClip";

describe("parseClipLabel", () => {
  it("parses simple second ranges", () => {
    const parsed = parseClipLabel("issue=10-20");
    expect(parsed).toEqual({ label: "issue", start: "10", end: "20" });
  });

  it("parses minute ranges", () => {
    const parsed = parseClipLabel("blank-row=0:18-3:40");
    expect(parsed).toEqual({ label: "blank-row", start: "0:18", end: "3:40" });
  });

  it("parses hour ranges", () => {
    const parsed = parseClipLabel("long=1:02:30-1:04:15");
    expect(parsed).toEqual({ label: "long", start: "1:02:30", end: "1:04:15" });
  });

  it("trims whitespace around label", () => {
    const parsed = parseClipLabel("  issue  =10-20");
    expect(parsed?.label).toBe("issue");
  });

  it("returns undefined for invalid formats", () => {
    expect(parseClipLabel("no-equals")).toBeUndefined();
    expect(parseClipLabel("no-separator")).toBeUndefined();
    expect(parseClipLabel("issue=10")).toBeUndefined();
    expect(parseClipLabel("issue=abc-def")).toBeUndefined();
  });
});

describe("clipPointsToLabels", () => {
  it("converts clip points to vidtrace labels", () => {
    const labels = clipPointsToLabels([
      { label: "a", start: "0:10", end: "0:20" },
      { label: "b", start: "1:05", end: "1:12" },
    ]);
    expect(labels).toEqual([
      { label: "a", start: "0:10", end: "0:20" },
      { label: "b", start: "1:05", end: "1:12" },
    ]);
  });
});
