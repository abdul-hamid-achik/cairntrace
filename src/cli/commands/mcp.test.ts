import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INVOCATION_ID_PATTERN } from "../../core/artifacts/invocationJournal";
import { InvocationJournalSchema } from "../../core/schema/events.v1";

const CAIRN = join(process.cwd(), "bin", "cairn");

const spec = (name: string, precondition?: string) => `version: 1
name: ${name}
intent: A mock run.
coldStart: guest
${
  precondition
    ? `preconditions:
  commands:
    - name: slow_setup
      run: "${precondition}"
      timeoutMs: 30000
`
    : ""
}steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

describe("cairn mcp over stdio", () => {
  it("cancels background invocations when the client closes stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-mcp-stdio-"));
    const artifactRoot = join(dir, "runs");
    await writeFile(join(dir, "slow.yml"), spec("stdio_slow", "sleep 3"));
    await writeFile(join(dir, "pass.yml"), spec("stdio_pass"));
    const child = spawn(CAIRN, ["mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => resolveExit(code));
    });
    try {
      let stdout = "";
      const responded = (id: number) =>
        new Promise<void>((resolveResponse, rejectResponse) => {
          const timer = setTimeout(
            () => rejectResponse(new Error(`no response ${id}: ${stdout}`)),
            20_000,
          );
          const check = (): void => {
            if (stdout.includes(`"id":${id}`)) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolveResponse();
            }
          };
          const onData = (chunk: Buffer): void => {
            stdout += String(chunk);
            check();
          };
          child.stdout.on("data", onData);
          check();
        });
      const send = (message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "0" },
        },
      });
      await responded(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "cairn_run",
          arguments: {
            specs: [join(dir, "slow.yml"), join(dir, "pass.yml")],
            mock: true,
            noServices: true,
            noWebServer: true,
            artifactRoot,
            wait: false,
          },
        },
      });
      await responded(2);
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((resolveTimeout) =>
          setTimeout(() => resolveTimeout("timeout"), 20_000),
        ),
      ]);
      expect(code).not.toBe("timeout");
      const [id] = (await readdir(join(artifactRoot, "_invocations"))).filter(
        (name) => INVOCATION_ID_PATTERN.test(name),
      );
      const journal = InvocationJournalSchema.parse(
        JSON.parse(
          await readFile(
            join(artifactRoot, "_invocations", id!, "invocation.json"),
            "utf8",
          ),
        ),
      );
      expect(journal.status).toBe("aborted");
      // The cancel lands before or during the slow spec: the second never starts.
      expect(journal.runs.map((run) => run.spec)).not.toContain(
        join(dir, "pass.yml"),
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
