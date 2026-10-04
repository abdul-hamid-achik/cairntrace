import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { applyUsageExitCodes } from "./usageExit";

/** Commander usage errors are exit 2 (errored), never 1 (failed outcome). */
const CAIRN = join(process.cwd(), "bin", "cairn");

async function cairn(args: string[]) {
  return execa(CAIRN, args, {
    reject: false,
    timeout: 30_000,
    env: { CAIRN_LOG_LEVEL: "silent", NO_COLOR: "1" },
  });
}

describe("cairn usage errors exit 2", () => {
  it("an unknown flag on run", async () => {
    const result = await cairn(["run", "--definitely-not-a-flag", "a.yml"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  it("a missing option value", async () => {
    const result = await cairn(["run", "--env"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("argument missing");
  });

  it("an unknown flag on nested commands (spec lint, export playwright)", async () => {
    expect((await cairn(["spec", "lint", "--nope"])).exitCode).toBe(2);
    expect((await cairn(["export", "playwright", "--nope"])).exitCode).toBe(2);
  });

  it("an unknown command and a missing required argument", async () => {
    expect((await cairn(["no-such-command"])).exitCode).toBe(2);
    expect((await cairn(["export", "playwright"])).exitCode).toBe(2);
  });

  it("--help and --version stay 0", async () => {
    const help = await cairn(["run", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: cairn run");
    expect((await cairn(["--version"])).exitCode).toBe(0);
  });
});

describe("applyUsageExitCodes", () => {
  it("reaches commands registered at any depth", () => {
    const codes: number[] = [];
    const exit = (code: number): never => {
      codes.push(code);
      throw new Error("exit");
    };
    const program = new Command().name("t");
    program.command("a").command("b").option("--x <v>");
    applyUsageExitCodes(program, exit);
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    for (const c of program.commands) {
      c.configureOutput({ writeErr: () => {}, writeOut: () => {} });
      for (const d of c.commands)
        d.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    }
    expect(() => program.parse(["a", "b", "--nope"], { from: "user" })).toThrow(
      "exit",
    );
    expect(() => program.parse(["--help"], { from: "user" })).toThrow("exit");
    expect(codes).toEqual([2, 0]);
  });
});
