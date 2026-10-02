import { describe, expect, it } from "vitest";
import type { ParseResult } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";
import { renderRequiresEnvGuard } from "./requiresGuard";

/**
 * requires → a run-time `test.skip` guard on process.env.CAIRN_ENV. It never
 * reads the shell the export ran in; when the export baked an environment's
 * baseUrl, the guard is tied to THAT environment.
 */

function spec(requires: Spec["requires"]): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "guarded_flow",
    intent: "A flow that may only run in some environments.",
    coldStart: "guest",
    ...(requires ? { requires } : {}),
    preconditions: { commands: [{ name: "seed", run: "./seed.sh" }] },
    steps: [{ open: "https://demo.example.test/home" }],
    outcomes: [
      {
        id: "home",
        description: "home is open",
        verify: { url: { matches: "/home" } },
      },
    ],
  });
}

describe("requires.env export guard", () => {
  it("renders nothing without requires.env", () => {
    expect(renderRequiresEnvGuard(undefined)).toEqual({ lines: [] });
    expect(
      renderRequiresEnvGuard({ mutates: true }).lines.join("\n"),
    ).toContain("requires.mutates: true");
  });

  it("checks CAIRN_ENV and opt-in variables at run time", () => {
    const lines = renderRequiresEnvGuard({
      env: ["local", { dev: { optIn: "CAIRN_ALLOW_DEV" } }],
    }).lines.join("\n");
    expect(lines).toContain("test.skip(");
    expect(lines).toContain('process.env.CAIRN_ENV === "local"');
    expect(lines).toContain(
      '(process.env.CAIRN_ENV === "dev" && /^(1|true)$/i.test(process.env["CAIRN_ALLOW_DEV"] ?? ""))',
    );
    expect(lines).toContain(
      "set CAIRN_ENV to local, dev (with CAIRN_ALLOW_DEV=1)",
    );
  });

  it("emits the guard in single-file exports, never the export-time env", () => {
    const previous = process.env.CAIRN_ENV;
    process.env.CAIRN_ENV = "export-time-env";
    try {
      const { source } = exportPlaywright(spec({ env: ["local"] }));
      expect(source).toContain('!(process.env.CAIRN_ENV === "local")');
      expect(source).not.toContain("export-time-env");
      expect(source.indexOf("test.skip(")).toBeLessThan(
        source.indexOf('test("guarded_flow"'),
      );
      expect(exportPlaywright(spec(undefined)).source).not.toContain(
        "test.skip(",
      );
    } finally {
      if (previous === undefined) delete process.env.CAIRN_ENV;
      else process.env.CAIRN_ENV = previous;
    }
  });

  it("guards a --project suite before its beforeAll preconditions", () => {
    const guarded = spec({ env: ["local"] });
    const parsed: ParseResult = {
      spec: guarded,
      resolved: guarded,
      path: "/tmp/project/flows/guarded.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const result = exportPlaywrightProject([parsed]);
    const test = result.files.find((file) =>
      file.relPath.endsWith("guarded_flow.spec.ts"),
    )?.source;
    expect(test).toBeDefined();
    const skipAt = test!.indexOf("test.skip(");
    expect(skipAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(test!.indexOf("test.beforeAll("));
  });

  it("ties the guard to the environment whose baseUrl the export baked", () => {
    const requires = {
      env: ["local", { dev: { optIn: "CAIRN_ALLOW_DEV" } }],
    } satisfies Spec["requires"];
    const local = renderRequiresEnvGuard(requires, { env: "local" });
    expect(local.refusedReason).toBeUndefined();
    const localText = local.lines.join("\n");
    expect(localText).toContain('!(process.env.CAIRN_ENV === "local")');
    // Another allowed environment cannot pass: the URLs belong to local.
    expect(localText).not.toContain('"dev"');

    const dev = renderRequiresEnvGuard(requires, { env: "dev" }).lines.join(
      "\n",
    );
    expect(dev).toContain(
      '!((process.env.CAIRN_ENV === "dev" && /^(1|true)$/i.test(process.env["CAIRN_ALLOW_DEV"] ?? "")))',
    );
    expect(dev).not.toContain('"local"');
  });

  it("always skips, with a reason, where the policy refuses the baked environment", () => {
    const cases: Array<
      [
        Spec["requires"],
        Parameters<typeof renderRequiresEnvGuard>[1] & {},
        string,
      ]
    > = [
      [{ env: ["local"] }, { env: "dev" }, "requires.env allows"],
      [undefined, { env: "prod", policy: { trait: "protected" } }, "protected"],
      [
        { mutates: true },
        { env: "dev", policy: { mutations: "deny" } },
        "denies mutations",
      ],
    ];
    for (const [requires, target, code] of cases) {
      const guard = renderRequiresEnvGuard(requires, target);
      expect(guard.refusedReason).toContain(`"${target.env}"`);
      expect(guard.refusedReason).toContain(code);
      expect(guard.lines.join("\n")).toContain("test.skip(true, ");
    }
    // Allowed with no requires.env: no guard at all.
    expect(renderRequiresEnvGuard(undefined, { env: "dev" })).toEqual({
      lines: [],
    });
  });

  it("reports a refused baked environment as an envPolicy risk", () => {
    const single = exportPlaywright(spec({ env: ["local"] }), {
      envTarget: { env: "dev" },
    });
    expect(single.source).toContain("test.skip(true, ");
    expect(single.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "envPolicy", id: "requires" }),
    );

    const guarded = spec({ env: ["local"] });
    const parsed: ParseResult = {
      spec: guarded,
      resolved: guarded,
      path: "/tmp/project/flows/guarded.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const project = exportPlaywrightProject([parsed], {
      baseUrl: "http://dev.example.test",
      envTarget: { env: "dev" },
    });
    expect(project.specs[0]?.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "envPolicy" }),
    );
    const test = project.files.find((file) =>
      file.relPath.endsWith("guarded_flow.spec.ts"),
    )?.source;
    expect(test).toContain("test.skip(true, ");
  });
});
