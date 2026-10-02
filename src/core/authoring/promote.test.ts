import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_KIT_END,
  AGENT_KIT_START,
  buildAgentKitSnippet,
  upsertAgentKit,
} from "./agentKit";
import { authorFlowPrompt, authorFlowSteps } from "./authorFlow";
import { AuthoringConfigSchema } from "../schema/config.v1";
import { expandSpecArgsWithDrafts } from "../../cli/invocation/selection";
import { authoringConfigOf, draftsDirFor, isDraftSpec } from "./config";
import {
  contentHash,
  defaultPromoteTarget,
  readFinishReceipt,
  rebaseRelativePaths,
  receiptPath,
  removeFinishReceipt,
  writeFinishReceipt,
} from "./promote";

describe("drafts", () => {
  it("resolves the drafts dir and recognizes drafts", () => {
    expect(draftsDirFor("/p", undefined)).toBe("/p/flows/_drafts");
    expect(
      draftsDirFor("/p", { authoring: { draftsDir: "specs/_wip/" } }),
    ).toBe("/p/specs/_wip");
    expect(authoringConfigOf({ authoring: { draftsDir: 3 } })).toEqual({});
    // A drafts dir `cairn run <dir>` would not skip is not a drafts dir.
    const loose = AuthoringConfigSchema.safeParse({
      draftsDir: "flows/drafts",
    });
    expect(loose.success).toBe(false);
    expect(loose.error?.issues[0]?.message).toContain("starting with _");
    expect(
      draftsDirFor("/p", { authoring: { draftsDir: "flows/drafts" } }),
    ).toBe("/p/flows/_drafts");
    const opts = { draftsDir: "/p/flows/_drafts", root: "/p" };
    expect(isDraftSpec("/p/flows/_drafts/a.yml", opts)).toBe(true);
    expect(isDraftSpec("/p/flows/_wip/a.yml", opts)).toBe(true);
    expect(isDraftSpec("/p/flows/_a.yml", opts)).toBe(true);
    expect(isDraftSpec("/p/flows/a.yml", opts)).toBe(false);
    expect(isDraftSpec("/elsewhere/_x/a.yml", opts)).toBe(false);
  });

  it("lists the drafts a directory run leaves out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-drafts-"));
    await mkdir(join(dir, "flows", "_drafts"), { recursive: true });
    await mkdir(join(dir, "flows", "_empty"), { recursive: true });
    await mkdir(join(dir, "flows", "actions"), { recursive: true });
    await writeFile(join(dir, "flows", "a.yml"), "x: 1\n");
    await writeFile(join(dir, "flows", "_wip.yml"), "x: 1\n");
    await writeFile(join(dir, "flows", "_drafts", "b.yml"), "x: 1\n");
    await writeFile(join(dir, "flows", "actions", "c.yml"), "x: 1\n");
    const out = await expandSpecArgsWithDrafts(["flows"], dir);
    expect(out.specs).toEqual([join(dir, "flows", "a.yml")]);
    expect(out.drafts).toEqual([
      join(dir, "flows", "_drafts"),
      join(dir, "flows", "_wip.yml"),
    ]);
  });

  it("promotes out of the drafts dir by default", () => {
    const opts = { draftsDir: "/p/flows/_drafts", root: "/p" };
    expect(defaultPromoteTarget("/p/flows/_drafts/a.yml", opts)).toBe(
      "/p/flows/a.yml",
    );
    expect(defaultPromoteTarget("/p/flows/_drafts/team/a.yml", opts)).toBe(
      "/p/flows/team/a.yml",
    );
    expect(defaultPromoteTarget("/p/flows/_wip/_b.yml", opts)).toBe(
      "/p/flows/wip/b.yml",
    );
  });
});

describe("rebaseRelativePaths", () => {
  it("rewrites imports and file fields, keeping quoting and comments", () => {
    const text = `version: 1
name: x
imports:
  - ../../actions/login.yml # login
  - "./local.yml"
outcomes:
  - id: ok
    description: ok
    verify:
      script: { runtime: node, file: '../../verifiers/check.mjs' }
steps:
  - upload: { by: label, name: File, path: ../fixtures/a.csv }
  - eval: { file: "\${config.dir}/scripts/x.js" }
  - transform: { file: ./t.mjs, input: /abs/in.csv }
`;
    const out = rebaseRelativePaths(text, "/p/flows/_drafts", "/p/flows");
    expect(out.rebased).toEqual([
      {
        where: "imports[0]",
        from: "../../actions/login.yml",
        to: "../actions/login.yml",
      },
      { where: "imports[1]", from: "./local.yml", to: "./_drafts/local.yml" },
      {
        where: "steps[0].upload.path",
        from: "../fixtures/a.csv",
        to: "fixtures/a.csv",
      },
      {
        where: "steps[2].transform.file",
        from: "./t.mjs",
        to: "./_drafts/t.mjs",
      },
      {
        where: "outcomes[0].verify.script.file",
        from: "../../verifiers/check.mjs",
        to: "../verifiers/check.mjs",
      },
    ]);
    expect(out.text).toContain("  - ../actions/login.yml # login");
    expect(out.text).toContain('  - "./_drafts/local.yml"');
    expect(out.text).toContain("file: '../verifiers/check.mjs'");
    expect(out.text).toContain('eval: { file: "${config.dir}/scripts/x.js" }');
    expect(out.text).toContain("input: /abs/in.csv");
    expect(rebaseRelativePaths(text, "/p/a", "/p/a").rebased).toEqual([]);
    expect(
      rebaseRelativePaths(
        "steps:\n  - eval: { file: ${file.dir}/x.js }\n",
        "/a",
        "/b",
      ).warnings,
    ).toHaveLength(1);
  });
});

describe("finish receipts", () => {
  it("round-trips and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairn-receipt-"));
    const path = writeFinishReceipt(root, {
      version: 1,
      path: "/p/flows/_drafts/a.yml",
      status: "green",
      contentHash: contentHash("x"),
      finishedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(path).toBe(receiptPath(root, "/p/flows/_drafts/a.yml"));
    expect(path).toContain(join(root, "_finish"));
    expect(readFinishReceipt(root, "/p/flows/_drafts/a.yml")?.status).toBe(
      "green",
    );
    removeFinishReceipt(root, "/p/flows/_drafts/a.yml");
    expect(readFinishReceipt(root, "/p/flows/_drafts/a.yml")).toBeUndefined();
  });
});

describe("agent kit and author-flow recipe", () => {
  it("builds a project-aware snippet and upserts it idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-kit-"));
    await mkdir(join(dir, "actions"), { recursive: true });
    await writeFile(
      join(dir, "actions", "login.yml"),
      "version: 1\nname: login_as_admin\nsteps:\n  - open: /login\n",
    );
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      "version: 1\ndefaultEnvironment: staging\nauthoring: { draftsDir: specs/_wip }\nenvironments:\n  local: {}\n  staging: {}\n",
    );
    const kit = await buildAgentKitSnippet({ cwd: dir });
    expect(kit.snippet.startsWith(AGENT_KIT_START)).toBe(true);
    expect(kit.snippet.trimEnd().endsWith(AGENT_KIT_END)).toBe(true);
    expect(kit.snippet).toContain("environments: local, staging (default)");
    expect(kit.snippet).toContain("`specs/_wip/`");
    expect(kit.snippet).toContain("use: login_as_admin");
    expect(kit.snippet).toContain("--env staging");
    const lines = kit.snippet.trimEnd().split("\n").length;
    expect(lines).toBeGreaterThanOrEqual(20);
    expect(lines).toBeLessThanOrEqual(36);

    expect(upsertAgentKit(undefined, kit.snippet)).toEqual({
      text: kit.snippet,
      action: "created",
    });
    const appended = upsertAgentKit("# Agents\n\nBe nice.\n", kit.snippet);
    expect(appended.action).toBe("appended");
    expect(appended.text).toBe(`# Agents\n\nBe nice.\n\n${kit.snippet}`);
    expect(upsertAgentKit(appended.text, kit.snippet).action).toBe("unchanged");
    const replaced = upsertAgentKit(
      `${appended.text.replace("Reusable actions", "Old actions")}\n## After\n`,
      kit.snippet,
    );
    expect(replaced.action).toBe("replaced");
    expect(replaced.text).toContain("Reusable actions");
    expect(replaced.text).toContain("## After");
  });

  it("renders the recipe with the request, env and target", () => {
    const text = authorFlowPrompt({
      request: "Edit the website\nand save",
      env: "local",
      targetDir: "flows/_drafts",
    });
    expect(text).toContain("> Edit the website\n> and save");
    expect(text).toContain(
      'cairn_catalog { query: "<key words of the request>", env: "local" }',
    );
    expect(text).toContain('into: "flows/_drafts"');
    expect(text.indexOf("cairn_catalog")).toBeLessThan(
      text.indexOf("cairn_discover_open"),
    );
    expect(text.indexOf("cairn_spec_finish")).toBeLessThan(
      text.indexOf("cairn_spec_promote"),
    );
    expect(authorFlowSteps()).toHaveLength(6);
  });
});
