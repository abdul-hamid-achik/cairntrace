import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MissingTemplateVariableError, parseSpec } from "./parseSpec";
import { resolveFixtureTemplate } from "../fixtures/template";
import { resolveDatasourcePlaceholders } from "../datasources/resolve";
import { resolveAuthTemplates } from "../runner/envAuth";
import { lookupVar, renderVarValue } from "../config/varValue";
import type { Datasource } from "../datasources/schema";
import type { EnvAuth } from "../schema/request.v1";

// F7 typed config vars: lists and objects reach structured consumers as
// themselves (an unquoted whole `${vars.X}`), string contexts get compact
// JSON, and `${vars.X.key}` / `${vars.X.0}` read inside them.

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-typed-vars-"));
});

const vars = {
  ids: [101, 102],
  admin: { email: "admin@example.test", roles: ["owner", "billing"] },
  tokens: ["t-${run.token}", { worker: "w${worker.index}" }],
  tenant: "acme",
};

describe("typed vars in specs", () => {
  it("keeps a list / object whole in an unquoted value, renders JSON in a string, and reads dotted paths", async () => {
    const path = join(dir, "typed.yml");
    await writeFile(
      path,
      [
        "version: 1",
        "name: typed",
        "intent: typed vars reach a script verifier",
        "coldStart: guest",
        "steps:",
        '  - fill: { by: selector, selector: "#ids", value: "${vars.ids}" }',
        "  - fill:",
        "      by: selector",
        '      selector: "#who"',
        "      value: ${vars.admin.email}",
        "outcomes:",
        "  - id: data",
        "    description: the seeded rows exist",
        "    verify:",
        "      script:",
        "        runtime: node",
        "        file: ./check.mjs",
        "        fixtures:",
        "          ids: ${vars.ids}",
        "          admin: ${vars.admin}",
        "          tokens: ${vars.tokens}",
        '          label: "ids=${vars.ids}"',
        "          firstRole: ${vars.admin.roles.0}",
        "          tenant: ${vars.tenant}",
        "",
      ].join("\n"),
    );
    const { resolved } = await parseSpec(path, {
      vars,
      runtime: { runToken: "tok", workerIndex: 3 },
    });
    const fill = resolved.steps![0] as { fill: { value: string } };
    expect(fill.fill.value).toBe("[101,102]");
    expect((resolved.steps![1] as { fill: { value: string } }).fill.value).toBe(
      "admin@example.test",
    );
    const script = (
      resolved.outcomes[0]!.verify as {
        script: { fixtures: Record<string, unknown> };
      }
    ).script;
    expect(script.fixtures).toEqual({
      ids: [101, 102],
      admin: { email: "admin@example.test", roles: ["owner", "billing"] },
      // runtime placeholders inside a typed var render like scalar vars
      tokens: ["t-tok", { worker: "w3" }],
      label: "ids=[101,102]",
      firstRole: "owner",
      tenant: "acme",
    });
  });

  it("fails a missing path inside a typed var like a missing var", async () => {
    const path = join(dir, "missing.yml");
    await writeFile(
      path,
      [
        "version: 1",
        "name: missing",
        "intent: x",
        "coldStart: guest",
        "steps:",
        '  - open: "/u/${vars.admin.phone}"',
        "outcomes:",
        "  - { id: o, description: d, verify: { console: { errorsMax: 0 } } }",
        "",
      ].join("\n"),
    );
    await expect(parseSpec(path, { vars })).rejects.toBeInstanceOf(
      MissingTemplateVariableError,
    );
  });
});

describe("typed vars in config templates", () => {
  it("config fixtures keep the type of a whole reference and read dotted paths", () => {
    const resolved = resolveFixtureTemplate(
      {
        ids: "${vars.ids}",
        email: "${vars.admin.email}",
        note: "for ${vars.admin.roles}",
      },
      {
        with: {},
        fixtures: {},
        vars,
        env: {},
        now: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(resolved).toEqual({
      ids: [101, 102],
      email: "admin@example.test",
      note: 'for ["owner","billing"]',
    });
  });

  it("datasource strings read dotted paths and render lists as JSON", () => {
    const ds = resolveDatasourcePlaceholders(
      "api",
      {
        kind: "http",
        baseUrl: "https://${vars.admin.roles.0}.example.test",
        headers: { "x-ids": "${vars.ids}" },
      } as unknown as Datasource,
      { vars, env: {} },
    ) as unknown as { baseUrl: string; headers: Record<string, string> };
    expect(ds.baseUrl).toBe("https://owner.example.test");
    expect(ds.headers["x-ids"]).toBe("[101,102]");
  });

  it("environment login templates read dotted paths and render objects as JSON", () => {
    const auth = resolveAuthTemplates(
      {
        login: {
          url: "/api/login?u=${vars.admin.email}",
          method: "POST",
          body: { roles: "${vars.admin.roles}" },
        },
      } as unknown as EnvAuth,
      { env: {}, vars, envName: "local", registerSecrets: () => {} },
    );
    expect(auth.login.url).toBe("/api/login?u=admin@example.test");
    expect((auth.login as { body: { roles: string } }).body.roles).toBe(
      '["owner","billing"]',
    );
  });
});

describe("varValue helpers", () => {
  it("prefers a var literally named with a dot and walks lists by index", () => {
    expect(lookupVar({ "a.b": 1, a: { b: 2 } }, "a.b")).toEqual({
      found: true,
      value: 1,
    });
    expect(lookupVar({ a: { b: [5, 6] } }, "a.b.1")).toEqual({
      found: true,
      value: 6,
    });
    expect(lookupVar({ a: [1] }, "a.x")).toEqual({ found: false });
    expect(renderVarValue(undefined)).toBe("");
    expect(renderVarValue(false)).toBe("false");
    expect(renderVarValue({ a: [1, "b"] })).toBe('{"a":[1,"b"]}');
  });
});
