import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../core/config/loader";
import { EngineRequirementError } from "../../core/engineRequirements";
import { CAIRN_ENGINE_VERSION } from "../../core/engineVersion";
import { NodeRuntimeError } from "../../core/runtimes";
import { runNodeScript } from "../../core/runner/nodeScripts";
import { resolveConfigPinChecks } from "../commands/doctor";
import { executeRunInvocation } from "./executeRunInvocation";
import { configErrorExitCode, maybeInjectTvaultSecrets } from "./lifecycle";

/**
 * F19 engine pin: `requires.cairntrace` refuses a run (exit 4) on an older
 * cairn, `runtimes.node` / `CAIRN_NODE` choose the node binary of node
 * scripts, and `cairn doctor` reports both.
 */

let dir: string;

const SPEC = `version: 1
name: pin_spec
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const config = (extra: string): string => `version: 1
project: pin-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${extra}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-engine-pin-"));
  await writeFile(join(dir, "s.yml"), SPEC);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeNode(name: string, version: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\necho "$0" >> "${join(dir, "node-invocations.log")}"\nexec node "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("requires.cairntrace", () => {
  it("loadConfig refuses an unmet range with an EngineRequirementError (exit 4)", async () => {
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      config('requires:\n  cairntrace: ">=99.0"\n'),
    );
    const path = join(dir, "cairntrace.config.yml");
    await expect(loadConfig(path, path)).rejects.toBeInstanceOf(
      EngineRequirementError,
    );
    await expect(loadConfig(path, path)).rejects.toThrow(
      new RegExp(
        `requires cairntrace >=99\\.0, but this is cairntrace ${CAIRN_ENGINE_VERSION.replaceAll(".", "\\.")}`,
      ),
    );
    // doctor / validate read it without enforcing.
    await expect(
      loadConfig(path, path, { skipRequires: true }),
    ).resolves.toBeDefined();
    expect(configErrorExitCode(new EngineRequirementError("x"))).toBe(4);
    expect(configErrorExitCode(new NodeRuntimeError("x"))).toBe(4);
  });

  it("accepts a satisfied range and a config that declares nothing", async () => {
    const path = join(dir, "cairntrace.config.yml");
    await writeFile(
      path,
      config(`requires:\n  cairntrace: ">=${CAIRN_ENGINE_VERSION}"\n`),
    );
    await expect(loadConfig(path, path)).resolves.toBeDefined();
    await writeFile(path, config(""));
    await expect(loadConfig(path, path)).resolves.toBeDefined();
  });

  it("cairn run on an older cairn is exit 4 and starts nothing", async () => {
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      config('requires:\n  cairntrace: ">=99.0"\n'),
    );
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "s.yml")],
        options: {
          mock: true,
          artifactRoot: join(dir, "runs"),
          noWebServer: true,
        },
        cwd: dir,
      },
      { origin: "cli" } as never,
    ).catch((error) => error as Error);
    expect(result).toMatchObject({ exitCode: 4 });
    expect(JSON.stringify(result)).toContain("requires cairntrace >=99.0");
  });
});

describe("requires.cairntrace and the services commands", () => {
  const pinned = (): string =>
    config(`requires:
  cairntrace: ">=99.0"
services:
  teardown:
    - 'echo down >> "${join(dir, "down.log")}"'
`);

  it("services down still tears down (warning), up / restart / logs / status refuse with exit 4", async () => {
    const path = join(dir, "cairntrace.config.yml");
    await writeFile(path, pinned());
    const { servicesDown } = await import("../commands/services/down");
    const { servicesUp } = await import("../commands/services/up");
    const { servicesRestart } = await import("../commands/services/restart");
    const { servicesLogs } = await import("../commands/services/logs");
    const { getServicesStatus } = await import("../commands/services/status");

    const down = await servicesDown({ config: path });
    expect(down).toMatchObject({ ok: true, exitCode: 0 });
    expect(down.warnings.join("\n")).toMatch(
      /requires cairntrace >=99\.0.*not enforced for a teardown/,
    );
    expect(await readFile(join(dir, "down.log"), "utf8")).toBe("down\n");

    const up = await servicesUp({ config: path });
    expect(up).toMatchObject({ ok: false, exitCode: 4 });
    expect(up.error).toMatch(/requires cairntrace >=99\.0/);
    const restart = await servicesRestart({ config: path, windows: ["web"] });
    expect(restart).toMatchObject({ ok: false, exitCode: 4 });
    const logs = await servicesLogs({ config: path, window: "web" });
    expect(logs).toMatchObject({ ok: false, exitCode: 4 });
    const status = await getServicesStatus({ config: path });
    expect(status.engineRequirement).toMatch(/requires cairntrace >=99\.0/);
    expect(status.hasServices).toBe(true);
  });
});

describe("runtimes.node and CAIRN_NODE", () => {
  it("runNodeScript spawns the binary CAIRN_NODE names", async () => {
    const wrapper = await fakeNode("node-wrapper", "22.9.0");
    const result = await runNodeScript({
      source:
        "return { ok: true, evidence: process.versions.node.split('.')[0] > 0 };",
      ctx: { vars: {} },
      cwd: dir,
      entryNames: ["verify"],
      env: { ...process.env, CAIRN_NODE: wrapper },
    });
    expect(result.ok).toBe(true);
    const log = (await readFile(join(dir, "node-invocations.log"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log)).toEqual(new Set([wrapper]));
  });

  it("falls back to node on PATH without CAIRN_NODE", async () => {
    const result = await runNodeScript({
      source: "return { ok: true, evidence: 1 };",
      ctx: { vars: {} },
      cwd: dir,
      entryNames: ["verify"],
      env: { ...process.env, CAIRN_NODE: "" },
    });
    expect(result.ok).toBe(true);
  });

  it("the run exports the config's runtimes.node.path as CAIRN_NODE for children", async () => {
    const pinned = await fakeNode("node-pinned", "22.9.0");
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      config(
        `runtimes:\n  node:\n    path: ./node-pinned\n    version: ">=22"\n`,
      ),
    );
    const scoped = await maybeInjectTvaultSecrets(
      join(dir, "s.yml"),
      { config: join(dir, "cairntrace.config.yml") },
      {},
      dir,
    );
    expect(scoped.childEnv.CAIRN_NODE).toBe(pinned);
    expect(scoped.env.CAIRN_NODE).toBe(pinned);
  });

  it("an explicit CAIRN_NODE wins over the config", async () => {
    const pinned = await fakeNode("node-pinned", "22.9.0");
    const other = await fakeNode("node-other", "23.0.0");
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      config(`runtimes:\n  node:\n    path: ./node-pinned\n`),
    );
    const previous = process.env.CAIRN_NODE;
    process.env.CAIRN_NODE = other;
    try {
      const scoped = await maybeInjectTvaultSecrets(
        join(dir, "s.yml"),
        { config: join(dir, "cairntrace.config.yml") },
        {},
        dir,
      );
      expect(scoped.childEnv.CAIRN_NODE).toBe(other);
      expect(scoped.childEnv.CAIRN_NODE).not.toBe(pinned);
    } finally {
      if (previous === undefined) delete process.env.CAIRN_NODE;
      else process.env.CAIRN_NODE = previous;
    }
  });

  it("a node that is out of range refuses the run before anything starts (exit 4)", async () => {
    await fakeNode("node-old", "18.0.0");
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      config(`runtimes:\n  node:\n    path: ./node-old\n    version: ">=22"\n`),
    );
    await expect(
      maybeInjectTvaultSecrets(
        join(dir, "s.yml"),
        { config: join(dir, "cairntrace.config.yml") },
        {},
        dir,
      ),
    ).rejects.toBeInstanceOf(NodeRuntimeError);
  });

  it("a config without runtimes does not touch CAIRN_NODE", async () => {
    await writeFile(join(dir, "cairntrace.config.yml"), config(""));
    const scoped = await maybeInjectTvaultSecrets(
      join(dir, "s.yml"),
      { config: join(dir, "cairntrace.config.yml") },
      {},
      dir,
    );
    expect(scoped.childEnv.CAIRN_NODE).toBeUndefined();
  });
});

describe("doctor config pins", () => {
  it("reports requires and runtimes only when declared, and fails an unmet range", async () => {
    const path = join(dir, "cairntrace.config.yml");
    await writeFile(path, config(""));
    expect(await resolveConfigPinChecks(undefined, dir)).toEqual([]);
    await writeFile(
      path,
      config(`requires:\n  cairntrace: ">=${CAIRN_ENGINE_VERSION}"\n`),
    );
    expect(await resolveConfigPinChecks(undefined, dir)).toEqual([
      expect.objectContaining({ name: "config-requires", ok: true }),
    ]);
    await writeFile(path, config('requires:\n  cairntrace: ">=99.0"\n'));
    const [check] = await resolveConfigPinChecks(path, dir);
    expect(check).toMatchObject({ name: "config-requires", ok: false });
    expect(check!.detail).toContain(">=99.0");
    await fakeNode("node-old", "18.0.0");
    await writeFile(
      path,
      config(`runtimes:\n  node:\n    path: ./node-old\n    version: ">=22"\n`),
    );
    const [node] = await resolveConfigPinChecks(path, dir);
    expect(node).toMatchObject({ name: "config-node-runtime", ok: false });
    expect(node!.detail).toMatch(/does not satisfy/);
  });
});
