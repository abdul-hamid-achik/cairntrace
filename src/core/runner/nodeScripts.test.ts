import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "./nodeScripts";

describe("runNodeScript", () => {
  it("executes TypeScript syntax that requires transformation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-node-script-"));
    const file = join(dir, "verifier.ts");

    try {
      await writeFile(
        file,
        `
type Fixture = { value: string };

export default async function verify() {
  const fixture: Fixture = { value: "ready" };
  return { value: fixture.value };
}
`,
      );

      const result = await runNodeScript({
        file,
        ctx: {},
        cwd: dir,
        entryNames: ["verify"],
      });

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ value: "ready" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runNodeScript live output and progress", () => {
  it("forwards output lines without the result protocol and exposes ctx.progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-node-progress-"));
    const progressFile = join(dir, "outcome.progress");
    try {
      await writeFile(progressFile, "");
      const lines: Array<[string, string]> = [];
      const result = await runNodeScript({
        source: [
          'console.log("first");',
          'console.error("to stderr");',
          'ctx.progress("47/120 tasks");',
          'ctx.progress("multi\\nline");',
          'console.log("last");',
          "return { ok: true, evidence: 1 };",
        ].join("\n"),
        ctx: { vars: {} },
        cwd: dir,
        entryNames: ["verify"],
        env: { ...process.env, CAIRN_PROGRESS_FILE: progressFile },
        onOutputLine: (stream, line) => lines.push([stream, line]),
      });
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ ok: true, evidence: 1 });
      expect(lines.filter(([s]) => s === "stdout")).toEqual([
        ["stdout", "first"],
        ["stdout", "last"],
      ]);
      expect(lines).toContainEqual(["stderr", "to stderr"]);
      expect(lines.some(([, l]) => l.includes("__CAIRNTRACE_RESULT__"))).toBe(
        false,
      );
      expect(await readFile(progressFile, "utf8")).toBe(
        "47/120 tasks\nmulti line\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps ctx.progress a no-op without CAIRN_PROGRESS_FILE", async () => {
    const env = { ...process.env };
    delete env.CAIRN_PROGRESS_FILE;
    const result = await runNodeScript({
      source: 'ctx.progress("ignored"); return typeof ctx.progress;',
      ctx: {},
      entryNames: ["verify"],
      env,
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("function");
  });
});

describe("runNodeScript SDK resolution and polite cancel", () => {
  it("resolves the SDK specifier to sdkEntry without a local install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-node-sdk-"));
    try {
      const sdk = join(dir, "fake-sdk.mjs");
      await writeFile(sdk, "export const marker = 'runner-sdk';\n");
      await writeFile(
        join(dir, "v.mjs"),
        `import { marker } from "@thelacanians/cairntrace/verifier";
export default async function verify() { return marker; }
`,
      );
      const result = await runNodeScript({
        file: join(dir, "v.mjs"),
        ctx: {},
        cwd: dir,
        entryNames: ["verify"],
        sdkEntry: sdk,
      });
      expect(result.ok, result.stderr).toBe(true);
      expect(result.result).toBe("runner-sdk");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SIGTERMs first, then SIGKILLs the whole tree after the grace window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-node-grace-"));
    const pidFile = join(dir, "grandchild.pid");
    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = runNodeScript({
        source: [
          'const { spawn } = await import("node:child_process");',
          'const { writeFileSync } = await import("node:fs");',
          'process.on("SIGTERM", () => {});', // ignores the polite request
          'const child = spawn("sleep", ["30"], { stdio: "ignore" });',
          `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          "await new Promise(() => setInterval(() => {}, 1000));",
        ].join("\n"),
        ctx: {},
        cwd: dir,
        entryNames: [],
        signal: controller.signal,
        cancelGraceMs: 300,
      });
      let pid = 0;
      while (!pid) {
        if (Date.now() - started > 15_000) throw new Error("no grandchild");
        pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        await new Promise((r) => setTimeout(r, 25));
      }
      const abortedAt = Date.now();
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.error?.name).toBe("CancelledError");
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(250);
      await new Promise((r) => setTimeout(r, 100));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
