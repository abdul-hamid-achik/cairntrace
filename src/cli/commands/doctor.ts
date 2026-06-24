import { access, constants, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { emit, resolveFormat } from "../format";

export interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface DoctorOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
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
  checks.push({
    name: "agent-browser",
    ok: ab.ok,
    detail: ab.ok
      ? ab.stdout.trim()
      : "agent-browser not on $PATH (cairn run will fail without --mock)",
  });

  const fcheap = await tryExec("fcheap", ["--version"]);
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

  const codemap = await tryExec("codemap", ["version"]);
  checks.push({
    name: "codemap",
    ok: codemap.ok,
    detail: codemap.ok
      ? codemap.stdout.trim()
      : "codemap not on $PATH (cairn annotate will be unavailable)",
  });

  const tvault = await tryExec("tvault", ["version"]);
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

  const ok = checks.every((c) => c.ok);
  const report: DoctorReport = { ok, checks };

  process.stdout.write(emit(format, report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exit(ok ? 0 : 2);
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
