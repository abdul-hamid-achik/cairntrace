import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "./nodeScripts";

describe("runNodeScript", () => {
  it("executes TypeScript syntax that requires transformation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-node-script-"));
    const file = join(dir, "verifier.ts");

    try {
      await writeFile(
        file,
        `
type Fixture = { value: string };

export default async function verify() {
  const fixture: Fixture = { value: "ready" };
  return { value: fixture.value };
}
`,
      );

      const result = await runNodeScript({
        file,
        ctx: {},
        cwd: dir,
        entryNames: ["verify"],
      });

      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ value: "ready" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
