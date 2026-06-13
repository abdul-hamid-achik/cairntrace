import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { expandSpecArgs, synthesizeErroredResult } from "./run";

describe("synthesizeErroredResult", () => {
  it("produces a RunResult that parses against the v1 wire schema", () => {
    const result = synthesizeErroredResult(
      "/some/absolute/path/to/spec.yml",
      new Error("could not load spec"),
    );
    const parsed = RunResultSchema.parse(result);
    expect(parsed.status).toBe("errored");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.runDir.startsWith("/")).toBe(true);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]!.error).toBe("could not load spec");
  });

  it("absolutifies a relative spec path", () => {
    const result = synthesizeErroredResult(
      "flows/relative.yml",
      new Error("oops"),
    );
    expect(result.spec.path.startsWith("/")).toBe(true);
  });

  it("strips .yml/.yaml from the spec name", () => {
    expect(
      synthesizeErroredResult("/x/import_xlsx.yml", new Error("e")).spec.name,
    ).toBe("import_xlsx");
    expect(
      synthesizeErroredResult("/x/foo.yaml", new Error("e")).spec.name,
    ).toBe("foo");
  });
});

describe("parseVarFlags", () => {
  it("parses repeated key=value pairs", async () => {
    const { parseVarFlags } = await import("./run");
    expect(parseVarFlags(["baseUrl=http://localhost:3123", "a=b"])).toEqual({
      baseUrl: "http://localhost:3123",
      a: "b",
    });
  });

  it("splits on the first = only", async () => {
    const { parseVarFlags } = await import("./run");
    expect(parseVarFlags(["token=a=b=c"])).toEqual({ token: "a=b=c" });
  });

  it("throws on malformed pairs", async () => {
    const { parseVarFlags } = await import("./run");
    expect(() => parseVarFlags(["nodelimiter"])).toThrow(/key=value/);
    expect(() => parseVarFlags(["=value"])).toThrow(/key=value/);
  });

  it("returns an empty bag for undefined", async () => {
    const { parseVarFlags } = await import("./run");
    expect(parseVarFlags(undefined)).toEqual({});
  });
});

describe("expandSpecArgs", () => {
  it("expands directories recursively while skipping actions and underscore specs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-expand-"));
    await mkdir(join(dir, "flows", "nested"), { recursive: true });
    await mkdir(join(dir, "flows", "actions"), { recursive: true });
    await writeFile(join(dir, "flows", "a.yml"), "version: 1\n");
    await writeFile(join(dir, "flows", "nested", "b.yaml"), "version: 1\n");
    await writeFile(join(dir, "flows", "_draft.yml"), "version: 1\n");
    await writeFile(join(dir, "flows", "actions", "login.yml"), "version: 1\n");
    await writeFile(join(dir, "flows", "notes.txt"), "notes\n");

    await expect(expandSpecArgs(["flows"], dir)).resolves.toEqual([
      join(dir, "flows", "a.yml"),
      join(dir, "flows", "nested", "b.yaml"),
    ]);
  });

  it("preserves explicit files and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-expand-"));
    await writeFile(join(dir, "_explicit.yml"), "version: 1\n");

    await expect(
      expandSpecArgs(["_explicit.yml", "missing.yml"], dir),
    ).resolves.toEqual(["_explicit.yml", "missing.yml"]);
  });
});
