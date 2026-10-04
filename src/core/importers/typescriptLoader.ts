import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type * as TS from "typescript";

export class TypescriptUnavailableError extends Error {}

interface Candidate {
  where: "project" | "cairntrace";
  path?: string;
  version?: string;
  /** Why it could not be used. */
  problem: string;
}

const NO_JS_API =
  "it has no JavaScript API (no createSourceFile; the native TypeScript 7 compiler ships only tsc)";

/**
 * The `typescript` compiler API (`createSourceFile`, `ModuleKind`, …) for
 * static reads of Playwright code — the importer's AST walk and the export's
 * host profile. The project's own copy is preferred when it exposes the
 * JavaScript API (its version matches the syntax it writes); otherwise
 * cairntrace's own (`typescript` is a runtime dependency of cairntrace). A
 * TypeScript without the JavaScript API — the native TypeScript 7 compiler,
 * which ships `tsc` but no `createSourceFile` — is skipped, and named in the
 * error when nothing usable is left. CommonJS, so it loads synchronously.
 */
export function loadTypescript(
  startDir: string,
  opts: { own?: boolean } = {},
): typeof TS {
  const candidates: Candidate[] = [];
  const attempts: Array<{
    where: Candidate["where"];
    resolvePath: () => string;
  }> = [
    {
      where: "project",
      resolvePath: () =>
        createRequire(join(resolve(startDir), "noop.js")).resolve("typescript"),
    },
    ...(opts.own === false
      ? []
      : [
          {
            where: "cairntrace" as const,
            resolvePath: () =>
              createRequire(import.meta.url).resolve("typescript"),
          },
        ]),
  ];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    let path: string;
    try {
      path = attempt.resolvePath();
    } catch {
      candidates.push({ where: attempt.where, problem: "not installed" });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const loaded = createRequire(path)(path) as
        | (typeof TS & { default?: typeof TS })
        | undefined;
      const ts = loaded?.default ?? loaded;
      if (ts && typeof ts.createSourceFile === "function") return ts;
      candidates.push({
        where: attempt.where,
        path,
        ...(typeof ts?.version === "string" ? { version: ts.version } : {}),
        problem: NO_JS_API,
      });
    } catch (e) {
      candidates.push({
        where: attempt.where,
        path,
        problem: `it cannot be loaded (${(e as Error).message.split("\n")[0]})`,
      });
    }
  }
  const found = candidates.filter((c) => c.path !== undefined);
  const detail =
    found.length > 0
      ? found
          .map(
            (c) =>
              `${
                c.where === "project" ? "the project's" : "cairntrace's"
              } typescript${
                c.version ? ` ${c.version}` : ""
              } (${c.path}): ${c.problem}`,
          )
          .join("; ")
      : `no \`typescript\` package in or above ${dirname(resolve(startDir, "x"))}${
          opts.own === false ? "" : " and none in cairntrace"
        }`;
  throw new TypescriptUnavailableError(
    `no TypeScript with the JavaScript API to read the Playwright code statically: ${detail}. ${
      found.some((c) => c.problem === NO_JS_API)
        ? "A TypeScript 5 or 6 package (`typescript`) has the API; cairntrace depends on one, so reinstalling cairntrace restores it"
        : "Reinstall cairntrace (it depends on typescript)"
    }`,
  );
}
