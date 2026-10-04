import { dirname, resolve } from "node:path";
import type { Spec } from "../schema/spec.v1";
import {
  renderSpecYaml,
  summarizeCoverage,
  type ImportCoverage,
  type ImportItem,
} from "./importCommon";
import { importPlaywrightAst } from "./playwrightAst";
import { loadTypescript } from "./typescriptLoader";

export interface ImportPlaywrightResult {
  spec: Spec;
  yaml: string;
  /** Every TODO, one line each (unmapped constructs with their reason). */
  todos: string[];
  /** Mapped / approximated / unmapped counts over every construct looked at. */
  coverage: ImportCoverage;
  /** What was mapped loosely, one line each. */
  approximations: string[];
  /** Every construct and what became of it. */
  items: ImportItem[];
}

export interface ImportPlaywrightOptions {
  sourcePath?: string;
  /** Title substring or 1-based index of the test to import (default: the first). */
  test?: string;
  /** Directory to look for `typescript` from (default: the source's directory). */
  resolveFrom?: string;
}

/**
 * `cairn import playwright`: a `@playwright/test` file as a reviewable
 * Cairntrace spec, by a TypeScript AST walk (never executing the file).
 * Throws `TypescriptUnavailableError` when no `typescript` package is found.
 */
export function importPlaywright(
  source: string,
  opts: ImportPlaywrightOptions = {},
): ImportPlaywrightResult {
  const startDir =
    opts.resolveFrom ??
    (opts.sourcePath ? dirname(resolve(opts.sourcePath)) : process.cwd());
  const ts = loadTypescript(startDir);
  const absolute = opts.sourcePath ? resolve(opts.sourcePath) : undefined;
  const ast = importPlaywrightAst(ts, source, {
    ...(absolute ? { sourcePath: absolute } : {}),
    ...(opts.test ? { test: opts.test } : {}),
  });
  const yaml = renderSpecYaml(ast.spec, {
    generator: "cairn import playwright",
    ...(opts.sourcePath ? { sourceLabel: opts.sourcePath } : {}),
    headerTodos: ast.headerTodos,
    approximations: ast.approximations,
    items: ast.items,
  });
  return {
    spec: ast.spec,
    yaml,
    todos: ast.todos,
    coverage: summarizeCoverage(ast.items),
    approximations: ast.approximations,
    items: ast.items,
  };
}
