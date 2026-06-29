import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffoldCommand } from "./scaffold.js";
import type { CodemapDeps } from "../annotate.js";

/* ---------------------------------------------------------------------------
 * scaffoldCommand — `cairn spec scaffold --from-codemap` (FEATURES item 6)
 *
 * `--from-codemap` consults `codemap semantic` + `codemap orphans` for untested
 * entrypoints and pre-fills the spec's `coversSymbol` binding from the symbol's
 * signature/docstring. A fake codemap verifies the binding without codemap on
 * $PATH. Uses semantic + orphans ONLY — `codemap read-order` is not yet shipped
 * here (noted as a future enhancement in FEATURES.md).
 * ------------------------------------------------------------------------- */

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "cairntrace-scaffold-test-"));
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

/** Fake codemap: one untested entrypoint (orphan) + its semantic signature. */
function fakeCodemap(): CodemapDeps {
  const orphan = {
    symbol: "handleSubmit",
    file: "src/forms/handler.ts",
    line: 22,
    signature: "handleSubmit(e: Event): Promise<void>",
    docstring: "Validate then post the form entry to the API.",
    kind: "handler",
  };
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "orphans")
        return { exitCode: 0, stdout: JSON.stringify([orphan]), stderr: "" };
      if (args[0] === "semantic" || args[0] === "find")
        return { exitCode: 0, stdout: JSON.stringify([orphan]), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: `unknown ${args[0]}` };
    },
  };
}

const unavailable: CodemapDeps = {
  isAvailable: async () => false,
  exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
};

describe("scaffoldCommand --from-codemap (feature 6)", () => {
  it("pre-fills coversSymbol from an untested codemap entrypoint", async () => {
    const name = `form_submit_${Date.now()}`;
    await scaffoldCommand(
      name,
      {
        intent: "the form submit handler posts valid entries",
        out: outDir,
        fromCodemap: "handleSubmit",
      },
      fakeCodemap(),
    );

    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    // The spec stub is already bound to coversSymbol.
    expect(yaml).toMatch(/coversSymbol:\s*handleSubmit/);
    // The header comment carries the signature + docstring provenance.
    expect(yaml).toContain("handleSubmit(e: Event): Promise<void>");
    expect(yaml).toContain("Validate then post the form entry to the API.");
    expect(yaml).toContain("src/forms/handler.ts:22");
  });

  it("uses the spec name as the query when --from-codemap has no value", async () => {
    // spec name "handleSubmit"-ish is snake_case-invalid, so use a name the
    // fake matches via the explicit query fallback path instead.
    const name = `entry_${Date.now()}`;
    await scaffoldCommand(
      name,
      {
        intent: "covers an untested entrypoint",
        out: outDir,
        fromCodemap: true,
      },
      fakeCodemap(),
    );
    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    // Orphans are returned regardless of query, so the first orphan binds.
    expect(yaml).toMatch(/coversSymbol:\s*handleSubmit/);
  });

  it("scaffolds without a binding when codemap is absent (best-effort)", async () => {
    const name = `no_codemap_${Date.now()}`;
    await scaffoldCommand(
      name,
      { intent: "no codemap available", out: outDir, fromCodemap: "login" },
      unavailable,
    );
    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    expect(yaml).not.toMatch(/coversSymbol:/);
  });

  it("scaffolds without a binding when --from-codemap is omitted", async () => {
    const name = `plain_${Date.now()}`;
    await scaffoldCommand(
      name,
      { intent: "plain scaffold", out: outDir },
      fakeCodemap(),
    );
    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    expect(yaml).not.toMatch(/coversSymbol:/);
  });
});
