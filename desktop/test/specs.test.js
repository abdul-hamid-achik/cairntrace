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
