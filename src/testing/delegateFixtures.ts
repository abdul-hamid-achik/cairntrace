import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeRunInvocation } from "../cli/invocation/executeRunInvocation";
import { DelegateStreamProducer } from "../core/delegate/remoteStream";
import { DELEGATE_LABEL } from "../core/schema/delegate.v1";
import type { RunInvocationOptions } from "../core/schema/runInvocation.v1";
import type { FakeRunnerScenario } from "./fakeDelegateRunner";

/**
 * Shared fixtures of the delegated-runner tests: a tiny project with three
 * mock specs and a config whose `remote` environment delegates to the fake
 * runner, and a recorder that runs a suite for real on the `worker`
 * environment (mock backend) and keeps what a runner would relay: the
 * stream `cairn logs --relay` prints and the run directories. The
 * recording carries `--label cairn.delegate={{invocationId}}` (what the
 * request's `cairnArgs` add); the fake runner fills in the local id.
 */

export const FAKE_RUNNER = join(import.meta.dirname, "fakeDelegateRunner.ts");

export interface DelegateRecording {
  journalDir: string;
  invocationId: string;
  lines: string[];
  runDirs: string[];
}

const passing = (name: string): string => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

export function delegateSpec(name: string, failing = false): string {
  const text = passing(name);
  return failing ? text.replace('matches: "/home"', 'matches: "/never"') : text;
}

/** flows/alpha.yml, flows/bravo.yml (pass) and flows/broken.yml (fails). */
export async function writeDelegateProject(dir: string): Promise<void> {
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", "alpha.yml"), delegateSpec("alpha"));
  await writeFile(join(dir, "flows", "bravo.yml"), delegateSpec("bravo"));
  await writeFile(
    join(dir, "flows", "broken.yml"),
    delegateSpec("broken", true),
  );
}

/** The config text; `runner` is the indented body of `remote.runner`. */
export function delegateConfig(runner: string, extra = ""): string {
  return `version: 1
project: delegate-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
  worker:
    baseUrl: https://demo.example.test
  remote:
    baseUrl: https://demo.example.test
    runner:
${runner}
${extra}suites:
  both: { specs: [flows/alpha.yml, flows/bravo.yml] }
  mixed: { specs: [flows/alpha.yml, flows/broken.yml] }
  one: { specs: [flows/alpha.yml] }
`;
}

/** Write a scenario and a config whose runner replays it. */
export async function writeScenarioConfig(
  dir: string,
  name: string,
  scenario: FakeRunnerScenario,
  /** Edit the config text (another suite, a policy…). */
  options: {
    runnerExtra?: string;
    extra?: string;
    cancelGraceMs?: number;
    configText?: (text: string) => string;
  } = {},
): Promise<{ config: string; scenarioPath: string; recordTo: string }> {
  const scenarioPath = join(dir, `scenario-${name}.json`);
  const recordTo = join(dir, `received-${name}.json`);
  await writeFile(
    scenarioPath,
    JSON.stringify({ recordTo, ...scenario } satisfies FakeRunnerScenario),
  );
  const runner = `      command: [bun, ${JSON.stringify(FAKE_RUNNER)}, ${JSON.stringify(scenarioPath)}]
      cancelGraceMs: ${options.cancelGraceMs ?? 4000}
${options.runnerExtra ?? ""}`;
  const config = join(dir, `cfg-${name}.config.yml`);
  const text = delegateConfig(runner, options.extra);
  await writeFile(config, options.configText ? options.configText(text) : text);
  return { config, scenarioPath, recordTo };
}

/** Run `suite` for real on `worker` (mock backend) and record it. */
export async function recordDelegateSuite(
  dir: string,
  remoteRoot: string,
  suite: string,
  /** Run options over the recording's (mock, worker, the label…). */
  /** The config text (default: {@link delegateConfig}). */
  /** Spec paths that narrow the suite (what cairnArgs carry after a local refusal). */
  extra: {
    options?: Partial<RunInvocationOptions>;
    configText?: string;
    specs?: string[];
  } = {},
): Promise<DelegateRecording> {
  const config = join(dir, "record.config.yml");
  await writeFile(
    config,
    extra.configText ?? delegateConfig("      command: [bun, unused]"),
  );
  const result = await executeRunInvocation(
    {
      specs: extra.specs ?? [],
      options: {
        suite,
        env: "worker",
        mock: true,
        config,
        artifactRoot: remoteRoot,
        noWebServer: true,
        noServices: true,
        label: [`${DELEGATE_LABEL}={{invocationId}}`],
        ...extra.options,
      },
      cwd: dir,
    },
    { origin: "cli" },
  );
  if (!result.journalDir) throw new Error("the recording wrote no journal");
  const lines = await new DelegateStreamProducer(result.journalDir).poll(true);
  return {
    journalDir: result.journalDir,
    invocationId: result.invocationId,
    lines,
    runDirs: result.runDirs,
  };
}

/** Index just after the stream's first `invocation.run.finished` line. */
export function afterFirstRun(lines: readonly string[]): number {
  return (
    lines.findIndex((line) => line.includes('"invocation.run.finished"')) + 1
  );
}
