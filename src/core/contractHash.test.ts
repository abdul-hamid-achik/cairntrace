import { describe, expect, it } from "vitest";
import { computeContractHash } from "./contractHash";
import type { Outcome } from "./schema/spec.v1";

const outcomeA: Outcome = {
  id: "a",
  description: "description A",
  verify: { text: { contains: "hello" }, region: "page" },
};
const outcomeB: Outcome = {
  id: "b",
  description: "description B",
  verify: { console: { errorsMax: 0 } },
};

describe("computeContractHash", () => {
  it("produces a deterministic sha256: hash", () => {
    const h1 = computeContractHash({ intent: "do X", outcomes: [outcomeA] });
    const h2 = computeContractHash({ intent: "do X", outcomes: [outcomeA] });
    expect(h1).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(h1).toBe(h2);
  });

  it("changes when intent changes", () => {
    const a = computeContractHash({ intent: "do X", outcomes: [outcomeA] });
    const b = computeContractHash({ intent: "do Y", outcomes: [outcomeA] });
    expect(a).not.toBe(b);
  });

  it("changes when outcomes change", () => {
    const a = computeContractHash({ intent: "do X", outcomes: [outcomeA] });
    const b = computeContractHash({
      intent: "do X",
      outcomes: [outcomeA, outcomeB],
    });
    expect(a).not.toBe(b);
  });

  it("is insensitive to key order within an outcome", () => {
    const ordered: Outcome = {
      id: "x",
      description: "d",
      verify: { text: { contains: "y" }, region: "page" },
    };
    const reordered = {
      description: "d",
      id: "x",
      verify: { region: "page", text: { contains: "y" } },
    } as Outcome;
    expect(computeContractHash({ intent: "i", outcomes: [ordered] })).toBe(
      computeContractHash({ intent: "i", outcomes: [reordered] }),
    );
  });
});
