import { describe, expect, it } from "vitest";
import {
  resolveCodemapIndexCheck,
  resolveIosChecks,
  resolvePlaywrightChecks,
  type IosCheckDeps,
  type PlaywrightCheckDeps,
} from "./doctor.js";
import type { CodemapDeps } from "./annotate.js";

/* ---------------------------------------------------------------------------
 * resolveCodemapIndexCheck — `cairn doctor` codebase resolution (FEATURES item 7)
 *
 * `cairn doctor` resolves the target codebase from the `codemap projects`
 * registry (XDG) instead of a hardcoded `codemap.path`, and reports
 * "codebase indexed: yes (N symbols)". A fake codemap verifies the registry
 * lookup without codemap on $PATH. An unrelated registry entry must never
 * satisfy the current codebase check.
 * ------------------------------------------------------------------------- */

function fakeCodemap(symbols: number, path = process.cwd()): CodemapDeps {
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
    expect(check!.detail).toContain(process.cwd());
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
            stdout: JSON.stringify([{ name: "myapp", path: process.cwd() }]),
            stderr: "",
          };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    };
    const check = await resolveCodemapIndexCheck(noCount, true);
    expect(check!.ok).toBe(true);
    expect(check!.detail).toBe(`codebase indexed: yes at ${process.cwd()}`);
  });

  it("does not accept an unrelated registered project as the current codebase", async () => {
    const check = await resolveCodemapIndexCheck(
      fakeCodemap(4522, "/repo/unrelated"),
      true,
    );

    expect(check).toEqual({
      name: "codemap-index",
      ok: false,
      detail:
        `current codebase is not indexed (${process.cwd()}) — ` +
        "run `codemap index` from this directory",
    });
  });
});

/* ---------------------------------------------------------------------------
 * resolveCodemapIndexCheck — `codemap status` freshness (feature 7, codemap_status)
 * ------------------------------------------------------------------------- */
function fakeCodemapWithStatus(
  nodes: number,
  stale: { changed: number; new: number; deleted: number } | undefined,
  root = "/repo/myapp",
): CodemapDeps {
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "status") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            project: "myapp",
            root,
            registered: true,
            nodes,
            files: 30,
            vectors: nodes,
            ...(stale ? { stale } : {}),
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unknown ${args[0]}` };
    },
  };
}

describe("resolveCodemapIndexCheck — freshness (codemap status)", () => {
  it("reports 'fresh' when there is no drift", async () => {
    const check = await resolveCodemapIndexCheck(
      fakeCodemapWithStatus(4522, { changed: 0, new: 0, deleted: 0 }),
      true,
    );
    expect(check!.ok).toBe(true);
    expect(check!.detail).toMatch(/4522 symbols/);
    expect(check!.detail).toContain(", fresh");
  });

  it("reports 'stale: N changed…' when the index has drifted", async () => {
    const check = await resolveCodemapIndexCheck(
      fakeCodemapWithStatus(100, { changed: 3, new: 1, deleted: 0 }),
      true,
    );
    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain("stale: 3 changed, 1 new, 0 deleted");
  });

  it("falls back to the registry when status is not registered", async () => {
    // status returns registered:false -> the projects fallback path is used.
    const notRegistered: CodemapDeps = {
      isAvailable: async () => true,
      async exec(args) {
        if (args[0] === "status")
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              project: "",
              root: "",
              registered: false,
              nodes: 0,
            }),
            stderr: "",
          };
        if (args[0] === "projects")
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              { name: "myapp", path: process.cwd(), symbols: 50 },
            ]),
            stderr: "",
          };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    };
    const check = await resolveCodemapIndexCheck(notRegistered, true);
    expect(check!.detail).toMatch(/50 symbols/);
    expect(check!.detail).not.toContain("fresh");
  });
});

/* ---------------------------------------------------------------------------
 * resolvePlaywrightChecks — package + matching Chromium readiness
 * ------------------------------------------------------------------------- */

function fakePlaywrightDeps(
  options: {
    packageError?: Error;
    executablePath?: string;
    executableReady?: boolean;
    executablePathError?: Error;
  } = {},
): PlaywrightCheckDeps {
  return {
    async load() {
      if (options.packageError) throw options.packageError;
      return {
        chromium: {
          executablePath() {
            if (options.executablePathError) throw options.executablePathError;
            return options.executablePath ?? "/cache/playwright/chromium";
          },
        },
      };
    },
    async access() {
      if (options.executableReady === false) {
        throw new Error("ENOENT");
      }
    },
  };
}

describe("resolvePlaywrightChecks", () => {
  it("reports the package and matching Chromium executable as ready", async () => {
    const checks = await resolvePlaywrightChecks(fakePlaywrightDeps());

    expect(checks).toEqual([
      {
        name: "playwright-package",
        ok: true,
        detail: "Playwright package available",
      },
      {
        name: "playwright-chromium",
        ok: true,
        detail: "Chromium executable ready at /cache/playwright/chromium",
      },
    ]);
  });

  it("reports bun install when the Playwright package cannot load", async () => {
    const checks = await resolvePlaywrightChecks(
      fakePlaywrightDeps({
        packageError: new Error("Cannot find package 'playwright'"),
      }),
    );

    expect(checks.map((check) => check.ok)).toEqual([false, false]);
    expect(checks[0]!.detail).toContain("bun install");
    expect(checks[1]!.detail).toContain("not checked");
  });

  it("reports the exact browser install command when Chromium is absent", async () => {
    const checks = await resolvePlaywrightChecks(
      fakePlaywrightDeps({ executableReady: false }),
    );

    expect(checks[0]!.ok).toBe(true);
    expect(checks[1]).toMatchObject({
      name: "playwright-chromium",
      ok: false,
    });
    expect(checks[1]!.detail).toContain("bunx playwright install chromium");
    expect(checks[1]!.detail).toContain("/cache/playwright/chromium");
  });

  it("handles a Playwright runtime that cannot resolve its browser path", async () => {
    const checks = await resolvePlaywrightChecks(
      fakePlaywrightDeps({
        executablePathError: new Error("browser registry unavailable"),
      }),
    );

    expect(checks[1]).toMatchObject({
      name: "playwright-chromium",
      ok: false,
    });
    expect(checks[1]!.detail).toContain("browser registry unavailable");
    expect(checks[1]!.detail).toContain("bunx playwright install chromium");
  });

  it("rejects an empty Chromium executable path", async () => {
    const checks = await resolvePlaywrightChecks(
      fakePlaywrightDeps({ executablePath: "" }),
    );

    expect(checks[1]).toMatchObject({
      name: "playwright-chromium",
      ok: false,
    });
    expect(checks[1]!.detail).toContain("empty Chromium executable path");
  });
});

/* ---------------------------------------------------------------------------
 * resolveIosChecks — `cairn doctor --ios` iOS readiness probes
 * ------------------------------------------------------------------------- */
function fakeIosExec(
  responses: Record<string, { ok: boolean; stdout: string }>,
): IosCheckDeps {
  return {
    async exec(bin, args) {
      const key = `${bin} ${args.join(" ")}`;
      return responses[key] ?? { ok: false, stdout: "" };
    },
  };
}

describe("resolveIosChecks (cairn doctor --ios)", () => {
  it("reports all green when Xcode/Appium/xcuitest/simulators are present", async () => {
    const checks = await resolveIosChecks(
      fakeIosExec({
        "xcode-select -p": {
          ok: true,
          stdout: "/Applications/Xcode.app/Contents/Developer\n",
        },
        "appium --version": { ok: true, stdout: "2.5.1\n" },
        "appium driver list --installed": {
          ok: true,
          stdout: "- xcuitest@7.40.7 [installed]\n",
        },
        "xcrun simctl list devices available": {
          ok: true,
          stdout:
            "    iPhone 15 Pro (ABC) (Shutdown)\n    iPad (A16) (DEF) (Booted)\n",
        },
      }),
    );
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.name === "ios-appium")!.detail).toContain(
      "2.5.1",
    );
    expect(checks.find((c) => c.name === "ios-simulators")!.detail).toContain(
      "2 iOS simulator(s)",
    );
  });

  it("flags missing appium and skips the xcuitest check", async () => {
    const checks = await resolveIosChecks(
      fakeIosExec({
        "xcode-select -p": { ok: true, stdout: "/Applications/Xcode.app\n" },
        "appium --version": { ok: false, stdout: "" },
        "xcrun simctl list devices available": {
          ok: true,
          stdout: "    iPhone 15 (ABC) (Shutdown)\n",
        },
      }),
    );
    const appium = checks.find((c) => c.name === "ios-appium")!;
    expect(appium.ok).toBe(false);
    expect(appium.detail).toContain("npm install -g appium");
    // The xcuitest probe is skipped when appium itself is absent.
    expect(checks.find((c) => c.name === "ios-xcuitest")).toBeUndefined();
  });

  it("flags appium present but the xcuitest driver missing", async () => {
    const checks = await resolveIosChecks(
      fakeIosExec({
        "xcode-select -p": { ok: true, stdout: "/Applications/Xcode.app\n" },
        "appium --version": { ok: true, stdout: "2.5.1\n" },
        "appium driver list --installed": {
          ok: true,
          stdout: "- safari@1.0 [installed]\n",
        },
        "xcrun simctl list devices available": {
          ok: true,
          stdout: "    iPhone 15 (ABC) (Shutdown)\n",
        },
      }),
    );
    const xcuitest = checks.find((c) => c.name === "ios-xcuitest")!;
    expect(xcuitest.ok).toBe(false);
    expect(xcuitest.detail).toContain("appium driver install xcuitest");
  });

  it("flags no available simulators", async () => {
    const checks = await resolveIosChecks(
      fakeIosExec({
        "xcode-select -p": { ok: true, stdout: "/Applications/Xcode.app\n" },
        "appium --version": { ok: true, stdout: "2.5.1\n" },
        "appium driver list --installed": {
          ok: true,
          stdout: "- xcuitest@7.40.7 [installed]\n",
        },
        "xcrun simctl list devices available": {
          ok: true,
          stdout: "== Devices ==\n-- iOS 17 --\n",
        },
      }),
    );
    const sims = checks.find((c) => c.name === "ios-simulators")!;
    expect(sims.ok).toBe(false);
    expect(sims.detail).toContain("no iOS simulators available");
  });
});
