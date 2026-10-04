import { describe, expect, it } from "vitest";
import { sanitizeStashMeta, stashMetaForRun, truncateUtf8 } from "./stash";

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

describe("truncateUtf8", () => {
  it("keeps a value at or under the limit untouched (exact limit included)", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc");
    expect(truncateUtf8("a".repeat(256), 256)).toBe("a".repeat(256));
    expect(truncateUtf8("é".repeat(128), 256)).toBe("é".repeat(128));
    expect(truncateUtf8("", 256)).toBe("");
  });

  it("cuts ASCII at the byte boundary", () => {
    expect(truncateUtf8("a".repeat(300), 256)).toBe("a".repeat(256));
  });

  it("never splits a 2-byte character", () => {
    // 1 + 2 * 128 = 257 bytes: the last "é" would straddle the limit.
    const out = truncateUtf8(`a${"é".repeat(128)}`, 256);
    expect(out).toBe(`a${"é".repeat(127)}`);
    expect(bytes(out)).toBe(255);
  });

  it("never splits a 3-byte character", () => {
    const out = truncateUtf8("検".repeat(150), 256);
    expect(out).toBe("検".repeat(85));
    expect(bytes(out)).toBe(255);
    expect(truncateUtf8("検".repeat(86), 258)).toBe("検".repeat(86));
  });

  it("never splits a 4-byte character or a surrogate pair", () => {
    const out = truncateUtf8("😀".repeat(100), 256);
    expect(out).toBe("😀".repeat(64));
    expect(bytes(out)).toBe(256);
    const odd = truncateUtf8(`ab${"😀".repeat(100)}`, 256);
    expect(odd).toBe(`ab${"😀".repeat(63)}`);
    expect(bytes(odd)).toBe(254);
    // The result is valid UTF-8: it round-trips through a Buffer.
    expect(Buffer.from(odd, "utf8").toString("utf8")).toBe(odd);
    expect(odd).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("keeps a ZWJ emoji sequence's code points whole, never half a code point", () => {
    const family = "👨‍👩‍👧"; // 3 emoji + 2 ZWJ = 3 * 4 + 2 * 3 bytes
    const out = truncateUtf8(family.repeat(40), 256);
    expect(bytes(out)).toBeLessThanOrEqual(256);
    expect(family.repeat(40).startsWith(out)).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("handles a limit of zero and a limit smaller than the first character", () => {
    expect(truncateUtf8("abc", 0)).toBe("");
    expect(truncateUtf8("😀", 3)).toBe("");
  });
});

describe("sanitizeStashMeta", () => {
  it("applies fcheap's key rules and drops reserved keys", () => {
    expect(
      sanitizeStashMeta({
        cairn_version: "3.0.1",
        "Bad-Key": "x",
        "": "x",
        "-lead": "x",
        "has space": "x",
        ["k".repeat(65)]: "x",
        ["k".repeat(64)]: "ok",
        source: "x",
        secrets_found: "0",
        indexed: "true",
        "a.b-c_d9": "ok",
      }),
    ).toEqual({
      cairn_version: "3.0.1",
      ["k".repeat(64)]: "ok",
      "a.b-c_d9": "ok",
    });
  });

  it("strips C0, DEL and C1 control characters (Go's unicode.IsControl)", () => {
    expect(
      sanitizeStashMeta({ spec: "a\u0000b\u001fc\u007fd\u0085e\u009ff" }),
    ).toEqual({ spec: "abcdef" });
    expect(sanitizeStashMeta({ spec: "\u0001\u0002" })).toEqual({});
    // Printable non-ASCII is untouched (U+00A0 is not a control character).
    expect(sanitizeStashMeta({ spec: "a é" })).toEqual({ spec: "a é" });
  });

  it("truncates by bytes and keeps at most 32 entries", () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`k${index}`, "v"]),
    );
    expect(Object.keys(sanitizeStashMeta(many))).toHaveLength(32);
    const out = sanitizeStashMeta({ spec: "検".repeat(150) });
    expect(bytes(out.spec!)).toBe(255);
  });
});

describe("stashMetaForRun", () => {
  it("keeps every value within fcheap's 256-byte limit for multi-byte names", () => {
    const meta = stashMetaForRun({
      runId: "r".repeat(400),
      status: "failed",
      spec: { name: "😀".repeat(200) },
      environment: "検".repeat(200),
      backend: "playwright",
    });
    for (const value of Object.values(meta)) {
      expect(bytes(value)).toBeLessThanOrEqual(256);
    }
    expect(meta.spec).toBe("😀".repeat(64));
    expect(meta.env).toBe("検".repeat(85));
    expect(meta.run_id).toBe("r".repeat(256));
    expect(meta.status).toBe("failed");
    expect(meta.cairn_version).toBeTruthy();
  });
});
