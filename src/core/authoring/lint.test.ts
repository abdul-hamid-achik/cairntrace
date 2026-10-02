import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  findUnquotedHashes,
  lintExitCode,
  lintSpecs,
  quoteHashes,
} from "./lint";

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-lint-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await mkdir(join(dir, "verifiers"), { recursive: true });
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
defaultEnvironment: local
secrets:
  provider: env
  required: [LINT_APP_PASSWORD]
environments:
  local:
    baseUrl: http://app.test
    vars: { user: alice }
  dev:
    baseUrl: https://dev.app.test
`,
  );
  await writeFile(
    join(dir, "verifiers", "check.mjs"),
    `/**
 * Checks the saved row.
 *
 * Fixtures:
 *   table: the table name (required)
 *   expected: the expected value
 */
export default function verify({ fixtures }) {
  return { ok: fixtures.table === fixtures.expected };
}
`,
  );
  return dir;
}

const env = { LINT_APP_PASSWORD: "Lint-Secret-Value-77" };

function rules(result: Awaited<ReturnType<typeof lintSpecs>>): string[] {
  return result.files[0]!.findings.map((f) => f.rule);
}

describe("cairn spec lint", () => {
  it("explains an unquoted # selector instead of a schema dump, and --fix quotes it", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "hash.yml");
    const text = `version: 1
name: hash_spec
intent: Save
coldStart: guest
outcomes:
  - id: saved
    description: saved
    verify: { text: { contains: Saved } }
steps:
  # the save button
  - id: click_save
    click: { by: selector, selector: #save-btn }
  - id: fill_site
    fill:
      by: selector
      selector: #website  # the website input
      value: x
`;
    await writeFile(spec, text);
    const before = await lintSpecs([spec], { cwd: dir, env });
    expect(before.files[0]!.findings.map((f) => [f.rule, f.line])).toEqual([
      ["unquoted-hash", 12],
      ["unquoted-hash", 16],
    ]);
    expect(lintExitCode(before)).toBe(4);

    const fixed = await lintSpecs([spec], { cwd: dir, env, fix: true });
    expect(fixed.summary).toMatchObject({ errors: 0, fixed: 2 });
    const after = await readFile(spec, "utf8");
    expect(after).toContain('click: { by: selector, selector: "#save-btn" }');
    expect(after).toContain('selector: "#website"  # the website input');
    expect(after).toContain("# the save button");
    const doc = parseYaml(after) as { steps: Array<Record<string, any>> };
    expect(doc.steps[0]!["click"].selector).toBe("#save-btn");
    expect(findUnquotedHashes(after)).toEqual([]);
  });

  it("adds missing step ids with --fix, keeping comments and quoting", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "ids.yml");
    await writeFile(
      spec,
      `version: 1
name: ids_spec
intent: Ids
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { url: { endsWith: /x } }
steps:
  - open: '/x' # keep me
  - { click: { by: role, role: button, name: Go } }
  - id: already
    wait: { ms: 10 }
`,
    );
    const result = await lintSpecs([spec], { cwd: dir, env, fix: true });
    expect(result.files[0]!.fixed).toBe(2);
    const after = await readFile(spec, "utf8");
    expect(after).toContain("  - id: open_x\n    open: '/x' # keep me");
    expect(after).toContain(
      "  - { id: click_go, click: { by: role, role: button, name: Go } }",
    );
    const again = await lintSpecs([spec], { cwd: dir, env });
    expect(rules(again)).not.toContain("missing-step-id");
  });

  it("names schema problems per step", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "schema.yml");
    await writeFile(
      spec,
      `version: 1
name: schema_spec
intent: Schema
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { url: { endsWith: /x } }
steps:
  - id: fill_pw
    fill: { by: label, label: Password, value: x }
  - id: frobnicate
    frobnicate: true
`,
    );
    const result = await lintSpecs([spec], { cwd: dir, env });
    const messages = result.files[0]!.findings.map((f) => f.message);
    expect(messages).toContain(
      'steps[0].fill: fill step: unknown key(s) "label"',
    );
    expect(messages.join("\n")).toMatch(/unknown step kind "frobnicate"/);
    expect(
      result.files[0]!.findings.find((f) => f.where === "steps[0].fill")?.line,
    ).toBe(11);
  });

  it("resolves vars per --env, flags residual shell placeholders and echo-only cold starts", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "envs.yml");
    await writeFile(
      spec,
      `version: 1
name: envs_spec
intent: Envs
preconditions:
  commands:
    - run: echo ready
    - run: 'echo "\${requests.token.body}"'
outcomes:
  - id: ok
    description: ok
    verify: { url: { endsWith: /x } }
steps:
  - id: open_user
    open: /users/\${vars.user}
`,
    );
    const result = await lintSpecs([spec], {
      cwd: dir,
      env,
      envs: ["local", "dev"],
    });
    const file = result.files[0]!;
    expect(file.envs).toEqual(["local", "dev"]);
    expect(file.findings).toContainEqual(
      expect.objectContaining({
        rule: "unresolved-var",
        env: "dev",
        severity: "error",
      }),
    );
    expect(file.findings).toContainEqual(
      expect.objectContaining({
        rule: "residual-placeholder",
        env: "local",
        where: "preconditions.commands[1].run",
      }),
    );
    expect(file.findings).toContainEqual(
      expect.objectContaining({
        rule: "cold-start-echo-only",
        severity: "warning",
      }),
    );
  });

  it("flags literal secrets, evals with typed equivalents, host paths, fixture keys and missing files", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "smells.yml");
    await writeFile(
      spec,
      `version: 1
name: smells_spec
intent: Smells
coldStart: guest
vars:
  apiToken: plain-token-value
outcomes:
  - id: row_saved
    description: row saved
    verify:
      script:
        runtime: node
        file: ../verifiers/check.mjs
        fixtures: { expected: "1", tabel: rows }
steps:
  - id: fill_password
    fill: { by: label, name: Password, value: Lint-Secret-Value-77 }
  - id: fill_pin
    fill: { by: label, name: PIN, value: "1234" }
  - id: eval_go
    eval:
      js: "location.assign('/next'); document.querySelector('#ok').click()"
  - id: upload_file
    upload: { by: label, name: File, path: /Users/someone/data/file.csv }
  - id: eval_file
    eval: { file: ./missing.js }
`,
    );
    const result = await lintSpecs([spec], { cwd: dir, env });
    const findings = result.files[0]!.findings;
    const byRule = (rule: string) => findings.filter((f) => f.rule === rule);
    expect(
      byRule("literal-secret")
        .map((f) => f.where)
        .toSorted(),
    ).toEqual(["steps[0].fill.value", "steps[1].fill.value", "vars.apiToken"]);
    expect(
      byRule("literal-secret").find((f) => f.where === "steps[0].fill.value")
        ?.message,
    ).toContain("${secrets.LINT_APP_PASSWORD}");
    expect(
      byRule("eval-typed-equivalent").map(
        (f) => f.message.match(/typed (\w+) step/)?.[1],
      ),
    ).toEqual(["open", "click"]);
    expect(byRule("absolute-path")[0]?.where).toBe("steps[3].upload.path");
    expect(byRule("unknown-fixture-key")).toEqual([
      expect.objectContaining({
        where: "outcomes[0].verify.script.fixtures.tabel",
      }),
    ]);
    expect(byRule("missing-fixture-key")[0]?.message).toContain('"table"');
    expect(byRule("missing-file").length).toBeGreaterThanOrEqual(2);
    // Nothing secret is echoed back.
    expect(JSON.stringify(result)).not.toContain("Lint-Secret-Value-77");
  });

  it("explains a placeholder that takes a number into a string field", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "typed.yml");
    await writeFile(
      spec,
      `version: 1
name: typed_spec
intent: Typed
coldStart: guest
vars: { price: 12.50 }
outcomes:
  - id: ok
    description: ok
    verify: { url: { endsWith: /x } }
steps:
  - id: fill_price
    fill:
      by: label
      name: Price
      value: \${vars.price}
`,
    );
    const result = await lintSpecs([spec], { cwd: dir, env });
    const finding = result.files[0]!.findings.find((f) => f.rule === "schema");
    expect(finding).toMatchObject({
      where: "steps[0].fill.value",
      line: 15,
    });
    expect(finding!.message).toContain("after placeholder substitution");
    expect(finding!.message).toContain('quote it ("${vars.name}")');
  });

  it("lints a reusable action and reports a clean spec as ok", async () => {
    const dir = await project();
    const action = join(dir, "flows", "login.yml");
    await writeFile(
      action,
      `version: 1
name: login
steps:
  - fill: { by: label, name: Password, value: "\${secrets.LINT_APP_PASSWORD}" }
`,
    );
    const clean = join(dir, "flows", "clean.yml");
    await writeFile(
      clean,
      `version: 1
name: clean_spec
intent: Clean
imports: [./login.yml]
outcomes:
  - id: ok
    description: ok
    verify: { url: { endsWith: /x } }
steps:
  - id: use_login
    use: login
`,
    );
    const result = await lintSpecs([action, clean], { cwd: dir, env });
    expect(result.files.map((f) => [f.kind, f.status])).toEqual([
      ["action", "ok"],
      ["spec", "ok"],
    ]);
    expect(lintExitCode(result)).toBe(0);
  });
});

describe("cairn spec lint fix safety", () => {
  const NESTED = `version: 1
name: nested_spec
intent: Go
coldStart: guest
outcomes:
  - id: done
    description: done
    verify: { text: { contains: Done } }
steps:
  - id: click_go
    click:  #primary button
      by: role
      role: button
      name: Go
`;

  it("does not report a comment after a key that holds a nested map", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "nested.yml");
    await writeFile(spec, NESTED);
    expect(findUnquotedHashes(NESTED)).toEqual([]);
    const result = await lintSpecs([spec], { cwd: dir, env, fix: true });
    expect(rules(result)).not.toContain("unquoted-hash");
    expect(lintExitCode(result)).toBe(0);
    expect(await readFile(spec, "utf8")).toBe(NESTED);
  });

  it("refuses a quote that would change the document", () => {
    const offset = NESTED.indexOf("#primary");
    expect(
      quoteHashes(NESTED, [
        {
          line: 11,
          offset,
          key: "click:  ",
          value: "#primary button",
        },
      ]),
    ).toBeUndefined();
  });

  it("does not add step ids through YAML aliases", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "alias.yml");
    const text = `version: 1
name: alias_spec
intent: Go
coldStart: guest
outcomes:
  - id: done
    description: done
    verify: { text: { contains: Done } }
steps:
  - &first
    open: /x
  - *first
`;
    await writeFile(spec, text);
    const result = await lintSpecs([spec], { cwd: dir, env, fix: true });
    const ids = result.files[0]!.findings.filter(
      (f) => f.rule === "missing-step-id",
    );
    expect(ids).toHaveLength(2);
    expect(ids.every((f) => f.fix?.applied === false)).toBe(true);
    expect(result.summary.fixed).toBe(0);
    expect(await readFile(spec, "utf8")).toBe(text);
  });

  it("flags a precondition cwd that does not exist", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "pre.yml");
    await writeFile(
      spec,
      `version: 1
name: pre_spec
intent: Go
coldStart: guest
preconditions:
  commands:
    - name: seed
      run: test -f seed.sql
      cwd: ../../fixtures
outcomes:
  - id: done
    description: done
    verify: { text: { contains: Done } }
steps:
  - id: open_x
    open: /x
`,
    );
    const result = await lintSpecs([spec], { cwd: dir, env });
    expect(result.files[0]!.findings).toContainEqual(
      expect.objectContaining({
        rule: "missing-file",
        severity: "error",
        where: "preconditions.commands[0].cwd",
      }),
    );
  });

  it("warns, not errors, on a literal in a field that only sounds like a credential", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "token.yml");
    await writeFile(
      spec,
      `version: 1
name: token_spec
intent: Create a deploy token
coldStart: guest
outcomes:
  - id: done
    description: done
    verify: { text: { contains: Done } }
steps:
  - id: fill_token_name
    fill: { by: label, name: Token name, value: ci-deploy }
  - id: fill_pin
    fill: { by: label, name: PIN, value: "1234" }
  - id: fill_password
    fill: { by: label, name: Password, value: Lint-Secret-Value-77 }
`,
    );
    const result = await lintSpecs([spec], { cwd: dir, env });
    const secrets = result.files[0]!.findings.filter(
      (f) => f.rule === "literal-secret",
    );
    expect(secrets.map((f) => [f.where, f.severity])).toEqual([
      ["steps[2].fill.value", "error"],
      ["steps[1].fill.value", "warning"],
    ]);
    expect(secrets[1]!.fix?.description).toContain("${vars.X}");
  });
});

describe("cairn spec lint: shell args", () => {
  it("warns when a run command reads $N the step does not pass", async () => {
    const dir = await project();
    const spec = join(dir, "flows", "args.yml");
    await writeFile(
      spec,
      `version: 1
name: args_spec
intent: Clean up
coldStart: guest
outcomes:
  - id: home
    description: home
    verify: { url: { matches: "/" } }
steps:
  - id: open_home
    open: /
  - id: seed
    run: 'node ./seed.mjs "$1"'
  - id: seed_ok
    run: { shell: 'node ./seed.mjs "$1"', args: ["\${vars.user}"] }
teardown:
  - id: cleanup
    run: { shell: 'node ./cleanup.mjs "$1" "$2"', args: ["x"] }
`,
    );
    await writeFile(join(dir, "flows", "seed.mjs"), "");
    await writeFile(join(dir, "flows", "cleanup.mjs"), "");
    const result = await lintSpecs([spec], { cwd: dir, env });
    const shell = result.files[0]!.findings.filter(
      (f) => f.rule === "shell-arg-unset",
    );
    expect(shell.map((f) => [f.where, f.severity])).toEqual([
      ["steps[1].run", "warning"],
      ["teardown[0].run", "warning"],
    ]);
    expect(shell[0]!.message).toContain("passes no args");
    expect(shell[1]!.message).toContain("reads $2 but the step passes 1 arg");
  });
});
