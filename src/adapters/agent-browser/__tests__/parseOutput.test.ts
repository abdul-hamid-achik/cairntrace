import { describe, expect, it } from "vitest";
import {
  buildGlobalArgs,
  parseBoxEnvelope,
  parseEnvelope,
  parseJsonArray,
  parseViewportMetrics,
  quoteIfNeeded,
} from "../parseOutput";

describe("parseEnvelope", () => {
  it("extracts the named array out of the {success, data} envelope", () => {
    const stdout = JSON.stringify({
      success: true,
      data: { requests: [{ url: "/a" }, { url: "/b" }] },
      error: null,
    });
    expect(parseEnvelope<{ url: string }>(stdout, "requests")).toEqual([
      { url: "/a" },
      { url: "/b" },
    ]);
  });

  // These four previously returned [] "so verifiers never crash". Crashing is
  // the correct outcome: every caller feeds an absence-shaped verifier
  // (console.errorsMax, noFailedRequests) that reads an empty set as a PASS, so
  // [] certified a page nobody read as healthy. A real empty result arrives as
  // {"data":{"messages":[]}} — the key is always present — so none of the
  // shapes below can occur on a successful read.
  it("throws for empty stdout — a successful --json read always emits an envelope", () => {
    expect(() => parseEnvelope("", "requests")).toThrow(/got empty output/);
    expect(() => parseEnvelope("   \n\t  ", "requests")).toThrow(
      /got empty output/,
    );
  });

  it("throws on JSON parse failure rather than reporting an empty result", () => {
    expect(() => parseEnvelope("not json", "requests")).toThrow(
      /could not parse the JSON envelope for "requests"/,
    );
    expect(() => parseEnvelope('{"truncated', "requests")).toThrow(
      /could not parse the JSON envelope for "requests"/,
    );
  });

  it("throws when the inner key is missing", () => {
    expect(() =>
      parseEnvelope('{"success":true,"data":{}}', "requests"),
    ).toThrow(/has no "requests" array/);
    expect(() =>
      parseEnvelope('{"success":true,"data":{"messages":[]}}', "requests"),
    ).toThrow(/has no "requests" array/);
  });

  it("throws when the envelope value is not an array", () => {
    expect(() =>
      parseEnvelope('{"data":{"requests":"oops"}}', "requests"),
    ).toThrow(/has no "requests" array/);
    expect(() =>
      parseEnvelope('{"data":{"requests":null}}', "requests"),
    ).toThrow(/has no "requests" array/);
  });

  it("still returns [] for a genuinely empty result set", () => {
    expect(
      parseEnvelope('{"success":true,"data":{"requests":[]}}', "requests"),
    ).toEqual([]);
  });

  it("works for the console envelope key", () => {
    const stdout = JSON.stringify({
      data: {
        messages: [
          { type: "log", text: "hi" },
          { type: "error", text: "boom" },
        ],
      },
    });
    const msgs = parseEnvelope<{ type: string; text: string }>(
      stdout,
      "messages",
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.type).toBe("error");
  });
});

describe("parseJsonArray", () => {
  it("parses a bare JSON array", () => {
    expect(parseJsonArray("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("returns [] on non-array JSON", () => {
    expect(parseJsonArray('{"not":"an array"}')).toEqual([]);
  });

  it("returns [] on empty or malformed input", () => {
    expect(parseJsonArray("")).toEqual([]);
    expect(parseJsonArray("not json")).toEqual([]);
  });
});

describe("buildGlobalArgs", () => {
  it("emits no flags for the default options", () => {
    expect(buildGlobalArgs({ session: "x" })).toEqual([]);
  });

  it("emits each flag in the documented order", () => {
    const args = buildGlobalArgs({
      session: "x",
      headed: true,
      profile: "/p",
      initialStatePath: "/s.json",
      screenshotDir: "/shots",
      maxOutput: 4096,
      debug: true,
      extraGlobalArgs: ["--proxy", "http://x"],
    });
    expect(args).toEqual([
      "--headed",
      "--profile",
      "/p",
      "--state",
      "/s.json",
      "--screenshot-dir",
      "/shots",
      "--max-output",
      "4096",
      "--debug",
      "--proxy",
      "http://x",
    ]);
  });

  it("skips falsy headed/debug", () => {
    expect(
      buildGlobalArgs({ session: "x", headed: false, debug: false }),
    ).toEqual([]);
  });

  it("emits provider and device flags for iOS/cloud providers", () => {
    expect(
      buildGlobalArgs({
        session: "x",
        provider: "ios",
        device: "iPhone 15 Pro",
      }),
    ).toEqual(["-p", "ios", "--device", "iPhone 15 Pro"]);
  });

  it("emits --idle-timeout when idleTimeoutMs is a number, including 0", () => {
    expect(buildGlobalArgs({ session: "x", idleTimeoutMs: 0 })).toEqual([
      "--idle-timeout",
      "0",
    ]);
    expect(buildGlobalArgs({ session: "x", idleTimeoutMs: 3_600_000 })).toEqual(
      ["--idle-timeout", "3600000"],
    );
  });
});

describe("parseBoxEnvelope", () => {
  it("extracts x/y/width/height from a `get box --json` envelope", () => {
    const stdout = JSON.stringify({
      success: true,
      data: { x: 1184.5, y: 2358.8, width: 80.4, height: 42 },
      error: null,
    });
    expect(parseBoxEnvelope(stdout)).toEqual({
      x: 1184.5,
      y: 2358.8,
      width: 80.4,
      height: 42,
    });
  });

  it("returns undefined for empty, malformed, or incomplete output", () => {
    expect(parseBoxEnvelope("")).toBeUndefined();
    expect(parseBoxEnvelope("not json")).toBeUndefined();
    expect(
      parseBoxEnvelope(
        JSON.stringify({ success: false, data: null, error: "boom" }),
      ),
    ).toBeUndefined();
    expect(
      parseBoxEnvelope(JSON.stringify({ success: true, data: { x: 1 } })),
    ).toBeUndefined();
  });
});

describe("parseViewportMetrics", () => {
  it("extracts scroll/inner dimensions from an `eval ... --json` envelope", () => {
    const stdout = JSON.stringify({
      success: true,
      data: {
        origin: "http://example.test",
        result: { scrollX: 0, scrollY: 0, innerWidth: 1280, innerHeight: 577 },
      },
      error: null,
    });
    expect(parseViewportMetrics(stdout)).toEqual({
      scrollX: 0,
      scrollY: 0,
      innerWidth: 1280,
      innerHeight: 577,
    });
  });

  it("returns undefined for empty, malformed, or incomplete output", () => {
    expect(parseViewportMetrics("")).toBeUndefined();
    expect(parseViewportMetrics("not json")).toBeUndefined();
    expect(
      parseViewportMetrics(JSON.stringify({ success: true, data: {} })),
    ).toBeUndefined();
    expect(
      parseViewportMetrics(
        JSON.stringify({
          success: true,
          data: { result: { innerWidth: 1280 } },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("quoteIfNeeded", () => {
  it("passes plain tokens through unchanged", () => {
    expect(quoteIfNeeded("open")).toBe("open");
    expect(quoteIfNeeded("/path/with-no-spaces.txt")).toBe(
      "/path/with-no-spaces.txt",
    );
  });

  it("quotes tokens with whitespace", () => {
    expect(quoteIfNeeded("hello world")).toBe('"hello world"');
  });

  it("escapes embedded double quotes", () => {
    expect(quoteIfNeeded('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("escapes embedded backslashes", () => {
    expect(quoteIfNeeded("c:\\path\\file")).toBe('"c:\\\\path\\\\file"');
  });

  it("quotes tokens that are just a quote (regression: empty inside)", () => {
    expect(quoteIfNeeded('"')).toBe('"\\""');
  });
});
