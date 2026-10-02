import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { MockBrowserBackend } from "../adapters/mock/MockBrowserBackend";
import type { Step } from "../core/schema/spec.v1";
import { buildMcpServer } from "./server";

/**
 * A scripted agent follows the `author-flow` recipe over MCP against a
 * neutral fixture project (mock browser): catalog → discover with a login
 * setup → fill + save (the save PATCHes) → convention export into the
 * drafts dir (the recorded settings steps become `use: open_settings`) →
 * spec finish (cold start, stamped; mock backend) → promote, which wants
 * force for a mock finish.
 */

const SECRET = "Fixture-Pass-9137";

async function fixtureProject(): Promise<{
  dir: string;
  config: string;
  root: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-author-flow-"));
  const root = join(dir, "runs");
  await mkdir(join(dir, "actions"), { recursive: true });
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(
    join(dir, "actions", "login.yml"),
    `version: 1
name: login
description: Sign in as the supplier user
steps:
  - open: /login
  - fill: { by: label, name: Email, value: "\${vars.supplierEmail}" }
  - fill: { by: label, name: Password, value: "\${secrets.PORTAL_PASSWORD}" }
  - click: { by: role, role: button, name: Sign in }
`,
  );
  await writeFile(
    join(dir, "actions", "open_settings.yml"),
    `version: 1
name: open_settings
description: Open the account settings page
steps:
  - open: /settings
  - click: { by: role, role: tab, name: Notifications }
`,
  );
  const config = join(dir, "cairntrace.config.yml");
  await writeFile(
    config,
    `version: 1
project: portal-fixture
artifactRoot: ${root}
defaultEnvironment: local
secrets:
  provider: env
  required: [PORTAL_PASSWORD]
authoring:
  template:
    requires: { env: [local] }
    metadata: { tags: [profile] }
environments:
  local:
    baseUrl: http://portal.test
    vars:
      # The supplier account the fixture seeds.
      supplierEmail: supplier@example.test
      # Value the profile tests write into the Website field.
      websiteValue: https://acme.example.test
`,
  );
  return { dir, config, root };
}

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client(
    { name: "author-flow-agent", version: "1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = await c.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    sc: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: (result.content as Array<{ text: string }>)[0]?.text ?? "",
  };
}

describe("author-flow (scripted agent over MCP, mock browser)", () => {
  const savedPassword = process.env["PORTAL_PASSWORD"];
  beforeEach(() => {
    process.env["PORTAL_PASSWORD"] = SECRET;
    // The fixture app: Save PATCHes the profile and confirms it.
    const original = MockBrowserBackend.prototype.runStep;
    vi.spyOn(MockBrowserBackend.prototype, "runStep").mockImplementation(
      async function (this: MockBrowserBackend, step: Step) {
        const result = await original.call(this, step);
        if (
          "click" in step &&
          (step.click as { name?: string }).name === "Save"
        ) {
          this.pushNetworkEntry({
            method: "PATCH",
            url: "http://portal.test/api/profile/42?draft=0",
            status: 204,
            resourceType: "fetch",
          });
          this.setPageText("Profile saved");
        }
        return result;
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedPassword === undefined) delete process.env["PORTAL_PASSWORD"];
    else process.env["PORTAL_PASSWORD"] = savedPassword;
  });

  it("goes from a request to a promoted, stamped spec", async () => {
    const p = await fixtureProject();
    const c = await connect();

    // 0. The recipe itself.
    const prompts = await c.listPrompts();
    expect(prompts.prompts.map((x) => x.name)).toContain("author-flow");
    const prompt = await c.getPrompt({
      name: "author-flow",
      arguments: {
        request:
          "Sign in as the supplier, set the profile website, save, check it persisted.",
        env: "local",
        targetDir: "flows/_drafts",
      },
    });
    const recipe = (prompt.messages[0]!.content as { text: string }).text;
    for (const tool of [
      "cairn_catalog",
      "cairn_discover_open",
      "cairn_discover_interact",
      "cairn_discover_export",
      "cairn_spec_finish",
      "cairn_spec_promote",
    ]) {
      expect(recipe).toContain(tool);
    }
    expect(recipe).toContain('snapshotMode: "diff"');

    // 1. Catalog first.
    const catalog = await call(c, "cairn_catalog", {
      config: p.config,
      env: "local",
      query: "profile website login",
    });
    expect(catalog.isError, catalog.text).toBe(false);
    const actions = (catalog.sc["actions"] as Array<{ name: string }>).map(
      (a) => a.name,
    );
    expect(actions).toContain("login");
    const vars = (catalog.sc["vars"] as Array<{ name: string }>).map(
      (v) => v.name,
    );
    expect(vars).toContain("websiteValue");

    // 2. Discover with the login action as setup.
    const opened = await call(c, "cairn_discover_open", {
      config: p.config,
      env: "local",
      mock: true,
      setup: [{ use: "login" }],
      url: "/profile",
      snapshotMode: "diff",
      ttlMs: 600_000,
    });
    expect(opened.isError, opened.text).toBe(false);
    const sessionId = opened.sc["sessionId"] as string;
    const journal = opened.sc["journal"] as string;

    // 3. Interact: fill the website, confirm with the password, save.
    const filled = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "fill",
      target: { by: "label", name: "Website" },
      value: "https://acme.example.test",
      snapshotMode: "diff",
    });
    expect(filled.isError, filled.text).toBe(false);
    const confirmed = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "fill",
      target: { by: "label", name: "Current password" },
      value: SECRET,
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    expect(JSON.stringify(confirmed.sc["recordedStep"])).not.toContain(SECRET);
    const saved = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "click",
      target: { by: "role", role: "button", name: "Save" },
    });
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.sc["network"]).toEqual({
      mutations: [{ method: "PATCH", path: "/api/profile/42", status: 204 }],
    });
    // Then the notification settings: the steps `open_settings` performs.
    const settings = await call(c, "cairn_discover_navigate", {
      sessionId,
      url: "/settings",
    });
    expect(settings.isError, settings.text).toBe(false);
    const tab = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "click",
      target: { by: "role", role: "tab", name: "Notifications" },
    });
    expect(tab.isError, tab.text).toBe(false);

    // 4. Export with conventions into the drafts dir.
    const exported = await call(c, "cairn_discover_export", {
      sessionId,
      config: p.config,
      into: "flows/_drafts",
      name: "profile_website_persisted",
      intent:
        "A supplier can change the profile website and the change is saved",
      outcomes: [
        {
          id: "profile_saved",
          description: "The profile confirms the save",
          verify: { text: { contains: "Profile saved" } },
        },
      ],
    });
    expect(exported.isError, exported.text).toBe(false);
    const draftPath = join(
      p.dir,
      "flows",
      "_drafts",
      "profile_website_persisted.yml",
    );
    expect(resolve(exported.sc["path"] as string)).toBe(draftPath);
    expect(exported.sc["draft"]).toBe(true);
    const report = exported.sc["report"] as {
      liftedVars: Array<{ var: string; value?: string }>;
      reusedActions: Array<{
        action: string;
        source: string;
        applied: boolean;
        steps?: [number, number];
      }>;
      secretsPlaceholdered: unknown[];
    };
    expect(report.reusedActions).toContainEqual(
      expect.objectContaining({
        action: "login",
        source: "setup",
        applied: true,
      }),
    );
    // The recorded /settings + Notifications steps became `use: open_settings`.
    expect(report.reusedActions).toContainEqual(
      expect.objectContaining({
        action: "open_settings",
        source: "recorded",
        applied: true,
      }),
    );
    expect(report.liftedVars).toContainEqual(
      expect.objectContaining({
        var: "websiteValue",
        value: "https://acme.example.test",
      }),
    );

    const draftText = await readFile(draftPath, "utf8");
    expect(draftText).not.toContain(SECRET);
    expect(draftText).toContain("${secrets.PORTAL_PASSWORD}");
    expect(draftText).toContain("${vars.websiteValue}");
    const draft = parseYaml(draftText) as {
      name: string;
      requires: unknown;
      metadata: { tags: string[] };
      imports: string[];
      steps: Array<Record<string, unknown>>;
    };
    expect(draft.name).toBe("profile_website_persisted");
    expect(draft.requires).toEqual({ env: ["local"] });
    expect(draft.metadata.tags).toEqual(["profile"]);
    expect(draft.imports).toEqual([
      "../../actions/login.yml",
      "../../actions/open_settings.yml",
    ]);
    expect(draft.steps[0]).toMatchObject({ use: "login" });
    expect(draft.steps).toContainEqual(
      expect.objectContaining({
        id: "use_open_settings",
        use: "open_settings",
      }),
    );
    expect(JSON.stringify(draft.steps)).not.toContain("Notifications");
    for (const step of draft.steps) {
      expect(step["id"]).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(draft.steps.map((s) => s["id"])).size).toBe(
      draft.steps.length,
    );
    expect(draft.steps).toContainEqual(
      expect.objectContaining({
        open: { path: "/profile", waitUntil: "networkidle" },
      }),
    );
    const save = draft.steps.find((s) => "click" in s)!;
    expect(save["postcondition"]).toEqual({
      network: {
        method: "PATCH",
        urlContains: "/api/profile/",
        status: { below: 400 },
      },
    });

    // Studio-readable session journal.
    expect(isAbsolute(journal)).toBe(true);
    for (const file of ["session.json", "events.ndjson", "draft.spec.yml"]) {
      expect(existsSync(join(journal, file)), file).toBe(true);
    }
    const session = JSON.parse(
      await readFile(join(journal, "session.json"), "utf8"),
    );
    expect(session).toMatchObject({
      version: 1,
      sessionId,
      kind: "discovery",
      status: "open",
    });
    expect(session.exportedTo).toContain(draftPath);
    const events = (await readFile(join(journal, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type as string);
    for (const type of [
      "session.opened",
      "action.performed",
      "step.recorded",
      "draft.updated",
      "export.written",
    ]) {
      expect(events).toContain(type);
    }
    expect(
      (await readdir(join(journal, "screenshots"))).length,
    ).toBeGreaterThan(0);
    expect((await readdir(join(journal, "snapshots"))).length).toBeGreaterThan(
      0,
    );
    expect(await readdir(join(journal, "network"))).not.toHaveLength(0);
    expect(
      await readFile(join(journal, "draft.spec.yml"), "utf8"),
    ).not.toContain(SECRET);

    await call(c, "cairn_discover_close", { sessionId });

    // 5. Finish: lint, cold start, stamp.
    const finished = await call(c, "cairn_spec_finish", {
      path: draftPath,
      config: p.config,
      mock: true,
    });
    expect(finished.isError, finished.text).toBe(false);
    expect(finished.sc).toMatchObject({
      status: "green",
      exitCode: 0,
      draft: true,
      stamped: true,
      run: { status: "passed", coldStart: true, environment: "local" },
    });
    expect(finished.sc["contractHash"]).toMatch(/^sha256:/);
    const context = finished.sc["context"] as { summary: string };
    expect(context.summary).toContain("profile_saved");
    expect((finished.sc["nextActions"] as string[]).join(" ")).toContain(
      "cairn spec promote",
    );

    // 6. Promote (the human approved). A mock finish never touched the
    // app, so the gate wants force — and says why.
    expect(finished.sc["run"]).toMatchObject({ backend: "mock" });
    const gated = await call(c, "cairn_spec_promote", {
      path: draftPath,
      config: p.config,
    });
    expect(gated.isError).toBe(true);
    expect(gated.text).toContain("ran on the mock backend");
    expect(existsSync(draftPath)).toBe(true);
    const promoted = await call(c, "cairn_spec_promote", {
      path: draftPath,
      config: p.config,
      force: true,
    });
    expect(promoted.isError, promoted.text).toBe(false);
    expect(promoted.sc).toMatchObject({
      forced: true,
      finish: { backend: "mock" },
    });
    expect((promoted.sc["warnings"] as string[]).join(" ")).toContain(
      "mock backend",
    );
    const promotedPath = join(p.dir, "flows", "profile_website_persisted.yml");
    expect(resolve(promoted.sc["to"] as string)).toBe(promotedPath);
    expect(promoted.sc["contractHash"]).toBe(finished.sc["contractHash"]);
    expect(promoted.sc["intent"]).toContain("profile website");
    expect(existsSync(draftPath)).toBe(false);
    const final = parseYaml(await readFile(promotedPath, "utf8")) as {
      imports: string[];
      contractHash: string;
    };
    expect(final.imports).toEqual([
      "../actions/login.yml",
      "../actions/open_settings.yml",
    ]);
    expect(final.contractHash).toBe(finished.sc["contractHash"]);

    await c.close();
  }, 60_000);
});
