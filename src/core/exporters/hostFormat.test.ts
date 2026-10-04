import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatWithHostPrettier } from "./hostFormat";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cairn-host-format-")));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function bin(root: string, source: string): string {
  const path = join(root, "prettier");
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

describe("formatWithHostPrettier", () => {
  it("formats code, markdown and json by their final path, runs to a fixed point and counts rewrites", async () => {
    const root = tmpRoot();
    const log = join(root, "calls.log");
    // Needs two passes: the first pass adds one line, the second adds another.
    const prettier = bin(
      root,
      `const fs = require("node:fs");
const file = process.argv[process.argv.indexOf("--stdin-filepath") + 1];
fs.appendFileSync(${JSON.stringify(log)}, file + "\\n");
let text = fs.readFileSync(0, "utf8");
if (!text.includes("// one")) text += "// one\\n";
else if (!text.includes("// two")) text += "// two\\n";
process.stdout.write(text);
`,
    );
    const out = join(root, "tree", "not-yet");
    const result = await formatWithHostPrettier(
      [
        { relPath: "a.spec.ts", source: "export const a = 1;\n" },
        {
          relPath: "lib/b.ts",
          source: "export const b = 2;\n// one\n// two\n",
        },
        { relPath: "notes.txt", source: "plain\n" },
      ],
      { bin: prettier },
      out,
      root,
    );
    expect(result.files[0]!.source).toBe(
      "export const a = 1;\n// one\n// two\n",
    );
    // Already stable: unchanged, not counted.
    expect(result.files[1]!.source).toBe(
      "export const b = 2;\n// one\n// two\n",
    );
    // Not a formattable extension: untouched and never sent to prettier.
    expect(result.files[2]!.source).toBe("plain\n");
    expect(result.formatted).toBe(1);
    expect(result.skipped).toEqual([]);
    // Each file is named by its final path (the directory need not exist).
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toContain(join(out, "a.spec.ts"));
    expect(calls).toContain(join(out, "lib", "b.ts"));
    expect(calls.some((call) => call.endsWith("notes.txt"))).toBe(false);
  });

  it("keeps a file as generated, with the reason, when prettier fails on it", async () => {
    const root = tmpRoot();
    const prettier = bin(
      root,
      `process.stderr.write("SyntaxError: nope\\nmore\\n"); process.exit(2);\n`,
    );
    mkdirSync(join(root, "out"));
    const result = await formatWithHostPrettier(
      [{ relPath: "a.ts", source: "export const = ;\n" }],
      { bin: prettier },
      join(root, "out"),
    );
    expect(result.files[0]!.source).toBe("export const = ;\n");
    expect(result.formatted).toBe(0);
    expect(result.skipped).toEqual([
      { relPath: "a.ts", reason: "SyntaxError: nope" },
    ]);
  });

  it("reports a binary that cannot start instead of throwing", async () => {
    const root = tmpRoot();
    const result = await formatWithHostPrettier(
      [{ relPath: "a.ts", source: "export const a = 1;\n" }],
      { bin: join(root, "missing-prettier") },
      root,
    );
    expect(result.formatted).toBe(0);
    expect(result.skipped[0]?.relPath).toBe("a.ts");
    expect(result.files[0]!.source).toBe("export const a = 1;\n");
  });
});
