import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MissingTemplateVariableError, parseSpec } from "../parser/parseSpec";
import { ReusableActionSchema } from "../schema/spec.v1";
import { isSensitiveName, looksLikeSecretValue, createMasker } from "./mask";
import { queryTokens, rank, tokenize } from "./query";
import { analyzeVerifierSource } from "./verifierContract";

describe("tokenize / rank", () => {
  it("splits camelCase, snake_case and kebab-case and stems lightly", () => {
    expect(tokenize("websiteFieldSelector")).toEqual([
      "websit",
      "field",
      "selector",
    ]);
    expect(tokenize("edit_and_save_text_field")).toEqual([
      "edit",
      "sav",
      "text",
      "field",
    ]);
    expect(tokenize("Saved the Fields, editing URLs")).toEqual([
      "sav",
      "field",
      "edit",
      "url",
    ]);
    expect(queryTokens("Edit edit website")).toEqual(["edit", "websit"]);
  });

  it("weights name over description over comments and explains matches", () => {
    const tokens = queryTokens("website");
    const byName = rank(tokens, [{ field: "name", text: "website_check" }]);
    const byDescription = rank(tokens, [
      { field: "description", text: "checks the website" },
    ]);
    const byComment = rank(tokens, [{ field: "comment", text: "website" }]);
    expect(byName.score).toBeGreaterThan(byDescription.score);
    expect(byDescription.score).toBeGreaterThan(byComment.score);
    expect(byName.matched).toEqual([{ token: "websit", field: "name" }]);
    expect(rank(tokens, [{ field: "name", text: "login" }])).toEqual({
      score: 0,
      matched: [],
    });
    // A long prefix counts half.
    expect(
      rank(queryTokens("config"), [{ field: "name", text: "configuration" }])
        .score,
    ).toBe(1.5);
  });

  it("joins phrasal verbs and folds login spellings", () => {
    for (const q of ["log in", "logged in", "Logging in", "sign in", "signIn"])
      expect(queryTokens(q)).toEqual(["login"]);
    expect(tokenize("login_as_admin")).toEqual(["login", "admin"]);
    expect(tokenize("sign_in_as_admin")).toEqual(["login", "admin"]);
    expect(tokenize("log out, set up the db")).toEqual([
      "logout",
      "setup",
      "db",
    ]);
    // Doubled consonants undone after -ed/-ing, but not -ll/-ss.
    expect(tokenize("submitted filled passed")).toEqual([
      "submit",
      "fill",
      "pass",
    ]);
    // "in" stays a stopword elsewhere.
    expect(tokenize("items in list")).toEqual(["item", "list"]);
    const login = [
      { field: "name" as const, text: "login_as_admin login_as_admin" },
    ];
    expect(rank(queryTokens("log in"), login)).toEqual({
      score: 3,
      matched: [{ token: "login", field: "name" }],
    });
    expect(rank(queryTokens("logged in"), login).score).toBe(3);
  });
});

describe("masking", () => {
  it("judges names on credential words, plurals and run-together names", () => {
    expect(isSensitiveName("adminPassword")).toBe(true);
    expect(isSensitiveName("API_KEY")).toBe(true);
    expect(isSensitiveName("apiKeys")).toBe(true);
    expect(isSensitiveName("session_token")).toBe(true);
    // Plurals and names the artifact redactor's key check flags.
    for (const name of [
      "accessTokens",
      "apiSecrets",
      "sessionCookies",
      "userPasswords",
      "DBPASSWORD",
      "adminpassword",
      "SECRETKEY",
      "samlAssertion",
      "codeVerifier",
      "OTP_CODE",
      "dbPass",
      "literalPw",
      "seed_pass",
      "ADMIN_PW",
    ]) {
      expect(isSensitiveName(name), name).toBe(true);
    }
    for (const name of ["bypass", "compass", "passenger", "bypassCache"]) {
      expect(isSensitiveName(name), name).toBe(false);
    }
    expect(isSensitiveName("rootPath")).toBe(false);
    expect(isSensitiveName("footprint")).toBe(false);
    expect(isSensitiveName("cwdPath")).toBe(false);
    expect(isSensitiveName("websiteFieldSelector")).toBe(false);
  });

  it("recognizes token-like literals but not ids, paths or selectors", () => {
    expect(
      looksLikeSecretValue(
        ["ghp", "a1B2c3D4e5".repeat(4).slice(0, 36)].join("_"),
      ),
    ).toBe(true);
    expect(
      looksLikeSecretValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"),
    ).toBe(true);
    expect(looksLikeSecretValue("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8")).toBe(
      true,
    );
    expect(looksLikeSecretValue("5d9df40c2a84427ea0210621")).toBe(false);
    expect(
      looksLikeSecretValue("/connection/5d9df40c2a84427ea0210621/mine"),
    ).toBe(false);
    expect(looksLikeSecretValue('[data-field="website"] input')).toBe(false);
  });

  it("keeps bare placeholders, masks defaults and URL credentials", () => {
    const masker = createMasker();
    expect(masker.value("apiToken", "${env.API_TOKEN}")).toEqual({
      value: "${env.API_TOKEN}",
    });
    expect(
      masker.value("apiToken", "${env.API_TOKEN:-literal-default}"),
    ).toEqual({
      value: "[redacted]",
      masked: true,
    });
    expect(
      masker.value("dbUrl", "postgres://user:pw@db.example.test/app"),
    ).toEqual({
      value: "postgres://[redacted]@db.example.test/app",
      masked: true,
    });
    expect(masker.value("pin", 1234)).toEqual({ value: 1234 });
    expect(masker.value("DBPASSWORD", "hunter2")).toEqual({
      value: "[redacted]",
      masked: true,
    });
    expect(masker.value("accessTokens", "tok-plain-value")).toEqual({
      value: "[redacted]",
      masked: true,
    });
    // A token-looking fallback is masked whatever the name says…
    expect(
      masker.value(
        "stripeKey",
        `${"$"}{env.STRIPE_KEY:-${["sk", "live", "Z9y8X7w6V5".repeat(3).slice(0, 25)].join("_")}}`,
      ),
    ).toEqual({ value: "[redacted]", masked: true });
    // …while a plain fallback under a plain name stays readable.
    expect(
      masker.value("baseHost", "${env.BASE_HOST:-http://localhost:3000}"),
    ).toEqual({ value: "${env.BASE_HOST:-http://localhost:3000}" });
  });
});

describe("analyzeVerifierSource", () => {
  it("reads a Fixtures: header block and the prose before it", () => {
    const a = analyzeVerifierSource(`// Checks the saved value.
//
// Fixtures:
//   - \`expected\` (required) — the value to find
//   selector: where to look (optional)
return { ok: fixtures.expected === "x" };
`);
    expect(a.description).toBe("Checks the saved value.");
    expect(a.source).toBe("header");
    expect(a.keys).toEqual([
      {
        name: "expected",
        description: "the value to find",
        required: true,
        source: "header",
      },
      {
        name: "selector",
        description: "where to look",
        required: false,
        source: "header",
      },
    ]);
  });

  it("reads inline lists, JSDoc @fixture tags and comments after imports", () => {
    const inline = analyzeVerifierSource(`import x from "y";
/**
 * Verifies the export.
 * Fixtures: path, rows
 * @fixture extra additional key
 */
export default () => ({ ok: true });
`);
    expect(inline.description).toBe("Verifies the export.");
    expect(inline.keys.map((k) => k.name)).toEqual(["path", "rows", "extra"]);
    expect(inline.keys[2]).toMatchObject({ description: "additional key" });
  });

  it("reads dash-separated keys with wrapped descriptions and flags", () => {
    const a = analyzeVerifierSource(`// Counts rendered rows.
//
// Fixtures:
//   tablePattern    – regex selecting the target table.
//   expectedCount   – rows that must be preserved
//                     (e.g. "0" for an empty table). Strict equality.
//   emptyText       – (optional) copy shown when the table is empty
//   entityId        - REQUIRED: id of the synthetic record.
//   httpUser / httpPassword - optional basic auth;
//
// Browser-context globals: \`fixtures\`, \`document\`.
return { ok: true };
`);
    expect(a.keys).toEqual([
      {
        name: "tablePattern",
        description: "regex selecting the target table.",
        source: "header",
      },
      {
        name: "expectedCount",
        description:
          'rows that must be preserved (e.g. "0" for an empty table). Strict equality.',
        source: "header",
      },
      {
        name: "emptyText",
        description: "copy shown when the table is empty",
        required: false,
        source: "header",
      },
      {
        name: "entityId",
        description: "id of the synthetic record.",
        required: true,
        source: "header",
      },
      {
        name: "httpUser",
        description: "basic auth;",
        required: false,
        source: "header",
      },
      {
        name: "httpPassword",
        description: "basic auth;",
        required: false,
        source: "header",
      },
    ]);
  });

  it("reads a one-line prose Fixtures: comment as one key", () => {
    const a = analyzeVerifierSource(`import { readFileSync } from "node:fs";

/** Fixtures: probeFile is the JSON written by the fault injector. */
export default function verify({ fixtures }) {
  return { ok: readFileSync(fixtures.probeFile, "utf8").length > 0 };
}
`);
    expect(a.source).toBe("header");
    expect(a.keys).toEqual([
      {
        name: "probeFile",
        description: "is the JSON written by the fault injector.",
        source: "header",
      },
    ]);
  });

  it("reads exported fixtures objects and arrays", () => {
    expect(
      analyzeVerifierSource(`export const fixtures = ["a", 'b'];`).keys.map(
        (k) => k.name,
      ),
    ).toEqual(["a", "b"]);
    const obj = analyzeVerifierSource(
      `export const fixtures: Record<string, unknown> = { a: "first", b: { required: true }, "c-d": 1 };`,
    );
    expect(obj.source).toBe("export");
    expect(obj.keys).toEqual([
      { name: "a", description: "first", source: "export" },
      { name: "b", required: true, source: "export" },
      { name: "c-d", source: "export" },
    ]);
  });

  it("infers keys from usage, ignoring comments, strings and regex literals", () => {
    const a =
      analyzeVerifierSource(`const { alpha, beta: renamed = 1 } = ctx.fixtures;
const v = String(fixtures.gamma || "").replace(/^["']|["']$/g, "");
const w = fixtures?.["delta"];
// fixtures.commented is not read
const s = "fixtures.inString";
`);
    expect(a.source).toBe("usage");
    expect(a.keys.map((k) => k.name).toSorted()).toEqual([
      "alpha",
      "beta",
      "delta",
      "gamma",
    ]);
    expect(a.dynamic).toBe(false);
  });

  it("follows aliases of the fixtures object", () => {
    const a = analyzeVerifierSource(`export default async function verify(ctx) {
  const f = ctx.fixtures || {};
  const path = ctx.fixtures.templatePath;
  return { ok: Number(f.expectedCount) > 0 && f["label"] !== "" && other.f.ignored };
}
`);
    expect(a.keys.map((k) => k.name).toSorted()).toEqual([
      "expectedCount",
      "label",
      "templatePath",
    ]);
    expect(a.dynamic).toBe(false);
  });

  it("treats fixtures handed to an imported helper as dynamic", () => {
    const viaHelper =
      analyzeVerifierSource(`import { checkOwnership } from "./support";
export default function verify(ctx) {
  const fixtures = ctx.fixtures;
  checkOwnership(fixtures);
  return { ok: fixtures.ready === "true" };
}
`);
    expect(viaHelper.dynamic).toBe(true);
    expect(viaHelper.keys.map((k) => k.name)).toEqual(["ready"]);
    const local =
      analyzeVerifierSource(`function check(fixtures) { return fixtures.ready; }
export default (ctx) => ({ ok: check(ctx.fixtures) });
`);
    expect(local.dynamic).toBe(false);
  });

  it("follows fixtures into a local function's parameter", () => {
    const a =
      analyzeVerifierSource(`function readWebsite(fx) { return fx.websiteValue; }
const pick = async (other, f) => f.extra;
export default (ctx) => {
  const fixtures = ctx.fixtures;
  return { ok: fixtures.label && readWebsite(fixtures) && pick(1, fixtures) };
};
`);
    expect(a.dynamic).toBe(false);
    expect(a.keys.map((k) => k.name).toSorted()).toEqual([
      "extra",
      "label",
      "websiteValue",
    ]);
  });

  it("treats the whole object passed to any other call as dynamic", () => {
    expect(
      analyzeVerifierSource(
        "const text = JSON.stringify(fixtures); return { ok: fixtures.label };",
      ).dynamic,
    ).toBe(true);
    // A destructuring parameter is not followed.
    expect(
      analyzeVerifierSource(
        "const read = ({ a }) => a; return { ok: read(fixtures) };",
      ).dynamic,
    ).toBe(true);
    // Declarations and control flow are not calls.
    expect(
      analyzeVerifierSource(
        "export default async function verify(fixtures) { if (fixtures) return { ok: fixtures.y }; }",
      ).dynamic,
    ).toBe(false);
  });

  it("marks dynamic fixture reads", () => {
    expect(
      analyzeVerifierSource("for (const k of Object.keys(ctx.fixtures)) {}")
        .dynamic,
    ).toBe(true);
    expect(analyzeVerifierSource("const all = { ...fixtures };").dynamic).toBe(
      true,
    );
    expect(analyzeVerifierSource("const v = fixtures[name];").dynamic).toBe(
      true,
    );
    expect(analyzeVerifierSource("return { ok: true };")).toEqual({
      source: "none",
      dynamic: false,
      keys: [],
    });
  });
});

describe("ReusableActionSchema description/inputs", () => {
  const base = { version: 1, name: "act", steps: [{ open: "/" }] };

  it("accepts a description and inputs that match the vars defaults", () => {
    const parsed = ReusableActionSchema.parse({
      ...base,
      description: "Opens the home page",
      vars: { path: "/", count: 3 },
      inputs: {
        path: { description: "where to go", default: "/" },
        count: { default: 3 },
        target: { required: true, description: "passed by the caller" },
      },
    });
    expect(parsed.description).toBe("Opens the home page");
    expect(parsed.inputs?.target).toEqual({
      required: true,
      description: "passed by the caller",
    });
  });

  it("rejects inputs that disagree with vars", () => {
    const mismatch = ReusableActionSchema.safeParse({
      ...base,
      vars: { path: "/" },
      inputs: { path: { default: "/home" } },
    });
    expect(mismatch.success).toBe(false);
    expect(mismatch.error?.issues[0]).toMatchObject({
      path: ["inputs", "path"],
      message: 'inputs.path.default ("/home") does not match vars.path ("/")',
    });
    const notAVar = ReusableActionSchema.safeParse({
      ...base,
      inputs: { path: { default: "/" } },
    });
    expect(notAVar.error?.issues[0]?.message).toMatch(/add vars\.path: "\/"/);
    const requiredWithDefault = ReusableActionSchema.safeParse({
      ...base,
      vars: { path: "/" },
      inputs: { path: { required: true } },
    });
    expect(requiredWithDefault.error?.issues[0]?.message).toMatch(
      /is required but has a default/,
    );
    expect(
      ReusableActionSchema.safeParse({
        ...base,
        inputs: { path: { unknown: 1 } },
      }).success,
    ).toBe(false);
  });
});

const REQUIRED_INPUT_ACTION = `version: 1
name: edit_field
description: Fill a labelled field.
inputs:
  label:
    description: Label of the field to fill
    required: true
  value:
    description: Value to type
    default: hello
vars:
  value: hello
steps:
  - fill: { by: label, name: "\${vars.label}", value: "\${vars.value}" }
`;

/** A spec importing REQUIRED_INPUT_ACTION with optional `vars:` lines and call-site vars. */
const requiredInputSpec = (vars: string, callVars: string) => `version: 1
name: fill_flow
intent: fill a field
${vars}imports: [./edit_field.yml]
steps:
  - use:
      action: edit_field
      vars: { ${callVars} }
outcomes:
  - id: filled
    description: the field is filled
    verify: { text: { contains: done } }
`;

describe("a documented required action input", () => {
  it("parses when the importing spec's vars supply it, and a call site overrides it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-required-input-"));
    await writeFile(join(dir, "edit_field.yml"), REQUIRED_INPUT_ACTION);
    await writeFile(
      join(dir, "flow.yml"),
      requiredInputSpec(
        "vars:\n  label: Name\n",
        "label: Email, value: x@example.test",
      ),
    );
    const parsed = await parseSpec(join(dir, "flow.yml"), { env: {} });
    expect(parsed.resolved.steps![0]).toMatchObject({
      fill: { by: "label", name: "Email", value: "x@example.test" },
    });
    // --var / config vars reach the import the same way.
    await writeFile(
      join(dir, "flow.yml"),
      requiredInputSpec("", "value: typed"),
    );
    const viaVar = await parseSpec(join(dir, "flow.yml"), {
      env: {},
      vars: { label: "Company" },
    });
    expect(viaVar.resolved.steps![0]).toMatchObject({
      fill: { name: "Company", value: "typed" },
    });
  });

  it("is not satisfied by a call-site value alone (imports resolve first)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-required-input-"));
    await writeFile(join(dir, "edit_field.yml"), REQUIRED_INPUT_ACTION);
    await writeFile(
      join(dir, "flow.yml"),
      requiredInputSpec("", "label: Email"),
    );
    await expect(
      parseSpec(join(dir, "flow.yml"), { env: {} }),
    ).rejects.toBeInstanceOf(MissingTemplateVariableError);
  });
});
