import { describe, expect, it } from "vitest";
import { resolveCodemapIndexCheck } from "./doctor.js";
import type { CodemapDeps } from "./annotate.js";

/* ---------------------------------------------------------------------------
 * resolveCodemapIndexCheck — `cairn doctor` codebase resolution (FEATURES item 7)
 *
 * `cairn doctor` resolves the target codebase from the `codemap projects`
 * registry (XDG) instead of a hardcoded `codemap.path`, and reports
 * "codebase indexed: yes (N symbols)". A fake codemap verifies the registry
 * lookup without codemap on $PATH. No `codemap status` freshness — best-effort
 * + TODO (not yet shipped in codemap).
 * ------------------------------------------------------------------------- */

function fakeCodemap(symbols: number, path = "/repo/myapp"): CodemapDeps {
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "projects") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: "myapp", path, symbols, indexedAt: "2026-06-29T00:00:00Z" },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unknown ${args[0]}` };
    },
  };
}

const emptyRegistry: CodemapDeps = {
  isAvailable: async () => true,
  async exec(args) {
    if (args[0] === "projects")
      return { exitCode: 0, stdout: "[]", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "" };
  },
};

describe("resolveCodemapIndexCheck (feature 7)", () => {
  it("reports 'codebase indexed: yes (N symbols)' from the registry", async () => {
    const check = await resolveCodemapIndexCheck(fakeCodemap(4522), true);
    expect(check).toBeDefined();
    expect(check!.name).toBe("codemap-index");
    expect(check!.ok).toBe(true);
    expect(check!.detail).toMatch(/codebase indexed: yes \(4522 symbols/);
    expect(check!.detail).toContain("/repo/myapp");
  });

  it("returns undefined when codemap is not on $PATH (the codemap check covers it)", async () => {
    const check = await resolveCodemapIndexCheck(fakeCodemap(10), false);
    expect(check).toBeUndefined();
  });

  it("flags an empty registry so the user runs `codemap index`", async () => {
    const check = await resolveCodemapIndexCheck(emptyRegistry, true);
    expect(check).toBeDefined();
    expect(check!.ok).toBe(false);
    expect(check!.detail).toMatch(/no projects in registry/);
  });

  it("tolerates registry entries without a symbol count", async () => {
    const noCount: CodemapDeps = {
      isAvailable: async () => true,
      async exec(args) {
        if (args[0] === "projects")
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ name: "myapp", path: "/repo/myapp" }]),
            stderr: "",
          };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    };
    const check = await resolveCodemapIndexCheck(noCount, true);
    expect(check!.ok).toBe(true);
    expect(check!.detail).toBe("codebase indexed: yes at /repo/myapp");
  });
});
