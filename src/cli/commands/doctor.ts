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

  const artifactRoot = join(homedir(), ".cairntrace", "runs");
  const writable = await isWritableOrCreatable(artifactRoot);
  checks.push({
    name: "artifact-root",
    ok: writable,
    detail: `${artifactRoot} ${writable ? "writable" : "not writable"}`,
  });

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
