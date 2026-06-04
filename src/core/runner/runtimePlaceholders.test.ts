import { describe, expect, it } from "vitest";
import {
  deepMapStrings,
  resolveResponsePlaceholders,
} from "./runtimePlaceholders";

describe("resolveResponsePlaceholders", () => {
  const responses = {
    qr: {
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      body: { token: "tok-123", items: [{ id: 7 }], nested: { a: "b" } },
    },
  };

  it("resolves dotted paths into the response envelope", () => {
    expect(
      resolveResponsePlaceholders("${requests.qr.body.token}", responses),
    ).toBe("tok-123");
    expect(
      resolveResponsePlaceholders("${requests.qr.status}", responses),
    ).toBe("200");
  });

  it("supports array indices as path segments", () => {
    expect(
      resolveResponsePlaceholders("${requests.qr.body.items.0.id}", responses),
    ).toBe("7");
  });

  it("renders objects as JSON", () => {
    expect(
      resolveResponsePlaceholders("${requests.qr.body.nested}", responses),
    ).toBe('{"a":"b"}');
  });

  it("renders unknown names and missing paths as empty string", () => {
    expect(
      resolveResponsePlaceholders("${requests.nope.body}", responses),
    ).toBe("");
    expect(
      resolveResponsePlaceholders("${requests.qr.body.missing}", responses),
    ).toBe("");
  });

  it("substitutes inside larger strings", () => {
    expect(
      resolveResponsePlaceholders(
        "Bearer ${requests.qr.body.token}",
        responses,
      ),
    ).toBe("Bearer tok-123");
  });
});

describe("deepMapStrings", () => {
  it("maps every string in a nested structure, leaving other types intact", () => {
    const input = {
      a: "x",
      b: 1,
      c: [true, "y", { d: "z", e: null }],
    };
    const out = deepMapStrings(input, (s) => s.toUpperCase());
    expect(out).toEqual({
      a: "X",
      b: 1,
      c: [true, "Y", { d: "Z", e: null }],
    });
  });
});
