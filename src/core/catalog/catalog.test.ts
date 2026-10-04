import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../mcp/server";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { buildCheckpointMeta } from "../checkpoint/meta";
import { buildCatalog, CatalogConfigError } from "./buildCatalog";
import { CatalogResultSchema } from "./catalog.v1";
import { renderCatalogMarkdown } from "./markdown";

// A small neutral project: config with environments, commented vars and a
// merge key; three actions (description field, leading comment, inputs);
// specs that import/use them and call script verifiers; run directories;
// and a checkpoint store.

let dir: string;
let runs: string;
let store: CheckpointStore;

const CONFIG = (runsDir: string) => `version: 1
project: catalog-fixture
defaultEnvironment: local
artifactRoot: ${runsDir}
services:
  docker:
    command: docker compose up -d
  seed:
    command: bun seed.ts
environments:
  local:
    baseUrl: http://localhost:4100
    policy:
      trait: owned
      mutations: allow
      description: Your own laptop stack
    vars: &local-vars
      # Selector of the Website input on the company profile page
      websiteFieldSelector: '[data-field="website"] input'
      # Website value the profile flows write
      websiteValue: https://example.test
      adminPassword: hunter2-local
      sessionKey: abcdef0123456789abcdef0123456789abcd
      rootPath: /root
      apiToken: "\${env.CATALOG_TEST_TOKEN}"
  shared:
    baseUrl: https://shared.example.test
    services: false
    policy: { trait: shared, mutations: deny }
    secrets:
      provider: env
      required: [SHARED_LOGIN]
    vars:
      <<: *local-vars
      # The shared stack keeps its own website value
      websiteValue: https://shared.example.test/site
`;

const EDIT_TEXT_FIELD = `version: 1
name: edit_and_save_text_field
description: Reveal, edit and save a profile text field such as the company website.
vars:
  textFieldSelector: "[data-field] input"
  textFieldValue: hello
inputs:
  textFieldSelector:
    description: CSS selector of the input to edit
  textFieldValue:
    description: Value to type before saving
    default: hello
steps:
  - fill:
      by: selector
      selector: "\${vars.textFieldSelector}"
      value: "\${vars.textFieldValue}"
  - click: { by: role, role: button, name: Save }
  - wait: { text: "\${vars.savedLabel}" }
`;

const LOGIN = `# Sign in as the seeded administrator.
# Reads the adminPassword config var.

version: 1
name: login_as_admin
steps:
  - open: /login
  - fill: { by: label, name: Password, value: "\${vars.adminPassword}" }
`;

const EDIT_NAME = `version: 1
name: edit_profile_name
description: Change the display name on the profile page and save the field.
vars:
  displayName: Acme
steps:
  - fill: { by: label, name: Display name, value: "\${vars.displayName}" }
`;

const WEBSITE_SPEC = `# The company website edit survives a reload.
version: 1
name: profile_website_persisted
intent: an administrator edits the company website on the profile and it persists
metadata:
  tags: [profile, website]
requires:
  env: [local]
session:
  resume: admin_session
imports:
  - ../actions/login_as_admin.yml
  - ../actions/edit_and_save_text_field.yml
steps:
  - use: login_as_admin
  - use:
      action: edit_and_save_text_field
      vars:
        textFieldSelector: "\${vars.websiteFieldSelector}"
        textFieldValue: "\${vars.websiteValue}"
outcomes:
  - id: website_persisted
    description: the website input holds the saved value after reload
    verify:
      script:
        file: ../verifiers/check-website.ts
        fixtures:
          websiteValue: "\${vars.websiteValue}"
          bogusKey: nope
  - id: report_exported
    description: the report export lists the rows
    verify:
      script:
        runtime: node
        file: ../verifiers/check-export.ts
        fixtures:
          reportPath: /tmp/r.csv
`;

const SELECTOR_ONLY_SPEC = `version: 1
name: website_selector_only
intent: check the website input exists
coldStart: guest
outcomes:
  - id: input_present
    description: the input is present
    verify:
      script:
        file: \${config.dir}/verifiers/check-website.ts
        fixtures:
          websiteSelector: "\${vars.websiteFieldSelector}"
`;

const GUEST_SPEC = `version: 1
name: guest_home
intent: a guest sees the public landing page
coldStart: guest
outcomes:
  - id: landing
    description: landing copy is visible
    verify: { text: { contains: Welcome } }
steps:
  - open: /
`;

const DRAFT_SPEC = `version: 1
name: rename_company
intent: rename the company display name
imports: [../../actions/edit_profile_name.yml]
steps:
  - use: edit_profile_name
outcomes:
  - id: renamed
    description: the new name shows
    verify: { text: { contains: Acme } }
`;

const CHECK_WEBSITE = `// Browser verifier: the profile Website input holds the saved value after
// a reload, so the value came from the server.
//
// Fixtures:
//   websiteValue: expected value (required)
//   websiteSelector: selector of the input (optional)
const sel = String(fixtures.websiteSelector || "input").replace(/^["']|["']$/g, "");
const input = document.querySelector(sel);
return { ok: Boolean(input) && input.value === fixtures.websiteValue, evidence: {} };
`;

const CHECK_EXPORT = `import { readFile } from "node:fs/promises";

/** Node verifier: the exported report lists every row. */
export const contract = {
  fixtures: {
    reportPath: "absolute path of the exported CSV",
    rows: { description: "expected row count", required: true },
  },
};

export default async function verify(ctx) {
  const text = await readFile(ctx.fixtures.reportPath, "utf8");
  return { ok: text.length > 0, evidence: {} };
}
`;

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function putRun(
  name: string,
  spec: string,
  status: string,
  environment: string,
  durationMs: number,
): Promise<void> {
  const runDir = join(runs, name);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: name,
      runDir,
      spec: { name: spec, path: join(dir, "flows", `${spec}.yml`) },
      environment,
      backend: "mock",
      coldStart: true,
      status,
      startedAt: "2026-10-01T10:00:00.000Z",
      endedAt: "2026-10-01T10:00:01.000Z",
      durationMs,
      outcomes: [],
      steps: [],
      artifacts: {},
      exitCode: status === "passed" ? 0 : 1,
    }),
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-catalog-"));
  runs = join(dir, "runs");
  await put(join(dir, "cairntrace.config.yml"), CONFIG(runs));
  await put(
    join(dir, "actions", "edit_and_save_text_field.yml"),
    EDIT_TEXT_FIELD,
  );
  await put(join(dir, "actions", "login_as_admin.yml"), LOGIN);
  await put(join(dir, "actions", "edit_profile_name.yml"), EDIT_NAME);
  await put(join(dir, "flows", "profile_website_persisted.yml"), WEBSITE_SPEC);
  await put(
    join(dir, "flows", "website_selector_only.yml"),
    SELECTOR_ONLY_SPEC,
  );
  await put(join(dir, "flows", "guest_home.yml"), GUEST_SPEC);
  await put(join(dir, "flows", "_drafts", "rename_company.yml"), DRAFT_SPEC);
  await put(join(dir, "verifiers", "check-website.ts"), CHECK_WEBSITE);
  await put(join(dir, "verifiers", "check-export.ts"), CHECK_EXPORT);
  await put(
    join(dir, "docker-compose.yml"),
    "services:\n  db:\n    image: postgres\n",
  );

  await putRun(
    "2026-09-30T10-00-00-000Z_profile_website_persisted_aaaaaa",
    "profile_website_persisted",
    "passed",
    "local",
    4200,
  );
  await putRun(
    "2026-10-01T10-00-00-000Z_profile_website_persisted_bbbbbb",
    "profile_website_persisted",
    "failed",
    "local",
    5100,
  );
  await putRun(
    "2026-10-01T11-00-00-000Z_guest_home_cccccc",
    "guest_home",
    "passed",
    "shared",
    900,
  );
  await mkdir(join(runs, "_invocations", "x"), { recursive: true });

  store = new CheckpointStore(join(dir, "checkpoints"));
  await store.ensureRoot();
  await writeFile(store.pathFor("admin_session"), '{"cookies":[]}');
  await store.writeMeta(
    store.pathFor("admin_session"),
    buildCheckpointMeta({
      name: "admin_session",
      env: "local",
      baseUrl: "http://localhost:4100",
      ttl: "7d",
    }),
  );
  await writeFile(store.pathFor("orphan_state"), '{"cookies":[]}');
  // Unused, but captured for the local environment's origin: listed.
  await writeFile(store.pathFor("local_viewer"), '{"cookies":[]}');
  await store.writeMeta(
    store.pathFor("local_viewer"),
    buildCheckpointMeta({
      name: "local_viewer",
      env: "local",
      baseUrl: "http://localhost:4100/app",
    }),
  );
  // Another project's checkpoint in the shared store: only counted.
  await writeFile(store.pathFor("elsewhere_session"), '{"cookies":[]}');
  await store.writeMeta(
    store.pathFor("elsewhere_session"),
    buildCheckpointMeta({
      name: "elsewhere_session",
      env: "local",
      baseUrl: "https://elsewhere.example.test",
    }),
  );
});

const catalog = (opts: Parameters<typeof buildCatalog>[0] = {}) =>
  buildCatalog({ cwd: dir, checkpointStore: store, ...opts });

const signInFlow = (name: string) =>
  `version: 1\nname: ${name}\nintent: ${name}\nimports: [../actions/sign_in.yml]\nsteps:\n  - use: sign_in\noutcomes:\n  - id: ok\n    description: ok\n    verify: { text: { contains: ok } }\n`;

describe("buildCatalog", () => {
  it("lists actions with description, inputs, used-by and the last green run", async () => {
    const c = await catalog();
    expect(() => CatalogResultSchema.parse(c)).not.toThrow();
    expect(c.project).toBe("catalog-fixture");
    expect(c.scan).toMatchObject({ specs: 4, actions: 3, runs: 3 });
    expect(c.actions!.map((a) => a.name)).toEqual([
      "edit_and_save_text_field",
      "edit_profile_name",
      "login_as_admin",
    ]);
    const edit = c.actions![0]!;
    expect(edit).toMatchObject({
      file: "actions/edit_and_save_text_field.yml",
      descriptionSource: "field",
      steps: 3,
      usedBy: [
        {
          kind: "spec",
          name: "profile_website_persisted",
          file: "flows/profile_website_persisted.yml",
        },
      ],
      lastGreenRun: {
        runId: "2026-09-30T10-00-00-000Z_profile_website_persisted_aaaaaa",
        status: "passed",
        environment: "local",
        durationMs: 4200,
      },
    });
    expect(edit.problems).toBeUndefined();
    expect(edit.inputs).toEqual([
      {
        name: "textFieldSelector",
        description: "CSS selector of the input to edit",
        required: false,
        default: "[data-field] input",
        declared: true,
        referenced: true,
      },
      {
        name: "textFieldValue",
        description: "Value to type before saving",
        required: false,
        default: "hello",
        declared: true,
        referenced: true,
      },
      // Read in a step with no action default and no config var: the
      // importing spec's vars, a config var or --var must supply it.
      { name: "savedLabel", required: true, declared: false, referenced: true },
    ]);

    const login = c.actions!.find((a) => a.name === "login_as_admin")!;
    expect(login.descriptionSource).toBe("comment");
    expect(login.description).toBe(
      "Sign in as the seeded administrator.\nReads the adminPassword config var.",
    );
    // Supplied by the config in both environments → not required.
    expect(login.inputs).toEqual([
      {
        name: "adminPassword",
        required: false,
        declared: false,
        referenced: true,
        configEnvs: ["local", "shared"],
      },
    ]);

    const rename = c.actions!.find((a) => a.name === "edit_profile_name")!;
    expect(rename.usedBy).toEqual([
      {
        kind: "spec",
        name: "rename_company",
        file: "flows/_drafts/rename_company.yml",
      },
    ]);
    expect(rename.lastGreenRun).toBeUndefined();
  });

  it("lists config vars per environment, masked, with comments and inheritance", async () => {
    const c = await catalog({ kinds: ["vars"] });
    expect(c.kinds).toEqual(["vars"]);
    expect(c.actions).toBeUndefined();
    const local = c.vars!.filter((v) => v.env === "local");
    expect(local.map((v) => v.name)).toEqual([
      "websiteFieldSelector",
      "websiteValue",
      "adminPassword",
      "sessionKey",
      "rootPath",
      "apiToken",
    ]);
    expect(local[0]).toMatchObject({
      value: '[data-field="website"] input',
      comment: "Selector of the Website input on the company profile page",
      definedIn: "environment",
      usedBy: [
        { kind: "spec", name: "profile_website_persisted" },
        { kind: "spec", name: "website_selector_only" },
      ],
    });
    const byName = Object.fromEntries(local.map((v) => [v.name, v]));
    expect(byName.adminPassword).toMatchObject({
      value: "[redacted]",
      masked: true,
    });
    expect(byName.adminPassword!.usedBy).toEqual([
      {
        kind: "action",
        name: "login_as_admin",
        file: "actions/login_as_admin.yml",
      },
    ]);
    expect(byName.sessionKey).toMatchObject({
      value: "[redacted]",
      masked: true,
    });
    expect(byName.rootPath).toMatchObject({ value: "/root" });
    expect(byName.rootPath!.masked).toBeUndefined();
    // A bare placeholder is authored text, never the resolved secret.
    expect(byName.apiToken).toMatchObject({
      value: "${env.CATALOG_TEST_TOKEN}",
    });

    const shared = c.vars!.filter((v) => v.env === "shared");
    expect(shared[0]).toMatchObject({
      name: "websiteValue",
      value: "https://shared.example.test/site",
      comment: "The shared stack keeps its own website value",
      definedIn: "environment",
    });
    expect(shared.find((v) => v.name === "websiteFieldSelector")).toMatchObject(
      {
        definedIn: "inherited",
        inheritedFrom: "local",
        comment: "Selector of the Website input on the company profile page",
      },
    );
    expect(JSON.stringify(c)).not.toContain("hunter2-local");
    expect(JSON.stringify(c)).not.toContain("abcdef0123456789abcdef");
  });

  it("reads verifier contracts and flags unknown and missing fixture keys", async () => {
    const c = await catalog({ kinds: ["verifiers"] });
    const [exportCheck, website] = c.verifiers!;
    expect(website).toMatchObject({
      file: "verifiers/check-website.ts",
      exists: true,
      description:
        "Browser verifier: the profile Website input holds the saved value after\na reload, so the value came from the server.",
      fixtures: {
        source: "header",
        keys: [
          {
            name: "websiteValue",
            description: "expected value",
            required: true,
            source: "header",
          },
          {
            name: "websiteSelector",
            description: "selector of the input",
            required: false,
            source: "header",
          },
        ],
      },
    });
    expect(website!.usedBy).toEqual([
      {
        spec: "profile_website_persisted",
        file: "flows/profile_website_persisted.yml",
        outcome: "website_persisted",
        runtime: "browser",
        fixtureKeys: ["websiteValue", "bogusKey"],
        unknownKeys: ["bogusKey"],
      },
      {
        spec: "website_selector_only",
        file: "flows/website_selector_only.yml",
        outcome: "input_present",
        runtime: "browser",
        fixtureKeys: ["websiteSelector"],
        missingKeys: ["websiteValue"],
      },
    ]);
    expect(exportCheck).toMatchObject({
      file: "verifiers/check-export.ts",
      description: "Node verifier: the exported report lists every row.",
      fixtures: {
        source: "export",
        keys: [
          {
            name: "reportPath",
            description: "absolute path of the exported CSV",
            source: "export",
          },
          {
            name: "rows",
            description: "expected row count",
            required: true,
            source: "export",
          },
        ],
      },
      usedBy: [
        { outcome: "report_exported", runtime: "node", missingKeys: ["rows"] },
      ],
    });
  });

  it("describes environments with policy, services and secrets provider", async () => {
    const c = await catalog({ kinds: ["envs"] });
    expect(c.envs).toEqual([
      {
        name: "local",
        default: true,
        baseUrl: "http://localhost:4100",
        policy: {
          trait: "owned",
          mutations: "allow",
          description: "Your own laptop stack",
        },
        services: { enabled: true, phases: ["docker", "seed"] },
        vars: 6,
      },
      {
        name: "shared",
        default: false,
        baseUrl: "https://shared.example.test",
        policy: { trait: "shared", mutations: "deny" },
        services: { enabled: false, phases: [] },
        secrets: { provider: "env", required: ["SHARED_LOGIN"] },
        vars: 6,
      },
    ]);
  });

  it("lists every services phase an environment boots, its own block alone without a top-level one", async () => {
    const proj = await mkdtemp(join(tmpdir(), "cairn-catalog-env-services-"));
    await writeFile(
      join(proj, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local: {}
  remote:
    services:
      provisioner: { up: ./up.sh, down: ./down.sh }
      tunnels: [{ name: db, command: ssh -N box }]
      files: [{ path: app.json, json: { a: 1 } }]
      seed: { command: ./seed.sh }
suites:
  s:
    specs: [flows]
    processEnv: { ENGINE_MODE: durable }
    labels: { cohort: a }
    env:
      remote:
        bail: false
        labels: { cohort: b }
        seed: { postCommands: { skip: [extra] } }
`,
    );
    await mkdir(join(proj, "flows"), { recursive: true });
    await writeFile(join(proj, "flows", "a.yml"), signInFlow("a"));
    const c = await buildCatalog({ cwd: proj, kinds: ["envs", "suites"] });
    expect(() => CatalogResultSchema.parse(c)).not.toThrow();
    const envs = Object.fromEntries(c.envs!.map((e) => [e.name, e.services]));
    expect(envs).toEqual({
      local: { enabled: false, phases: [] },
      remote: {
        enabled: true,
        phases: ["provisioner", "tunnels", "files", "seed"],
      },
    });
    const suite = c.suites![0]!;
    const byEnv = Object.fromEntries(suite.envs.map((e) => [e.env, e]));
    expect(byEnv.local).toMatchObject({
      processEnv: ["ENGINE_MODE"],
      labels: ["cohort=a"],
    });
    expect(byEnv.local).not.toHaveProperty("bail");
    expect(byEnv.remote).toMatchObject({
      bail: false,
      seedSkip: ["extra"],
      processEnv: ["ENGINE_MODE"],
      labels: ["cohort=b"],
    });
  });

  it("lists flows with tags, requires, drafts and their last run", async () => {
    const c = await catalog({ kinds: ["flows"] });
    const byName = Object.fromEntries(c.flows!.map((f) => [f.name, f]));
    expect(byName.profile_website_persisted).toMatchObject({
      file: "flows/profile_website_persisted.yml",
      tags: ["profile", "website"],
      requires: { env: ["local"] },
      actions: ["login_as_admin", "edit_and_save_text_field"],
      checkpoint: "admin_session",
      lastRun: {
        runId: "2026-10-01T10-00-00-000Z_profile_website_persisted_bbbbbb",
        status: "failed",
        durationMs: 5100,
      },
    });
    expect(byName.rename_company).toMatchObject({
      draft: true,
      actions: ["edit_profile_name"],
    });
    expect(byName.guest_home!.lastRun).toMatchObject({
      status: "passed",
      environment: "shared",
    });

    // --env narrows last runs (and vars) to that environment.
    const shared = await catalog({ kinds: ["flows", "vars"], env: "shared" });
    const sharedFlows = Object.fromEntries(
      shared.flows!.map((f) => [f.name, f]),
    );
    expect(sharedFlows.profile_website_persisted!.lastRun).toBeUndefined();
    expect(sharedFlows.guest_home!.lastRun).toMatchObject({ status: "passed" });
    expect(new Set(shared.vars!.map((v) => v.env))).toEqual(
      new Set(["shared"]),
    );
  });

  it("lists checkpoints with scope, health and an origin check for --env", async () => {
    const c = await catalog({ kinds: ["checkpoints"] });
    const byName = Object.fromEntries(c.checkpoints!.map((k) => [k.name, k]));
    expect(byName.admin_session).toMatchObject({
      health: "ok",
      scope: { env: "local", baseUrl: "http://localhost:4100", ttl: "7d" },
      usedBy: [{ kind: "spec", name: "profile_website_persisted" }],
    });
    expect(byName.admin_session!.problem).toBeUndefined();
    expect(byName.local_viewer).toMatchObject({
      health: "ok",
      scope: { env: "local", baseUrl: "http://localhost:4100/app" },
      usedBy: [],
    });
    // The store is shared across projects: an unused checkpoint with no
    // scope, or one captured for an origin no environment here uses, is
    // only counted.
    expect(Object.keys(byName).toSorted()).toEqual([
      "admin_session",
      "local_viewer",
    ]);
    expect(c.scan.otherCheckpoints).toBe(2);
    expect(JSON.stringify(c)).not.toContain("elsewhere.example.test");
    expect(renderCatalogMarkdown(c)).toContain(
      "2 other checkpoint(s) in the store are not this project's",
    );

    const shared = await catalog({ kinds: ["checkpoints"], env: "shared" });
    expect(
      shared.checkpoints!.find((k) => k.name === "admin_session")!.problem,
    ).toMatchObject({
      code: "base-url-mismatch",
    });
  });

  it("ranks 'edit website field' to the existing edit-and-save action first", async () => {
    const c = await catalog({ query: "edit website field" });
    expect(c.limit).toBe(10);
    const [first, second] = c.actions!;
    expect(first!.name).toBe("edit_and_save_text_field");
    expect(first!.matched).toEqual(
      expect.arrayContaining([
        { token: "edit", field: "name" },
        { token: "field", field: "name" },
        { token: "websit", field: "description" },
      ]),
    );
    expect(second!.name).toBe("edit_profile_name");
    expect(first!.score!).toBeGreaterThan(second!.score!);
    expect(c.actions!.map((a) => a.name)).not.toContain("login_as_admin");
    expect(c.totals.actions).toBe(2);

    expect(c.vars![0]!.name).toBe("websiteFieldSelector");
    expect(c.flows![0]!.name).toBe("profile_website_persisted");
    expect(c.verifiers![0]!.file).toBe("verifiers/check-website.ts");

    const md = renderCatalogMarkdown(c);
    expect(md).toContain("**edit_and_save_text_field**");
    expect(md).toContain("websit→description");
  });

  it("applies --limit per kind and keeps the totals", async () => {
    const c = await catalog({ kinds: ["actions", "flows"], limit: 1 });
    expect(c.actions).toHaveLength(1);
    expect(c.flows).toHaveLength(1);
    expect(c.totals).toEqual({ actions: 3, flows: 4 });
  });

  it("refuses an environment the config does not define", async () => {
    await expect(catalog({ env: "nope" })).rejects.toBeInstanceOf(
      CatalogConfigError,
    );
    await expect(catalog({ env: "nope" })).rejects.toThrow(
      /unknown environment "nope"/,
    );
  });

  it("re-reads a file only when it changed", async () => {
    const path = join(dir, "actions", "edit_profile_name.yml");
    const before = await catalog({ kinds: ["actions"] });
    expect(
      before.actions!.find((a) => a.name === "edit_profile_name")!.description,
    ).toMatch(/^Change/);
    await writeFile(
      path,
      EDIT_NAME.replace("Change the display name", "Rename the display name"),
    );
    const later = new Date(Date.now() + 5_000);
    await utimes(path, later, later);
    const after = await catalog({ kinds: ["actions"] });
    expect(
      after.actions!.find((a) => a.name === "edit_profile_name")!.description,
    ).toMatch(/^Rename/);
    await writeFile(path, EDIT_NAME);
  });

  it("reports action inputs that disagree with vars", async () => {
    const bad = await mkdtemp(join(tmpdir(), "cairn-catalog-bad-"));
    await put(
      join(bad, "actions", "mismatch.yml"),
      `version: 1
name: mismatch
vars: { a: one, b: two }
inputs:
  a: { default: other }
  b: { required: true }
steps:
  - open: /
`,
    );
    const c = await buildCatalog({
      cwd: bad,
      kinds: ["actions"],
      artifactRoot: join(bad, "runs"),
    });
    expect(c.configPath).toBeUndefined();
    expect(c.actions![0]!.problems).toEqual([
      'inputs.a.default ("other") does not match vars.a ("one")',
      "inputs.b is required but has a default (vars.b); drop required or the default",
    ]);
    // No config: an --env cannot be checked, so it is a config error too.
    await expect(
      buildCatalog({ cwd: bad, env: "nope", artifactRoot: join(bad, "runs") }),
    ).rejects.toThrow(/--env "nope" needs a cairntrace\.config\.yml/);
  });

  it("attributes last runs by spec path, not a same-named spec elsewhere", async () => {
    const proj = await mkdtemp(join(tmpdir(), "cairn-catalog-runs-"));
    const runRoot = join(proj, "runs");
    await put(
      join(proj, "cairntrace.config.yml"),
      `version: 1\nartifactRoot: ${runRoot}\nenvironments:\n  local:\n    baseUrl: http://localhost:4100\n`,
    );
    await put(
      join(proj, "actions", "sign_in.yml"),
      "version: 1\nname: sign_in\nsteps:\n  - open: /login\n",
    );
    await put(join(proj, "flows", "login.yml"), signInFlow("login"));
    await put(join(proj, "flows", "moved.yml"), signInFlow("moved"));
    const run = async (
      id: string,
      spec: string,
      path: string,
      status: string,
    ): Promise<void> => {
      await mkdir(join(runRoot, id), { recursive: true });
      await writeFile(
        join(runRoot, id, "run.json"),
        JSON.stringify({
          runId: id,
          spec: { name: spec, path },
          environment: "local",
          status,
        }),
      );
    };
    const here = join(proj, "flows", "login.yml");
    const elsewhere = "/elsewhere/project/flows/login.yml";
    await run("2026-09-01T10-00-00-000Z_login_aaaaa1", "login", here, "passed");
    await run("2026-09-02T10-00-00-000Z_login_aaaaa2", "login", here, "failed");
    await run(
      "2026-09-10T10-00-00-000Z_login_bbbbb1",
      "login",
      elsewhere,
      "passed",
    );
    await run(
      "2026-09-11T10-00-00-000Z_moved_ccccc1",
      "moved",
      "/old/checkout/flows/moved.yml",
      "passed",
    );

    const c = await buildCatalog({ cwd: proj, kinds: ["actions", "flows"] });
    const flows = Object.fromEntries(c.flows!.map((f) => [f.name, f]));
    expect(flows.login!.lastRun).toEqual({
      runId: "2026-09-02T10-00-00-000Z_login_aaaaa2",
      spec: "login",
      status: "failed",
      environment: "local",
    });
    // No run recorded this path: the newest run under the name, flagged.
    expect(flows.moved!.lastRun).toMatchObject({
      runId: "2026-09-11T10-00-00-000Z_moved_ccccc1",
      matchedBy: "name",
    });
    // A path match wins over a newer name-only match.
    expect(c.actions![0]!.lastGreenRun).toEqual({
      runId: "2026-09-01T10-00-00-000Z_login_aaaaa1",
      spec: "login",
      status: "passed",
      environment: "local",
    });
    expect(c.scan.runs).toBe(4);
  });

  it("leaves malformed rows out with a warning instead of failing", async () => {
    const proj = await mkdtemp(join(tmpdir(), "cairn-catalog-loose-"));
    const runRoot = join(proj, "runs");
    await put(
      join(proj, "cairntrace.config.yml"),
      `version: 1\nartifactRoot: ${runRoot}\nenvironments:\n  local:\n    vars:\n      "": orphan\n      kept: yes-kept\n`,
    );
    await put(
      join(proj, "actions", "_drafts", "unnamed.yml"),
      'version: 1\nname: ""\nsteps:\n  - open: /\n',
    );
    await put(
      join(proj, "flows", "checks.yml"),
      `version: 1\nname: checks\nintent: checks\noutcomes:\n  - id: ""\n    description: x\n    verify:\n      script:\n        file: ../verifiers/check.ts\n`,
    );
    await put(join(proj, "verifiers", "check.ts"), "return { ok: true };\n");
    await mkdir(join(runRoot, "2026-09-01T10-00-00-000Z_checks_aaaaa1"), {
      recursive: true,
    });
    await writeFile(
      join(runRoot, "2026-09-01T10-00-00-000Z_checks_aaaaa1", "run.json"),
      JSON.stringify({
        runId: "2026-09-01T10-00-00-000Z_checks_aaaaa1",
        spec: { name: "checks", path: join(proj, "flows", "checks.yml") },
        status: "",
      }),
    );

    const c = await buildCatalog({
      cwd: proj,
      kinds: ["actions", "vars", "verifiers", "flows"],
    });
    expect(() => CatalogResultSchema.parse(c)).not.toThrow();
    expect(c.actions).toEqual([]);
    expect(c.vars!.map((v) => v.name)).toEqual(["kept"]);
    expect(c.verifiers![0]!.usedBy[0]!.outcome).toBe("(unnamed)");
    expect(c.flows![0]!.lastRun).toBeUndefined();
    expect(c.warnings).toEqual(
      expect.arrayContaining([
        "actions/_drafts/unnamed.yml: action name is empty",
        expect.stringMatching(/^vars: left out .*name: /),
      ]),
    );
  });
});

describe("MCP cairn_catalog", () => {
  it("returns the catalog document and exposes cairn://catalog", async () => {
    const server = buildMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: {} },
    );
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const res = await client.callTool({
        name: "cairn_catalog",
        arguments: {
          config: join(dir, "cairntrace.config.yml"),
          query: "edit website field",
          kind: "actions",
        },
      });
      expect(res.isError).toBeFalsy();
      const doc = CatalogResultSchema.parse(res.structuredContent);
      expect(doc.actions![0]!.name).toBe("edit_and_save_text_field");
      expect(doc.kinds).toEqual(["actions"]);
      // The text content is a short summary; the rows travel structured.
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain(
        "actions 2: edit_and_save_text_field, edit_profile_name",
      );
      expect(text).toContain("Rows are in structuredContent");
      expect(text).not.toContain("inputs:");

      // Without query or limit, rows per kind are capped (totals stay whole).
      const unqueried = await client.callTool({
        name: "cairn_catalog",
        arguments: {
          config: join(dir, "cairntrace.config.yml"),
          kind: ["vars", "flows"],
        },
      });
      const capped = CatalogResultSchema.parse(unqueried.structuredContent);
      expect(capped.limit).toBe(20);
      expect(capped.totals).toEqual({ vars: 12, flows: 4 });
      const limited = await client.callTool({
        name: "cairn_catalog",
        arguments: {
          config: join(dir, "cairntrace.config.yml"),
          kind: "vars",
          limit: 3,
        },
      });
      const few = CatalogResultSchema.parse(limited.structuredContent);
      expect(few.vars).toHaveLength(3);
      expect((limited.content as Array<{ text: string }>)[0]!.text).toContain(
        "vars 3 of 12:",
      );

      const unknown = await client.callTool({
        name: "cairn_catalog",
        arguments: { config: join(dir, "cairntrace.config.yml"), env: "nope" },
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.structuredContent).toMatchObject({ exitCode: 4 });

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toContain(
        "cairn://catalog",
      );
      // The resource catalogs the project the server runs in (its cwd).
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const read = await client.readResource({ uri: "cairn://catalog" });
        const content = read.contents[0] as { text: string; mimeType: string };
        expect(content.mimeType).toBe("application/json");
        const whole = CatalogResultSchema.parse(JSON.parse(content.text));
        expect(whole.project).toBe("catalog-fixture");
        // Scoped to defaultEnvironment so the resource stays small.
        expect(whole.env).toBe("local");
        expect(new Set(whole.vars!.map((v) => v.env))).toEqual(
          new Set(["local"]),
        );
        expect(whole.kinds).toHaveLength(8);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await client.close();
    }
  });
});
