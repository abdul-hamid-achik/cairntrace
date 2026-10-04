#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DELEGATE_ENV,
  DelegateRequestSchema,
  type DelegateRequest,
} from "../core/schema/delegate.v1";

/**
 * A reference delegated runner (`urn:cairntrace.dev:delegate:v1`) for tests:
 * it replays a recorded delegate events stream — typically what `cairn logs
 * --invocation <ref> --relay` printed for a real (mock-backend) invocation —
 * into CAIRN_DELEGATE_EVENTS and copies that invocation's run directories
 * under the request's `artifactRootLocal`, the way a real runner mirrors
 * them from the remote machine: everything else first, `run.json` and
 * `artifact-manifest.json` last, modification times kept.
 *
 *   bun src/testing/fakeDelegateRunner.ts <scenario.json>
 *
 * A recording made with `--label cairn.delegate={{invocationId}}` stands for
 * a remote invocation started with the request's `cairnArgs`: the
 * placeholder becomes the local invocation id in the stream and in each
 * copied run.json (its manifest entry follows), as if the remote cairn had
 * written that label itself.
 *
 * The scenario can also misbehave on purpose (garbage lines, a missing run
 * directory, foreign run directories, a crash, a hang until SIGINT,
 * ignoring SIGINT, an exit code cairn does not use, a reconnect that tears a
 * line and re-streams from the start) so the relay's diagnostics and the
 * verdict can be tested without a remote machine.
 */
export interface FakeRunnerScenario {
  /** Stream lines, appended in order (`{{invocationId}}` → the local id). */
  lines: string[];
  /** Run directories to place (source dir; the name is the run id). */
  runDirs?: string[];
  /** Copy the run directories before the stream (default after it). */
  copyRunDirsFirst?: boolean;
  /** Run ids whose directories are not copied (a runner that lost one). */
  skipRunDirs?: string[];
  /**
   * `false`: copy run.json exactly as recorded, `{{invocationId}}` left in
   * its labels — the runs of some other invocation (`foreign-run`).
   * Default true.
   */
  labelRuns?: boolean;
  /**
   * After this many lines, append a torn copy of the next one (no newline)
   * and re-stream every line from the start: a runner whose connection
   * dropped mid-line and reconnected.
   */
  reconnectAfter?: number;
  /** Pause between lines (ms). */
  delayMs?: number;
  /** Text printed on stdout before the stream (lands in logs/delegate.log). */
  stdout?: string[];
  /** Exit code once done (default 0). */
  exitCode?: number;
  /** After `hangAfter` lines, wait (for a signal) instead of finishing. */
  hangAfter?: number;
  /** End by killing itself with this signal instead of exiting. */
  killSelf?: NodeJS.Signals;
  /** SIGINT: append these lines, copy what is left, exit. `ignore` keeps running. */
  onSigint?: {
    lines?: string[];
    exitCode?: number;
    delayMs?: number;
    ignore?: boolean;
  };
  /**
   * Start a helper process in the runner's own process group (an ssh
   * follower, an rsync); on SIGINT write `{ "helperAlive": boolean }` here —
   * whether the helper survived the cancel signal, so the runner could
   * still use it to copy results back.
   */
  helperProbe?: string;
  /** Write the request this runner received (and its env) here. */
  recordTo?: string;
}

const PLACEHOLDER = "{{invocationId}}";

/**
 * Copy one run directory the way the contract asks: every other file
 * first, then `run.json`, then `artifact-manifest.json`, each keeping its
 * modification time (latest / previous order by directory mtime). With
 * `invocationId`, the `{{invocationId}}` placeholder of run.json becomes
 * it, and the manifest's run.json entry (bytes, sha256) follows.
 */
export function copyRunDir(
  from: string,
  to: string,
  invocationId?: string,
): void {
  const last = ["run.json", "artifact-manifest.json"];
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
      else if (entry.isFile()) files.push(relPath);
    }
  };
  walk(from, "");
  const ordered = [
    ...files.filter((file) => !last.includes(file)),
    ...last.filter((file) => files.includes(file)),
  ];
  let runJson: Buffer | undefined;
  for (const file of ordered) {
    const source = join(from, file);
    const target = join(to, file);
    mkdirSync(join(target, ".."), { recursive: true });
    if (file === "run.json" && invocationId !== undefined) {
      runJson = Buffer.from(
        readFileSync(source, "utf8").replaceAll(PLACEHOLDER, invocationId),
      );
      writeFileSync(target, runJson);
    } else if (file === "artifact-manifest.json" && runJson) {
      const manifest = JSON.parse(readFileSync(source, "utf8")) as {
        artifacts?: Array<{ path: string; bytes?: number; sha256?: string }>;
      };
      for (const entry of manifest.artifacts ?? []) {
        if (entry.path !== "run.json") continue;
        entry.bytes = runJson.length;
        entry.sha256 = createHash("sha256").update(runJson).digest("hex");
      }
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      copyFileSync(source, target);
    }
    const stat = statSync(source);
    utimesSync(target, stat.atime, stat.mtime);
  }
  const dirStat = statSync(from);
  utimesSync(to, dirStat.atime, dirStat.mtime);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Run one scenario; resolves with the exit code (or never, on a hang). */
export async function runFakeDelegateRunner(
  scenarioPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const scenario = JSON.parse(
    readFileSync(scenarioPath, "utf8"),
  ) as FakeRunnerScenario;
  const request: DelegateRequest = DelegateRequestSchema.parse(
    JSON.parse(readFileSync(env[DELEGATE_ENV.request]!, "utf8")),
  );
  const eventsPath = env[DELEGATE_ENV.events]!;
  if (scenario.recordTo) {
    writeFileSync(
      scenario.recordTo,
      JSON.stringify({
        request,
        env: {
          contract: env[DELEGATE_ENV.contract],
          invocationId: env[DELEGATE_ENV.invocationId],
          invocationDir: env[DELEGATE_ENV.invocationDir],
          artifactRoot: env[DELEGATE_ENV.artifactRoot],
          cairnEnv: env.CAIRN_ENV,
          extra: env.FAKE_RUNNER_EXTRA,
        },
      }),
    );
  }
  let helper: ChildProcess | undefined;
  if (scenario.helperProbe) {
    // Same process group as the runner (not detached).
    helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    process.on("exit", () => helper?.kill("SIGKILL"));
  }
  const skip = new Set(scenario.skipRunDirs ?? []);
  const copied = new Set<string>();
  const label = scenario.labelRuns === false ? undefined : request.invocationId;
  const copyAll = (): void => {
    for (const dir of scenario.runDirs ?? []) {
      const runId = dir.split("/").pop()!;
      if (skip.has(runId) || copied.has(runId)) continue;
      copied.add(runId);
      copyRunDir(dir, join(request.artifactRootLocal, runId), label);
    }
  };
  const substitute = (line: string): string =>
    line.replaceAll(PLACEHOLDER, request.invocationId);
  const write = (line: string): void => {
    appendFileSync(eventsPath, `${substitute(line)}\n`);
  };
  let interrupted = false;
  process.on("SIGINT", () => {
    const onSigint = scenario.onSigint;
    if (onSigint?.ignore) return;
    interrupted = true;
    void (async () => {
      if (helper && scenario.helperProbe) {
        // Long enough for a helper the same signal killed to be reaped.
        await sleep(300);
        writeFileSync(
          scenario.helperProbe,
          JSON.stringify({
            helperAlive: helper.exitCode === null && helper.signalCode === null,
          }),
        );
        helper.kill("SIGKILL");
      }
      if (onSigint?.delayMs) await sleep(onSigint.delayMs);
      for (const line of onSigint?.lines ?? []) write(line);
      copyAll();
      process.exit(onSigint?.exitCode ?? 130);
    })();
  });
  for (const line of scenario.stdout ?? []) process.stdout.write(`${line}\n`);
  if (scenario.copyRunDirsFirst) copyAll();
  let written = 0;
  let reconnected = false;
  for (let at = 0; at < scenario.lines.length; at++) {
    if (interrupted) return new Promise<number>(() => undefined);
    if (scenario.hangAfter !== undefined && written >= scenario.hangAfter) {
      break;
    }
    if (
      !reconnected &&
      scenario.reconnectAfter !== undefined &&
      written === scenario.reconnectAfter
    ) {
      reconnected = true;
      const next = substitute(scenario.lines[at]!);
      appendFileSync(eventsPath, next.slice(0, Math.ceil(next.length / 2)));
      at = -1;
      continue;
    }
    write(scenario.lines[at]!);
    written += 1;
    if (scenario.delayMs) await sleep(scenario.delayMs);
  }
  if (scenario.hangAfter !== undefined) {
    // Wait for SIGINT (or SIGTERM / SIGKILL from cairn's escalation).
    setInterval(() => undefined, 60_000);
    return new Promise<number>(() => undefined);
  }
  if (!scenario.copyRunDirsFirst) copyAll();
  if (scenario.killSelf) {
    process.kill(process.pid, scenario.killSelf);
    await sleep(5_000);
  }
  return scenario.exitCode ?? 0;
}

if (import.meta.main) {
  const code = await runFakeDelegateRunner(process.argv[2]!);
  process.exit(code);
}
