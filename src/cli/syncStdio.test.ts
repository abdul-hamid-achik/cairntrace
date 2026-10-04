import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const MODULE = resolve(__dirname, "syncStdio.ts");
const dir = mkdtempSync(join(tmpdir(), "cairn-sync-stdio-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A child that prints `bytes` bytes as cairn's commands do (one write, then process.exit) and reports patching. */
function script(name: string, command: string, bytes: number): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(
    path,
    `import { installSyncStdio } from ${JSON.stringify(MODULE)};
const before = process.stdout.write;
installSyncStdio(["bun", "cairn", ${JSON.stringify(command)}]);
if (process.env.REPORT_PATCHED) process.stderr.write(process.stdout.write === before ? "untouched" : "patched");
process.stdout.write(JSON.stringify({ data: "x".repeat(${bytes}) }) + "\\n");
process.exit(0);
`,
  );
  return path;
}

function sh(command: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

describe("installSyncStdio", () => {
  it("keeps every byte a command printed before process.exit, even when the reader is slow", () => {
    const bytes = 300_000;
    const r = sh(
      `bun ${script("big", "spec", bytes)} | (sleep 0.3; cat) | wc -c`,
    );
    expect(r.status, r.stderr).toBe(0);
    // {"data":"…"} plus the newline
    expect(Number(r.stdout.trim())).toBe(bytes + 12);
  });

  it("stops quietly when the reader goes away (EPIPE) instead of crashing", () => {
    const r = sh(
      `bun ${script("epipe", "spec", 300_000)} | head -c 10 >/dev/null; echo "\${PIPESTATUS[0]}"`,
    );
    expect(r.stdout.trim()).toBe("0");
  });

  it("leaves `cairn mcp` (a JSON-RPC stream) on the runtime's own writer", () => {
    const mcp = sh(`bun ${script("mcp", "mcp", 10)} | cat >/dev/null`, {
      REPORT_PATCHED: "1",
    });
    expect(mcp.stderr).toBe("untouched");
    const other = sh(`bun ${script("other", "run", 10)} | cat >/dev/null`, {
      REPORT_PATCHED: "1",
    });
    expect(other.stderr).toBe("patched");
  });
});
