import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browseErrorExitCode,
  discoverToMarkdown,
  resolveDiscoverTarget,
  resolveDiscoverUrl,
  type DiscoverReport,
} from "./discover";

describe("resolveDiscoverUrl", () => {
  it("passes absolute URLs through", async () => {
    await expect(resolveDiscoverUrl("https://example.com/x")).resolves.toBe(
      "https://example.com/x",
    );
  });

  it("resolves relative URLs against config baseUrl", async () => {
    const configPath = await writeTestConfig();
    await expect(
      resolveDiscoverUrl("/dashboard", { config: configPath }),
    ).resolves.toBe("http://localhost:8787/dashboard");
  });

  it("resolves relative URLs with a different env", async () => {
    const configPath = await writeTestConfig();
    await expect(
      resolveDiscoverUrl("settings", { config: configPath, env: "preview" }),
    ).resolves.toBe("https://preview.example.com/app/settings");
  });

  it("fails clearly when a relative URL has no config baseUrl", async () => {
    await expect(resolveDiscoverUrl("/settings")).rejects.toThrow(
      /requires environments\.local\.baseUrl/,
    );
  });
});

describe("discoverToMarkdown", () => {
  it("renders a report with snapshot, roles, and testids", () => {
    const report: DiscoverReport = {
      status: "ok",
      requestedUrl: "/login",
      url: "http://localhost:3000/login",
      backend: "mock",
      snapshot: [
        { role: "heading", name: "Welcome", level: 1, ref: "e1" },
        { role: "button", name: "Sign In", level: 2, ref: "e2" },
      ],
      inventory: {
        roles: [
          {
            role: "button",
            name: "Sign In",
            count: 1,
            refs: ["e2"],
            locator: { by: "role", role: "button", name: "Sign In" },
          },
        ],
        testids: [
          {
            testId: "submit-btn",
            count: 1,
            selector: '[data-testid="submit-btn"]',
            tagNames: ["button"],
            textSamples: ["Sign In"],
          },
        ],
      },
    };

    const md = discoverToMarkdown(report);
    expect(md).toContain("# Discover: http://localhost:3000/login");
    expect(md).toContain("## Accessibility Snapshot");
    expect(md).toContain('heading "Welcome" [ref=e1]');
    expect(md).toContain('button "Sign In" [ref=e2]');
    expect(md).toContain("## Roles");
    expect(md).toContain('button "Sign In"');
    expect(md).toContain("## Test IDs");
    expect(md).toContain("submit-btn");
    expect(md).toContain('[data-testid="submit-btn"]');
  });

  it("renders an empty snapshot gracefully", () => {
    const report: DiscoverReport = {
      status: "ok",
      requestedUrl: "/empty",
      url: "http://localhost:3000/empty",
      backend: "mock",
      snapshot: [],
    };

    const md = discoverToMarkdown(report);
    expect(md).toContain("(empty snapshot)");
  });
});

async function writeTestConfig(extra = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-discover-test-"));
  const configPath = join(dir, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8787
  preview:
    baseUrl: https://preview.example.com/app
${extra}`,
  );
  return configPath;
}

describe("resolveDiscoverTarget", () => {
  it("returns the config testIdAttribute and resolves --var placeholders", async () => {
    const configPath = await writeTestConfig(
      "browser:\n  testIdAttribute: data-qa\n",
    );
    const target = await resolveDiscoverTarget("/items/${vars.itemId}", {
      config: configPath,
      var: ["itemId=42"],
    });
    expect(target.url).toBe("http://localhost:8787/items/42");
    expect(target.testIdAttribute).toBe("data-qa");
  });

  it("maps an unknown --env to exit code 4", async () => {
    const configPath = await writeTestConfig();
    const err = await resolveDiscoverTarget("/x", {
      config: configPath,
      env: "nope",
    }).catch((e: unknown) => e);
    expect(browseErrorExitCode(err)).toBe(4);
    expect(browseErrorExitCode(new Error("other"))).toBe(2);
  });
});

describe("discoverToMarkdown test-id attribute", () => {
  it("names a custom test-id attribute", () => {
    const md = discoverToMarkdown({
      status: "ok",
      requestedUrl: "/x",
      url: "http://localhost/x",
      backend: "mock",
      snapshot: [],
      inventory: { testids: [], testIdAttribute: "data-qa" },
    });
    expect(md).toContain("## Test IDs (data-qa)");
    expect(md).toContain("No data-qa attributes found");
  });
});

describe("discover setup flags", () => {
  it("maps --use / --from-spec to a setup", async () => {
    const { setupFromFlags } = await import("./discover");
    expect(setupFromFlags({})).toBeUndefined();
    expect(
      setupFromFlags({ use: ["login", "pick:org=acme,plan=pro"] }),
    ).toEqual([
      { use: "login" },
      { use: "pick", vars: { org: "acme", plan: "pro" } },
    ]);
    expect(setupFromFlags({ fromSpec: "flows/a.yml", untilStep: "3" })).toEqual(
      {
        fromSpec: "flows/a.yml",
        untilStep: 3,
      },
    );
    expect(() => setupFromFlags({ fromSpec: "flows/a.yml" })).toThrow(
      /go together/,
    );
    expect(() =>
      setupFromFlags({ use: ["x"], fromSpec: "a", untilStep: "b" }),
    ).toThrow(/not both/);
  });

  it("loads an outcomes file (array or { outcomes })", async () => {
    const { loadOutcomesFile } = await import("./discover");
    const dir = await mkdtemp(join(tmpdir(), "cairn-outcomes-"));
    const a = join(dir, "a.yml");
    await writeFile(
      a,
      "- id: ok\n  description: d\n  verify: { text: { contains: X } }\n",
    );
    expect(await loadOutcomesFile(a)).toHaveLength(1);
    const b = join(dir, "b.json");
    await writeFile(
      b,
      JSON.stringify({
        outcomes: [{ id: "Bad Id", description: "d", verify: {} }],
      }),
    );
    await expect(loadOutcomesFile(b)).rejects.toThrow(/outcome 1/);
  });
});

describe("cairn discover → sessions → export --from-session (CLI)", () => {
  const CAIRN = join(process.cwd(), "bin", "cairn");
  it("journals a one-shot and exports it from the journal", async () => {
    const { execa } = await import("execa");
    const { readFile, mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "cairn-discover-cli-"));
    const root = join(dir, "runs");
    await mkdir(join(dir, "actions"), { recursive: true });
    await writeFile(
      join(dir, "actions", "sign_in.yml"),
      "version: 1\nname: sign_in\nsteps:\n  - open: /login\n",
    );
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1\nartifactRoot: ${root}\nenvironments:\n  local: {}\n`,
    );
    const opened = await execa(
      CAIRN,
      [
        "discover",
        "/home",
        "--mock",
        "--use",
        "sign_in",
        "--snapshot-mode",
        "compact",
        "--json",
      ],
      { cwd: dir, reject: false },
    );
    expect(opened.exitCode, opened.stderr).toBe(0);
    const report = JSON.parse(opened.stdout);
    expect(report).toMatchObject({
      status: "ok",
      requestedUrl: "/home",
      backend: "mock",
      setup: { ok: true, steps: 1 },
      snapshotInfo: { mode: "compact" },
    });
    expect(report.journal).toBe(join(root, "_sessions", report.sessionId));

    const listed = await execa(CAIRN, ["discover", "sessions", "--json"], {
      cwd: dir,
      reject: false,
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).sessions[0]).toMatchObject({
      sessionId: report.sessionId,
      kind: "discovery",
      status: "closed",
    });

    // Never exported: there is no contract to reuse.
    const noContract = await execa(
      CAIRN,
      [
        "discover",
        "export",
        "--from-session",
        report.sessionId,
        "--path",
        "flows/home.yml",
        "--json",
      ],
      { cwd: dir, reject: false },
    );
    expect(noContract.exitCode).toBe(4);
    expect(noContract.stderr).toContain("no earlier export");

    const outcomes = join(dir, "outcomes.yml");
    await writeFile(
      outcomes,
      "- id: home\n  description: home page\n  verify: { url: { endsWith: /home } }\n",
    );
    const exported = await execa(
      CAIRN,
      [
        "discover",
        "export",
        "--from-session",
        report.sessionId,
        "--path",
        "flows/home.yml",
        "--intent",
        "A signed-in user reaches home",
        "--outcomes",
        outcomes,
        "--json",
      ],
      { cwd: dir, reject: false },
    );
    expect(exported.exitCode, exported.stderr).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({
      path: "flows/home.yml",
      verifyOk: true,
      stepCount: 2,
      sessionId: report.sessionId,
    });
    const spec = await readFile(join(dir, "flows", "home.yml"), "utf8");
    expect(spec).toContain("- use: sign_in");
    expect(spec).toContain("../actions/sign_in.yml");

    // A re-export reuses the intent and outcomes the first export recorded.
    const again = await execa(
      CAIRN,
      [
        "discover",
        "export",
        "--from-session",
        report.sessionId,
        "--path",
        "flows/home_again.yml",
        "--json",
      ],
      { cwd: dir, reject: false },
    );
    expect(again.exitCode, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reused the intent and outcomes"),
      ]),
    );
    const respec = await readFile(join(dir, "flows", "home_again.yml"), "utf8");
    expect(respec).toContain("intent: A signed-in user reaches home");
    expect(respec).toContain("id: home");

    const missing = await execa(
      CAIRN,
      [
        "discover",
        "export",
        "--from-session",
        "nope-nope-nope",
        "--path",
        "x.yml",
        "--intent",
        "x",
        "--outcomes",
        outcomes,
      ],
      { cwd: dir, reject: false },
    );
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("session journal not found");
  }, 60_000);

  it("exits 7 when the environment policy refuses --from-spec, 4 for an unknown --use", async () => {
    const { execa } = await import("execa");
    const { mkdir } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "cairn-discover-cli-"));
    await mkdir(join(dir, "flows"), { recursive: true });
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
artifactRoot: ${join(dir, "runs")}
defaultEnvironment: local
environments:
  local: { baseUrl: "http://localhost:9" }
  staging: { baseUrl: "http://localhost:9" }
`,
    );
    await writeFile(
      join(dir, "flows", "staging_only.yml"),
      `version: 1
name: staging_only
intent: x
requires: { env: [staging] }
outcomes:
  - id: o
    description: d
    verify: { url: { matches: ".*" } }
steps:
  - id: go
    open: /profile
`,
    );
    const refused = await execa(
      CAIRN,
      [
        "discover",
        "--mock",
        "--from-spec",
        "flows/staging_only.yml",
        "--until-step",
        "go",
        "--json",
      ],
      { cwd: dir, reject: false },
    );
    expect(refused.exitCode, refused.stderr).toBe(7);
    expect(refused.stderr).toContain('refused in environment "local"');

    const unknown = await execa(
      CAIRN,
      ["discover", "--mock", "--use", "no_such_action", "--json"],
      { cwd: dir, reject: false },
    );
    expect(unknown.exitCode, unknown.stderr).toBe(4);
  }, 60_000);
});
