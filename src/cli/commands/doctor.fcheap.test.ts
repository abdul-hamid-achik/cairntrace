import { describe, expect, it } from "vitest";
import { resolveFcheapChecks, type FcheapCheckDeps } from "./doctor";

/** A fake fcheap for `cairn doctor` (never the real binary). */
function deps(
  opts: {
    installed?: boolean;
    meta?: boolean;
    runIndex?: boolean;
    signedIn?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): FcheapCheckDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    env: opts.env ?? {},
    async exec(_bin, args) {
      calls.push(args);
      if (opts.installed === false) return { ok: false, stdout: "" };
      if (args[0] === "--version") {
        return { ok: true, stdout: "fcheap version 0.36.1 (abc) 2026-10-01\n" };
      }
      if (args[0] === "save") {
        return {
          ok: true,
          stdout: opts.meta === false ? "" : "  --meta stringArray",
        };
      }
      if (args[0] === "publish") {
        return {
          ok: true,
          stdout: opts.runIndex === false ? "" : "  --run-index string",
        };
      }
      if (args[0] === "auth") return { ok: opts.signedIn ?? false, stdout: "" };
      return { ok: false, stdout: "" };
    },
  };
}

describe("cairn doctor — file.cheap readiness", () => {
  it("fails only when fcheap is missing", async () => {
    const checks = await resolveFcheapChecks(deps({ installed: false }));
    expect(checks).toEqual([
      expect.objectContaining({ name: "fcheap", ok: false }),
    ]);
  });

  it("reports version, console session and an unconfigured publisher", async () => {
    const checks = await resolveFcheapChecks(deps());
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["fcheap", true],
      ["fcheap-auth", true],
      ["fcheap-publisher", true],
    ]);
    expect(checks[0]!.detail).toBe("fcheap version 0.36.1 (abc) 2026-10-01");
    expect(checks[1]!.detail).toContain("not signed in");
    expect(checks[2]!.detail).toContain("not configured");
  });

  it("flags missing --meta / --run-index support in the version detail", async () => {
    const [fcheap] = await resolveFcheapChecks(
      deps({ meta: false, runIndex: false }),
    );
    expect(fcheap!.detail).toContain("save --meta unsupported");
    expect(fcheap!.detail).toContain("publish --run-index unsupported");
  });

  it("reports a ready publisher without printing credential values", async () => {
    const checks = await resolveFcheapChecks(
      deps({
        signedIn: true,
        env: {
          FILECHEAP_ARTIFACT_SERVICE_URL: "https://artifacts.example.test",
          FILECHEAP_INGEST_TOKEN: "ingest-secret-value",
        },
      }),
    );
    const text = JSON.stringify(checks);
    expect(text).not.toContain("ingest-secret-value");
    expect(text).not.toContain("artifacts.example.test");
    expect(checks.find((c) => c.name === "fcheap-auth")?.detail).toContain(
      "signed in",
    );
    expect(checks.find((c) => c.name === "fcheap-publisher")).toMatchObject({
      ok: true,
      detail: expect.stringContaining("ready"),
    });
  });

  it("fails a half-configured publisher", async () => {
    const checks = await resolveFcheapChecks(
      deps({ env: { FILECHEAP_INGEST_TOKEN: "t" } }),
    );
    expect(checks.find((c) => c.name === "fcheap-publisher")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("FILECHEAP_ARTIFACT_SERVICE_URL"),
    });
  });
});
