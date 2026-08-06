/**
 * Thin client over the external `monitor` CLI (github.com/abdul-hamid-achik/monitor).
 *
 * Every call is graceful: if the `monitor` binary is missing or a command
 * fails, the call resolves to `undefined` so callers (the run-time sampler,
 * the `monitor` step, the process verifier) can degrade cleanly instead of
 * failing the run. Cairntrace never hard-depends on monitor being installed.
 *
 * The binary path defaults to `monitor` on PATH and can be overridden with
 * `CAIRN_MONITOR_BINARY`. All commands carry a short execa timeout so a
 * wedged `monitor` invocation can never hang a run.
 */

import { execa } from "execa";

/** A single point-in-time process sample (subset of monitor's ProcessInfo). */
export interface ProcessSample {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryPercent: number;
  threads: number;
  /** Epoch milliseconds when the sample was taken. */
  timestampMs: number;
}

/** One node of `monitor tree <pid> --json` (ProcessInfo + nested children). */
export interface ProcessTreeNode {
  pid: number;
  name: string;
  cpu_percent: number;
  memory: number;
  memory_percent: number;
  threads: number;
  parent?: number;
  is_system: boolean;
  is_protected: boolean;
  children?: ProcessTreeNode[];
}

/** Result of `monitor profile <pid> --type <t> --json` (subset). */
export interface ProfileResult {
  pid: number;
  type: string;
  method?: string;
  taken: string;
  /** Top stack symbols, when available (heap/goroutine/sample profiles). */
  symbols?: Array<{ func: string; file: string; line: number }>;
  /** Path to a saved raw profile file, when monitor wrote one. */
  path?: string;
  receipt?: { verified: boolean; size_bytes?: number; limitation?: string };
  context?: Record<string, string>;
}

export type ProfileType = "heap" | "cpu" | "goroutine" | "sample";

export interface MonitorTargetSelector {
  runtime: "node" | "bun" | "deno" | "go" | "python";
  codebaseRoot: string;
  mainScriptSuffix?: string;
}

export interface ResolvedMonitorTarget {
  pid: number;
  name: string;
  runtime: string;
  codebaseRoot?: string;
  mainScript?: string;
  inspectAddr?: string;
}

/**
 * The surface the sampler / monitor step depend on. The default
 * implementation shells out to the `monitor` binary; tests inject a fake.
 */
export interface MonitorClient {
  /** Whether the `monitor` binary is available on PATH. Cached after first probe. */
  available(): Promise<boolean>;
  /** `monitor process <pid> --json` → one sample, or undefined on failure. */
  sampleProcess(pid: number): Promise<ProcessSample | undefined>;
  /** `monitor tree <pid> --json` → subtree forest, or undefined on failure. */
  processTree(pid: number): Promise<ProcessTreeNode[] | undefined>;
  /** Resolve exactly one service process, refusing zero/ambiguous matches. */
  resolveTarget(
    selector: MonitorTargetSelector,
  ): Promise<ResolvedMonitorTarget | undefined>;
  /** `monitor profile <pid> --type <t> --json` → profile, or undefined on failure. */
  captureProfile(
    pid: number,
    type: ProfileType,
    options?: {
      durationSeconds?: number;
      outputPath?: string;
      stepId?: string;
      service?: string;
    },
  ): Promise<ProfileResult | undefined>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function binaryPath(override?: string): string {
  return override ?? process.env["CAIRN_MONITOR_BINARY"] ?? "monitor";
}

const availabilityCache = new Map<string, boolean>();

async function probeAvailable(binary: string): Promise<boolean> {
  const cached = availabilityCache.get(binary);
  if (cached !== undefined) return cached;
  try {
    const result = await execa(binary, ["--version"], {
      timeout: 3_000,
      reject: false,
    });
    availabilityCache.set(binary, result.exitCode === 0);
  } catch {
    availabilityCache.set(binary, false);
  }
  return availabilityCache.get(binary) ?? false;
}

/** Default `MonitorClient` that shells out to the real `monitor` binary. */
export function defaultMonitorClient(binaryOverride?: string): MonitorClient {
  const binary = binaryPath(binaryOverride);
  return {
    async available() {
      return probeAvailable(binary);
    },

    async sampleProcess(pid: number): Promise<ProcessSample | undefined> {
      if (!(await probeAvailable(binary))) return undefined;
      try {
        const result = await execa(binary, ["process", String(pid), "--json"], {
          timeout: DEFAULT_TIMEOUT_MS,
          reject: false,
        });
        if (result.exitCode !== 0) return undefined;
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        return {
          pid: Number(parsed["pid"]),
          name: String(parsed["name"] ?? ""),
          cpuPercent: Number(parsed["cpu_percent"] ?? 0),
          memoryBytes: Number(parsed["memory"] ?? 0),
          memoryPercent: Number(parsed["memory_percent"] ?? 0),
          threads: Number(parsed["threads"] ?? 0),
          timestampMs: Date.now(),
        };
      } catch {
        return undefined;
      }
    },

    async processTree(pid: number): Promise<ProcessTreeNode[] | undefined> {
      if (!(await probeAvailable(binary))) return undefined;
      try {
        const result = await execa(binary, ["tree", String(pid), "--json"], {
          timeout: DEFAULT_TIMEOUT_MS,
          reject: false,
        });
        if (result.exitCode !== 0) return undefined;
        return JSON.parse(result.stdout) as ProcessTreeNode[];
      } catch {
        return undefined;
      }
    },

    async resolveTarget(selector: MonitorTargetSelector): Promise<
      ResolvedMonitorTarget | undefined
    > {
      if (!(await probeAvailable(binary))) return undefined;
      const args = [
        "resolve",
        "--runtime",
        selector.runtime,
        "--codebase-root",
        selector.codebaseRoot,
        "--json",
      ];
      if (selector.mainScriptSuffix) {
        args.push("--main-script-suffix", selector.mainScriptSuffix);
      }
      try {
        const result = await execa(binary, args, {
          timeout: DEFAULT_TIMEOUT_MS,
          reject: false,
        });
        if (result.exitCode !== 0) return undefined;
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        const pid = Number(parsed["pid"]);
        if (!Number.isInteger(pid) || pid <= 1) return undefined;
        return {
          pid,
          name: String(parsed["name"] ?? ""),
          runtime: String(parsed["runtime"] ?? selector.runtime),
          ...(typeof parsed["codebase_root"] === "string"
            ? { codebaseRoot: parsed["codebase_root"] }
            : {}),
          ...(typeof parsed["main_script"] === "string"
            ? { mainScript: parsed["main_script"] }
            : {}),
          ...(typeof parsed["inspect_addr"] === "string"
            ? { inspectAddr: parsed["inspect_addr"] }
            : {}),
        };
      } catch {
        return undefined;
      }
    },

    async captureProfile(pid: number, type: ProfileType, options = {}): Promise<
      ProfileResult | undefined
    > {
      if (!(await probeAvailable(binary))) return undefined;
      const args = ["profile", String(pid), "--type", type, "--json"];
      if (options.durationSeconds !== undefined) {
        args.push("--duration", `${options.durationSeconds}s`);
      }
      if (options.outputPath !== undefined) {
        args.push("--output", options.outputPath);
      }
      try {
        const result = await execa(binary, args, {
          timeout: Math.max(
            DEFAULT_TIMEOUT_MS,
            (options.durationSeconds ?? 5) * 1_000 + 15_000,
          ),
          reject: false,
          env: {
            ...process.env,
            ...(options.stepId ? { MONITOR_STEP_ID: options.stepId } : {}),
            ...(options.service ? { MONITOR_SERVICE: options.service } : {}),
          },
        });
        if (result.exitCode !== 0) return undefined;
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        return {
          pid: Number(parsed["pid"]),
          type: String(parsed["type"] ?? type),
          ...(typeof parsed["method"] === "string"
            ? { method: parsed["method"] }
            : {}),
          taken: String(parsed["taken"] ?? ""),
          ...(Array.isArray(parsed["symbols"])
            ? {
                symbols: (
                  parsed["symbols"] as Array<Record<string, unknown>>
                ).map((s) => ({
                  func: String(s["func"] ?? s["Func"] ?? ""),
                  file: String(s["file"] ?? s["File"] ?? ""),
                  line: Number(s["line"] ?? s["Line"] ?? 0),
                })),
              }
            : {}),
          ...(typeof parsed["path"] === "string"
            ? { path: parsed["path"] }
            : {}),
          ...(parsed["receipt"] && typeof parsed["receipt"] === "object"
            ? {
                receipt: parsed["receipt"] as ProfileResult["receipt"],
              }
            : {}),
          ...(parsed["context"] && typeof parsed["context"] === "object"
            ? { context: parsed["context"] as Record<string, string> }
            : {}),
        };
      } catch {
        return undefined;
      }
    },
  };
}

/** Flatten a process tree forest into a list (depth-first, root-first). */
export function flattenTree(nodes: ProcessTreeNode[]): ProcessTreeNode[] {
  const out: ProcessTreeNode[] = [];
  const walk = (n: ProcessTreeNode): void => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}
