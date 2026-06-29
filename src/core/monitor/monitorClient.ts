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
  taken: string;
  /** Top stack symbols, when available (heap/goroutine/sample profiles). */
  symbols?: Array<{ func: string; file: string; line: number }>;
  /** Path to a saved raw profile file, when monitor wrote one. */
  path?: string;
}

export type ProfileType = "heap" | "cpu" | "goroutine" | "sample";

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
  /** `monitor profile <pid> --type <t> --json` → profile, or undefined on failure. */
  captureProfile(
    pid: number,
    type: ProfileType,
  ): Promise<ProfileResult | undefined>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function binaryPath(): string {
  return process.env["CAIRN_MONITOR_BINARY"] ?? "monitor";
}

let availabilityCache: boolean | undefined;

async function probeAvailable(): Promise<boolean> {
  if (availabilityCache !== undefined) return availabilityCache;
  try {
    await execa(binaryPath(), ["version"], { timeout: 3_000, reject: false });
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

/** Default `MonitorClient` that shells out to the real `monitor` binary. */
export function defaultMonitorClient(): MonitorClient {
  return {
    async available() {
      return probeAvailable();
    },

    async sampleProcess(pid: number): Promise<ProcessSample | undefined> {
      if (!(await probeAvailable())) return undefined;
      try {
        const { stdout } = await execa(
          binaryPath(),
          ["process", String(pid), "--json"],
          { timeout: DEFAULT_TIMEOUT_MS, reject: false },
        );
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
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
      if (!(await probeAvailable())) return undefined;
      try {
        const { stdout } = await execa(
          binaryPath(),
          ["tree", String(pid), "--json"],
          { timeout: DEFAULT_TIMEOUT_MS, reject: false },
        );
        return JSON.parse(stdout) as ProcessTreeNode[];
      } catch {
        return undefined;
      }
    },

    async captureProfile(pid: number, type: ProfileType): Promise<
      ProfileResult | undefined
    > {
      if (!(await probeAvailable())) return undefined;
      try {
        const { stdout } = await execa(
          binaryPath(),
          ["profile", String(pid), "--type", type, "--json"],
          { timeout: DEFAULT_TIMEOUT_MS, reject: false },
        );
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        return {
          pid: Number(parsed["pid"]),
          type: String(parsed["type"] ?? type),
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
