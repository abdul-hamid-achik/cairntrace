import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExplain } from "./explain";

// `cairn explain` is the agent's contract for the CLI surface. A flag that
// explain lists but commander does not register fails with "unknown option"
// (exit 1); a registered flag explain omits is invisible to agents. Compare
// every explain command against its real `--help`.

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

/** Format shortcuts every command registers; explain documents `--format`. */
const FORMAT_SHORTCUTS = new Set(["--json", "--yaml", "--md", "--help"]);

function help(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [BIN, ...command.split(" "), "--help"], {
      env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

/**
 * Commander prints each option at a two-space indent (`  -x, --flag <v>`);
 * wrapped description lines are indented further, so they never match.
 */
function registeredFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const line of helpText.split("\n")) {
    const m = /^ {2}(?:-[A-Za-z], )?(--[a-z0-9][a-z0-9-]*)/.exec(line);
    if (m) flags.add(m[1]!);
  }
  return flags;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

describe("cairn explain ↔ CLI flag parity", () => {
  it("lists exactly the flags each command registers", async () => {
    const commands = buildExplain().commands;
    const helps = await mapLimit(commands, 4, (c) => help(c.name));
    const drift: string[] = [];
    commands.forEach((command, i) => {
      const registered = registeredFlags(helps[i]!);
      expect(
        registered.size,
        `no options parsed from \`cairn ${command.name} --help\``,
      ).toBeGreaterThan(0);
      const explained = new Set(command.flags.map((f) => f.name));
      for (const name of explained) {
        if (!registered.has(name)) {
          drift.push(`${command.name}: explain lists ${name}, CLI rejects it`);
        }
      }
      for (const name of registered) {
        if (!explained.has(name) && !FORMAT_SHORTCUTS.has(name)) {
          drift.push(`${command.name}: CLI has ${name}, explain omits it`);
        }
      }
    });
    expect(drift).toEqual([]);
  }, 120_000);
});
