import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * A graceful cancel (MCP cairn_run_cancel / request cancel) that lands while
 * a spec's precondition runs: the engine passes its signal into runSpec, the
 * precondition's process tree is killed at once and the spec still writes a
 * consistent, errored run directory.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-engine-run-cancel-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("engine cancel inside a running spec", () => {
  it("kills the running precondition and settles an errored run promptly", async () => {
    const pidFile = join(dir, "precondition.pid");
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: engine_precondition_cancel
intent: A spec whose precondition never finishes on its own.
coldStart: guest
preconditions:
  commands:
    - name: quiesce
      run: 'sleep 30 & echo $! > "${pidFile}"; wait'
      timeoutMs: 600000
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executeRunInvocation(
      {
        specs: [join(dir, "spec.yml")],
        options: { mock: true, artifactRoot: join(dir, "runs") },
        cwd: dir,
      },
      { origin: "mcp", signal: controller.signal },
    );
    let pid = 0;
    const deadline = Date.now() + 10_000;
    while (pid === 0) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (/^\d+\s*$/.test(text)) pid = Number(text.trim());
      else if (Date.now() > deadline) throw new Error("precondition never ran");
      else await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    controller.abort();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result).toMatchObject({
      kind: "single",
      aborted: true,
      exitCode: 2,
    });
    const doc = RunResultSchema.parse(result.document);
    expect(doc).toMatchObject({
      status: "errored",
      failure: { phase: "cancelled", name: "quiesce" },
    });
    expect(result.runDirs).toEqual([doc.runDir]);
    const onDisk = JSON.parse(
      await readFile(join(doc.runDir, "run.json"), "utf8"),
    ) as { status: string };
    expect(onDisk.status).toBe("errored");
    const journal = JSON.parse(
      await readFile(join(result.journalDir!, "invocation.json"), "utf8"),
    ) as { status: string };
    expect(journal.status).toBe("aborted");
    const killDeadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < killDeadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
