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

  it("returns [] for empty stdout", () => {
    expect(parseEnvelope("", "requests")).toEqual([]);
    expect(parseEnvelope("   \n\t  ", "requests")).toEqual([]);
  });

  it("returns [] on JSON parse failure (don't crash verifiers)", () => {
    expect(parseEnvelope("not json", "requests")).toEqual([]);
    expect(parseEnvelope('{"truncated', "requests")).toEqual([]);
  });

  it("returns [] when the inner key is missing", () => {
    expect(parseEnvelope('{"success":true,"data":{}}', "requests")).toEqual([]);
    expect(
      parseEnvelope('{"success":true,"data":{"messages":[]}}', "requests"),
    ).toEqual([]);
  });

  it("returns [] when the envelope value is not an array (defensive)", () => {
    expect(parseEnvelope('{"data":{"requests":"oops"}}', "requests")).toEqual(
      [],
    );
    expect(parseEnvelope('{"data":{"requests":null}}', "requests")).toEqual([]);
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
