import { describe, expect, it } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { synthesizeErroredResult } from "./run";

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
