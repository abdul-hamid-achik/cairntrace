import { describe, expect, it } from "vitest";
import {
  authoredPlaceholders,
  collectRuntimeRefKeys,
  emitStr,
  envDefaultSentinel,
  findLateBoundLeak,
  humanizeSentinels,
  newRefUsage,
  parseTemplateValue,
} from "./templateValue";

describe("env default sentinel (${env.X:-default} read at run time)", () => {
  it("round-trips a name and a default that holds quotes, braces and other sentinels", () => {
    const fallback = `a "b" {c} \`d\` \${e} __CAIRN_RUN_TOKEN__`;
    const sentinel = envDefaultSentinel("REGION", fallback);
    // Hex only: nothing in the sentinel can break out of a JSON / template.
    expect(sentinel).toMatch(/^__CAIRN_ENV_DEFAULT__[0-9a-f]+_[0-9a-f]*__$/);
    expect(parseTemplateValue(`x-${sentinel}-y`)).toEqual([
      { kind: "lit", text: "x-" },
      { kind: "envDefault", name: "REGION", fallback },
      { kind: "lit", text: "-y" },
    ]);
  });

  it("emits process.env.X || default, re-parsing the default's own late-bound parts", () => {
    const usage = newRefUsage();
    const expr = emitStr(
      envDefaultSentinel("REGION", "eu-__CAIRN_RUN_TOKEN__"),
      usage,
    );
    expect(expr).toBe("(process.env.REGION || `eu-${RUN_TOKEN}`)");
    expect(usage.runToken).toBe(true);
    expect([...usage.optionalEnvNames]).toEqual(["REGION"]);
    expect([...usage.envNames]).toEqual([]);
    expect(
      emitStr(`/p?r=${envDefaultSentinel("REGION", "eu")}`, newRefUsage()),
    ).toBe('`/p?r=${(process.env.REGION || "eu")}`');
  });

  it("an empty default is an empty string fallback", () => {
    const usage = newRefUsage();
    expect(emitStr(envDefaultSentinel("X", ""), usage)).toBe(
      '(process.env.X || "")',
    );
  });

  it("is rendered readably in comments, never leaking the sentinel", () => {
    const text = `${envDefaultSentinel("REGION", "eu")} and __CAIRN_SECRET_REF__TOKEN__`;
    expect(humanizeSentinels(text)).toBe(
      'process.env.REGION || "eu" and process.env.TOKEN',
    );
    expect(authoredPlaceholders(`run ${text} __CAIRN_RUN_TOKEN__`)).toBe(
      "run ${env.REGION:-eu} and ${env.TOKEN} ${run.token}",
    );
  });

  it("an unemitted sentinel is caught by the leak scan", () => {
    expect(
      findLateBoundLeak(`x ${envDefaultSentinel("A", "b")}`),
    ).toBeDefined();
  });
});

describe("runtime splice namespaces", () => {
  it("parses ${runs.…}, ${captures.…} and ${fixtures.…} as runtime refs", () => {
    const parts = parseTemplateValue(
      "${runs.seeded.id} ${captures.rows.cells.0} ${fixtures.thing.sku}",
    ).filter((part) => part.kind === "runtime");
    expect(
      parts.map((part) => (part.kind === "runtime" ? part.ref : "")),
    ).toEqual([
      "runs.seeded.id",
      "captures.rows.cells.0",
      "fixtures.thing.sku",
    ]);
    expect(
      collectRuntimeRefKeys("${runs.a.b} ${captures.c} ${fixtures.d.e}"),
    ).toEqual(new Set(["runs:a", "captures:c", "fixtures:d"]));
  });

  it("stays literal where the runner does not splice the namespace", () => {
    const literal: string[] = [];
    const parts = parseTemplateValue("${runs.a.b}", {
      sources: new Set(["requests"]),
      onLiteralRef: (ref) => literal.push(ref),
    });
    expect(parts).toEqual([{ kind: "lit", text: "${runs.a.b}" }]);
    expect(literal).toEqual(["runs.a.b"]);
  });

  it("binds through the usual cairnSplice when a producer is in scope", () => {
    const usage = newRefUsage();
    usage.bindings.set("runs:seeded", "cairnRuns_seeded");
    expect(emitStr("id=${runs.seeded.id}", usage)).toBe(
      '`id=${cairnSplice(cairnRuns_seeded, ["id"])}`',
    );
    const unbound = newRefUsage();
    expect(emitStr("${captures.nope}", unbound)).toContain(
      'cairnUnresolvedSplice("captures.nope")',
    );
  });
});
