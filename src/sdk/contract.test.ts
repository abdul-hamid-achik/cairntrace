import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintSpecs } from "../core/authoring/lint";
import { analyzeVerifierSource } from "../core/catalog/verifierContract";
import { sdkContractFromSource } from "./contract";

const IMPORT = `import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";\n`;

describe("sdkContractFromSource (static, never executed)", () => {
  it("reads an inline z.object: types, required, defaults, descriptions, enums", () => {
    const contract = sdkContractFromSource(`${IMPORT}
// A header that is not the description.
export default defineVerifier({
  description: 'Orders reach the "shipped" state, default: fast',
  fixtures: z.object({
    orderId: z.string().min(1).describe("Order id, e.g. o-1, default: none"),
    "expected-count": z.coerce.number().int().default(1),
    owners: z.array(z.string()).optional(),
    since: z.date().nullish(),
    mode: z.enum(["fast", 'slow']).default("fast"),
    kind: z.literal("order"),
    either: z.union([z.string(), z.number()]),
    nested: z.object({ a: z.string() }).describe(\`nested, object\`),
    list: z.string().array(),
    retries: z.number().catch(3),
    loose: z.any(),
  }),
  async run(ctx) {
    const a = { x: 1 };
    return ctx.result.ok(a);
  },
});
`);
    expect(contract).toEqual({
      mode: "static",
      description: 'Orders reach the "shipped" state, default: fast',
      strict: true,
      keys: [
        {
          name: "orderId",
          type: "string",
          required: true,
          description: "Order id, e.g. o-1, default: none",
        },
        { name: "expected-count", type: "number", required: false, default: 1 },
        { name: "owners", type: "string[]", required: false },
        { name: "since", type: "date", required: false },
        {
          name: "mode",
          type: "enum",
          required: false,
          default: "fast",
          values: ["fast", "slow"],
        },
        { name: "kind", type: "literal", required: true, values: ["order"] },
        { name: "either", type: "string | number", required: true },
        {
          name: "nested",
          type: "object",
          required: true,
          description: "nested, object",
        },
        { name: "list", type: "string[]", required: true },
        { name: "retries", type: "number", required: false },
        // zod treats a key whose schema accepts undefined as optional.
        { name: "loose", type: "any", required: false },
      ],
    });
  });

  it("follows one const binding, .extend, .partial, .pick and strictness", () => {
    const contract = sdkContractFromSource(`${IMPORT}
const Base = z.object({ a: z.string(), b: z.number() });
const Fixtures = Base.extend({ c: z.boolean() })
  .partial()
  .passthrough();
export const verify = defineVerifier({ fixtures: Fixtures, run: () => true });
`);
    expect(contract).toMatchObject({
      mode: "static",
      strict: false,
      keys: [
        { name: "a", required: false },
        { name: "b", required: false },
        { name: "c", type: "boolean", required: false },
      ],
    });
    expect(
      sdkContractFromSource(`${IMPORT}
const fixtures = z.object({ a: z.string(), b: z.string(), c: z.string() }).pick({ a: true, c: true });
export default defineVerifier({ fixtures, run: () => true });
`)?.keys.map((k) => k.name),
    ).toEqual(["a", "c"]);
  });

  it("reports dynamic schemas with what it could read", () => {
    expect(
      sdkContractFromSource(`${IMPORT}
import { Shared } from "./shared.ts";
export default defineVerifier({ fixtures: Shared, run: () => true });
`),
    ).toMatchObject({ mode: "dynamic", keys: [] });
    expect(
      sdkContractFromSource(`${IMPORT}
import { common } from "./shared.ts";
export default defineVerifier({
  fixtures: z.object({ ...common, own: z.string() }),
  run: () => true,
});
`),
    ).toMatchObject({
      mode: "dynamic",
      keys: [{ name: "own", type: "string", required: true }],
      reason: "the z.object() shape spreads another object",
    });
    expect(
      sdkContractFromSource(`${IMPORT}
const definition = { run: () => true };
export default defineVerifier(definition);
`),
    ).toMatchObject({ mode: "dynamic" });
  });

  it("resolves shorthand keys and claims nothing about keys it cannot read", () => {
    const contract = sdkContractFromSource(`${IMPORT}
import { within as sharedWithin, optionalTag } from "./shared.ts";
const within = z.number().default(5000);
const retries = z.number().optional();
export default defineVerifier({
  fixtures: z.object({
    orderId: z.string(),
    within,
    retries: retries,
    budget: sharedWithin,
    tag: optionalTag(),
    note: z.union([z.string(), z.undefined()]),
    later: sharedWithin.optional(),
    custom: z.custom((v) => typeof v === "string"),
    pre: z.preprocess((v) => v ?? "x", z.string()),
    tags: z.string().optional().array(),
  }),
  run: () => true,
});
`);
    expect(contract).toMatchObject({ mode: "static", strict: true });
    expect(contract?.keys).toEqual([
      { name: "orderId", type: "string", required: true },
      { name: "within", type: "number", required: false, default: 5000 },
      { name: "retries", type: "number", required: false },
      { name: "budget", type: "unknown" },
      { name: "tag", type: "unknown" },
      { name: "note", type: "string | undefined", required: false },
      { name: "later", type: "unknown", required: false },
      { name: "custom", type: "unknown" },
      { name: "pre", type: "string" },
      { name: "tags", type: "string[]", required: true },
    ]);
    expect(contract?.reason).toMatch(
      /budget, tag, custom, pre cannot be read statically/,
    );
  });

  it("reads intersections and treats other object methods as dynamic", () => {
    expect(
      sdkContractFromSource(`${IMPORT}
export default defineVerifier({
  fixtures: z.object({ orderId: z.string() }).and(z.object({ region: z.string().optional() })),
  run: () => true,
});
`),
    ).toMatchObject({
      mode: "static",
      strict: true,
      keys: [
        { name: "orderId", required: true },
        { name: "region", required: false },
      ],
    });
    expect(
      sdkContractFromSource(`${IMPORT}
const A = z.object({ a: z.string() });
export default defineVerifier({
  fixtures: z.intersection(A, z.object({ b: z.number() }).passthrough()),
  run: () => true,
});
`),
    ).toMatchObject({
      mode: "static",
      strict: false,
      keys: [{ name: "a" }, { name: "b", type: "number" }],
    });
    expect(
      sdkContractFromSource(`${IMPORT}
import { Extra } from "./extra.ts";
export default defineVerifier({
  fixtures: z.object({ a: z.string() }).and(Extra),
  run: () => true,
});
`),
    ).toMatchObject({ mode: "dynamic", strict: false, keys: [{ name: "a" }] });
    expect(
      sdkContractFromSource(`${IMPORT}
export default defineVerifier({
  fixtures: z.object({ a: z.string() }).or(z.object({ b: z.string() })),
  run: () => true,
});
`),
    ).toMatchObject({
      mode: "dynamic",
      strict: false,
      reason: expect.stringContaining(".or()"),
    });
    expect(
      sdkContractFromSource(`${IMPORT}
export default defineVerifier({
  fixtures: z.object({ a: z.string() }).describe("x").superRefine(() => {}).optional(),
  run: () => true,
});
`),
    ).toMatchObject({ mode: "static", strict: true });
  });

  it("does not claim a contract for zod v4 schemas (the SDK refuses them)", () => {
    expect(
      sdkContractFromSource(`import { defineVerifier } from "@thelacanians/cairntrace/verifier";
import { z } from "zod/v4";
export default defineVerifier({ fixtures: z.object({ a: z.string() }), run: () => true });
`),
    ).toMatchObject({
      mode: "dynamic",
      strict: false,
      keys: [],
      reason: expect.stringContaining("zod v4"),
    });
  });

  it("treats a verifier without a schema as accepting any fixture", () => {
    expect(
      sdkContractFromSource(`${IMPORT}
export default defineVerifier({ run: (ctx) => ctx.result.ok() });
`),
    ).toMatchObject({ mode: "static", strict: false, keys: [] });
  });

  it("ignores defineVerifier in comments, strings and declarations", () => {
    expect(
      sdkContractFromSource(`// defineVerifier({ fixtures: z.object({ a: z.string() }) })
const doc = "defineVerifier({})";
function defineVerifier(x) { return x; }
export default async function verify(ctx) { return { ok: true }; }
`),
    ).toBeUndefined();
  });
});

describe("catalog/lint read the SDK contract first", () => {
  it("analyzeVerifierSource prefers the SDK schema over the header comment", () => {
    const analysis = analyzeVerifierSource(`${IMPORT}
/**
 * Checks orders.
 *
 * Fixtures:
 *   stale: an old documented key
 */
export default defineVerifier({
  fixtures: z.object({ orderId: z.string(), limit: z.number().default(5) }),
  run: () => true,
});
`);
    expect(analysis).toEqual({
      description: "Checks orders.",
      source: "sdk",
      dynamic: false,
      strict: true,
      keys: [
        { name: "orderId", required: true, type: "string", source: "sdk" },
        { name: "limit", required: false, type: "number", source: "sdk" },
      ],
    });
  });

  it("keeps the header-comment fallback for plain scripts", () => {
    const analysis = analyzeVerifierSource(`/**
 * Fixtures:
 *   table: the table (required)
 */
export default async function verify(ctx) {
  return { ok: Boolean(ctx.fixtures.table) };
}
`);
    expect(analysis.source).toBe("header");
    expect(analysis.keys[0]).toMatchObject({ name: "table", required: true });
  });

  it("does not lint keys it cannot read as missing, but still flags typos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-lint-unread-"));
    try {
      await mkdir(join(dir, "verifiers"), { recursive: true });
      await writeFile(
        join(dir, "verifiers", "shared.ts"),
        `import { z } from "@thelacanians/cairntrace/verifier";
export const within = z.number().default(30_000);
export const optionalTag = () => z.string().optional();
`,
      );
      await writeFile(
        join(dir, "verifiers", "orders.ts"),
        `${IMPORT}
import { within, optionalTag } from "./shared.ts";
export default defineVerifier({
  fixtures: z.object({
    orderId: z.string(),
    within,
    tag: optionalTag(),
    note: z.union([z.string(), z.undefined()]),
  }).and(z.object({ region: z.string() })),
  run: () => true,
});
`,
      );
      const spec = join(dir, "orders.yml");
      await writeFile(
        spec,
        `version: 1
name: orders_spec
intent: Orders
coldStart: guest
steps:
  - id: open_home
    open: http://app.test/
outcomes:
  - id: saved
    description: saved
    verify:
      script:
        runtime: node
        file: ./verifiers/orders.ts
        fixtures:
          orderId: "7"
          region: eu
          regoin: eu
`,
      );
      const result = await lintSpecs([spec], { cwd: dir, env: {} });
      const findings = result.files[0]!.findings.filter((f) =>
        f.rule.endsWith("fixture-key"),
      );
      expect(findings).toEqual([
        expect.objectContaining({
          rule: "unknown-fixture-key",
          severity: "error",
          where: "outcomes[0].verify.script.fixtures.regoin",
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lints unknown and missing SDK fixture keys as errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-lint-"));
    try {
      await mkdir(join(dir, "verifiers"), { recursive: true });
      await writeFile(
        join(dir, "verifiers", "orders.ts"),
        `${IMPORT}
export default defineVerifier({
  fixtures: z.object({ orderId: z.string(), limit: z.number().default(5) }),
  run: () => true,
});
`,
      );
      const spec = join(dir, "orders.yml");
      await writeFile(
        spec,
        `version: 1
name: orders_spec
intent: Orders
coldStart: guest
steps:
  - id: open_home
    open: http://app.test/
outcomes:
  - id: saved
    description: saved
    verify:
      script:
        runtime: node
        file: ./verifiers/orders.ts
        fixtures:
          ordrId: "7"
          limit: 3
`,
      );
      const result = await lintSpecs([spec], { cwd: dir, env: {} });
      const findings = result.files[0]!.findings.filter((f) =>
        f.rule.endsWith("fixture-key"),
      );
      expect(findings).toEqual([
        expect.objectContaining({
          rule: "unknown-fixture-key",
          severity: "error",
          where: "outcomes[0].verify.script.fixtures.ordrId",
        }),
        expect.objectContaining({
          rule: "missing-fixture-key",
          severity: "error",
          message: expect.stringContaining(
            'requires fixture "orderId" (string)',
          ),
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
