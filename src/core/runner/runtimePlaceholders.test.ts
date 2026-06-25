import { describe, expect, it } from "vitest";
import {
  collectUnresolvedRuntimeRefs,
  deepMapStrings,
  resolveEvalPlaceholders,
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

describe("resolveEvalPlaceholders", () => {
  const evals = {
    state: { value: { count: 5, items: [{ id: "a" }], nested: { x: 1 } } },
  };

  it("resolves dotted paths into the eval value envelope", () => {
    expect(resolveEvalPlaceholders("${evals.state.value.count}", evals)).toBe(
      "5",
    );
    expect(
      resolveEvalPlaceholders("${evals.state.value.items.0.id}", evals),
    ).toBe("a");
  });

  it("renders objects as JSON", () => {
    expect(resolveEvalPlaceholders("${evals.state.value.nested}", evals)).toBe(
      '{"x":1}',
    );
  });

  it("renders unknown names and missing paths as empty string", () => {
    expect(resolveEvalPlaceholders("${evals.nope.value}", evals)).toBe("");
    expect(resolveEvalPlaceholders("${evals.state.value.missing}", evals)).toBe(
      "",
    );
  });

  it("substitutes inside larger strings", () => {
    expect(
      resolveEvalPlaceholders("Count: ${evals.state.value.count}", evals),
    ).toBe("Count: 5");
  });
});

describe("collectUnresolvedRuntimeRefs", () => {
  const artifacts = {
    template: {
      kind: "download" as const,
      path: "/runs/x/downloads/template.xlsx",
      relativePath: "downloads/template.xlsx",
    },
  };

  it("reports artifact refs that were never produced, anywhere in the value", () => {
    const verifier = {
      xlsx: { path: "${artifacts.missing.path}", sheets: [{ name: "Data" }] },
    };
    expect(collectUnresolvedRuntimeRefs(verifier, artifacts)).toEqual([
      "artifacts.missing",
    ]);
  });

  it("is empty when all refs resolve", () => {
    const verifier = {
      script: { fixtures: { templatePath: "${artifacts.template.path}" } },
    };
    expect(collectUnresolvedRuntimeRefs(verifier, artifacts)).toEqual([]);
  });

  it("reports request refs missing from captured responses", () => {
    const verifier = {
      script: { fixtures: { token: "${requests.auth.body.token}" } },
    };
    expect(collectUnresolvedRuntimeRefs(verifier, artifacts, {})).toEqual([
      "requests.auth",
    ]);
    expect(
      collectUnresolvedRuntimeRefs(verifier, artifacts, { auth: { body: {} } }),
    ).toEqual([]);
  });

  it("reports eval refs missing from captured eval values", () => {
    const verifier = {
      script: { fixtures: { count: "${evals.state.value.count}" } },
    };
    expect(collectUnresolvedRuntimeRefs(verifier, artifacts, {}, {})).toEqual([
      "evals.state",
    ]);
    expect(
      collectUnresolvedRuntimeRefs(
        verifier,
        artifacts,
        {},
        {
          state: { value: { count: 5 } },
        },
      ),
    ).toEqual([]);
  });

  it("dedupes repeated references to the same missing name", () => {
    const verifier = {
      xlsx: { path: "${artifacts.gone.path}" },
      note: "${artifacts.gone.relativePath}",
    };
    expect(collectUnresolvedRuntimeRefs(verifier, {})).toEqual([
      "artifacts.gone",
    ]);
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
