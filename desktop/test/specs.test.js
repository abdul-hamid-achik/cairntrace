/**
 * Project + spec inspection: config discovery, artifact-root resolution, spec
 * file discovery, and the YAML summary the Specs view renders.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const specs = require("../lib/specs");
const { cleanup, makeProject, tempDir, write } = require("./helpers");

after(cleanup);

describe("findConfig", () => {
  it("walks up from a nested spec directory", () => {
    const root = makeProject();
    const nested = path.join(root, "flows", "deep", "deeper");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(
      specs.findConfig(nested),
      path.join(root, "cairntrace.config.yml"),
    );
  });

  it("finds a .yaml variant", () => {
    const root = tempDir("cairn-cfg-");
    write(root, "cairntrace.config.yaml", "version: 1\n");
    assert.equal(
      specs.findConfig(path.join(root, "flows")),
      path.join(root, "cairntrace.config.yaml"),
    );
  });

  it("returns null when nothing is found within the depth bound", () => {
    assert.equal(specs.findConfig(tempDir("cairn-empty-"), 1), null);
  });
});

describe("readProjectConfig", () => {
  it("exposes environments, artifact root, and browser settings", () => {
    const root = makeProject();
    const config = specs.readProjectConfig(
      path.join(root, "cairntrace.config.yml"),
    );
    assert.equal(config.project, "fixture-project");
    assert.equal(config.defaultEnvironment, "local");
    assert.equal(config.artifactRoot, "/tmp/fixture-runs");
    assert.equal(config.testIdAttribute, "data-qa");
    assert.equal(config.parseError, null);
    assert.deepEqual(
      config.environments.map((env) => [env.name, env.baseUrl]),
      [
        ["local", "http://localhost:8787"],
        ["staging", "https://staging.example.com"],
      ],
    );
    const staging = config.environments.find((env) => env.name === "staging");
    assert.equal(
      staging.disabled,
      true,
      "services: false must surface as disabled",
    );
  });

  it("reports a parse error instead of throwing", () => {
    const root = tempDir("cairn-badcfg-");
    const file = write(
      root,
      "cairntrace.config.yml",
      "environments: [\n  broken\n",
    );
    const config = specs.readProjectConfig(file);
    assert.match(
      config.parseError,
      /line \d+, column \d+|sequence|indent|expected/i,
    );
    assert.deepEqual(config.environments, []);
  });

  it("returns an empty shape for a missing config", () => {
    const config = specs.readProjectConfig(null);
    assert.equal(config.path, null);
    assert.equal(config.parseError, null);
    assert.equal(config.hasWebServer, false);
  });
});

describe("resolveRunsRoot", () => {
  it("prefers the explicit setting, then config, then the default", () => {
    assert.deepEqual(
      specs.resolveRunsRoot({
        configured: "/tmp/mine",
        configArtifactRoot: "/tmp/cfg",
        home: "/home/u",
      }),
      { runsRoot: "/tmp/mine", source: "settings" },
    );
    assert.deepEqual(
      specs.resolveRunsRoot({
        configArtifactRoot: "/tmp/cfg",
        home: "/home/u",
      }),
      { runsRoot: "/tmp/cfg", source: "config" },
    );
    assert.deepEqual(specs.resolveRunsRoot({ home: "/home/u" }), {
      runsRoot: "/home/u/.cairntrace/runs",
      source: "default",
    });
  });

  it("ignores blank settings", () => {
    assert.equal(
      specs.resolveRunsRoot({ configured: "   ", home: "/home/u" }).source,
      "default",
    );
  });
});

describe("findSpecFiles", () => {
  it("finds spec YAMLs and skips node_modules and non-specs", () => {
    const root = makeProject();
    const found = specs.findSpecFiles(root).map((file) => file.rel);
    assert.ok(
      found.includes(path.join("flows", "checkout.yml")),
      `missing checkout.yml in ${found}`,
    );
    assert.ok(
      !found.some((rel) => rel.includes("node_modules")),
      "node_modules must be skipped",
    );
    assert.ok(
      !found.includes(path.join("config", "docker-compose.yml")),
      "a compose file is not a spec",
    );
  });

  it("flags a spec whose YAML does not parse", () => {
    const root = makeProject();
    const found = specs.findSpecFiles(root);
    const broken = found.find((file) => file.rel.endsWith("broken.yml"));
    assert.ok(broken, "broken.yml should still be listed");
    const summary = specs.summarizeSpecText(
      fs.readFileSync(broken.path, "utf8"),
      broken.path,
    );
    assert.ok(summary.parseError, "parse error must be reported");
  });

  it("honours the limit", () => {
    const root = makeProject();
    assert.ok(specs.findSpecFiles(root, { limit: 1 }).length <= 1);
  });
});

describe("isSpecText", () => {
  it("requires steps plus intent or outcomes", () => {
    assert.equal(
      specs.isSpecText("steps:\n  - open: /\nintent: do a thing\n"),
      true,
    );
    assert.equal(specs.isSpecText("steps:\n  - open: /\noutcomes: []\n"), true);
    assert.equal(specs.isSpecText("intent: no steps here\n"), false);
    assert.equal(specs.isSpecText("services:\n  docker: {}\n"), false);
    assert.equal(specs.isSpecText(""), false);
  });
});

describe("summarizeSpecText", () => {
  const text = () =>
    fs.readFileSync(path.join(makeProject(), "flows", "checkout.yml"), "utf8");

  it("extracts the contract surface", () => {
    const summary = specs.summarizeSpecText(text(), "checkout.yml");
    assert.equal(summary.name, "checkout");
    assert.equal(summary.intent, "a guest can complete checkout");
    assert.deepEqual(summary.imports, ["actions/login_admin.yml"]);
    assert.deepEqual(summary.tags, ["smoke", "checkout"]);
    assert.equal(summary.parseError, null);
    assert.deepEqual(
      summary.outcomes.map((outcome) => [outcome.id, outcome.verifiers]),
      [["order_saved", ["text"]]],
    );
    assert.deepEqual(
      summary.steps.map((step) => [step.id, step.kind]),
      [
        ["open_home", "open"],
        ["click_buy", "click"],
        ["maybe_dismiss", "click"],
      ],
    );
    const conditional = summary.steps.find(
      (step) => step.id === "maybe_dismiss",
    );
    assert.equal(conditional.when, "text:Accept cookies");
    assert.equal(conditional.optional, true);
  });

  it("falls back to the filename for an unnamed spec", () => {
    const summary = specs.summarizeSpecText(
      "steps:\n  - open: /\nintent: x\n",
      "/p/flows/my_flow.yml",
    );
    assert.equal(summary.name, "my_flow");
  });

  it("reports an empty spec", () => {
    assert.match(specs.summarizeSpecText("", "a.yml").parseError, /empty/);
  });
});

describe("stepKind", () => {
  it("names the step from its action key", () => {
    assert.equal(specs.stepKind({ id: "a", click: {} }), "click");
    assert.equal(specs.stepKind({ id: "a", use: "login" }), "use");
    assert.equal(specs.stepKind({ id: "a", wait: { text: "x" } }), "wait");
    assert.equal(specs.stepKind({ id: "a", batch: [] }), "batch");
    assert.equal(specs.stepKind({ id: "a", request: {} }), "request");
    assert.equal(specs.stepKind(null), "step");
  });

  it("falls back to the first unknown key", () => {
    assert.equal(specs.stepKind({ id: "a", futureAction: {} }), "futureAction");
  });
});

describe("scaffoldTarget", () => {
  it("sanitises the name and joins it to the output dir", () => {
    assert.equal(
      specs.scaffoldTarget("/p/flows", "checkout flow!"),
      "/p/flows/checkout_flow_.yml",
    );
    assert.equal(
      specs.scaffoldTarget("/p/flows", "ok-name_1"),
      "/p/flows/ok-name_1.yml",
    );
  });
});

describe("inspectProjectDir", () => {
  it("reports config, git, and package.json presence", () => {
    const root = makeProject();
    const info = specs.inspectProjectDir(root);
    assert.equal(info.dir, root);
    assert.equal(info.configPath, path.join(root, "cairntrace.config.yml"));
    assert.equal(info.isGit, false);
    assert.equal(info.hasPackageJson, false);
  });
});

describe("spec discovery hygiene", () => {
  /** A project whose runs/exports hold copies that must never list as specs. */
  function noisyProject() {
    const root = makeProject();
    const spec = "steps:\n  - open: /\nintent: copy\n";
    write(
      root,
      "runs/2026-09-01T10-00-00-000Z_checkout_aaaaaa/spec.resolved.yml",
      spec,
    );
    write(root, "runs/2026-09-01T10-00-00-000Z_checkout_aaaaaa/run.yaml", spec);
    write(root, "exports/checkout.yml", spec);
    write(root, "playwright-export/checkout.yml", spec);
    write(root, "reports/checkout.yml", spec);
    write(
      root,
      "flows/2026-09-01T10-00-00-000Z_checkout_bbbbbb/spec.yml",
      spec,
    );
    write(root, "flows/nested/spec.resolved.yml", spec);
    write(root, "custom-artifacts/2026/copy.yml", spec);
    return root;
  }

  it("skips runs/, exports, reports, run-dir copies, and resolved/run YAMLs", () => {
    const root = noisyProject();
    const found = specs.findSpecFiles(root).map((file) => file.rel);
    assert.ok(found.includes(path.join("flows", "checkout.yml")));
    for (const rel of found) {
      assert.ok(!rel.startsWith("runs"), rel);
      assert.ok(!rel.startsWith("exports"), rel);
      assert.ok(!rel.startsWith("playwright-export"), rel);
      assert.ok(!rel.startsWith("reports"), rel);
      assert.ok(!rel.endsWith("spec.resolved.yml"), rel);
      assert.ok(!rel.includes("_checkout_bbbbbb"), rel);
      assert.ok(!rel.endsWith("cairntrace.config.yml"), rel);
    }
  });

  it("lists authored specs in feature folders named exports/reports/runs", () => {
    const root = makeProject();
    const spec = "steps:\n  - open: /\nintent: authored\n";
    write(root, "flows/exports/exports-flow.yml", spec);
    write(root, "flows/reports/reports-flow.yml", spec);
    write(root, "flows/runs/runs-flow.yml", spec);
    write(root, "flows/billing/billing-flow.yml", spec);
    // Output-shaped folders deeper in the tree are still skipped.
    write(
      root,
      "suites/runs/2026-09-01T10-00-00-000Z_copy_cccccc/spec.resolved.yml",
      spec,
    );
    write(root, "suites/runs/loose-copy.yml", spec);
    write(root, "suites/exports/.cairn-export.json", "{}");
    write(root, "suites/exports/exported.yml", spec);
    write(root, "suites/reports/_invocations/inv_1/invocation.json", "{}");
    write(root, "suites/reports/report-copy.yml", spec);
    const expected = [
      path.join("flows", "billing", "billing-flow.yml"),
      path.join("flows", "exports", "exports-flow.yml"),
      path.join("flows", "reports", "reports-flow.yml"),
      path.join("flows", "runs", "runs-flow.yml"),
    ];
    const found = specs.findSpecFiles(root).map((file) => file.rel);
    for (const rel of expected) assert.ok(found.includes(rel), rel);
    assert.ok(!found.some((rel) => rel.startsWith("suites")), found.join());
  });

  it("never lists a session journal's draft, and lists drafts folders", () => {
    const root = makeProject();
    const spec = "steps:\n  - open: /\nintent: draft\n";
    // A session journal in a stray artifact root: its draft is a working copy.
    write(root, "artifacts/_sessions/abc123def/draft.spec.yml", spec);
    write(root, "suites/reports/_sessions/abc123def/draft.spec.yml", spec);
    write(root, "suites/reports/report-copy.yml", spec);
    // An authored drafts folder (`authoring.draftsDir`) is the author's.
    write(root, "flows/_drafts/profile_website.yml", spec);
    const found = specs.findSpecFiles(root).map((file) => file.rel);
    assert.ok(
      found.includes(path.join("flows", "_drafts", "profile_website.yml")),
      found.join(),
    );
    assert.ok(!found.some((rel) => rel.includes("_sessions")), found.join());
    assert.ok(!found.some((rel) => rel.startsWith("suites")), found.join());
  });

  it("skips runs/exports/reports at the project root even without markers", async () => {
    const root = makeProject();
    const spec = "steps:\n  - open: /\nintent: copy\n";
    write(root, "exports/plain.yml", spec);
    write(root, "flows/exports/kept.yml", spec);
    const scanned = (await specs.scanSpecs(root)).map((file) => file.rel);
    assert.ok(scanned.includes(path.join("flows", "exports", "kept.yml")));
    assert.ok(!scanned.some((rel) => rel.startsWith("exports")));
  });

  it("skips the resolved artifact root wherever it lives", () => {
    const root = noisyProject();
    const withRoot = specs
      .findSpecFiles(root, {
        excludeDirs: [path.join(root, "custom-artifacts")],
      })
      .map((file) => file.rel);
    assert.ok(!withRoot.some((rel) => rel.startsWith("custom-artifacts")));
    const without = specs.findSpecFiles(root).map((file) => file.rel);
    assert.ok(without.some((rel) => rel.startsWith("custom-artifacts")));
  });

  it("scanSpecs (async) matches findSpecFiles and caches summaries by mtime", async () => {
    const root = noisyProject();
    const cache = new Map();
    const scanned = await specs.scanSpecs(root, { cache });
    assert.deepEqual(
      scanned.map((file) => file.rel).toSorted(),
      specs
        .findSpecFiles(root)
        .map((file) => file.rel)
        .toSorted(),
    );
    const checkout = scanned.find(
      (file) => file.rel === path.join("flows", "checkout.yml"),
    );
    assert.equal(checkout.summary.name, "checkout");
    assert.ok(cache.size > 0);
    // A cached entry is reused as-is (proved by poisoning it).
    const key = checkout.path;
    cache.set(key, { ...cache.get(key), summary: { name: "from-cache" } });
    const again = await specs.scanSpecs(root, { cache });
    assert.equal(
      again.find((file) => file.path === key).summary.name,
      "from-cache",
    );
  });
});

describe("artifactRoot resolution like the CLI", () => {
  it("resolves a relative config artifactRoot against the project (cairn's cwd)", () => {
    assert.deepEqual(
      specs.resolveRunsRoot({
        configArtifactRoot: "runs",
        baseDir: "/work/demo",
        home: "/home/u",
      }),
      { runsRoot: path.resolve("/work/demo/runs"), source: "config" },
    );
  });

  it("substitutes ${env.X} / ${env.X:-default} like the CLI loader", () => {
    assert.equal(
      specs.substituteConfigEnv("artifactRoot: ${env.RUNS_DIR:-runs}", {}),
      "artifactRoot: runs",
    );
    assert.equal(
      specs.substituteConfigEnv("artifactRoot: ${env.RUNS_DIR:-runs}", {
        RUNS_DIR: "/data/runs",
      }),
      "artifactRoot: /data/runs",
    );
    assert.equal(specs.substituteConfigEnv("x: ${env.MISSING}", {}), "x: ");
  });

  it("substitutes ${config.dir} with the config file's directory, like the CLI", () => {
    const root = tempDir("cairn-cfgdir-");
    // A directory name with YAML-significant characters must not break it.
    const dir = path.join(root, "team #1: demo");
    const configPath = write(
      dir,
      "cairntrace.config.yml",
      "version: 1\nartifactRoot: ${config.dir}/runs\n",
    );
    const config = specs.readProjectConfig(configPath);
    assert.equal(config.parseError, null);
    assert.equal(config.artifactRoot, `${dir}/runs`);
    assert.deepEqual(
      specs.resolveRunsRoot({
        configArtifactRoot: config.artifactRoot,
        baseDir: "/elsewhere",
        home: "/home/u",
      }),
      { runsRoot: path.join(dir, "runs"), source: "config" },
    );
    // Env substitution and merge keys still apply.
    assert.deepEqual(
      specs.parseConfigText(
        "base: &b\n  x: 1\nenvironments:\n  local:\n    <<: *b\n    dir: ${config.dir}\n    name: ${env.NAME:-n}\n",
        "/work/demo/cairntrace.config.yml",
        {},
      ).environments.local,
      { x: 1, dir: "/work/demo", name: "n" },
    );
  });
});

describe("summarizeSpecText when:", () => {
  it("keeps string and object when: predicates as text", () => {
    const summary = specs.summarizeSpecText(
      [
        "intent: demo",
        "steps:",
        "  - id: a",
        "    click: { role: button, name: Accept }",
        "    when: 'text:Accept cookies'",
        "  - id: b",
        "    click: { role: button, name: Close }",
        "    when: { selector: '.banner', hasText: Close }",
        "",
      ].join("\n"),
      "/p/demo.yml",
    );
    assert.deepEqual(
      summary.steps.map((step) => step.when),
      ["text:Accept cookies", "selector: .banner, hasText: Close"],
    );
  });
});

describe("environment policy and requires (contract 2b)", () => {
  it("reads each environment's policy block from the config", () => {
    const root = tempDir("cairn-policy-");
    const file = write(
      root,
      "cairntrace.config.yml",
      [
        "defaultEnvironment: local",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:8787",
        "    policy: { trait: owned, mutations: allow }",
        "  staging:",
        "    baseUrl: https://staging.example.com",
        "    policy:",
        "      trait: shared",
        "      mutations: deny",
        "      description: shared with the QA team",
        "  prod:",
        "    baseUrl: https://example.com",
        "    policy: { trait: protected, mutations: deny }",
        "  sandbox:",
        "    baseUrl: http://localhost:9000",
        "",
      ].join("\n"),
    );
    const config = specs.readProjectConfig(file);
    const byName = Object.fromEntries(
      config.environments.map((env) => [env.name, env.policy]),
    );
    assert.deepEqual(byName.local, {
      trait: "owned",
      mutations: "allow",
      description: null,
    });
    assert.deepEqual(byName.staging, {
      trait: "shared",
      mutations: "deny",
      description: "shared with the QA team",
    });
    assert.equal(byName.prod?.trait, "protected");
    assert.equal(byName.sandbox, null);
  });

  it("summarizes a spec's requires block (env list with opt-ins, mutates)", () => {
    const summary = specs.summarizeSpecText(
      [
        "name: reset_orders",
        "intent: reset orders",
        "requires:",
        "  env:",
        "    - local",
        "    - staging: { optIn: ALLOW_STAGING_RESET }",
        "  mutates: true",
        "outcomes: []",
        "steps:",
        "  - open: /",
        "",
      ].join("\n"),
      "reset.yml",
    );
    assert.deepEqual(summary.requires, {
      env: [
        { name: "local", optIn: null },
        { name: "staging", optIn: "ALLOW_STAGING_RESET" },
      ],
      mutates: true,
    });
    assert.equal(
      specs.summarizeSpecText("intent: x\nsteps: []\n", "x.yml").requires,
      null,
    );
  });
});
