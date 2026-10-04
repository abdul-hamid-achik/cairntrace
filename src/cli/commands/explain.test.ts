import { describe, expect, it } from "vitest";
import { buildExplain, explainToMarkdown } from "./explain";
import { ExplainResultSchema } from "../../core/schema/explain.v1";
import { DOC_TOPICS } from "./docs";

describe("buildExplain", () => {
  const doc = buildExplain();

  it("validates against the v1 ExplainResult schema", () => {
    expect(() => ExplainResultSchema.parse(doc)).not.toThrow();
  });

  it("documents the `type` step (SPA keydown rationale vs fill)", () => {
    const typeStep = doc.steps.find((s) => s.id === "type");
    expect(typeStep).toBeDefined();
    expect(typeStep!.kind).toBe("interaction");
    expect(typeStep!.summary).toContain("fill");
    expect(typeStep!.yamlExample).toContain("type:");
    expect(typeStep!.yamlExample).toContain("value");
    expect(typeStep!.yamlExample).toContain("delayMs");
  });

  it("includes the clip command with its label flag", () => {
    const clip = doc.commands.find((c) => c.name === "clip");
    expect(clip).toBeDefined();
    expect(clip!.synopsis).toContain("cairn clip <run-ref>");
    expect(clip!.flags.map((f) => f.name)).toContain("--label");
  });

  it("documents the run policy: --bail, exit codes 8 and 9, doctor --orphans", () => {
    const run = doc.commands.find((c) => c.name === "run")!;
    expect(run.flags.map((f) => f.name)).toContain("--bail");
    expect(Object.keys(run.exitCodes)).toEqual(
      expect.arrayContaining(["0", "1", "2", "3", "4", "6", "7", "8", "9"]),
    );
    expect(run.exitCodes["8"]).toContain("critical");
    expect(run.exitCodes["9"]).toContain("verifyClean");
    expect(run.exitCodes["4"]).toContain("run.lock");
    expect(run.notes).toContain("Exit precedence: 8 > 9");
    const doctor = doc.commands.find((c) => c.name === "doctor")!;
    expect(doctor.flags.map((f) => f.name)).toEqual(
      expect.arrayContaining(["--orphans", "--kill", "--yes"]),
    );
    expect(doctor.exitCodes["1"]).toContain("orphan");
    const mcp = doc.commands.find((c) => c.name === "mcp")!;
    expect(mcp.notes).toContain("stopOnFail, bail");
  });

  it("builds the docs synopsis from every DOC_TOPICS entry", () => {
    const docsCmd = doc.commands.find((c) => c.name === "docs");
    expect(docsCmd).toBeDefined();
    expect(docsCmd!.synopsis).toBe(
      `cairn docs [${DOC_TOPICS.join("|")}] [--format json|yaml|md]`,
    );
    // The stale 9-topic synopsis omitted these authoring-central topics.
    expect(docsCmd!.synopsis).toContain("discovery");
    expect(docsCmd!.synopsis).toContain("export");
    expect(docsCmd!.synopsis).toContain("brief");
  });

  it("documents export brief", () => {
    const brief = doc.commands.find((c) => c.name === "export brief");
    expect(brief).toBeDefined();
    expect(brief!.synopsis).toContain("cairn export brief");
    expect(brief!.outputSchema).toBe("urn:cairntrace.dev:brief:v1");
  });
});

describe("buildExplain run hooks and placeholders", () => {
  const doc = buildExplain();
  const run = doc.commands.find((c) => c.name === "run")!;
  const flag = (cmd: string, name: string) =>
    doc.commands
      .find((c) => c.name === cmd)
      ?.flags.find((f) => f.name === name);

  it("says --after runs after EACH spec with the CAIRN_RUN_* env (2.14.0+)", () => {
    const after = flag("run", "--after")!;
    expect(after.description).toContain("after EACH spec");
    for (const env of [
      "CAIRN_RUN_DIR",
      "CAIRN_RUN_ID",
      "CAIRN_RUN_STATUS",
      "CAIRN_SPEC_PATH",
    ]) {
      expect(after.description).toContain(env);
    }
    expect(after.description).not.toMatch(/once after all specs/);
  });

  it("documents --repeat/--matrix/--stop-on-fail/--hook-timeout-ms", () => {
    for (const name of [
      "--repeat",
      "--matrix",
      "--stop-on-fail",
      "--hook-timeout-ms",
      "--progress",
      "--provider",
      "--device",
    ]) {
      expect(flag("run", name), name).toBeDefined();
    }
  });

  it("documents ${project.root} and ${config.dir} in run notes and markdown", () => {
    expect(run.notes).toContain("${project.root}");
    expect(run.notes).toContain("action's directory");
    expect(run.notes).toContain("${config.dir}");
    const md = explainToMarkdown(doc);
    expect(md).toContain("## Placeholders");
    expect(md).toContain("${config.dir}");
  });

  it("documents heal/discover/snapshot runtime flags and testIdAttribute", () => {
    // The CLI registers --env/--config/--var on `spec heal` and --var on
    // discover/snapshot (the parity test checks the CLI side); the MCP tool
    // takes the same inputs, and the notes say so.
    const heal = doc.commands.find((c) => c.name === "spec heal")!;
    for (const name of ["--env", "--config", "--var"]) {
      expect(flag("spec heal", name), name).toBeDefined();
    }
    expect(heal.exitCodes["4"]).toContain("unknown --env");
    expect(heal.synopsis).toContain("--var key=value");
    expect(heal.notes).toContain("cairn_spec_heal");
    for (const command of ["discover", "snapshot"]) {
      expect(flag(command, "--var"), command).toBeDefined();
      expect(doc.commands.find((c) => c.name === command)!.synopsis).toContain(
        "--var key=value",
      );
    }
    expect(doc.commands.find((c) => c.name === "discover")!.notes).toContain(
      "recorded relative",
    );
    expect(flag("discover", "--testids")!.description).toContain(
      "browser.testIdAttribute",
    );
    expect(flag("snapshot", "--testids")!.description).toContain(
      "browser.testIdAttribute",
    );
    expect(
      doc.commands.find((c) => c.name === "spec verify")!.exitCodes["4"],
    ).toContain("reference audit");
  });
});
