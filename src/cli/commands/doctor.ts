import { access, constants, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { emit, resolveFormat } from "../format";
import { type CodemapDeps, defaultCodemapDeps } from "./annotate.js";
import { codemapProjects, codemapStatus } from "./codemap.js";
import { resolveFcheapBinary } from "./fcheapClient.js";

/** Injectable codemap seam for `cairn doctor` (FEATURES item 7). */
export interface DoctorDeps {
  codemap: CodemapDeps;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  /** Also probe iOS readiness (Xcode / Appium / xcuitest / simulators). */
  ios?: boolean;
}

/** Minimum agent-browser cairn is verified against (wait --state, idle timeout). */
export const RECOMMENDED_AGENT_BROWSER = "0.34.0";

export function assessAgentBrowserVersion(versionOutput: string): DoctorCheck {
  const trimmed = versionOutput.trim();
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) {
    return {
      name: "agent-browser",
      ok: true,
      detail: trimmed || "agent-browser (unparsed version)",
    };
  }
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const recommended = RECOMMENDED_AGENT_BROWSER.split(".").map(Number);
  const older =
    current[0]! < recommended[0]! ||
    (current[0] === recommended[0] && current[1]! < recommended[1]!) ||
    (current[0] === recommended[0] &&
      current[1] === recommended[1] &&
      current[2]! < recommended[2]!);
  if (older) {
    return {
      name: "agent-browser",
      ok: false,
      detail:
        `agent-browser ${match[0]} is older than recommended ${RECOMMENDED_AGENT_BROWSER} ` +
        `(wait --state collision, find role implicit names, idle timeout). ` +
        `Upgrade: brew upgrade agent-browser`,
    };
  }
  return {
    name: "agent-browser",
    ok: true,
    detail: trimmed,
  };
}

export async function doctorCommand(
  opts: DoctorOptions,
  deps: DoctorDeps = { codemap: defaultCodemapDeps },
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const checks: DoctorReport["checks"] = [];

  checks.push({
    name: "node",
    ok: true,
    detail: `node ${process.versions.node}`,
  });

  const bun = await tryExec("bun", ["--version"]);
  checks.push({
    name: "bun",
    ok: bun.ok,
    detail: bun.ok ? `bun ${bun.stdout.trim()}` : "bun not on $PATH",
  });

  const ab = await tryExec("agent-browser", ["--version"]);
  checks.push(
    ab.ok
      ? assessAgentBrowserVersion(ab.stdout)
      : {
          name: "agent-browser",
          ok: false,
          detail:
            "agent-browser not on $PATH (cairn run will fail without --mock)",
        },
  );

  checks.push(...(await resolvePlaywrightChecks()));

  const fcheap = await tryExec(resolveFcheapBinary(), ["--version"]);
  checks.push({
    name: "fcheap",
    ok: fcheap.ok,
    detail: fcheap.ok
      ? fcheap.stdout.trim()
      : "fcheap not on $PATH (cairn stash and --stash-on-failure will be unavailable)",
  });

  const vecgrep = await tryExec("vecgrep", ["version"]);
  checks.push({
    name: "vecgrep",
    ok: vecgrep.ok,
    detail: vecgrep.ok
      ? vecgrep.stdout.trim()
      : "vecgrep not on $PATH (cairn investigate --connect will be unavailable)",
  });

  const vidtrace = await tryExec("vidtrace", ["version"]);
  checks.push({
    name: "vidtrace",
    ok: vidtrace.ok,
    detail: vidtrace.ok
      ? vidtrace.stdout.trim()
      : "vidtrace not on $PATH (cairn audit video evidence extraction will be unavailable)",
  });

  const monitor = await tryExec("monitor", ["--version"]);
  checks.push({
    name: "monitor",
    ok: monitor.ok,
    detail: monitor.ok
      ? monitor.stdout.trim()
      : "monitor not on $PATH (cairn run --monitor and monitor steps will be unavailable)",
  });

  const ffmpeg = await tryExec("ffmpeg", ["-version"]);
  checks.push({
    name: "ffmpeg",
    ok: ffmpeg.ok,
    detail: ffmpeg.ok
      ? (ffmpeg.stdout.trim().split("\n")[0] ?? "ffmpeg available")
      : "ffmpeg not on $PATH (video speed adjustment and audit audio bridging will be unavailable)",
  });

  const codemap = await tryExec("codemap", ["version"]);
  checks.push({
    name: "codemap",
    ok: codemap.ok,
    detail: codemap.ok
      ? codemap.stdout.trim()
      : "codemap not on $PATH (cairn annotate will be unavailable)",
  });

  // Resolve the target codebase's codemap index status + freshness
  // (`codemap status --json` for the current project, falling back to the
  // `codemap projects` registry). (FEATURES item 7)
  const indexCheck = await resolveCodemapIndexCheck(deps.codemap, codemap.ok);
  if (indexCheck) checks.push(indexCheck);

  const tvault = await tryExec("tvault", ["--version"]);
  checks.push({
    name: "tvault",
    ok: tvault.ok,
    detail: tvault.ok
      ? tvault.stdout.trim()
      : "tvault not on $PATH (secrets.provider: tvault will be unavailable)",
  });

  const artifactRoot = join(homedir(), ".cairntrace", "runs");
  const writable = await isWritableOrCreatable(artifactRoot);
  checks.push({
    name: "artifact-root",
    ok: writable,
    detail: `${artifactRoot} ${writable ? "writable" : "not writable"}`,
  });

  // Disk-space check: a full disk surfaces as cryptic ENOSPC mid-run, so
  // flag it here first. Threshold is deliberately conservative — one evening
  // of trace-heavy runs has produced 12GB.
  const free = await freeDiskBytes(artifactRoot);
  if (free !== undefined) {
    const gb = free / 1024 ** 3;
    checks.push({
      name: "disk-space",
      ok: gb >= 1,
      detail:
        `${gb.toFixed(1)}GB free at ${artifactRoot}` +
        (gb >= 1 ? "" : " — low; run `cairn clean` or set retention.keepRuns"),
    });
  }

  // iOS readiness is opt-in: most projects never target iOS, so these checks
  // only run (and only gate the exit code) when --ios is passed.
  if (opts.ios) {
    checks.push(...(await resolveIosChecks()));
  }

  const ok = checks.every((c) => c.ok);
  const report: DoctorReport = { ok, checks };

  process.stdout.write(emit(format, report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exit(ok ? 0 : 2);
}

interface PlaywrightRuntime {
  chromium: {
    executablePath(): string;
  };
}

/** Injectable seams for the Playwright package/browser preflight. */
export interface PlaywrightCheckDeps {
  load: () => Promise<PlaywrightRuntime>;
  access: (path: string, mode?: number) => Promise<void>;
}

/**
 * Check the two independent prerequisites for `--backend playwright`:
 * Cairntrace's Playwright package must load, and that package's matching
 * Chromium executable must have been installed.
 */
export async function resolvePlaywrightChecks(
  deps: PlaywrightCheckDeps = {
    load: async () => import("playwright"),
    access,
  },
): Promise<DoctorCheck[]> {
  let runtime: PlaywrightRuntime;
  try {
    runtime = await deps.load();
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? ` (${error.message.trim()})`
        : "";
    return [
      {
        name: "playwright-package",
        ok: false,
        detail: `Playwright package unavailable${detail} — run \`bun install\``,
      },
      {
        name: "playwright-chromium",
        ok: false,
        detail:
          "Chromium readiness not checked because the Playwright package is unavailable",
      },
    ];
  }

  const checks: DoctorCheck[] = [
    {
      name: "playwright-package",
      ok: true,
      detail: "Playwright package available",
    },
  ];

  let executablePath: string;
  try {
    executablePath = runtime.chromium.executablePath();
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? `: ${error.message.trim()}`
        : "";
    checks.push({
      name: "playwright-chromium",
      ok: false,
      detail:
        `could not resolve Playwright Chromium${detail} — ` +
        "run `bunx playwright install chromium`",
    });
    return checks;
  }

  if (!executablePath.trim()) {
    checks.push({
      name: "playwright-chromium",
      ok: false,
      detail:
        "Playwright returned an empty Chromium executable path — " +
        "run `bunx playwright install chromium`",
    });
    return checks;
  }

  try {
    await deps.access(executablePath, constants.X_OK);
    checks.push({
      name: "playwright-chromium",
      ok: true,
      detail: `Chromium executable ready at ${executablePath}`,
    });
  } catch {
    checks.push({
      name: "playwright-chromium",
      ok: false,
      detail:
        `Chromium executable missing or not executable at ${executablePath} — ` +
        "run `bunx playwright install chromium`",
    });
  }

  return checks;
}

/**
 * Resolve the target codebase's codemap index status + freshness and build the
 * doctor "codebase indexed" check. Prefers `codemap status --json` (current
 * project: node count + `stale` drift); falls back to the `codemap projects`
 * registry when `status` isn't registered. Returns undefined when codemap is
 * absent (the `codemap` availability check already flags that). (FEATURES item 7)
 */
export async function resolveCodemapIndexCheck(
  deps: CodemapDeps,
  codemapOnPath: boolean,
): Promise<{ name: string; ok: boolean; detail: string } | undefined> {
  if (!codemapOnPath) return undefined;

  // Prefer `codemap status --json` — it carries the per-project freshness
  // (`stale`: changed/new/deleted file counts) that the registry listing lacks.
  const status = await codemapStatus(deps);
  if (status && status.registered) {
    const fresh = status.stale
      ? status.stale.changed + status.stale.new + status.stale.deleted === 0
      : true;
    const freshness = status.stale
      ? fresh
        ? ", fresh"
        : `, stale: ${status.stale.changed} changed, ${status.stale.new} new, ${status.stale.deleted} deleted`
      : "";
    const where = status.root ? ` at ${status.root}` : "";
    return {
      name: "codemap-index",
      ok: true,
      detail: `codebase indexed: yes (${status.nodes} symbols${where}${freshness})`,
    };
  }

  // Fallback: the `codemap projects` registry (e.g. status didn't resolve the
  // cwd's project). No freshness verdict here — `codemap status` is the source
  // of drift, and it didn't report this project as registered.
  const projects = await codemapProjects(deps);
  if (projects.length === 0) {
    return {
      name: "codemap-index",
      ok: false,
      detail:
        "codemap on $PATH but no projects in registry — run `codemap index`",
    };
  }
  const cwd = process.cwd();
  const proj = projects.find(
    (p) => p.path && (cwd === p.path || cwd.startsWith(`${p.path}/`)),
  );
  if (!proj) {
    return {
      name: "codemap-index",
      ok: false,
      detail:
        `current codebase is not indexed (${cwd}) — ` +
        "run `codemap index` from this directory",
    };
  }
  const where = proj.path ? ` at ${proj.path}` : "";
  return {
    name: "codemap-index",
    ok: true,
    detail:
      proj.symbols !== undefined
        ? `codebase indexed: yes (${proj.symbols} symbols${where})`
        : `codebase indexed: yes${where}`,
  };
}

/** Injectable exec seam for the iOS readiness checks (`cairn doctor --ios`). */
export interface IosCheckDeps {
  exec: (
    bin: string,
    args: string[],
  ) => Promise<{ ok: boolean; stdout: string }>;
}

/**
 * Probe iOS readiness for `cairn doctor --ios`: Xcode (simulators), Appium,
 * the xcuitest driver, and available iOS simulators. agent-browser drives
 * Mobile Safari through Appium + xcuitest on top of Xcode's simulators.
 */
export async function resolveIosChecks(
  deps: IosCheckDeps = { exec: tryExec },
): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const xcode = await deps.exec("xcode-select", ["-p"]);
  checks.push({
    name: "ios-xcode",
    ok: xcode.ok,
    detail: xcode.ok
      ? `Xcode at ${xcode.stdout.trim()}`
      : "Xcode not found — install Xcode from the App Store (provides the iOS simulators)",
  });

  const appium = await deps.exec("appium", ["--version"]);
  checks.push({
    name: "ios-appium",
    ok: appium.ok,
    detail: appium.ok
      ? `appium ${appium.stdout.trim()}`
      : "appium not on $PATH — install with `npm install -g appium`",
  });

  if (appium.ok) {
    const drivers = await deps.exec("appium", [
      "driver",
      "list",
      "--installed",
    ]);
    const hasXcuitest = /xcuitest/i.test(drivers.stdout);
    checks.push({
      name: "ios-xcuitest",
      ok: hasXcuitest,
      detail: hasXcuitest
        ? "xcuitest driver installed"
        : "xcuitest driver missing — install with `appium driver install xcuitest`",
    });
  }

  const sims = await deps.exec("xcrun", [
    "simctl",
    "list",
    "devices",
    "available",
  ]);
  const simCount = sims.stdout
    .split("\n")
    .filter((l) => /iphone|ipad/i.test(l)).length;
  checks.push({
    name: "ios-simulators",
    ok: simCount > 0,
    detail:
      simCount > 0
        ? `${simCount} iOS simulator(s) available — target one with --provider ios --device "<name>"`
        : "no iOS simulators available — create one in Xcode → Settings → Platforms",
  });

  return checks;
}

async function tryExec(
  bin: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const r = await execa(bin, args, { reject: false });
    return {
      ok: r.exitCode === 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function freeDiskBytes(dir: string): Promise<number | undefined> {
  try {
    const { statfs } = await import("node:fs/promises");
    const s = await statfs(dir);
    return s.bsize * s.bavail;
  } catch {
    // statfs unavailable on this runtime/filesystem — skip the check.
    return undefined;
  }
}

async function isWritableOrCreatable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    try {
      await mkdir(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

function toMarkdown(r: DoctorReport): string {
  const lines = [
    `# Cairntrace doctor — ${r.ok ? "OK" : "issues"}`,
    "",
    ...r.checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`),
  ];
  return lines.join("\n");
}
