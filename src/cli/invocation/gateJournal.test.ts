import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * The run engine hands the resolved config's `gates:` registry and the
 * invocation journal to the services / webServer readiness waits: a named
 * `webServer.ready` gate resolves from a config that is NOT named
 * cairntrace.config.yml (a fallback lookup from the config dir would miss
 * it), and its gate.* events land in the invocation's events.ndjson.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-gate-journal-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readiness gates in the invocation journal", () => {
  it("journals gate.started / gate.passed of a named webServer.ready gate", async () => {
    const dir = join(root, "p1");
    await mkdir(dir, { recursive: true });
    const flag = join(dir, "ready.flag");
    const config = join(dir, "ci.config.yml");
    await writeFile(
      config,
      `version: 1
artifactRoot: ${JSON.stringify(join(dir, "runs"))}
defaultEnvironment: local
environments:
  local: { baseUrl: https://demo.example.test }
gates:
  app_marker:
    command: ${JSON.stringify(`test -f ${JSON.stringify(flag)}`)}
    every: 50
    timeout: 10000
webServer:
  command: ${JSON.stringify(`touch ${JSON.stringify(flag)}; echo server-up; sleep 30`)}
  waitForText: server-up
  reuseExisting: false
  readyTimeoutMs: 15000
  ready: [app_marker]
`,
    );
    const spec = join(dir, "a.yml");
    await writeFile(
      spec,
      `version: 1
name: gate_journal
intent: A mock run behind a gated webServer.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );

    const result = await executeRunInvocation(
      { specs: [spec], options: { mock: true, config }, cwd: dir },
      { origin: "cli", onDocument: () => undefined },
    );
    expect(result.kind).toBe("single");

    const events = (
      await readFile(
        join(dir, "runs", "_invocations", result.invocationId, "events.ndjson"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; name?: string });
    const gate = events.filter((e) => e.type.startsWith("gate."));
    expect(gate.map((e) => e.type)).toContain("gate.started");
    expect(gate.find((e) => e.type === "gate.passed")?.name).toBe("app_marker");
  }, 30_000);
});
