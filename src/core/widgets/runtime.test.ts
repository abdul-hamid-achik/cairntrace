import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import {
  buildWidgetScript,
  defaultWidgets,
  driverModuleExpression,
  prepareWidgets,
  runWidgetOp,
  widgetRuntimeSource,
  widgetScriptParts,
} from "./runtime";

describe("widget runtime source", () => {
  it("is one function expression without comment lines, and the script compiles", () => {
    const source = widgetRuntimeSource();
    expect(source.startsWith("async function cairnWidgetRuntime(")).toBe(true);
    expect(source.split("\n").some((line) => line.startsWith("//"))).toBe(
      false,
    );
    const script = buildWidgetScript(defaultWidgets("data-qa"), {
      op: "set",
      target: { field: "country" },
      value: "Spain",
      timeoutMs: 1000,
    });
    expect(() => new Script(script)).not.toThrow();
    expect(script).toContain('"testIdAttribute":"data-qa"');
    const parts = widgetScriptParts(defaultWidgets());
    expect(script.endsWith(parts.suffix)).toBe(true);
  });
});

describe("custom driver modules", () => {
  it("accepts export default and module.exports, and compiles them", () => {
    const esm = driverModuleExpression(
      "const helper = (x) => x;\nexport default { name: 'a', match: () => true, read: () => '', write: () => {} };\n",
      "a.js",
    );
    expect(esm).toContain("module.exports.default = {");
    const cjs = driverModuleExpression(
      "module.exports = { name: 'b', match() { return false; }, read() { return ''; }, async write() {} };",
      "b.js",
    );
    expect(() => new Script(`(${cjs})`)).not.toThrow();
  });

  it("rejects imports, named exports and syntax errors with the file name", () => {
    expect(() =>
      driverModuleExpression("import x from 'y';\nexport default {};", "i.js"),
    ).toThrow(/i\.js: driver modules run in the page and cannot use import/);
    expect(() =>
      driverModuleExpression("export const name = 'x';", "n.js"),
    ).toThrow(/n\.js: export the driver with `export default/);
    expect(() =>
      driverModuleExpression("export default { name: 'x', ", "s.js"),
    ).toThrow(/^s\.js: /);
  });

  it("prepares config: fieldRoot list, testIdAttribute, built-ins and files relative to the config dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-widget-config-"));
    await mkdir(join(dir, "drivers"));
    await writeFile(
      join(dir, "drivers", "picker.js"),
      "export default { name: 'picker', match: () => false, read: () => '', write() {} };",
    );
    const prepared = await prepareWidgets(
      {
        testIdAttribute: "data-qa",
        fieldRoot: '[data-field="{key}"]',
        widgets: [{ use: "vue-multiselect" }, { file: "./drivers/picker.js" }],
      },
      dir,
    );
    expect(prepared.config).toEqual({
      testIdAttribute: "data-qa",
      fieldRoot: ['[data-field="{key}"]'],
      drivers: [
        { use: "vue-multiselect" },
        { custom: 0, file: "./drivers/picker.js" },
      ],
    });
    expect(prepared.customDrivers).toHaveLength(1);
    expect(prepared.customDrivers[0]!.expression).toContain("picker");
    await expect(
      prepareWidgets({ widgets: [{ file: "./missing.js" }] }, dir),
    ).rejects.toThrow(/browser\.widgets\[0\]\.file "\.\/missing\.js"/);
    expect(await prepareWidgets(undefined, dir)).toEqual({
      config: {},
      customDrivers: [],
    });
  });
});

describe("runWidgetOp", () => {
  it("parses the page result and bounds the evaluate call", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ ok: true, status: "committed" });
    const result = await runWidgetOp(backend, defaultWidgets(), {
      op: "set",
      target: { field: "x" },
      value: 1,
      timeoutMs: 3000,
    });
    expect(result).toEqual({ ok: true, status: "committed" });
    // A value may be a password: the script never travels in argv.
    expect(backend.lastEvaluateOptions).toEqual({
      timeoutMs: 8000,
      sensitive: true,
    });
    await runWidgetOp(backend, defaultWidgets(), {
      op: "click",
      mode: "dispatch",
      target: { locator: { by: "selector", selector: "#a" } },
      timeoutMs: 3000,
    });
    expect(backend.lastEvaluateOptions).toEqual({ timeoutMs: 8000 });
  });

  it("loads project driver modules only for ops that pick a driver", async () => {
    const backend = new MockBrowserBackend();
    const prepared = {
      config: { drivers: [{ use: "pills" }, { custom: 0, file: "d.js" }] },
      customDrivers: [
        { file: "d.js", expression: "({ name: 'marker-driver-x' })" },
      ],
    };
    await runWidgetOp(backend, prepared, {
      op: "probe",
      target: { locator: { by: "selector", selector: "#a" } },
      timeoutMs: 1000,
    });
    expect(backend.lastEvaluatedScript).not.toContain("marker-driver-x");
    expect(backend.lastEvaluatedScript).toContain(
      '"drivers":[{"use":"pills"}]',
    );
    await runWidgetOp(backend, prepared, {
      op: "set",
      target: { field: "x" },
      value: 1,
      timeoutMs: 1000,
    });
    expect(backend.lastEvaluatedScript).toContain("marker-driver-x");
  });

  it("turns eval failures and malformed output into failed results", async () => {
    const failing = new MockBrowserBackend();
    failing.evaluate = async () => ({
      ok: false,
      stdout: "",
      stderr: "Execution context was destroyed",
      exitCode: 1,
      durationMs: 1,
      argv: ["eval"],
    });
    expect(
      await runWidgetOp(failing, defaultWidgets(), {
        op: "read",
        timeoutMs: 10,
      }),
    ).toMatchObject({
      ok: false,
      error: "widget runtime eval failed: Execution context was destroyed",
    });
    const garbled = new MockBrowserBackend();
    garbled.enqueueEvalResult("not an object");
    expect(
      await runWidgetOp(garbled, defaultWidgets(), {
        op: "read",
        timeoutMs: 10,
      }),
    ).toMatchObject({ ok: false, status: "failed" });
  });
});
