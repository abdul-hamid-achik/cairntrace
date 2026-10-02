import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * `cairn spec lint | finish | promote`, `cairn init agent-kit` and the
 * convention flags of `cairn discover export`, through the real binary.
 */

const CAIRN = join(process.cwd(), "bin", "cairn");

async function project(): Promise<{ dir: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-authoring-cli-"));
  const root = join(dir, "runs");
  await mkdir(join(dir, "actions"), { recursive: true });
  await mkdir(join(dir, "flows", "_drafts"), { recursive: true });
  await writeFile(
    join(dir, "actions", "sign_in.yml"),
    "version: 1\nname: sign_in\nsteps:\n  - open: /login\n  - click: { by: role, role: button, name: Sign in }\n",
  );
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
artifactRoot: ${root}
authoring:
  template:
    metadata: { tags: [drafted] }
environments:
  local:
    baseUrl: http://app.test
    vars: { homeTitle: Welcome home }
`,
  );
  return { dir, root };
}

async function cairn(args: string[], cwd: string) {
  const { execa } = await import("execa");
  return execa(CAIRN, args, {
    cwd,
    reject: false,
    env: { CAIRN_LOG_LEVEL: "silent", NO_COLOR: "1" },
  });
}

const DRAFT = `version: 1
name: home_reached
intent: A signed-in user reaches home
imports: [../../actions/sign_in.yml]
outcomes:
  - id: home
    description: home page
    verify: { url: { endsWith: /home } }
steps:
  - use: sign_in
  - click: { by: selector, selector: #home-link }
  - open: /home
`;

describe("authoring CLI", () => {
  it("lints (exit 4), fixes, finishes green, refuses then promotes a draft", async () => {
    const p = await project();
    const draft = join(p.dir, "flows", "_drafts", "home_reached.yml");
    await writeFile(draft, DRAFT);

    const lint = await cairn(["spec", "lint", draft, "--json"], p.dir);
    expect(lint.exitCode, lint.stderr).toBe(4);
    const lintDoc = JSON.parse(lint.stdout);
    expect(lintDoc.$schema).toBe("urn:cairntrace.dev:spec-lint:v1");
    expect(lintDoc.files[0].findings[0]).toMatchObject({
      rule: "unquoted-hash",
      line: 11,
      fix: { safe: true },
    });

    const early = await cairn(
      ["spec", "finish", draft, "--mock", "--json"],
      p.dir,
    );
    expect(early.exitCode).toBe(4);
    expect(JSON.parse(early.stdout)).toMatchObject({
      status: "lint-failed",
      nextActions: expect.arrayContaining([expect.stringContaining("--fix")]),
    });

    const fixed = await cairn(
      ["spec", "lint", draft, "--fix", "--json"],
      p.dir,
    );
    expect(fixed.exitCode, fixed.stdout).toBe(0);
    expect(JSON.parse(fixed.stdout).summary.fixed).toBe(4);

    const notYet = await cairn(["spec", "promote", draft, "--json"], p.dir);
    expect(notYet.exitCode).toBe(4);
    expect(notYet.stderr).toContain("no `cairn spec finish` ran for it");

    const finish = await cairn(
      ["spec", "finish", draft, "--mock", "--json"],
      p.dir,
    );
    expect(finish.exitCode, finish.stdout + finish.stderr).toBe(0);
    const finishDoc = JSON.parse(finish.stdout);
    expect(finishDoc).toMatchObject({
      $schema: "urn:cairntrace.dev:spec-finish:v1",
      status: "green",
      draft: true,
      stamped: true,
      run: { status: "passed", coldStart: true, backend: "mock" },
    });
    expect(existsSync(finishDoc.run.report)).toBe(true);

    // A mock finish never touched the app: promote wants --force.
    const mockOnly = await cairn(["spec", "promote", draft, "--json"], p.dir);
    expect(mockOnly.exitCode).toBe(4);
    expect(mockOnly.stderr).toContain("ran on the mock backend");
    expect(finishDoc.nextActions.join(" ")).toContain("mock backend only");

    // Finished by absolute path, promoted by a cwd-relative one.
    const md = await cairn(
      [
        "spec",
        "promote",
        "flows/_drafts/home_reached.yml",
        "--to",
        "flows/smoke",
        "--force",
      ],
      p.dir,
    );
    expect(md.exitCode, md.stderr).toBe(0);
    expect(md.stdout).toContain("# Promoted");
    expect(md.stdout).toContain("on mock");
    expect(md.stdout).toContain("ran on the mock backend");
    const promoted = join(p.dir, "flows", "smoke", "home_reached.yml");
    expect(existsSync(draft)).toBe(false);
    const spec = parseYaml(await readFile(promoted, "utf8"));
    expect(spec.imports).toEqual(["../../actions/sign_in.yml"]);
    expect(spec.contractHash).toBe(finishDoc.contractHash);
    expect(spec.steps.map((s: { id: string }) => s.id)).toEqual([
      "use_sign_in",
      "click_home_link",
      "open_home",
    ]);
  }, 60_000);

  it("promotes with --force, refuses non-drafts and existing targets", async () => {
    const p = await project();
    const draft = join(p.dir, "flows", "_drafts", "home_reached.yml");
    await writeFile(draft, DRAFT.replace("#home-link", '"#home-link"'));
    const notDraft = join(p.dir, "flows", "live.yml");
    await writeFile(notDraft, DRAFT.replace("../../", "../"));
    const refused = await cairn(["spec", "promote", notDraft], p.dir);
    expect(refused.exitCode).toBe(4);
    expect(refused.stderr).toContain("is not a draft");

    await writeFile(join(p.dir, "flows", "home_reached.yml"), "taken\n");
    const exists = await cairn(["spec", "promote", draft, "--force"], p.dir);
    expect(exists.exitCode).toBe(4);
    expect(exists.stderr).toContain("already exists");

    const forced = await cairn(
      [
        "spec",
        "promote",
        "flows/_drafts/home_reached.yml",
        "--force",
        "--to",
        "flows/forced.yml",
        "--json",
      ],
      p.dir,
    );
    expect(forced.exitCode, forced.stderr).toBe(0);
    const doc = JSON.parse(forced.stdout);
    expect(doc).toMatchObject({
      $schema: "urn:cairntrace.dev:spec-promote:v1",
      from: "flows/_drafts/home_reached.yml",
      to: "flows/forced.yml",
      forced: true,
      intent: "A signed-in user reaches home",
    });
    expect(doc.contractHash).toMatch(/^sha256:/);
    expect(doc.warnings.join(" ")).toContain("--force");
  }, 60_000);

  it("prints and writes the agent kit", async () => {
    const p = await project();
    const printed = await cairn(["init", "agent-kit", "--json"], p.dir);
    expect(printed.exitCode, printed.stderr).toBe(0);
    expect(JSON.parse(printed.stdout).snippet).toContain("use: sign_in");
    const written = await cairn(
      ["init", "agent-kit", "--write", "--json"],
      p.dir,
    );
    expect(JSON.parse(written.stdout).written).toEqual({
      path: "AGENTS.md",
      action: "created",
    });
    const again = await cairn(
      ["init", "agent-kit", "--write", "--json"],
      p.dir,
    );
    expect(JSON.parse(again.stdout).written.action).toBe("unchanged");
  }, 60_000);

  it("exports a session journal with conventions into the drafts dir", async () => {
    const p = await project();
    const opened = await cairn(
      ["discover", "/home", "--mock", "--use", "sign_in", "--json"],
      p.dir,
    );
    expect(opened.exitCode, opened.stderr).toBe(0);
    const { sessionId } = JSON.parse(opened.stdout);
    const outcomes = join(p.dir, "outcomes.yml");
    await writeFile(
      outcomes,
      "- id: home\n  description: home page\n  verify: { url: { endsWith: /home } }\n",
    );
    const args = [
      "discover",
      "export",
      "--from-session",
      sessionId,
      "--into",
      "flows/_drafts",
      "--name",
      "home_reached",
      "--intent",
      "A signed-in user reaches home",
      "--outcomes",
      outcomes,
      "--requires-env",
      "local",
      "--tag",
      "smoke",
      "--json",
    ];
    const exported = await cairn(args, p.dir);
    expect(exported.exitCode, exported.stderr).toBe(0);
    const doc = JSON.parse(exported.stdout);
    expect(doc).toMatchObject({
      path: "flows/_drafts/home_reached.yml",
      name: "home_reached",
      draft: true,
      report: {
        reusedActions: [
          expect.objectContaining({ action: "sign_in", source: "setup" }),
        ],
      },
    });
    const spec = parseYaml(
      await readFile(
        join(p.dir, "flows", "_drafts", "home_reached.yml"),
        "utf8",
      ),
    );
    expect(spec).toMatchObject({
      requires: { env: ["local"] },
      metadata: { tags: ["drafted", "smoke"] },
      imports: ["../../actions/sign_in.yml"],
      steps: [
        { id: "use_sign_in", use: "sign_in" },
        { id: "open_home", open: { path: "/home", waitUntil: "networkidle" } },
      ],
    });
    const again = await cairn(args, p.dir);
    expect(again.exitCode).toBe(4);
    expect(again.stderr).toContain("already exists");
    // Drafts never join a directory run, and the selection says so.
    const run = await cairn(["run", "flows", "--mock", "--json"], p.dir);
    expect(run.stdout + run.stderr).not.toContain("home_reached");
    const selection = await cairn(
      ["run", "flows", "--select-only", "--json"],
      p.dir,
    );
    expect(JSON.parse(selection.stdout).skipped).toContainEqual(
      expect.objectContaining({
        name: "_drafts",
        path: expect.stringMatching(/\/flows\/_drafts$/),
        reason: expect.stringContaining("draft"),
      }),
    );
  }, 60_000);
});

describe("promoteSpec file references", () => {
  const BODY = `outcomes:
  - id: done
    description: done
    verify: { url: { endsWith: /x } }
`;

  it("rebases precondition cwds and eval host files, and warns about cwd-less commands", async () => {
    const p = await project();
    await mkdir(join(p.dir, "fixtures"), { recursive: true });
    await writeFile(join(p.dir, "fixtures", "seed.sql"), "select 1;\n");
    await mkdir(join(p.dir, "flows", "_drafts", "deep"), { recursive: true });
    await writeFile(
      join(p.dir, "flows", "_drafts", "deep", "upload.csv"),
      "a,b\n",
    );
    const draft = join(p.dir, "flows", "_drafts", "deep", "pathy.yml");
    await writeFile(
      draft,
      `version: 1
name: pathy
intent: Seeded upload
coldStart: guest
preconditions:
  commands:
    - name: seed
      run: test -f seed.sql
      cwd: ../../../fixtures
    - name: echo
      run: echo hi
${BODY}steps:
  - id: open_x
    open: /x
  - id: eval_upload
    eval:
      js: "return args.filePath"
      args: { filePath: ./upload.csv, fixtureFiles: { other: upload.csv } }
`,
    );
    const { promoteSpec } = await import("./promote");
    const result = await promoteSpec(draft, { force: true, cwd: p.dir });
    expect(result.to).toBe("flows/deep/pathy.yml");
    expect(result.rebased).toEqual([
      {
        where: "preconditions.commands[0].cwd",
        from: "../../../fixtures",
        to: "../../fixtures",
      },
      {
        where: "steps[1].eval.args.filePath",
        from: "./upload.csv",
        to: "../_drafts/deep/upload.csv",
      },
      {
        where: "steps[1].eval.args.fixtureFiles.other",
        from: "upload.csv",
        to: "../_drafts/deep/upload.csv",
      },
    ]);
    expect(result.warnings.join(" ")).toContain(
      "preconditions.commands[1] (echo) has no cwd",
    );
    const lint = await cairn(
      ["spec", "lint", "flows/deep/pathy.yml", "--json"],
      p.dir,
    );
    expect(
      JSON.parse(lint.stdout).files[0].findings.filter(
        (f: { rule: string }) => f.rule === "missing-file",
      ),
    ).toEqual([]);
  }, 60_000);

  it("rolls back when the promoted copy would point at missing files", async () => {
    const p = await project();
    await writeFile(
      join(p.dir, "flows", "_drafts", "helper.js"),
      "return 1;\n",
    );
    const draft = join(p.dir, "flows", "_drafts", "dirbound.yml");
    const text = `version: 1
name: dirbound
intent: Uses a file next to it
coldStart: guest
${BODY}steps:
  - id: eval_helper
    eval: { file: "\${file.dir}/helper.js" }
`;
    await writeFile(draft, text);
    const { promoteSpec, PromoteError } = await import("./promote");
    const error = await promoteSpec(draft, { force: true, cwd: p.dir }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PromoteError);
    expect((error as Error).message).toContain(
      "would break its file references",
    );
    expect(existsSync(join(p.dir, "flows", "dirbound.yml"))).toBe(false);
    expect(await readFile(draft, "utf8")).toBe(text);
  }, 60_000);

  it("promotes only the content a reviewer saw (--expect-content-hash)", async () => {
    const p = await project();
    const draft = join(p.dir, "flows", "_drafts", "reviewed.yml");
    const text = `version: 1
name: reviewed
intent: Reviewed content only
coldStart: guest
${BODY}steps:
  - id: open_x
    open: /x
`;
    await writeFile(draft, text);
    const { createHash } = await import("node:crypto");
    const seen = createHash("sha256").update(text).digest("hex");
    const { promoteSpec, PromoteError } = await import("./promote");

    // Rewritten after review: refused (exit 4) even with force; draft kept.
    await writeFile(draft, text.replace("/x", "/y"));
    const changed = await promoteSpec(draft, {
      force: true,
      expectContentHash: seen,
      cwd: p.dir,
    }).catch((e: unknown) => e);
    expect(changed).toBeInstanceOf(PromoteError);
    expect((changed as InstanceType<typeof PromoteError>).exitCode).toBe(4);
    expect((changed as Error).message).toContain(
      "content changed since it was reviewed",
    );
    expect((changed as Error).message).not.toContain("--force");
    expect(existsSync(join(p.dir, "flows", "reviewed.yml"))).toBe(false);

    // A malformed digest is a usage error (exit 2).
    const malformed = await promoteSpec(draft, {
      force: true,
      expectContentHash: "abc",
      cwd: p.dir,
    }).catch((e: unknown) => e);
    expect((malformed as InstanceType<typeof PromoteError>).exitCode).toBe(2);

    // The reviewed text again (upper-case digest accepted): promoted.
    await writeFile(draft, text);
    const cli = await cairn(
      [
        "spec",
        "promote",
        draft,
        "--force",
        "--expect-content-hash",
        seen.toUpperCase(),
        "--json",
      ],
      p.dir,
    );
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout).to).toMatch(/flows\/reviewed\.yml$/);
  }, 60_000);
});
