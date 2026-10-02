import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../../adapters/mock/MockBrowserBackend";
import { UnknownEnvironmentError } from "../../../core/config/runtimeContext";
import {
  healReplayCommand,
  healSpec,
  healVerify,
} from "../../../core/healer/Healer";
import { SpecRefusedError } from "../../../core/runner/Runner";
import { healErrorExitCode, resolveHealRuntime } from "./heal";

let dir: string;
let configPath: string;
let specPath: string;

// The config lives OUTSIDE the spec's ancestry, so only an explicit
// `--config` can find it — exactly the case heal used to ignore.
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-heal-config-"));
  await mkdir(join(dir, "configs"), { recursive: true });
  await mkdir(join(dir, "flows"), { recursive: true });
  configPath = join(dir, "configs", "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
    vars: { landing: /local-landing }
  staging:
    baseUrl: https://staging.example.test
    vars: { landing: /staging-landing }
browser:
  testIdAttribute: data-qa
`,
  );
  specPath = join(dir, "flows", "landing.yml");
  await writeFile(
    specPath,
    `version: 1
name: heal_with_config
intent: heal resolves config vars like a run
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.landing}"
`,
  );
});

describe("resolveHealRuntime", () => {
  it("resolves --config/--env/--var and surfaces the browser block", async () => {
    const resolved = await resolveHealRuntime(specPath, {
      config: configPath,
      env: "staging",
      var: ["landing=/override"],
    });
    expect(resolved.runtime).toEqual({
      environmentOverride: "staging",
      configPath,
      vars: { landing: "/override" },
    });
    expect(resolved.browser?.testIdAttribute).toBe("data-qa");
    expect(resolved.warnings).toEqual([]);
  });

  it("fails fast on an unknown environment (exit 4) before any browser", async () => {
    const err = await resolveHealRuntime(specPath, {
      config: configPath,
      env: "prod",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownEnvironmentError);
    expect((err as UnknownEnvironmentError).exitCode).toBe(4);
  });

  it("rejects a malformed --var", async () => {
    await expect(
      resolveHealRuntime(specPath, { config: configPath, var: ["oops"] }),
    ).rejects.toThrow(/--var expects key=value/);
  });
});

describe("healSpec with config/env/vars", () => {
  it("runs and re-parses the spec with the explicit config, env and vars", async () => {
    const backend = new MockBrowserBackend();
    backend.failNextStep("drift");
    const out = await healSpec({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      configPath,
      environmentOverride: "staging",
      vars: { landing: "/from-var" },
    });
    // Without forwarding, `${vars.landing}` is undefined (the config is not
    // discoverable from the spec) and the run/re-parse would throw.
    expect(backend.stepLog[0]).toEqual({
      open: "https://staging.example.test/from-var",
    });
    expect(out.basedOnRunId).toBeTruthy();
    expect(out.status).toBe("no-heal-possible");
  });

  it("healVerify forwards the same runtime and names it in the replay hint", async () => {
    const backend = new MockBrowserBackend();
    const vr = await healVerify({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      configPath,
      environmentOverride: "staging",
    });
    expect(backend.stepLog[0]).toEqual({
      open: "https://staging.example.test/staging-landing",
    });
    expect(vr.replay).toContain("--env staging");
    expect(vr.replay).toContain(`--config ${configPath}`);
  });

  it("the replay hint repeats every --var and shell-quotes values and paths", async () => {
    const vr = await healVerify({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      configPath,
      environmentOverride: "staging",
      vars: { landing: "/x", note: "it's a $HOME test" },
    });
    expect(vr.replay).toContain("--var landing=/x");
    expect(vr.replay).toContain(`--var 'note=it'\\''s a $HOME test'`);
    expect(
      healReplayCommand({
        specPath: "/work/my flows/a.yml",
        configPath: "/work/conf dir/cairntrace.config.yml",
        environmentOverride: "staging",
        vars: { n: 3, ok: true },
      }),
    ).toBe(
      "cairn run '/work/my flows/a.yml' --env staging --config '/work/conf dir/cairntrace.config.yml' --var n=3 --var ok=true --json",
    );
  });
});

describe("healErrorExitCode", () => {
  it("maps a policy refusal to 7, like cairn run", () => {
    const refused = new SpecRefusedError(
      {
        reason: "requires.env does not list dev",
        env: "dev",
        requires: { env: ["local"] },
        code: "env-not-listed",
      },
      "/flows/x.yml",
    );
    expect(healErrorExitCode(refused)).toBe(7);
    expect(
      healErrorExitCode(
        new UnknownEnvironmentError(
          "prod",
          "override",
          ["local"],
          "/cairntrace.config.yml",
        ),
      ),
    ).toBe(4);
    expect(healErrorExitCode(new Error("boom"))).toBe(2);
  });
});
